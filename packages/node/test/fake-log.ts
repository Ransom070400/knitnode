import {
  encodeEntry,
  encodeTombstone,
  entryKey,
  streamIdForCollection,
  type VectorEntry,
} from '@knitnode/protocol';
import { MemorySource } from '../src/replay/memory.js';
import type { LogSubmission } from '../src/replay/source.js';

/**
 * Fixtures over {@link MemorySource}. The source itself ships in `src` because
 * it is useful outside tests — running the whole system without a funded key —
 * so there is one implementation of the synthetic log, not two.
 */

export const MEMORIES = streamIdForCollection('memories');
export const OTHER = streamIdForCollection('other');

export const ALICE = '0x' + 'a1'.repeat(20);
export const MALLORY = '0x' + 'b2'.repeat(20);

/** MemorySource with `streamId` defaulted to the `memories` collection. */
export class FakeLog extends MemorySource {
  override writes(o: {
    txSeq: number;
    block: number;
    sender: string;
    streamId?: string;
    values: { key: Uint8Array; value: Uint8Array }[];
  }): this {
    return super.writes({ ...o, streamId: o.streamId ?? MEMORIES });
  }

  override controls(o: {
    txSeq: number;
    block: number;
    sender: string;
    streamId?: string;
    ops: { Type: number; StreamId: string; Account?: string; Key?: Uint8Array }[];
  }): this {
    return super.controls({ ...o, streamId: o.streamId ?? MEMORIES });
  }
}

export type { LogSubmission };

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
