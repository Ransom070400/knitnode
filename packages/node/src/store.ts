import { DEFAULT_METRIC, type Metric, type SearchHit, type VectorEntry } from '@knitnode/protocol';
import { KnitNode } from './knitnode.js';
import type { ReplaySource } from './replay/source.js';
import { publishDeletes, publishEntries, type PublishResult } from './writer.js';
import { DEFAULT_START_BLOCK, GALILEO_TESTNET, type NetworkConfig } from './config.js';

export interface KnitStoreOpts {
  /** The single collection this store reads from and writes to. */
  collection: string;
  network?: NetworkConfig;
  /**
   * Signing key for the write path (`add`/`upsert`). Omit for a read-only
   * store — search and sync work without it; only publishing needs a key.
   */
  privateKey?: string;
  /**
   * Distance metric for the index. Part of the collection tag, so it selects
   * which stream this store reads *and* writes. Default `cosine`.
   */
  metric?: Metric;
  /** First Flow block to scan on replay. Default from `KNIT_START_BLOCK` (0). */
  startBlock?: number;
  /** Directory for persisted index + cursor. Enables resume across restarts. */
  checkpointDir?: string;
  /** Enforce 0G stream access control on replay (default true). */
  enforceAcl?: boolean;
  /** Where replay reads the log from. Defaults to 0G. */
  source?: ReplaySource;
  onLog?: (msg: string) => void;
}

/**
 * `KnitStore` is the ergonomic, single-collection façade over KnitNode (Phase 2).
 *
 * Where {@link publishEntries} and {@link KnitNode} are the low-level split
 * halves of the protocol — one writes tagged KV to 0G, the other replays a
 * stream into an HNSW index — a store binds both to one collection so callers
 * get a familiar vector-store shape:
 *
 * ```ts
 * const store = new KnitStore({ collection: 'memories', privateKey: pk });
 * await store.add([{ id: 'a', dim: 3, vector: Float32Array.from([1,0,0]), metadata: {} }]);
 * await store.sync();                       // replay our own write back
 * store.search([1, 0, 0], 5);               // top-k
 * ```
 *
 * The write and read paths stay orthogonal: `add` publishes to the log and
 * returns once finalized; `sync`/`watch` pull the log back into the local
 * index. A store never assumes its own writes are locally visible until synced —
 * that round-trip through 0G is the whole point.
 */
export class KnitStore {
  readonly collection: string;
  /** Metric this store reads and writes under. Part of the collection tag. */
  readonly metric: Metric;
  private readonly network: NetworkConfig;
  private readonly privateKey?: string;
  private readonly node: KnitNode;

  constructor(opts: KnitStoreOpts) {
    this.collection = opts.collection;
    this.metric = opts.metric ?? DEFAULT_METRIC;
    this.network = opts.network ?? GALILEO_TESTNET;
    this.privateKey = opts.privateKey;
    this.node = new KnitNode({
      network: this.network,
      collections: [opts.collection],
      metric: this.metric,
      startBlock: opts.startBlock ?? DEFAULT_START_BLOCK,
      checkpointDir: opts.checkpointDir,
      enforceAcl: opts.enforceAcl,
      source: opts.source,
      onLog: opts.onLog,
    });
  }

  /** Publish entries to this collection's stream. Requires a `privateKey`. */
  async add(entries: VectorEntry[]): Promise<PublishResult> {
    if (!this.privateKey) {
      throw new Error(
        'KnitStore is read-only: construct with a `privateKey` to publish entries',
      );
    }
    return publishEntries(this.network, this.privateKey, this.collection, entries, this.metric);
  }

  /**
   * Convenience for publishing a single vector. `dim` is inferred from the
   * vector length. Writes to the same `id` overwrite on replay.
   */
  async upsert(
    id: string,
    vector: number[] | Float32Array,
    metadata: Record<string, unknown> = {},
  ): Promise<PublishResult> {
    const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    return this.add([{ id, dim: vec.length, vector: vec, metadata }]);
  }

  /**
   * Publish tombstones removing `ids` from the collection. Requires a
   * `privateKey`. Like `add`, this only touches the log — the ids disappear
   * from the local index on the next {@link sync}, not on return.
   */
  async delete(ids: string[] | string): Promise<PublishResult> {
    if (!this.privateKey) {
      throw new Error(
        'KnitStore is read-only: construct with a `privateKey` to delete entries',
      );
    }
    const list = typeof ids === 'string' ? [ids] : ids;
    return publishDeletes(this.network, this.privateKey, this.collection, list, this.metric);
  }

  /** Catch the local index up to chain head. */
  async sync(): Promise<void> {
    await this.node.sync();
  }

  /** Continuously replay new submissions until `signal` aborts. */
  async watch(intervalMs = 5000, signal?: AbortSignal): Promise<void> {
    await this.node.watch(intervalMs, signal);
  }

  /** Top-k nearest neighbours to `query` over the replayed index. */
  search(query: number[] | Float32Array, k = 10): SearchHit[] {
    return this.node.similaritySearch(this.collection, query, k);
  }

  /** Number of distinct ids currently in the local index (0 before first sync). */
  get size(): number {
    return this.node.stats().find((s) => s.collection === this.collection)?.size ?? 0;
  }

  /** Expose the underlying node for advanced use (RPC server, multi-collection). */
  get knitNode(): KnitNode {
    return this.node;
  }
}
