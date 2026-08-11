import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  decodeEntry,
  isTombstone,
  streamIdForCollection,
  type Metric,
  type SearchHit,
} from '@knitnode/protocol';
import { CollectionIndex } from './index-store.js';
import { ReplayEngine, type ReplayWrite } from './replay/engine.js';
import { ZeroGSource } from './replay/zerog.js';
import type { ReplaySource } from './replay/source.js';
import { AccessControlSet } from './replay/acl.js';
import {
  signManifest,
  verifyManifest,
  type CheckpointEntry,
  type CheckpointManifest,
} from './manifest.js';
import { DEFAULT_START_BLOCK, GALILEO_TESTNET, type NetworkConfig } from './config.js';

const MANIFEST_FILE = 'manifest.json';
/** Bumped when the on-disk layout changes; older checkpoints are discarded. */
const MANIFEST_VERSION = 2;
const GENERATION_PREFIX = 'gen-';

export interface KnitNodeOpts {
  network?: NetworkConfig;
  /** Collections to watch. Their stream ids are derived and subscribed to. */
  collections: string[];
  /**
   * Distance metric for every collection's index. Part of the collection tag,
   * so it selects *which stream* each name resolves to — a node watching
   * `memories` under `l2` and one watching it under `cosine` are reading two
   * different streams, not disagreeing about one. Default `cosine`.
   */
  metric?: Metric;
  startBlock?: number;
  /**
   * Directory for persisted state. When set, a cold start resumes from the
   * saved cursor + index snapshots instead of replaying from `startBlock`, and
   * `sync`/`watch` re-save after catching up. Omit for pure in-memory replay.
   */
  checkpointDir?: string;
  /**
   * Enforce 0G stream access control on replay (default true): only writes from
   * an authorized sender are indexed. Set false to index every write blindly.
   */
  enforceAcl?: boolean;
  /**
   * Where replay reads the log from. Defaults to 0G via {@link ZeroGSource};
   * substitute one to replay a synthetic log without a chain.
   */
  source?: ReplaySource;
  /**
   * Private key used to sign checkpoint manifests. A signed checkpoint is
   * attributable: whoever loads it can tell which key produced it, rather than
   * only that the files agree with themselves. Omit to write unsigned ones.
   */
  signingKey?: string;
  /**
   * Addresses whose checkpoints this node will load. Set it and an unsigned or
   * differently-signed checkpoint is refused — the point of naming trusted
   * signers is lost if anything unsigned still loads. Leave it unset to accept
   * unsigned checkpoints (a broken signature is refused either way).
   */
  trustedSigners?: string[];
  onLog?: (msg: string) => void;
}

/**
 * The KnitNode service. Structurally a 0G KV node — it subscribes to tagged
 * streams and replays their writes — but it rebuilds an HNSW vector index per
 * collection instead of a KV map, and answers similarity search instead of
 * point lookups.
 *
 * Replay-first: state lives only in the indexes built from the log. A cold
 * start re-derives everything from height 0 (Phase 1; snapshots come later).
 */
export class KnitNode {
  private readonly network: NetworkConfig;
  private readonly metric: Metric;
  private readonly checkpointDir?: string;
  private readonly signingKey?: string;
  private readonly trustedSigners?: string[];
  private readonly onLog?: (msg: string) => void;
  private readonly collections = new Map<string, CollectionIndex>();
  /** streamId -> collection name, for routing replayed writes. */
  private readonly streamToCollection = new Map<string, string>();
  private readonly engine: ReplayEngine;
  private applied = 0;
  /** The checkpoint currently on disk: its generation and the snapshots it names. */
  private committed?: { generation: number; collections: CheckpointEntry[] };
  /**
   * Whether any index has been mutated since the committed generation was
   * written. Set by {@link apply}, which is the only thing that touches an
   * index — including when it merely *opens* a collection, since an empty
   * collection still has to appear in the generation the manifest names.
   */
  private indexesDirty = false;

