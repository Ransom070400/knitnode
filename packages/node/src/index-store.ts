// hnswlib-node is a native CommonJS addon; Node's ESM loader can't statically
// detect its named exports, so import the default and destructure at runtime.
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;
type HierarchicalNSW = InstanceType<typeof HierarchicalNSW>;
import type { Metric, SearchHit, VectorEntry } from '@knitnode/protocol';
import { HNSW_PARAMS } from './config.js';

const INITIAL_CAPACITY = 1024;

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
  private labelToId: string[] = [];
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
      if (id === undefined) continue;
      hits.push({
        id,
        distance: distances[i]!,
        metadata: this.metadata.get(id) ?? {},
      });
    }
    return hits;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    while (this.capacity < needed) this.capacity *= 2;
    this.index.resizeIndex(this.capacity);
  }
}
