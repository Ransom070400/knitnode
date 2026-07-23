import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';

const ANIMALS: VectorEntry[] = [
  { id: 'cat', dim: 4, vector: Float32Array.from([1.0, 0.0, 0.0, 0.0]), metadata: { kind: 'animal' } },
  { id: 'kitten', dim: 4, vector: Float32Array.from([0.9, 0.1, 0.0, 0.0]), metadata: { kind: 'animal' } },
  { id: 'dog', dim: 4, vector: Float32Array.from([0.7, 0.3, 0.0, 0.0]), metadata: { kind: 'animal' } },
  { id: 'car', dim: 4, vector: Float32Array.from([0.0, 0.0, 1.0, 0.0]), metadata: { kind: 'vehicle' } },
];

function feline(): CollectionIndex {
  const idx = new CollectionIndex('animals', 4, 'cosine');
  for (const e of ANIMALS) idx.upsert(e);
  return idx;
}

test('search returns nearest neighbours by cosine distance', () => {
  const idx = feline();
  const hits = idx.search([0.95, 0.05, 0.0, 0.0], 3);
  assert.equal(hits.length, 3);
  assert.ok(hits[0]!.id === 'cat' || hits[0]!.id === 'kitten');
  assert.equal(hits.at(-1)!.id !== 'car', true, 'a vehicle should not beat the animals');
  // distances are non-decreasing
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i]!.distance >= hits[i - 1]!.distance);
  }
  // metadata is carried through
  assert.equal(hits[0]!.metadata.kind, 'animal');
});

test('replaying the same entries in the same order is deterministic', () => {
  const a = feline().search([0.95, 0.05, 0.0, 0.0], 4);
  const b = feline().search([0.95, 0.05, 0.0, 0.0], 4);
  assert.deepEqual(
    a.map((h) => [h.id, h.distance]),
    b.map((h) => [h.id, h.distance]),
  );
});

test('upsert overwrites in place without growing the index', () => {
  const idx = feline();
  assert.equal(idx.size, 4);
  // Move cat onto the 4th axis — an otherwise-empty region, so no tie.
  idx.upsert({ id: 'cat', dim: 4, vector: Float32Array.from([0, 0, 0, 1]), metadata: { kind: 'relocated' } });
  assert.equal(idx.size, 4, 'overwrite must not add a new point');

  // The vector moved: querying the animal cluster should no longer surface cat first.
  const hits = idx.search([1.0, 0.0, 0.0, 0.0], 1);
  assert.notEqual(hits[0]!.id, 'cat');

  // But cat is still findable at its new location, with updated metadata.
  const near = idx.search([0, 0, 0, 1], 1);
  assert.equal(near[0]!.id, 'cat');
  assert.equal(near[0]!.metadata.kind, 'relocated');
});

test('search caps k at index size and rejects dim mismatch', () => {
  const idx = feline();
  assert.equal(idx.search([1, 0, 0, 0], 100).length, 4);
  assert.equal(new CollectionIndex('empty', 4).search([1, 0, 0, 0], 5).length, 0);
  assert.throws(() => idx.search([1, 0, 0], 1)); // wrong dim
  assert.throws(() =>
    idx.upsert({ id: 'z', dim: 2, vector: Float32Array.from([1, 0]), metadata: {} }),
  );
});

test('index grows past its initial capacity', () => {
  const idx = new CollectionIndex('big', 2, 'l2');
  for (let i = 0; i < 2000; i++) {
    idx.upsert({ id: `v${i}`, dim: 2, vector: Float32Array.from([i, -i]), metadata: {} });
  }
  assert.equal(idx.size, 2000);
  const hits = idx.search([10, -10], 1);
  assert.equal(hits[0]!.id, 'v10');
});
