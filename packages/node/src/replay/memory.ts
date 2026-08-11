import { StreamData, StreamDataBuilder } from '@0gfoundation/0g-storage-ts-sdk';
import {
  encodeEntry,
  encodeTombstone,
  entryKey,
  streamIdForCollection,
  DEFAULT_METRIC,
  type Metric,
  type VectorEntry,
} from '@knitnode/protocol';
import type { LogSubmission, ReplaySource } from './source.js';

/**
 * A synthetic log held in memory: the same {@link ReplaySource} contract 0G
 * satisfies, backed by an array you append to.
 *
 * The blobs are real — built with the SDK's own `StreamData` encoder — so
 * everything downstream of the source is the production path: tag filtering,
 * submission ordering, access control, decoding, indexing. Only the chain is
 * absent. That makes it the basis for tests and for running the whole system
 * without a funded key.
 */
export class MemorySource implements ReplaySource {
  private readonly subs: (LogSubmission & { block: number; data: Uint8Array })[] = [];
  private headFloor = 0;
  /** txSeqs whose bytes were actually fetched, in fetch order. Introspection. */
  readonly fetched: number[] = [];

  /**
   * Append a submission for a collection, encoding entries and deletes the way
   * {@link publishEntries} would. The stream id is derived from the collection
   * name and metric, so it lands where a node watching that collection looks.
   */
  publish(o: {
    txSeq: number;
    block: number;
    sender: string;
    collection: string;
    metric?: Metric;
    entries?: VectorEntry[];
    deletes?: string[];
  }): this {
    const values = [
      ...(o.entries ?? []).map((e) => ({ key: entryKey(e.id), value: encodeEntry(e) })),
      ...(o.deletes ?? []).map((id) => ({ key: entryKey(id), value: encodeTombstone(id) })),
    ];
    return this.writes({
      ...o,
      streamId: streamIdForCollection(o.collection, o.metric ?? DEFAULT_METRIC),
      values,
    });
  }

  /** Append a submission of raw KV writes to one stream. */
  writes(o: {
    txSeq: number;
    block: number;
    sender: string;
    streamId: string;
    values: { key: Uint8Array; value: Uint8Array }[];
  }): this {
    const b = new StreamDataBuilder(1);
    for (const v of o.values) b.set(o.streamId, v.key, v.value);
    return this.push(o.txSeq, o.block, o.sender, [o.streamId], b.build().encode());
  }

  /** Append a submission carrying access-control ops rather than writes. */
  controls(o: {
    txSeq: number;
    block: number;
    sender: string;
    streamId: string;
    ops: { Type: number; StreamId: string; Account?: string; Key?: Uint8Array }[];
  }): this {
    const sd = new StreamData(1);
    sd.Reads = [];
    sd.Writes = [];
    sd.Controls = o.ops;
    return this.push(o.txSeq, o.block, o.sender, [o.streamId], sd.encode());
  }

  /**
   * Move the head forward without adding anything to replay — blocks were
   * produced, none of them ours.
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
    // Deliberately reversed. A real source hands back whatever order it finds
    // them in, and replay order must come from txSeq alone — yielding in the
    // convenient order would let an ordering bug pass unnoticed.
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
