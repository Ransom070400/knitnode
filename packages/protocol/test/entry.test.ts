import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeEntry,
  encodeTombstone,
  decodeEntry,
  isTombstone,
  entryKey,
  collectionTag,
  parseCollectionTag,
  streamIdForCollection,
  ENTRY_FLAG_TOMBSTONE,
  type VectorEntry,
} from '../src/index.js';

/** Narrow a decoded value to a vector entry, failing the test if it's a tombstone. */
function asEntry(input: Uint8Array) {
  const decoded = decodeEntry(input);
  assert.equal(isTombstone(decoded), false, 'expected a vector entry, got a tombstone');
  return decoded as VectorEntry;
}

test('encodeEntry/decodeEntry round-trips a full entry', () => {
  const entry: VectorEntry = {
    id: 'cat',
    dim: 4,
    vector: Float32Array.from([1, 0.5, -0.25, 0]),
    metadata: { text: 'cat', kind: 'animal', n: 7, nested: { a: [1, 2, 3] } },
  };
  const decoded = asEntry(encodeEntry(entry));
  assert.equal(decoded.id, entry.id);
  assert.equal(decoded.dim, entry.dim);
  assert.deepEqual(Array.from(decoded.vector), Array.from(entry.vector));
  assert.deepEqual(decoded.metadata, entry.metadata);
});

test('encodeEntry handles empty metadata and unicode ids', () => {
  const entry: VectorEntry = {
    id: 'café-🐈',
    dim: 1,
    vector: Float32Array.from([3.5]),
    metadata: {},
  };
  const decoded = asEntry(encodeEntry(entry));
  assert.equal(decoded.id, 'café-🐈');
  assert.deepEqual(decoded.metadata, {});
});

test('encodeEntry rejects dim/vector mismatch and empty id', () => {
  assert.throws(() =>
    encodeEntry({ id: 'x', dim: 3, vector: Float32Array.from([1, 2]), metadata: {} }),
  );
  assert.throws(() =>
    encodeEntry({ id: '', dim: 1, vector: Float32Array.from([1]), metadata: {} }),
  );
});

test('decodeEntry rejects a truncated buffer', () => {
  const good = encodeEntry({
    id: 'a',
    dim: 2,
    vector: Float32Array.from([1, 2]),
    metadata: {},
  });
  assert.throws(() => decodeEntry(good.subarray(0, good.length - 1)));
});

test('encodeTombstone/decodeEntry round-trips a delete', () => {
  const decoded = decodeEntry(encodeTombstone('café-🐈'));
  assert.equal(isTombstone(decoded), true);
  assert.deepEqual(decoded, { id: 'café-🐈', deleted: true });
});

test('a tombstone is discriminated from a vector entry with the same id', () => {
  const entry: VectorEntry = {
    id: 'cat',
    dim: 2,
    vector: Float32Array.from([1, 0]),
    metadata: { kind: 'animal' },
  };
  assert.equal(isTombstone(decodeEntry(encodeEntry(entry))), false);
  assert.equal(isTombstone(decodeEntry(encodeTombstone('cat'))), true);

  // Same id ⇒ same KV key, so a delete overwrites the entry it retires and
  // inherits its access-control treatment.
  assert.deepEqual(entryKey('cat'), entryKey(entry.id));
});

test('tombstone sets only the tombstone flag and carries no payload', () => {
  const bytes = encodeTombstone('ab');
  assert.equal(bytes[1], ENTRY_FLAG_TOMBSTONE);
  assert.equal(bytes.length, 10 + 2, 'header + id only');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(2, true), 0, 'dim must be 0');
  assert.equal(view.getUint32(6, true), 0, 'metaLen must be 0');
});

test('decodeEntry rejects a malformed tombstone and encodeTombstone rejects an empty id', () => {
  const good = encodeTombstone('ab');
  assert.throws(() => decodeEntry(good.subarray(0, good.length - 1)), /tombstone length/);

  const trailing = new Uint8Array(good.length + 1);
  trailing.set(good);
  assert.throws(() => decodeEntry(trailing), /tombstone length/);

  assert.throws(() => encodeTombstone(''));
});

test('entryKey is the utf-8 encoding of the id', () => {
  assert.deepEqual(Array.from(entryKey('ab')), [0x61, 0x62]);
});

test('collection tag and stream id are deterministic', () => {
  assert.equal(collectionTag('memories'), 'knitnode:v1:memories');
  assert.deepEqual(parseCollectionTag('knitnode:v1:memories'), {
    namespace: 'knitnode',
    version: 'v1',
    collection: 'memories',
  });
  assert.equal(parseCollectionTag('other:v1:x'), null);

  const a = streamIdForCollection('memories');
  const b = streamIdForCollection('memories');
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, streamIdForCollection('other'));
});
