// hnswlib-node is a native CommonJS addon; Node's ESM loader can't statically
// detect its named exports, so import the default and destructure at runtime.
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;
type HierarchicalNSW = InstanceType<typeof HierarchicalNSW>;
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metric, SearchHit, VectorEntry } from '@knitnode/protocol';
import { HNSW_PARAMS } from './config.js';

const INITIAL_CAPACITY = 1024;

/** Digest scheme tag — bump if the canonical serialization below ever changes. */
const DIGEST_VERSION = 'knitnode-snapshot-v1';

/** Sidecar written alongside the binary HNSW graph so labels/metadata survive. */
interface IndexSidecar {
  name: string;
  dim: number;
  metric: Metric;
  capacity: number;
  /**
   * label -> id, in first-seen order (index position == label). `null` marks a
   * label vacated by {@link CollectionIndex.delete}; holes are never compacted
   * away, since shifting labels would fork the index.
   */
  labelToId: (string | null)[];
  /** id -> metadata. Must be JSON-serializable (true for typical embeddings). */
  metadata: Record<string, Record<string, unknown>>;
  /** Content digest of the index at save time; verified on load. */
  digest: string;
}

/** Stable JSON: object keys sorted recursively so the digest is order-invariant. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * A single collection's in-memory HNSW index, plus the id/metadata sidecar that
 * hnswlib doesn't store for us.
 *
 * Determinism contract: entries are applied strictly in replay (log-height)
 * order by the {@link ReplayEngine}; combined with fixed HNSW params and seed,
 * two nodes replaying the same stream build byte-identical graphs and return
 * identical top-k. `addPoint` is synchronous and single-threaded, so there's no
 * scheduling nondeterminism to guard against.
 */
export class CollectionIndex {
  private index: HierarchicalNSW;
  /** hnswlib addresses points by integer label; we assign them densely. */
  private idToLabel = new Map<string, number>();
  /** Dense by position; a `null` slot is a label retired by {@link delete}. */
  private labelToId: (string | null)[] = [];
  private metadata = new Map<string, Record<string, unknown>>();
  private capacity = INITIAL_CAPACITY;

  constructor(
    readonly name: string,
    readonly dim: number,
    readonly metric: Metric = 'cosine',
  ) {
    this.index = new HierarchicalNSW(metric, dim);
    this.index.initIndex(
      INITIAL_CAPACITY,
      HNSW_PARAMS.M,
      HNSW_PARAMS.efConstruction,
      HNSW_PARAMS.randomSeed,
      // allowReplaceDeleted — required for the id-overwrite path in `upsert`,
      // which markDeletes the old point and re-adds under the same label.
      true,
    );
    this.index.setEf(HNSW_PARAMS.efSearch);
  }

  get size(): number {
    return this.idToLabel.size;
  }

  /**
   * Insert or overwrite an entry. Overwrite path uses a stable label so repeated
   * writes to the same id don't grow the graph — and, crucially, keep the label
   * assignment a pure function of first-seen order for determinism.
   */
  upsert(entry: VectorEntry): void {
    if (entry.dim !== this.dim) {
      throw new Error(
        `entry "${entry.id}" has dim ${entry.dim}, collection "${this.name}" is dim ${this.dim}`,
      );
    }
    const point = Array.from(entry.vector);

    let label = this.idToLabel.get(entry.id);
    if (label === undefined) {
      label = this.labelToId.length;
      this.ensureCapacity(label + 1);
      this.idToLabel.set(entry.id, label);
      this.labelToId.push(entry.id);
      this.index.addPoint(point, label);
    } else {
      // Overwrite in place: mark the old point deleted, re-add under the same
      // label with replaceDeleted so the vector is updated.
      this.index.markDelete(label);
      this.index.addPoint(point, label, true);
    }
    this.metadata.set(entry.id, entry.metadata);
  }

  /**
   * Remove an id from the index — the replay effect of a tombstone. Returns
   * false if the id was never present (a delete for an unknown id is a no-op,
   * not an error: replay must tolerate a tombstone that races its entry).
   *
   * The label is retired, not recycled: `labelToId[label]` becomes a permanent
   * hole and a later re-add of the same id appends a *fresh* label. Reusing the
   * vacated label would make label assignment depend on deletion history rather
   * than on first-seen order, and two nodes that replayed the same log must
   * agree on labels for their digests to match. The cost is that delete/re-add
   * churn grows the graph; reclaiming that space means rebuilding from the log.
   */
  delete(id: string): boolean {
    const label = this.idToLabel.get(id);
    if (label === undefined) return false;
    this.index.markDelete(label);
    this.idToLabel.delete(id);
    this.labelToId[label] = null;
    this.metadata.delete(id);
    return true;
  }

