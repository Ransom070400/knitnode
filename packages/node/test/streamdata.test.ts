import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamDataBuilder, StreamData } from '@0gfoundation/0g-storage-ts-sdk';
import { streamIdForCollection, encodeEntry, entryKey } from '@knitnode/protocol';
import {
  decodeStreamData,
  decodeStreamTags,
  STREAM_DOMAIN,
} from '../src/replay/streamdata.js';

/**
 * The load-bearing test: `decodeStreamData` is a hand-written inverse of the
 * SDK's `StreamData.encode()` (the SDK ships no decoder). We assert byte-for-byte
 * agreement by building real StreamData with the SDK, encoding it, and decoding
 * it back — if the SDK ever changes its wire layout, this breaks loudly here
 * instead of silently corrupting replayed indexes on testnet.
 */

const STREAM_A = streamIdForCollection('alpha');
const STREAM_B = streamIdForCollection('beta');

function build(writes: { streamId: string; key: Uint8Array; data: Uint8Array }[]) {
  const b = new StreamDataBuilder(1);
  for (const w of writes) b.set(w.streamId, w.key, w.data);
  return b;
}

test('decodeStreamData round-trips a single write', () => {
  const key = entryKey('cat');
  const data = encodeEntry({
    id: 'cat',
    dim: 3,
    vector: Float32Array.from([1, 0, 0]),
    metadata: { kind: 'animal' },
  });
  const encoded = build([{ streamId: STREAM_A, key, data }]).build().encode();

  const { version, writes } = decodeStreamData(encoded);
  assert.equal(version, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.streamId.toLowerCase(), STREAM_A.toLowerCase());
  assert.deepEqual(Array.from(writes[0]!.key), Array.from(key));
  assert.deepEqual(Array.from(writes[0]!.data), Array.from(data));
});

test('decodeStreamData round-trips multiple writes across streams', () => {
  const items = [
    { streamId: STREAM_A, key: entryKey('a1'), data: Uint8Array.from([1, 2, 3]) },
    { streamId: STREAM_A, key: entryKey('a2'), data: Uint8Array.from([4, 5]) },
    { streamId: STREAM_B, key: entryKey('b1'), data: Uint8Array.from([6, 7, 8, 9]) },
  ];
  const encoded = build(items).build().encode();
  const { writes } = decodeStreamData(encoded);

  // The builder groups by streamId; assert every original write survives with
  // its payload intact regardless of emitted order.
  assert.equal(writes.length, items.length);
  for (const it of items) {
    const match = writes.find(
      (w) =>
        w.streamId.toLowerCase() === it.streamId.toLowerCase() &&
        Buffer.from(w.key).equals(Buffer.from(it.key)),
    );
    assert.ok(match, `missing write for key ${Buffer.from(it.key)}`);
    assert.deepEqual(Array.from(match!.data), Array.from(it.data));
  }
});

test('decodeStreamTags recovers the tagged stream ids', () => {
  const tags = build([
    { streamId: STREAM_A, key: entryKey('x'), data: Uint8Array.from([0]) },
    { streamId: STREAM_B, key: entryKey('y'), data: Uint8Array.from([0]) },
  ]).buildTags();

  const ids = decodeStreamTags(tags).map((s) => s.toLowerCase());
  assert.ok(ids.includes(STREAM_A.toLowerCase()));
  assert.ok(ids.includes(STREAM_B.toLowerCase()));
});

test('decodeStreamTags rejects a blob with the wrong domain', () => {
  const bad = new Uint8Array(64); // right length, all-zero domain
  assert.deepEqual(decodeStreamTags(bad), []);
  assert.deepEqual(decodeStreamTags(new Uint8Array(0)), []);
  assert.deepEqual(decodeStreamTags(new Uint8Array(33)), []); // not a multiple of 32
});

test('decodeStreamData round-trips access-control ops against the SDK encoder', () => {
  const ACC = '0x' + 'ab'.repeat(20);
  const KEY = Uint8Array.from([1, 2, 3]);
  const sd = new StreamData(1);
  sd.Reads = [];
  sd.Writes = [];
  sd.Controls = [
    { Type: 0x20, StreamId: STREAM_A, Account: ACC }, // GrantWriteRole (account)
    { Type: 0x10, StreamId: STREAM_A, Key: KEY }, // SetKeyToSpecial (key)
    { Type: 0x30, StreamId: STREAM_B, Key: KEY, Account: ACC }, // GrantSpecialWriteRole (key+account)
    { Type: 0x22, StreamId: STREAM_A }, // RenounceWriteRole (neither)
  ];

  const { writes, controls } = decodeStreamData(sd.encode());
  assert.equal(writes.length, 0);
  assert.equal(controls.length, 4);

  assert.equal(controls[0]!.type, 0x20);
  assert.equal(controls[0]!.account, ACC);
  assert.equal(controls[0]!.key, undefined);

  assert.equal(controls[1]!.type, 0x10);
  assert.deepEqual(controls[1]!.key && Array.from(controls[1]!.key), [1, 2, 3]);
  assert.equal(controls[1]!.account, undefined);

  assert.equal(controls[2]!.type, 0x30);
  assert.equal(controls[2]!.account, ACC);
  assert.deepEqual(controls[2]!.key && Array.from(controls[2]!.key), [1, 2, 3]);

  assert.equal(controls[3]!.type, 0x22);
  assert.equal(controls[3]!.key, undefined);
  assert.equal(controls[3]!.account, undefined);
});

test('STREAM_DOMAIN matches the SDK tag prefix', () => {
  const tags = build([
    { streamId: STREAM_A, key: entryKey('x'), data: Uint8Array.from([0]) },
  ]).buildTags();
  assert.deepEqual(Array.from(tags.subarray(0, 32)), Array.from(STREAM_DOMAIN));
});
