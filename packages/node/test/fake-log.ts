import { StreamData, StreamDataBuilder } from '@0gfoundation/0g-storage-ts-sdk';
import {
  encodeEntry,
  encodeTombstone,
  entryKey,
  streamIdForCollection,
  type VectorEntry,
} from '@knitnode/protocol';
import type { LogSubmission, ReplaySource } from '../src/replay/source.js';

/**
 * A synthetic 0G log for tests: real `StreamData` blobs built with the SDK's own
 * encoder, served through the {@link ReplaySource} seam. Everything downstream —
 * tag filtering, ordering, access control, decoding, indexing — is production
 * code; only the chain is fake.
 */

export const MEMORIES = streamIdForCollection('memories');
export const OTHER = streamIdForCollection('other');

export const ALICE = '0x' + 'a1'.repeat(20);
export const MALLORY = '0x' + 'b2'.repeat(20);

interface FakeSubmission extends LogSubmission {
  block: number;
  data: Uint8Array;
}

export class FakeLog implements ReplaySource {
  private readonly subs: FakeSubmission[] = [];
  private headFloor = 0;
  /** txSeqs whose bytes were actually fetched, in fetch order. */
  readonly fetched: number[] = [];

  /** A submission of KV writes to one stream. */
  writes(o: {
    txSeq: number;
    block: number;
    sender: string;
    streamId?: string;
    values: { key: Uint8Array; value: Uint8Array }[];
  }): this {
    const streamId = o.streamId ?? MEMORIES;
    const b = new StreamDataBuilder(1);
    for (const v of o.values) b.set(streamId, v.key, v.value);
    return this.push(o.txSeq, o.block, o.sender, [streamId], b.build().encode());
  }

  /** A submission carrying access-control ops rather than writes. */
  controls(o: {
    txSeq: number;
    block: number;
    sender: string;
    ops: { Type: number; StreamId: string; Account?: string; Key?: Uint8Array }[];
  }): this {
    const sd = new StreamData(1);
    sd.Reads = [];
    sd.Writes = [];
    sd.Controls = o.ops;
    return this.push(o.txSeq, o.block, o.sender, [MEMORIES], sd.encode());
  }

  /**
   * Move the chain head forward without adding anything to replay — blocks
   * were produced, none of them ours.
   */
  advanceTo(block: number): this {
    this.headFloor = Math.max(this.headFloor, block);
    return this;
  }

  private push(
    txSeq: number,
    block: number,
    sender: string,
    streamIds: string[],
    data: Uint8Array,
  ): this {
    this.subs.push({
      txSeq,
      block,
      sender: sender.toLowerCase(),
      streamIds: streamIds.map((s) => s.toLowerCase()),
      data,
    });
    return this;
  }

  async head(): Promise<number> {
    return this.subs.reduce((max, s) => Math.max(max, s.block), this.headFloor);
  }

  async *submissions(from: number, to: number): AsyncIterable<LogSubmission> {
    // Deliberately reversed: a source may hand back whatever order it finds,
    // and replay order must come from txSeq alone.
    for (const s of [...this.subs].reverse()) {
      if (s.block < from || s.block > to) continue;
      yield { txSeq: s.txSeq, sender: s.sender, streamIds: s.streamIds };
    }
  }

  async data(txSeq: number): Promise<Uint8Array> {
    const sub = this.subs.find((s) => s.txSeq === txSeq);
    if (!sub) throw new Error(`no submission ${txSeq}`);
    this.fetched.push(txSeq);
    return sub.data;
  }
}

export function entry(
  id: string,
  vector: number[],
  metadata: Record<string, unknown> = {},
): VectorEntry {
  const v = Float32Array.from(vector);
  return { id, dim: v.length, vector: v, metadata };
}

/** A KV write that stores an entry. */
export function put(e: VectorEntry) {
  return { key: entryKey(e.id), value: encodeEntry(e) };
}

/** A KV write that retires an id. */
export function drop(id: string) {
  return { key: entryKey(id), value: encodeTombstone(id) };
}