  /** Top-k nearest neighbours to `query`. Returns fewer than k if the index is small. */
  search(query: Float32Array | number[], k: number): SearchHit[] {
    if (query.length !== this.dim) {
      throw new Error(
        `query dim ${query.length} does not match collection dim ${this.dim}`,
      );
    }
    if (this.size === 0) return [];
    const point = Array.from(query);
    const kEff = Math.min(k, this.size);
    const { neighbors, distances } = this.index.searchKnn(point, kEff);

    const hits: SearchHit[] = [];
    for (let i = 0; i < neighbors.length; i++) {
      const id = this.labelToId[neighbors[i]!];
      if (id == null) continue; // unknown or deleted label
      hits.push({
        id,
        distance: distances[i]!,
        metadata: this.metadata.get(id) ?? {},
      });
    }
    return hits;
  }

  /**
   * Deterministic content digest of the index: sha256 over dim, metric, and
   * every live point in label order — its id, stored vector (LE float32), and
   * canonical metadata. Two indexes built from the same writes in the same order
   * produce the same digest, so it doubles as a snapshot-integrity checksum and
   * a cross-node agreement fingerprint.
   *
   * Deleted ids drop out entirely — their labels are skipped and `size` falls —
   * so the digest describes what the collection *contains*, not how it got
   * there. An id that was written and then tombstoned hashes identically to one
   * that was never written, even though the two indexes differ internally.
   */
  digest(): string {
    const h = createHash('sha256');
    h.update(`${DIGEST_VERSION}\n${this.dim}\n${this.metric}\n${this.size}\n`);
    const buf = Buffer.allocUnsafe(this.dim * 4);
    for (let label = 0; label < this.labelToId.length; label++) {
      const id = this.labelToId[label];
      if (id == null) continue; // retired label — contributes nothing
      const point = this.index.getPoint(label);
      for (let i = 0; i < point.length; i++) buf.writeFloatLE(point[i]!, i * 4);
      h.update(`\x00${id}\x00`);
      h.update(buf);
      h.update(canonicalJson(this.metadata.get(id) ?? {}));
    }
    return h.digest('hex');
  }

  /**
   * Persist the index to `dir` as two files: `<base>.hnsw` (the binary graph)
   * and `<base>.json` (the id/metadata sidecar hnswlib doesn't store, including
   * the content digest). Returns the digest so a manifest can record it.
   * Creates `dir` if missing.
   */
  saveTo(dir: string, base: string): string {
    mkdirSync(dir, { recursive: true });
    this.index.writeIndexSync(join(dir, `${base}.hnsw`));
    const digest = this.digest();
    const sidecar: IndexSidecar = {
      name: this.name,
      dim: this.dim,
      metric: this.metric,
      capacity: this.capacity,
      labelToId: this.labelToId,
      metadata: Object.fromEntries(this.metadata),
      digest,
    };
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(sidecar));
    return digest;
  }

  /**
   * Reconstruct a `CollectionIndex` previously written by {@link saveTo}, and
   * verify its content digest — a mismatch means the `.hnsw` or `.json` file was
   * corrupted or tampered with, and throws rather than loading bad state.
   */
  static loadFrom(dir: string, base: string): CollectionIndex {
    const sidecar = JSON.parse(
      readFileSync(join(dir, `${base}.json`), 'utf8'),
    ) as IndexSidecar;

    const idx = new CollectionIndex(sidecar.name, sidecar.dim, sidecar.metric);
    // readIndexSync replaces the freshly-init'd graph with the persisted one;
    // pass allowReplaceDeleted so future upserts keep working.
    idx.index.readIndexSync(join(dir, `${base}.hnsw`), true);
    idx.capacity = idx.index.getMaxElements();
    idx.labelToId = sidecar.labelToId;
    idx.idToLabel = new Map(
      sidecar.labelToId.flatMap((id, label) => (id == null ? [] : [[id, label] as const])),
    );
    idx.metadata = new Map(Object.entries(sidecar.metadata));

    const actual = idx.digest();
    if (sidecar.digest !== undefined && actual !== sidecar.digest) {
      throw new Error(
        `checkpoint digest mismatch for "${sidecar.name}" (${base}): ` +
          `expected ${sidecar.digest}, got ${actual} — snapshot is corrupt or tampered`,
      );
    }
    return idx;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    while (this.capacity < needed) this.capacity *= 2;
    this.index.resizeIndex(this.capacity);
  }
}