  constructor(opts: KnitNodeOpts) {
    this.network = opts.network ?? GALILEO_TESTNET;
    this.metric = opts.metric ?? 'cosine';
    this.checkpointDir = opts.checkpointDir;
    this.signingKey = opts.signingKey;
    this.trustedSigners = opts.trustedSigners;
    this.onLog = opts.onLog;

    for (const name of opts.collections) {
      const streamId = streamIdForCollection(name, this.metric).toLowerCase();
      this.streamToCollection.set(streamId, name);
    }

    // Restore snapshots first; a resumed cursor + ACL override the fresh start.
    const restored = this.loadCheckpoint();

    this.engine = new ReplayEngine({
      source: opts.source ?? new ZeroGSource({ network: this.network, onLog: this.onLog }),
      watchedStreamIds: this.streamToCollection.keys(),
      startBlock: restored?.nextBlock ?? opts.startBlock ?? DEFAULT_START_BLOCK,
      enforceAcl: opts.enforceAcl,
      initialAcl: restored?.acl,
      onLog: this.onLog,
    });
  }

  /** Catch up to chain head, replaying all pending writes into the indexes. */
  async sync(): Promise<void> {
    await this.engine.catchUp((w) => this.apply(w));
    // `applied` counts writes folded in; deletes mean that is not the same as
    // the number of entries currently indexed, so report both.
    const live = [...this.collections.values()].reduce((n, c) => n + c.size, 0);
    this.log(
      `sync complete — ${this.applied} write(s) applied, ${live} entries across ${this.collections.size} collection(s)`,
    );
    this.saveCheckpoint();
  }

  /**
   * Continuously replay: catch up, then poll for new submissions every
   * `intervalMs`. Runs until `signal` aborts. This is the "subscribe" behaviour.
   */
  async watch(intervalMs: number, signal?: AbortSignal): Promise<void> {
    await this.sync();
    while (!signal?.aborted) {
      await delay(intervalMs, signal);
      if (signal?.aborted) break;
      await this.engine.catchUp((w) => this.apply(w));
      this.saveCheckpoint();
    }
  }

