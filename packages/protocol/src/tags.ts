import { keccak_256 } from '@noble/hashes/sha3';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import type { Metric } from './types.js';

/**
 * Wire-format namespace. Bumping this (v1 -> v2) lets the entry encoding and
 * tag scheme evolve without ambiguity: a replaying node keys everything off the
 * version prefix, so old and new streams never collide.
 *
 * v2 added the metric to the tag — see {@link collectionTag}. A v1 stream
 * declares no metric, so there is no correct way to replay one; they are simply
 * different streams under a different prefix.
 */
export const TAG_NAMESPACE = 'knitnode';
export const TAG_VERSION = 'v2';

/** The metrics a collection may declare. Mirrors hnswlib space names. */
const METRICS: readonly Metric[] = ['l2', 'ip', 'cosine'];

export const DEFAULT_METRIC: Metric = 'cosine';

/**
 * Human-readable tag for a collection, e.g. `knitnode:v2:cosine:memories`.
 *
 * The metric is part of the tag, not node-local config, because it is part of
 * the determinism contract: an index is only reproducible if every replayer
 * folds the log under the same distance function. Naming it here means two
 * nodes that disagree about the metric derive *different stream ids* and never
 * see each other's writes, instead of silently building divergent indexes over
 * the same data and answering different top-k for identical queries.
 *
 * This is the logical name. On 0G it is projected to a 32-byte `streamId` via
 * {@link streamIdForCollection}; that hash is what actually tags transactions
 * on the Log Layer and what a KV node subscribes to.
 */
export function collectionTag(collection: string, metric: Metric = DEFAULT_METRIC): string {
  if (!collection) throw new Error('collection name must be non-empty');
  if (collection.includes(':')) {
    throw new Error(`collection name must not contain ':' (got "${collection}")`);
  }
  if (!METRICS.includes(metric)) {
    throw new Error(`unknown metric "${metric}" (expected ${METRICS.join(' | ')})`);
  }
  return `${TAG_NAMESPACE}:${TAG_VERSION}:${metric}:${collection}`;
}

/** Parse a tag string back into its parts, or return null if it isn't ours. */
export function parseCollectionTag(
  tag: string,
): { namespace: string; version: string; metric: Metric; collection: string } | null {
  const parts = tag.split(':');
  if (parts.length !== 4) return null;
  const [namespace, version, metric, collection] = parts as [string, string, string, string];
  if (namespace !== TAG_NAMESPACE) return null;
  if (!METRICS.includes(metric as Metric)) return null;
  return { namespace, version, metric: metric as Metric, collection };
}

/**
 * Deterministic 0G stream id for a collection: `keccak256(collectionTag)`,
 * as a 0x-prefixed 32-byte hex string. Any node, given the same collection
 * name and metric, derives the same stream id — so writers and replayers agree
 * without coordination.
 */
export function streamIdForCollection(
  collection: string,
  metric: Metric = DEFAULT_METRIC,
): string {
  const tag = collectionTag(collection, metric);
  return '0x' + bytesToHex(keccak_256(utf8ToBytes(tag)));
}
