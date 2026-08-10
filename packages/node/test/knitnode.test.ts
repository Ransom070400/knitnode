import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metric, VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';
import { KnitNode } from '../src/knitnode.js';

/**
 * Checkpoint restore, exercised through `KnitNode` itself. Construction is
 * offline — stream ids are derived locally and the RPC provider is lazy — so
 * everything up to the first `sync()` is testable without a chain.
 */

const ENTRIES: VectorEntry[] = [
  { id: 'cat', dim: 3, vector: Float32Array.from([1, 0, 0]), metadata: { kind: 'animal' } },
  { id: 'car', dim: 3, vector: Float32Array.from([0, 0, 1]), metadata: { kind: 'vehicle' } },
];

/** Write a one-collection checkpoint the way `saveCheckpoint` would. */
function writeCheckpoint(dir: string, name: string, metric: Metric, nextBlock = 42): void {
  const idx = new CollectionIndex(name, 3, metric);
  for (const e of ENTRIES) idx.upsert(e);
  const digest = idx.saveTo(dir, 'col-0');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      nextBlock,
      collections: [{ name, base: 'col-0', digest }],
    }),
  );
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'knit-node-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a cold start with no checkpoint has no collections', () => {
  const node = new KnitNode({ collections: ['memories'] });
  assert.deepEqual(node.stats(), []);
  assert.throws(() => node.similaritySearch('memories', [1, 0, 0], 1), /unknown or empty/);
});

test('KnitNode resumes a checkpoint and can search before any sync', () => {
  withTempDir((dir) => {
    writeCheckpoint(dir, 'memories', 'cosine');

    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir });
    assert.deepEqual(node.stats(), [
      { collection: 'memories', dim: 3, size: 2, metric: 'cosine' },
    ]);

    const hits = node.similaritySearch('memories', [0.95, 0.05, 0], 2);
    assert.equal(hits[0]!.id, 'cat');
    assert.equal(hits[0]!.metadata.kind, 'animal');
  });
});

test('KnitNode refuses a checkpoint built under a different metric', () => {
  withTempDir((dir) => {
    writeCheckpoint(dir, 'memories', 'cosine');

    // The metric is part of the collection tag, so an l2 node watches a
    // different stream — it must not resume onto cosine state that it could
    // never have replayed itself.
    assert.throws(
      () => new KnitNode({ collections: ['memories'], metric: 'l2', checkpointDir: dir }),
      /built under metric "cosine".*configured for "l2"/s,
    );

    // Matching metric still resumes.
    assert.equal(
      new KnitNode({ collections: ['memories'], metric: 'cosine', checkpointDir: dir }).stats()
        .length,
      1,
    );
  });
});

test('KnitNode ignores checkpointed collections it is not watching', () => {
  withTempDir((dir) => {
    writeCheckpoint(dir, 'memories', 'cosine');
    const node = new KnitNode({ collections: ['other'], checkpointDir: dir });
    assert.deepEqual(node.stats(), [], 'an unwatched snapshot is not loaded');
  });
});

test('a corrupt snapshot is refused rather than silently resumed', () => {
  withTempDir((dir) => {
    writeCheckpoint(dir, 'memories', 'cosine');
    // Keep the recorded digest, change the content.
    const path = join(dir, 'col-0.json');
    const sidecar = JSON.parse(readFileSync(path, 'utf8')) as {
      metadata: Record<string, Record<string, unknown>>;
    };
    sidecar.metadata.cat!.kind = 'tampered';
    writeFileSync(path, JSON.stringify(sidecar));

    assert.throws(
      () => new KnitNode({ collections: ['memories'], checkpointDir: dir }),
      /digest mismatch/,
    );
  });
});
