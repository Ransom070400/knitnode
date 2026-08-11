import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metric, VectorEntry } from '@knitnode/protocol';
import { CollectionIndex } from '../src/index-store.js';
import { KnitNode } from '../src/knitnode.js';
import { ALICE, entry, FakeLog, OTHER, put } from './fake-log.js';

/**
 * Checkpoint restore and commit, exercised through `KnitNode` itself.
 * Construction is offline — stream ids are derived locally and the RPC provider
 * is lazy — so everything up to the first `sync()` is testable without a chain.
 */

const ENTRIES: VectorEntry[] = [
  { id: 'cat', dim: 3, vector: Float32Array.from([1, 0, 0]), metadata: { kind: 'animal' } },
  { id: 'car', dim: 3, vector: Float32Array.from([0, 0, 1]), metadata: { kind: 'vehicle' } },
];

const MANIFEST = 'manifest.json';

/** Write a one-collection checkpoint the way `saveCheckpoint` would. */
function writeCheckpoint(
  dir: string,
  name: string,
  metric: Metric,
  { nextBlock = 42, generation = 1 } = {},
): void {
  const genDir = join(dir, `gen-${generation}`);
  mkdirSync(genDir, { recursive: true });

  const idx = new CollectionIndex(name, 3, metric);
  for (const e of ENTRIES) idx.upsert(e);
  const digest = idx.saveTo(genDir, 'col-0');

  writeFileSync(
    join(dir, MANIFEST),
    JSON.stringify({
      version: 2,
      generation,
      nextBlock,
      collections: [{ name, base: 'col-0', digest }],
    }),
  );
}

function readManifest(dir: string): {
  version: number;
  generation: number;
  nextBlock: number;
  collections: { name: string; base: string; digest: string }[];
} {
  return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'knit-node-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'knit-node-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
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
    const path = join(dir, 'gen-1', 'col-0.json');
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

test('a save after replay commits a new generation and retires the old one', async () => {
  await withTempDirAsync(async (dir) => {
    writeCheckpoint(dir, 'memories', 'cosine', { generation: 1, nextBlock: 42 });

    // Resume at block 42, then replay one new submission — sync() checkpoints.
    const log = new FakeLog().writes({
      txSeq: 1,
      block: 50,
      sender: ALICE,
      values: [put(entry('kitten', [0.9, 0.1, 0], { kind: 'animal' }))],
    });
    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir, source: log });
    await node.sync();

    const manifest = readManifest(dir);
    assert.equal(manifest.generation, 2, 'a save never overwrites the generation it loaded');
    assert.equal(manifest.version, 2);

    const gens = readdirSync(dir).filter((f) => f.startsWith('gen-'));
    assert.deepEqual(gens, ['gen-2'], 'the superseded generation is pruned');
    assert.ok(!existsSync(join(dir, `${MANIFEST}.tmp`)), 'no temp file is left behind');

    // The committed checkpoint is loadable and carries the new entry.
    const reopened = new KnitNode({ collections: ['memories'], checkpointDir: dir });
    assert.deepEqual(reopened.stats(), node.stats());
    assert.equal(reopened.stats()[0]!.size, 3);
    assert.equal(reopened.similaritySearch('memories', [0.95, 0.05, 0], 1)[0]!.id, 'cat');
  });
});

test('a save that replayed nothing rewrites only the manifest', async () => {
  await withTempDirAsync(async (dir) => {
    writeCheckpoint(dir, 'memories', 'cosine', { generation: 1, nextBlock: 42 });
    // A sentinel inside the generation: a full save would build gen-2 and prune
    // gen-1, taking this with it.
    writeFileSync(join(dir, 'gen-1', 'sentinel'), 'untouched');

    // The chain moved on by 9000 blocks, and the only traffic was somebody
    // else's stream — exactly the poll this optimization is for.
    const log = new FakeLog()
      .writes({
        txSeq: 1,
        block: 100,
        sender: ALICE,
        streamId: OTHER,
        values: [put(entry('theirs', [1, 0, 0]))],
      })
      .advanceTo(9000);

    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir, source: log });
    await node.sync();

    assert.equal(readManifest(dir).nextBlock, 9001, 'the advanced cursor is persisted');
    assert.equal(readManifest(dir).generation, 1, 'the generation on disk is reused');
    assert.equal(readFileSync(join(dir, 'gen-1', 'sentinel'), 'utf8'), 'untouched');
    assert.ok(!existsSync(join(dir, `${MANIFEST}.tmp`)));

    // And a restart resumes from the advanced cursor, not the stale one.
    const logs: string[] = [];
    const reopened = new KnitNode({
      collections: ['memories'],
      checkpointDir: dir,
      onLog: (m) => logs.push(m),
    });
    assert.ok(logs.some((m) => /block 9001/.test(m)), 'resumes at the saved cursor');
    assert.equal(reopened.stats()[0]!.size, 2, 'still a valid checkpoint');
  });
});

