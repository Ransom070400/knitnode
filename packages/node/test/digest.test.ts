import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';

const ENTRIES: VectorEntry[] = [
  { id: 'a', dim: 3, vector: Float32Array.from([1, 0, 0]), metadata: { k: 1, s: 'x' } },
  { id: 'b', dim: 3, vector: Float32Array.from([0, 1, 0]), metadata: { k: 2, s: 'y' } },
  { id: 'c', dim: 3, vector: Float32Array.from([0, 0, 1]), metadata: { k: 3, s: 'z' } },
];

function build(entries: VectorEntry[]): CollectionIndex {
  const idx = new CollectionIndex('c', 3, 'cosine');
  for (const e of entries) idx.upsert(e);
  return idx;
}

test('digest is deterministic for the same entries in the same order', () => {
  assert.equal(build(ENTRIES).digest(), build(ENTRIES).digest());
});

test('digest is metadata-key-order invariant but value sensitive', () => {
  const reordered: VectorEntry[] = ENTRIES.map((e) => ({
    ...e,
    metadata: { s: e.metadata.s, k: e.metadata.k }, // same pairs, keys swapped
  }));
  assert.equal(build(ENTRIES).digest(), build(reordered).digest());

  const changed = build(ENTRIES);
  changed.upsert({ id: 'a', dim: 3, vector: Float32Array.from([1, 0, 0]), metadata: { k: 999, s: 'x' } });
  assert.notEqual(build(ENTRIES).digest(), changed.digest());
});

test('digest changes with insertion order', () => {
  const reversed = [...ENTRIES].reverse();
  assert.notEqual(build(ENTRIES).digest(), build(reversed).digest());
});

test('loadFrom verifies the digest and rejects a tampered sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-digest-'));
  try {
    build(ENTRIES).saveTo(dir, 'col-0');
    // Clean load succeeds.
    assert.equal(CollectionIndex.loadFrom(dir, 'col-0').size, 3);

    // Tamper with metadata but leave the stored digest as-is → must throw.
    const sidecarPath = join(dir, 'col-0.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    sidecar.metadata.a.k = 12345;
    writeFileSync(sidecarPath, JSON.stringify(sidecar));

    assert.throws(() => CollectionIndex.loadFrom(dir, 'col-0'), /digest mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
