import { ethers } from 'ethers';
import {
  Batcher,
  Indexer,
  FixedPriceFlow__factory,
} from '@0gfoundation/0g-storage-ts-sdk';
import {
  encodeEntry,
  encodeTombstone,
  entryKey,
  streamIdForCollection,
  type VectorEntry,
} from '@knitnode/protocol';
import type { NetworkConfig } from './config.js';

/** StreamData structural version (distinct from the `knitnode:v1` tag version). */
export const STREAM_DATA_VERSION = 1;

export interface PublishResult {
  txHash: string;
  rootHash: string;
  streamId: string;
  count: number;
}

/**
 * Publish vector entries to a collection's stream on 0G Storage.
 *
 * Uses the SDK's `Batcher` directly: each entry becomes a KV write
 * (key = id bytes, value = binary entry) under the collection's derived stream
 * id, and the whole set is submitted as ONE tagged log entry. A KnitNode
 * watching that stream will replay these writes into its HNSW index.
 *
 * This is the Phase-1 write path; the ergonomic `KnitStore` wrapper is Phase 2.
 */
export async function publishEntries(
  network: NetworkConfig,
  privateKey: string,
  collection: string,
  entries: VectorEntry[],
): Promise<PublishResult> {
  if (entries.length === 0) throw new Error('no entries to publish');
  return publishValues(
    network,
    privateKey,
    collection,
    entries.map((e) => ({ key: entryKey(e.id), value: encodeEntry(e) })),
  );
}

/**
 * Publish tombstones: writes that remove `ids` from the collection on replay.
 *
 * A delete is an ordinary KV write whose *value* is a tombstone — 0G's
 * StreamData has no delete op, and inventing one out-of-band would break the
 * replay-is-the-only-state property. Using the same key as the entry it retires
 * also means access control treats a delete exactly like the write it undoes:
 * you cannot tombstone a key you were never allowed to write.
 */
export async function publishDeletes(
  network: NetworkConfig,
  privateKey: string,
  collection: string,
  ids: string[],
): Promise<PublishResult> {
  if (ids.length === 0) throw new Error('no ids to delete');
  return publishValues(
    network,
    privateKey,
    collection,
    ids.map((id) => ({ key: entryKey(id), value: encodeTombstone(id) })),
  );
}

/** Shared submit path: pack pre-encoded KV values into one tagged log entry. */
async function publishValues(
  network: NetworkConfig,
  privateKey: string,
  collection: string,
  values: { key: Uint8Array; value: Uint8Array }[],
): Promise<PublishResult> {
  const provider = new ethers.JsonRpcProvider(network.evmRpc);
  // ethers requires a 0x-prefixed key; tolerate a bare 64-char hex string.
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(normalizedKey, provider);
  // The 0G SDK bundles ethers' CommonJS build while we import the ESM build.
  // The two `ContractRunner`/`Wallet` types are structurally identical at
  // runtime (same package, same 6.13.1) but nominally distinct to TS, so we
  // cast across the ESM/CJS boundary here. See writer.ts dual-package note.
  const flow = FixedPriceFlow__factory.connect(
    network.flowContract,
    wallet as unknown as Parameters<typeof FixedPriceFlow__factory.connect>[1],
  );

  const indexer = new Indexer(network.indexerRpc);
  const [nodes, err] = await indexer.selectNodes(1);
  if (err || nodes.length === 0) {
    throw new Error(`failed to select storage nodes: ${err ?? 'none available'}`);
  }

  const streamId = streamIdForCollection(collection);
  const batcher = new Batcher(STREAM_DATA_VERSION, nodes, flow, network.evmRpc);
  for (const { key, value } of values) {
    batcher.streamDataBuilder.set(streamId, key, value);
  }

  const [res, execErr] = await batcher.exec({ finalityRequired: true });
  if (execErr) throw new Error(`batcher.exec failed: ${execErr}`);

  return {
    txHash: res.txHash,
    rootHash: res.rootHash,
    streamId,
    count: values.length,
  };
}
