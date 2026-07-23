import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeEntry,
  decodeEntry,
  entryKey,
  collectionTag,
  parseCollectionTag,
  streamIdForCollection,
  type VectorEntry,
} from '../src/index.js';

test('encodeEntry/decodeEntry round-trips a full entry', () => {
  const entry: VectorEntry = {
    id: 'cat',
    dim: 4,
    vector: Float32Array.from([1, 0.5, -0.25, 0]),
    metadata: { text: 'cat', kind: 'animal', n: 7, nested: { a: [1, 2, 3] } },
  };
  const decoded = decodeEntry(encodeEntry(entry));
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
  const decoded = decodeEntry(encodeEntry(entry));
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
