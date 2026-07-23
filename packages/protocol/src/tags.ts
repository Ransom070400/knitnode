import { keccak_256 } from '@noble/hashes/sha3';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

/**
 * Wire-format namespace. Bumping this (v1 -> v2) lets the entry encoding and
 * tag scheme evolve without ambiguity: a replaying node keys everything off the
 * version prefix, so old and new streams never collide.
 */
export const TAG_NAMESPACE = 'knitnode';
export const TAG_VERSION = 'v1';

/**
 * Human-readable tag for a collection, e.g. `knitnode:v1:memories`.
 *
 * This is the logical name. On 0G it is projected to a 32-byte `streamId` via
 * {@link streamIdForCollection}; that hash is what actually tags transactions
 * on the Log Layer and what a KV node subscribes to.
 */
export function collectionTag(collection: string): string {
  if (!collection) throw new Error('collection name must be non-empty');
  if (collection.includes(':')) {
    throw new Error(`collection name must not contain ':' (got "${collection}")`);
  }
  return `${TAG_NAMESPACE}:${TAG_VERSION}:${collection}`;
}

/** Parse a tag string back into its parts, or return null if it isn't ours. */
export function parseCollectionTag(
  tag: string,
): { namespace: string; version: string; collection: string } | null {
  const parts = tag.split(':');
  if (parts.length !== 3) return null;
  const [namespace, version, collection] = parts as [string, string, string];
  if (namespace !== TAG_NAMESPACE) return null;
  return { namespace, version, collection };
}

/**
 * Deterministic 0G stream id for a collection: `keccak256(collectionTag)`,
 * as a 0x-prefixed 32-byte hex string. Any node, given the same collection
 * name, derives the same stream id — so writers and replayers agree without
 * coordination.
 */
export function streamIdForCollection(collection: string): string {
  const tag = collectionTag(collection);
  return '0x' + bytesToHex(keccak_256(utf8ToBytes(tag)));
}
