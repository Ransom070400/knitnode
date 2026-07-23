import { decodeEntry, streamIdForCollection, type Metric, type SearchHit } from '@knitnode/protocol';
import { CollectionIndex } from './index-store.js';
import { ReplayEngine, type ReplayWrite } from './replay/engine.js';
import { DEFAULT_START_BLOCK, GALILEO_TESTNET, type NetworkConfig } from './config.js';

export interface KnitNodeOpts {
  network?: NetworkConfig;
  /** Collections to watch. Their stream ids are derived and subscribed to. */
  collections: string[];
  /** Distance metric for every collection's index. Fixed for determinism. */
  metric?: Metric;
  startBlock?: number;
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
  private readonly onLog?: (msg: string) => void;
  private readonly collections = new Map<string, CollectionIndex>();
  /** streamId -> collection name, for routing replayed writes. */
  private readonly streamToCollection = new Map<string, string>();
  private readonly engine: ReplayEngine;
  private applied = 0;

  constructor(opts: KnitNodeOpts) {
    this.network = opts.network ?? GALILEO_TESTNET;
    this.metric = opts.metric ?? 'cosine';
    this.onLog = opts.onLog;

    for (const name of opts.collections) {
      const streamId = streamIdForCollection(name).toLowerCase();
      this.streamToCollection.set(streamId, name);
    }

    this.engine = new ReplayEngine({
      network: this.network,
      watchedStreamIds: this.streamToCollection.keys(),
      startBlock: opts.startBlock ?? DEFAULT_START_BLOCK,
      onLog: this.onLog,
    });
  }

  /** Catch up to chain head, replaying all pending writes into the indexes. */
  async sync(): Promise<void> {
    await this.engine.catchUp((w) => this.apply(w));
    this.log(`sync complete — ${this.applied} entries across ${this.collections.size} collection(s)`);
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
    }
  }

  /** Apply one replayed write: decode the entry and upsert it into its index. */
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
    if (!index) {
      // First entry defines the collection's dimensionality.
      index = new CollectionIndex(collection, entry.dim, this.metric);
      this.collections.set(collection, index);
      this.log(`opened collection "${collection}" (dim ${entry.dim}, ${this.metric})`);
    }
    index.upsert(entry);
    this.applied++;
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}
