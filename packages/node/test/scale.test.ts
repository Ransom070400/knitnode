import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamDataBuilder } from '@0gfoundation/0g-storage-ts-sdk';
import {
  encodeEntry,
  decodeEntry,
  entryKey,
  streamIdForCollection,
  type VectorEntry,
} from '@knitnode/protocol';
import { decodeStreamData } from '../src/replay/streamdata.js';
import { CollectionIndex } from '../src/index-store.js';

/**
 * Realistic-scale exercise of the full offline pipeline — encode → SDK
 * StreamData → our decoder → decode → HNSW index → search → checkpoint — at
 * dimensions and counts the 5-vector demo can't reach. No chain, no gas.
 */

const DIM = 768;
const N = 400;

// Deterministic PRNG (mulberry32) so the test is reproducible without Date/random.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rand() * 2 - 1;
  return v;
}

/** A query vector plus `k` entries that are that vector with tiny noise. */
function plantedNeighbours(rand: () => number, k: number) {
  const query = randomVector(rand);
  const near: VectorEntry[] = [];
  for (let i = 0; i < k; i++) {
    const v = Float32Array.from(query, (x) => x + (rand() - 0.5) * 0.001);
    near.push({ id: `planted-${i}`, dim: DIM, vector: v, metadata: { planted: true, i } });
  }
  return { query: Array.from(query), near };
}

test(`full pipeline round-trips ${N} × ${DIM}-dim entries and finds planted neighbours`, () => {
  const rand = rng(42);
  const { query, near } = plantedNeighbours(rand, 5);

  const entries: VectorEntry[] = [...near];
  for (let i = near.length; i < N; i++) {
    entries.push({
      id: `vec-${i}`,
      dim: DIM,
      vector: randomVector(rand),
      metadata: { text: `item ${i}`, group: i % 7, score: rand() },
    });
  }

  // Encode each entry, pack into ONE StreamData via the SDK, encode the blob.
  const streamId = streamIdForCollection('scale');
  const builder = new StreamDataBuilder(1);
  const originalById = new Map<string, VectorEntry>();
  for (const e of entries) {
    builder.set(streamId, entryKey(e.id), encodeEntry(e));
    originalById.set(e.id, e);
  }
  const blob = builder.build().encode();

  // Decode the blob with our hand-written decoder, then decode each entry, and
  // apply to the index in that order — exactly the replay path.
  const { writes } = decodeStreamData(blob);
  assert.equal(writes.length, N);

  const index = new CollectionIndex('scale', DIM, 'cosine');
  for (const w of writes) {
    const decoded = decodeEntry(w.data);
    const original = originalById.get(decoded.id);
    assert.ok(original, `unexpected id ${decoded.id}`);
    // Bytes survive the full round-trip exactly.
    assert.deepEqual(Array.from(decoded.vector), Array.from(original!.vector));
    assert.deepEqual(decoded.metadata, original!.metadata);
    index.upsert(decoded);
  }
  assert.equal(index.size, N);

  // All 5 planted near-neighbours should come back in the top 5.
  const hits = index.search(query, 5);
  const plantedFound = hits.filter((h) => h.id.startsWith('planted-')).length;
  assert.equal(plantedFound, 5, `expected 5 planted hits in top-5, got ${plantedFound}`);
  assert.equal(hits[0]!.metadata.planted, true);

  // A checkpoint at this scale reloads to identical results.
  const dir = mkdtempSync(join(tmpdir(), 'knit-scale-'));
  try {
    index.saveTo(dir, 'scale');
    const restored = CollectionIndex.loadFrom(dir, 'scale');
    assert.equal(restored.size, N);
    assert.deepEqual(
      restored.search(query, 5).map((h) => [h.id, h.distance]),
      hits.map((h) => [h.id, h.distance]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
