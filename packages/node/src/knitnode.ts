import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { AccessControlSet, type AccessControlState } from './replay/acl.js';
import { DEFAULT_START_BLOCK, GALILEO_TESTNET, type NetworkConfig } from './config.js';

/** On-disk record tying a saved cursor to the collection snapshots beside it. */
interface CheckpointManifest {
  version: number;
  /** Next Flow block to scan — replay resumes here instead of from genesis. */
  nextBlock: number;
  collections: { name: string; base: string; digest: string }[];
  /** Replayed access-control state, so a resumed node keeps enforcing correctly. */
  acl?: AccessControlState;
}

const MANIFEST_FILE = 'manifest.json';

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
      const streamId = streamIdForCollection(name, this.metric).toLowerCase();
      this.streamToCollection.set(streamId, name);
    }

    // Restore snapshots first; a resumed cursor + ACL override the fresh start.
    const restored = this.loadCheckpoint();

    this.engine = new ReplayEngine({
      network: this.network,
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
   */
  saveCheckpoint(): void {
    if (!this.checkpointDir) return;
    mkdirSync(this.checkpointDir, { recursive: true });

    const collections: { name: string; base: string; digest: string }[] = [];
    let i = 0;
    for (const [name, index] of this.collections) {
      const base = `col-${i++}`;
      const digest = index.saveTo(this.checkpointDir, base);
      collections.push({ name, base, digest });
    }

    const manifest: CheckpointManifest = {
      version: 1,
      nextBlock: this.engine.nextBlock,
      collections,
      acl: this.engine.accessControl.toState(),
    };
    writeFileSync(
      join(this.checkpointDir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
    );
    this.log(`checkpoint saved — block ${manifest.nextBlock}, ${collections.length} collection(s)`);
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
    const watched = new Set(this.streamToCollection.values());
    for (const entry of manifest.collections) {
      if (!watched.has(entry.name)) continue; // not one we're watching now
      const index = CollectionIndex.loadFrom(this.checkpointDir, entry.base);
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
    }
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
      if (index?.delete(entry.id)) this.applied++;
      return;
    }

    if (!index) {
      // First entry defines the collection's dimensionality.
      index = new CollectionIndex(collection, entry.dim, this.metric);
      this.collections.set(collection, index);
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
