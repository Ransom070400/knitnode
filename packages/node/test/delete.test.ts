import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';

/**
 * Deletion is the replay effect of a tombstone. The invariant under test is
 * that removing an id never disturbs the labels of the ids around it — label
 * assignment must stay a pure function of first-seen order, or two nodes
 * replaying the same log stop agreeing.
 */

const ENTRIES: VectorEntry[] = [
  { id: 'cat', dim: 4, vector: Float32Array.from([1, 0, 0, 0]), metadata: { kind: 'animal' } },
  { id: 'dog', dim: 4, vector: Float32Array.from([0.7, 0.3, 0, 0]), metadata: { kind: 'animal' } },
  { id: 'car', dim: 4, vector: Float32Array.from([0, 0, 1, 0]), metadata: { kind: 'vehicle' } },
];

function build(): CollectionIndex {
  const idx = new CollectionIndex('animals', 4, 'cosine');
  for (const e of ENTRIES) idx.upsert(e);
  return idx;
}

const ANIMAL_QUERY = [0.95, 0.05, 0, 0];

test('delete removes an id from search results and shrinks size', () => {
  const idx = build();
  assert.equal(idx.size, 3);
  assert.ok(idx.search(ANIMAL_QUERY, 3).some((h) => h.id === 'cat'));

  assert.equal(idx.delete('cat'), true);
  assert.equal(idx.size, 2);

  const hits = idx.search(ANIMAL_QUERY, 3);
  assert.equal(hits.length, 2, 'k is capped at the live size');
  assert.ok(!hits.some((h) => h.id === 'cat'), 'deleted id must not resurface');
  assert.ok(hits.some((h) => h.id === 'dog'), 'surviving neighbours still match');
});

test('deleting an unknown or already-deleted id is a no-op, not an error', () => {
  const idx = build();
  assert.equal(idx.delete('nonexistent'), false);
  assert.equal(idx.delete('cat'), true);
  assert.equal(idx.delete('cat'), false, 'second delete reports nothing removed');
  assert.equal(idx.size, 2);
});

test('deleting every id leaves an empty but usable index', () => {
  const idx = build();
  for (const e of ENTRIES) assert.equal(idx.delete(e.id), true);
  assert.equal(idx.size, 0);
  assert.deepEqual(idx.search(ANIMAL_QUERY, 3), []);

  // And it still accepts writes afterwards.
  idx.upsert(ENTRIES[0]!);
  assert.equal(idx.size, 1);
  assert.equal(idx.search(ANIMAL_QUERY, 1)[0]!.id, 'cat');
});

test('re-adding a deleted id restores it with fresh metadata', () => {
  const idx = build();
  idx.delete('cat');
  idx.upsert({ id: 'cat', dim: 4, vector: Float32Array.from([1, 0, 0, 0]), metadata: { kind: 'reborn' } });

  assert.equal(idx.size, 3);
  const hit = idx.search(ANIMAL_QUERY, 3).find((h) => h.id === 'cat');
  assert.ok(hit, 'cat is findable again');
  assert.equal(hit.metadata.kind, 'reborn', 'stale metadata must not survive the delete');
});

test('delete does not disturb the labels of surviving ids', () => {
  // Deleting 'cat' then re-adding it must leave 'dog' and 'car' exactly where
  // they were — same distances, same metadata, unaffected by the churn.
  const untouched = build().search(ANIMAL_QUERY, 3).filter((h) => h.id !== 'cat');

  const idx = build();
  idx.delete('cat');
  idx.upsert(ENTRIES[0]!);

  assert.deepEqual(
    idx.search(ANIMAL_QUERY, 3).filter((h) => h.id !== 'cat').map((h) => [h.id, h.distance]),
    untouched.map((h) => [h.id, h.distance]),
  );
});

test('the same deletes in the same order produce the same digest', () => {
  const a = build();
  const b = build();
  const full = a.digest();

  a.delete('dog');
  b.delete('dog');
  assert.equal(a.digest(), b.digest(), 'replaying the same log agrees');
  assert.notEqual(a.digest(), full, 'a tombstone changes replay state');
});

test('the digest covers live content, not deletion history', () => {
  // The digest walks live labels in order and skips holes, so an index that
  // wrote 'dog' and deleted it hashes the same as one that never wrote it. The
  // two differ internally — different labels, different graph — but they agree
  // on what the collection *contains*, which is what the fingerprint is for.
  const deleted = build();
  deleted.delete('dog');

  const never = new CollectionIndex('animals', 4, 'cosine');
  for (const e of ENTRIES) if (e.id !== 'dog') never.upsert(e);

  assert.equal(deleted.size, never.size);
  assert.equal(deleted.digest(), never.digest());
});

test('deletions survive a checkpoint round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-delete-'));
  try {
    const idx = build();
    idx.delete('cat');
    const before = idx.search(ANIMAL_QUERY, 3);
    const digest = idx.saveTo(dir, 'col-0');

    // The hole is persisted as null, keeping later labels at their positions.
    const sidecar = JSON.parse(readFileSync(join(dir, 'col-0.json'), 'utf8'));
    assert.deepEqual(sidecar.labelToId, [null, 'dog', 'car']);
    assert.equal(sidecar.metadata.cat, undefined, 'metadata is dropped too');

    // loadFrom recomputes the digest, so a mismatch here would already throw.
    const restored = CollectionIndex.loadFrom(dir, 'col-0');
    assert.equal(restored.digest(), digest);
    assert.equal(restored.size, 2);
    assert.deepEqual(
      restored.search(ANIMAL_QUERY, 3).map((h) => [h.id, h.distance]),
      before.map((h) => [h.id, h.distance]),
    );

    // The restored index still deletes and writes correctly.
    assert.equal(restored.delete('cat'), false, 'stays deleted across restart');
    assert.equal(restored.delete('dog'), true);
    assert.equal(restored.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
