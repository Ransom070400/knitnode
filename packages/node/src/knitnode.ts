import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeEntry, streamIdForCollection, type Metric, type SearchHit } from '@knitnode/protocol';
import { CollectionIndex } from './index-store.js';
import { ReplayEngine, type ReplayWrite } from './replay/engine.js';
import { DEFAULT_START_BLOCK, GALILEO_TESTNET, type NetworkConfig } from './config.js';

/** On-disk record tying a saved cursor to the collection snapshots beside it. */
interface CheckpointManifest {
  version: number;
  /** Next Flow block to scan — replay resumes here instead of from genesis. */
  nextBlock: number;
  collections: { name: string; base: string }[];
}

const MANIFEST_FILE = 'manifest.json';

export interface KnitNodeOpts {
  network?: NetworkConfig;
  /** Collections to watch. Their stream ids are derived and subscribed to. */
  collections: string[];
  /** Distance metric for every collection's index. Fixed for determinism. */
  metric?: Metric;
  startBlock?: number;
  /**
   * Directory for persisted state. When set, a cold start resumes from the
   * saved cursor + index snapshots instead of replaying from `startBlock`, and
   * `sync`/`watch` re-save after catching up. Omit for pure in-memory replay.
   */
  checkpointDir?: string;
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
  private readonly onLog?: (msg: string) => void;
  private readonly collections = new Map<string, CollectionIndex>();
  /** streamId -> collection name, for routing replayed writes. */
  private readonly streamToCollection = new Map<string, string>();
  private readonly engine: ReplayEngine;
  private applied = 0;

  constructor(opts: KnitNodeOpts) {
    this.network = opts.network ?? GALILEO_TESTNET;
    this.metric = opts.metric ?? 'cosine';
    this.checkpointDir = opts.checkpointDir;
    this.onLog = opts.onLog;

    for (const name of opts.collections) {
      const streamId = streamIdForCollection(name).toLowerCase();
      this.streamToCollection.set(streamId, name);
    }

    // Restore snapshots first; a resumed cursor overrides the configured start.
    const resumeBlock = this.loadCheckpoint();

    this.engine = new ReplayEngine({
      network: this.network,
      watchedStreamIds: this.streamToCollection.keys(),
      startBlock: resumeBlock ?? opts.startBlock ?? DEFAULT_START_BLOCK,
      onLog: this.onLog,
    });
  }

  /** Catch up to chain head, replaying all pending writes into the indexes. */
  async sync(): Promise<void> {
    await this.engine.catchUp((w) => this.apply(w));
    this.log(`sync complete — ${this.applied} entries across ${this.collections.size} collection(s)`);
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
   */
  saveCheckpoint(): void {
    if (!this.checkpointDir) return;
    mkdirSync(this.checkpointDir, { recursive: true });

    const collections: { name: string; base: string }[] = [];
    let i = 0;
    for (const [name, index] of this.collections) {
      const base = `col-${i++}`;
      index.saveTo(this.checkpointDir, base);
      collections.push({ name, base });
    }

    const manifest: CheckpointManifest = {
      version: 1,
      nextBlock: this.engine.nextBlock,
      collections,
    };
    writeFileSync(
      join(this.checkpointDir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
    );
    this.log(`checkpoint saved — block ${manifest.nextBlock}, ${collections.length} collection(s)`);
  }

  /**
   * Restore snapshots for watched collections from `checkpointDir`. Returns the
   * saved next-block so replay resumes there, or undefined if there's no
   * checkpoint (cold start). Called from the constructor, before the engine.
   */
  private loadCheckpoint(): number | undefined {
    if (!this.checkpointDir) return undefined;
    const manifestPath = join(this.checkpointDir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) return undefined;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointManifest;
    const watched = new Set(this.streamToCollection.values());
    for (const entry of manifest.collections) {
      if (!watched.has(entry.name)) continue; // not one we're watching now
      const index = CollectionIndex.loadFrom(this.checkpointDir, entry.base);
      this.collections.set(entry.name, index);
      this.applied += index.size;
    }
    this.log(
      `resumed from checkpoint — block ${manifest.nextBlock}, ${this.collections.size} collection(s), ${this.applied} entries`,
    );
    return manifest.nextBlock;
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