  /**
   * Persist the replay cursor and every collection's index under
   * `checkpointDir`. No-op if checkpointing is disabled. Called automatically
   * after each catch-up; safe to call manually before shutdown.
   *
   * A checkpoint is a set of files that only mean anything together — a cursor,
   * an ACL, and one snapshot pair per collection — so saving them one at a time
   * leaves windows where the directory describes a state that never existed. A
   * crash between the snapshots and the manifest used to leave new indexes
   * beside an old cursor and an old ACL: silently inconsistent, and it survived
   * restarts because nothing on disk looked wrong.
   *
   * So each save writes its snapshots into a *fresh* generation directory that
   * nothing references yet, then swaps the manifest in with `rename`. Until
   * that rename lands the new files are invisible and the previous checkpoint
   * is still intact and still current; after it lands the whole new checkpoint
   * is live at once. A half-written snapshot can therefore never be loaded, so
   * the individual snapshot writes need no atomicity of their own.
   *
   * A poll that replayed nothing still has to persist its advanced cursor, but
   * has no reason to rewrite megabytes of unchanged HNSW graph to do it. When
   * the indexes are untouched the generation on disk still describes them
   * exactly, so the save reuses it and rewrites only the manifest — the cursor
   * and ACL live there anyway. Idle nodes then cost one small atomic write per
   * poll instead of a full snapshot dump.
   */
  saveCheckpoint(): void {
    if (!this.checkpointDir) return;
    const dir = this.checkpointDir;
    mkdirSync(dir, { recursive: true });

    const reused = this.reusableGeneration();
    const generation = reused?.generation ?? (this.committed?.generation ?? 0) + 1;
    const collections = reused?.collections ?? this.writeGeneration(dir, generation);

    let manifest: CheckpointManifest = {
      version: MANIFEST_VERSION,
      generation,
      nextBlock: this.engine.nextBlock,
      collections,
      acl: this.engine.accessControl.toState(),
    };
    // Sign last: the signature covers every other field, including the digests
    // that bind the snapshots just written.
    if (this.signingKey) manifest = signManifest(manifest, this.signingKey);
    // The commit point.
    writeFileAtomic(dir, MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    this.committed = { generation, collections };
    this.indexesDirty = false;

    if (reused) {
      this.log(`cursor saved — block ${manifest.nextBlock} (generation ${generation} unchanged)`);
      return;
    }
    this.pruneGenerations(dir, generation);
    this.log(`checkpoint saved — block ${manifest.nextBlock}, ${collections.length} collection(s)`);
  }

  /**
   * The committed generation, if it still describes the live indexes and can be
   * reused as-is. Requires both that nothing mutated an index and that the
   * committed snapshots line up one-for-one with the collections now open —
   * the second check is what keeps a manifest from ever naming a snapshot that
   * was never written, however the first one might be wrong.
   */
  private reusableGeneration():
    | { generation: number; collections: CheckpointEntry[] }
    | undefined {
    if (this.indexesDirty || !this.committed) return undefined;
    const { collections } = this.committed;
    if (collections.length !== this.collections.size) return undefined;
    let i = 0;
    for (const name of this.collections.keys()) {
      if (collections[i++]!.name !== name) return undefined;
    }
    return this.committed;
  }

  /** Dump every open collection into a fresh `gen-<n>` directory. */
  private writeGeneration(dir: string, generation: number): CheckpointEntry[] {
    const genDir = join(dir, `${GENERATION_PREFIX}${generation}`);
    // Clear anything an earlier aborted save left at this generation: it is
    // unreferenced by definition, since the manifest still names the last one.
    rmSync(genDir, { recursive: true, force: true });
    mkdirSync(genDir, { recursive: true });

    const collections: CheckpointEntry[] = [];
    let i = 0;
    for (const [name, index] of this.collections) {
      const base = `col-${i++}`;
      collections.push({ name, base, digest: index.saveTo(genDir, base) });
    }
    return collections;
  }

  /**
   * Delete generation directories the committed manifest no longer names. Best
   * effort: the checkpoint is already durable, so a failure here costs disk
   * space, not correctness.
   */
  private pruneGenerations(dir: string, keep: number): void {
    const current = `${GENERATION_PREFIX}${keep}`;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(GENERATION_PREFIX) || name === current) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    } catch (err) {
      this.log(`could not prune old checkpoint generations: ${err}`);
    }
  }

  /**
   * Restore snapshots + ACL for watched collections from `checkpointDir`.
   * Returns the saved next-block and access-control state so replay resumes
   * exactly, or undefined for a cold start. Called from the constructor, before
   * the engine is built.
   */
  private loadCheckpoint(): { nextBlock: number; acl?: AccessControlSet } | undefined {
    if (!this.checkpointDir) return undefined;
    const manifestPath = join(this.checkpointDir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) return undefined;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointManifest;
    if (manifest.version !== MANIFEST_VERSION) {
      // An older layout describes streams this build can no longer derive, so
      // there is nothing to salvage. Cold start is slow but correct.
      this.log(
        `ignoring checkpoint in format version ${manifest.version} (expected ${MANIFEST_VERSION}) — starting cold`,
      );
      return undefined;
    }

    // Before anything is read off disk: establish who produced this. A
    // signature covers the digests below, so verifying it here means the
    // snapshot checks that follow are checks against an attributable claim
    // rather than against whatever the file happens to say about itself.
    const signer = verifyManifest(manifest, { trustedSigners: this.trustedSigners });
    if (signer) this.log(`checkpoint signed by ${signer}`);
    else if (this.checkpointDir) this.log('checkpoint is unsigned — integrity only, not attributable');

    const genDir = join(this.checkpointDir, `${GENERATION_PREFIX}${manifest.generation}`);
    const watched = new Set(this.streamToCollection.values());
    const loaded: CheckpointEntry[] = [];
    for (const entry of manifest.collections) {
      if (!watched.has(entry.name)) continue; // not one we're watching now
      const index = CollectionIndex.loadFrom(genDir, entry.base, entry.digest);
      // The manifest keys on collection name alone, but the metric is part of
      // the tag — so a same-named snapshot built under a different metric came
      // from a different stream entirely. Refuse it loudly rather than resume
      // onto state this node could never have replayed.
      if (index.metric !== this.metric) {
        throw new Error(
          `checkpoint for "${entry.name}" was built under metric "${index.metric}", ` +
            `but this node is configured for "${this.metric}" — these are different ` +
            `collections; use a separate checkpointDir`,
        );
      }
      this.collections.set(entry.name, index);
      this.applied += index.size;
      loaded.push(entry);
    }
    // Record what's on disk, so the next save either reuses this generation or
    // counts past it — never overwrites the one we just loaded. `loaded` rather
    // than `manifest.collections` because snapshots we skipped are not ours to
    // keep vouching for.
    this.committed = { generation: manifest.generation, collections: loaded };
    this.log(
      `resumed from checkpoint — block ${manifest.nextBlock}, ${this.collections.size} collection(s), ${this.applied} entries`,
    );
    return {
      nextBlock: manifest.nextBlock,
      acl: manifest.acl ? AccessControlSet.fromState(manifest.acl) : undefined,
    };
  }

  /**
   * Apply one replayed write: decode the value and fold it into the collection's
   * index — an upsert for a vector entry, a removal for a tombstone.
   *
   * A malformed or unindexable value is skipped rather than thrown, and that
   * matters for more than tidiness: `apply` runs inside `catchUp`, so a throw
   * would abort the scan before the cursor advances, and every restart would
   * re-read the same bad write and die again — one bad value would brick the
   * node permanently. Skipping is still deterministic, because whether a value
   * is skipped depends only on its bytes and on replay-derived state.
   */
  private apply(write: ReplayWrite): void {
    const collection = this.streamToCollection.get(write.streamId.toLowerCase());
    if (!collection) return; // not one of ours (shouldn't happen — engine filters)

    let entry;
    try {
      entry = decodeEntry(write.data);
    } catch (err) {
      this.log(`skipping undecodable entry in "${collection}" @${write.logHeight}: ${err}`);
      return;
    }

    let index = this.collections.get(collection);

    if (isTombstone(entry)) {
      // A tombstone for a collection or id we've never seen is a no-op: the
      // delete simply has nothing to undo.
      if (index?.delete(entry.id)) {
        this.applied++;
        this.indexesDirty = true;
      }
      return;
    }

    if (!index) {
      // First entry defines the collection's dimensionality.
      index = new CollectionIndex(collection, entry.dim, this.metric);
      this.collections.set(collection, index);
      // Opening a collection is itself a change worth checkpointing: the next
      // save must produce a generation that contains it, even if the upsert
      // below turns out to be unindexable and leaves it empty.
      this.indexesDirty = true;
      this.log(`opened collection "${collection}" (dim ${entry.dim}, ${this.metric})`);
    }

    try {
      index.upsert(entry);
    } catch (err) {
      // Reachable from any authorized writer, e.g. a wrong-dimension vector.
      this.log(`skipping unindexable entry "${entry.id}" in "${collection}" @${write.logHeight}: ${err}`);
      return;
    }
    this.applied++;
    this.indexesDirty = true;
  }

  /** Top-k similarity search within a collection. */
  similaritySearch(collection: string, queryVector: number[] | Float32Array, k: number): SearchHit[] {
    const index = this.collections.get(collection);
    if (!index) {
      throw new Error(`unknown or empty collection "${collection}"`);
    }
    return index.search(queryVector, k);
  }

  /** Introspection for the RPC `collections` method. */
  stats(): { collection: string; dim: number; size: number; metric: Metric }[] {
    return [...this.collections.values()].map((c) => ({
      collection: c.name,
      dim: c.dim,
      size: c.size,
      metric: c.metric,
    }));
  }

  private log(msg: string): void {
    this.onLog?.(msg);
  }
}

/**
 * Replace `dir/name` with `contents` in one step: write a sibling temp file,
 * flush it to disk, then `rename` it over the target. Rename within a directory
 * is atomic, so a reader sees either the whole old file or the whole new one,
 * never a partial write — and the `fsync` before it means the bytes are really
 * on disk before they become reachable under the real name.
 */
function writeFileAtomic(dir: string, name: string, contents: string): void {
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  syncDirectory(dir);
}

/**
 * Flush a directory entry so the rename itself survives power loss. Best
 * effort: fsync on a directory is not portable (Windows rejects it), and
 * without it the rename is still atomic, just not guaranteed durable.
 */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Unsupported on this platform or filesystem — nothing to do about it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}