test('generation reuse is refused when the live collections do not match', () => {
  withTempDir((dir) => {
    writeCheckpoint(dir, 'memories', 'cosine', { generation: 1, nextBlock: 42 });

    // Reuse is gated on a dirty flag *and* on the committed snapshots matching
    // the live collections. This exercises the second gate alone: a collection
    // appears without the flag being set, and the save must still write a
    // generation — otherwise the manifest would name a snapshot that does not
    // exist. Reaching in is the point; no replay path can set up this state.
    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir });
    (node as unknown as { collections: Map<string, CollectionIndex> }).collections.set(
      'other',
      new CollectionIndex('other', 3, 'cosine'),
    );
    node.saveCheckpoint();

    const manifest = readManifest(dir);
    assert.equal(manifest.generation, 2);
    assert.deepEqual(manifest.collections.map((c) => c.name), ['memories', 'other']);
    for (const c of manifest.collections) {
      assert.ok(existsSync(join(dir, 'gen-2', `${c.base}.hnsw`)), `${c.base} was written`);
    }
  });
});

test('the first save of a cold node writes a generation, later idle ones do not', () => {
  withTempDir((dir) => {
    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir });
    node.saveCheckpoint();
    assert.equal(readManifest(dir).generation, 1, 'nothing on disk yet, so write one');

    node.saveCheckpoint();
    node.saveCheckpoint();
    assert.equal(readManifest(dir).generation, 1, 'and then stop rewriting it');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('gen-')), ['gen-1']);
  });
});

test('a save interrupted before the manifest swap leaves the old checkpoint intact', async () => {
  await withTempDirAsync(async (dir) => {
    writeCheckpoint(dir, 'memories', 'cosine', { generation: 1, nextBlock: 42 });

    // Simulate a crash partway through writing generation 2: snapshot files
    // exist and are garbage, but the manifest was never swapped.
    const partial = join(dir, 'gen-2');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'col-0.hnsw'), 'truncated');

    // The committed manifest still names gen-1, so the node resumes from it and
    // never touches the debris.
    const log = new FakeLog().advanceTo(50);
    const node = new KnitNode({ collections: ['memories'], checkpointDir: dir, source: log });
    assert.equal(node.stats()[0]!.size, 2);

    // An idle sync leaves the debris alone — it is unreferenced either way.
    await node.sync();
    assert.equal(readManifest(dir).generation, 1);
    assert.ok(existsSync(join(partial, 'col-0.hnsw')), 'debris is simply ignored');

    // The next save that has something to write claims gen-2, clearing it
    // rather than trusting whatever was left there.
    log.writes({ txSeq: 1, block: 60, sender: ALICE, values: [put(entry('kitten', [0.9, 0.1, 0]))] });
    await node.sync();

    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('gen-')), ['gen-2']);
    assert.equal(readFileSync(join(dir, 'gen-2', 'col-0.hnsw')).includes('truncated'), false);
    assert.equal(new KnitNode({ collections: ['memories'], checkpointDir: dir }).stats()[0]!.size, 3);
  });
});

test('a checkpoint in an older on-disk format is ignored, not half-loaded', () => {
  withTempDir((dir) => {
    // v1 layout: snapshots at the root, no generation.
    const idx = new CollectionIndex('memories', 3, 'cosine');
    for (const e of ENTRIES) idx.upsert(e);
    const digest = idx.saveTo(dir, 'col-0');
    writeFileSync(
      join(dir, MANIFEST),
      JSON.stringify({
        version: 1,
        nextBlock: 42,
        collections: [{ name: 'memories', base: 'col-0', digest }],
      }),
    );

    const logs: string[] = [];
    const node = new KnitNode({
      collections: ['memories'],
      checkpointDir: dir,
      onLog: (m) => logs.push(m),
    });
    assert.deepEqual(node.stats(), [], 'cold start rather than a crash');
    assert.ok(logs.some((m) => /format version 1/.test(m)), 'and it says so');
  });
});
