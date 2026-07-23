import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';

const ENTRIES: VectorEntry[] = [
  { id: 'cat', dim: 4, vector: Float32Array.from([1, 0, 0, 0]), metadata: { kind: 'animal', n: 1 } },
  { id: 'dog', dim: 4, vector: Float32Array.from([0.7, 0.3, 0, 0]), metadata: { kind: 'animal', n: 2 } },
  { id: 'car', dim: 4, vector: Float32Array.from([0, 0, 1, 0]), metadata: { kind: 'vehicle', n: 3 } },
];

test('CollectionIndex survives a save/load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-ckpt-'));
  try {
    const original = new CollectionIndex('animals', 4, 'cosine');
    for (const e of ENTRIES) original.upsert(e);
    const query = [0.95, 0.05, 0, 0];
    const before = original.search(query, 3);

    original.saveTo(dir, 'col-0');
    const restored = CollectionIndex.loadFrom(dir, 'col-0');

    assert.equal(restored.name, 'animals');
    assert.equal(restored.dim, 4);
    assert.equal(restored.metric, 'cosine');
    assert.equal(restored.size, original.size);

    // Same query returns identical ids, distances, and metadata after reload.
    const after = restored.search(query, 3);
    assert.deepEqual(
      after.map((h) => [h.id, h.distance, h.metadata]),
      before.map((h) => [h.id, h.distance, h.metadata]),
    );

    // The restored index is still writable (allowReplaceDeleted preserved).
    restored.upsert({ id: 'kitten', dim: 4, vector: Float32Array.from([0.9, 0.1, 0, 0]), metadata: { kind: 'animal' } });
    assert.equal(restored.size, ENTRIES.length + 1);
    restored.upsert({ id: 'cat', dim: 4, vector: Float32Array.from([0, 0, 0, 1]), metadata: { kind: 'moved' } });
    assert.equal(restored.size, ENTRIES.length + 1, 'overwrite after reload must not grow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
