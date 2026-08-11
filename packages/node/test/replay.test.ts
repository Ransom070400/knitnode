import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnitNode } from '../src/knitnode.js';
import { AccessControlType } from '../src/replay/acl.js';
import { ALICE, drop, entry, FakeLog, MALLORY, MEMORIES, OTHER, put } from './fake-log.js';

/**
 * The whole fold, offline: a synthetic log of real `StreamData` blobs replayed
 * through the real engine into a real index. Only the chain is fake, so tag
 * filtering, submission ordering, access control, decoding and the index
 * update are all the production code paths.
 */

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'knit-replay-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('sync replays a log into a searchable index', async () => {
  const log = new FakeLog().writes({
    txSeq: 1,
    block: 5,
    sender: ALICE,
    values: [put(entry('cat', [1, 0, 0], { kind: 'animal' })), put(entry('car', [0, 0, 1]))],
  });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  assert.deepEqual(node.stats(), [
    { collection: 'memories', dim: 3, size: 2, metric: 'cosine' },
  ]);
  const hits = node.similaritySearch('memories', [0.95, 0.05, 0], 1);
  assert.equal(hits[0]!.id, 'cat');
  assert.equal(hits[0]!.metadata.kind, 'animal');
});

test('writes are applied in txSeq order, not the order the source yields them', async () => {
  const log = new FakeLog()
    .writes({ txSeq: 1, block: 1, sender: ALICE, values: [put(entry('x', [1, 0, 0], { v: 1 }))] })
    .writes({ txSeq: 2, block: 2, sender: ALICE, values: [put(entry('x', [0, 0, 1], { v: 2 }))] });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  assert.deepEqual(log.fetched, [1, 2], 'sorted despite being yielded newest-first');
  assert.equal(node.stats()[0]!.size, 1, 'same id overwrites rather than accumulating');
  // The later submission wins: x now sits on the third axis.
  assert.equal(node.similaritySearch('memories', [0, 0, 1], 1)[0]!.metadata.v, 2);
});

test('a tombstone in a later submission removes the id', async () => {
  const log = new FakeLog()
    .writes({
      txSeq: 1,
      block: 1,
      sender: ALICE,
      values: [put(entry('cat', [1, 0, 0])), put(entry('car', [0, 0, 1]))],
    })
    .writes({ txSeq: 2, block: 2, sender: ALICE, values: [drop('cat')] });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  assert.equal(node.stats()[0]!.size, 1);
  const hits = node.similaritySearch('memories', [1, 0, 0], 5);
  assert.deepEqual(hits.map((h) => h.id), ['car'], 'the deleted id is gone from search');
});

test('an unindexable entry is skipped without aborting the scan', async () => {
  // Regression: upsert used to throw out through catchUp, so the cursor never
  // advanced and every restart re-read the same bad write and died again.
  const log = new FakeLog()
    .writes({ txSeq: 1, block: 1, sender: ALICE, values: [put(entry('good', [1, 0, 0]))] })
    .writes({ txSeq: 2, block: 2, sender: ALICE, values: [put(entry('wrong', [1, 0, 0, 0]))] })
    .writes({ txSeq: 3, block: 3, sender: ALICE, values: [put(entry('also-good', [0, 0, 1]))] });

  const logs: string[] = [];
  const node = new KnitNode({
    collections: ['memories'],
    source: log,
    onLog: (m) => logs.push(m),
  });
  await node.sync();

  assert.deepEqual(log.fetched, [1, 2, 3], 'replay continued past the bad write');
  assert.equal(node.stats()[0]!.size, 2);
  assert.ok(
    logs.some((m) => /skipping unindexable entry "wrong"/.test(m)),
    'and said why it was dropped',
  );
});

test('writes to unwatched streams are ignored', async () => {
  const log = new FakeLog()
    .writes({ txSeq: 1, block: 1, sender: ALICE, values: [put(entry('mine', [1, 0, 0]))] })
    .writes({
      txSeq: 2,
      block: 2,
      sender: ALICE,
      streamId: OTHER,
      values: [put(entry('theirs', [0, 1, 0]))],
    });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  assert.equal(node.stats()[0]!.size, 1);
  assert.deepEqual(log.fetched, [1], "the other stream's submission was never even downloaded");
});

test('only an authorized sender can write a collection', async () => {
  // The first sender to touch a stream is bootstrapped as its admin; a stranger
  // writing the same stream afterwards is silently dropped.
  const build = () =>
    new FakeLog()
      .writes({ txSeq: 1, block: 1, sender: ALICE, values: [put(entry('alice', [1, 0, 0]))] })
      .writes({ txSeq: 2, block: 2, sender: MALLORY, values: [put(entry('mallory', [0, 1, 0]))] });

  const enforced = new KnitNode({ collections: ['memories'], source: build() });
  await enforced.sync();
  assert.equal(enforced.stats()[0]!.size, 1);
  assert.deepEqual(
    enforced.similaritySearch('memories', [1, 0, 0], 5).map((h) => h.id),
    ['alice'],
  );

  // The same log with enforcement off indexes everything.
  const blind = new KnitNode({
    collections: ['memories'],
    source: build(),
    enforceAcl: false,
  });
  await blind.sync();
  assert.equal(blind.stats()[0]!.size, 2);
});

test('an admin can grant write access, and later submissions honour it', async () => {
  const log = new FakeLog()
    .writes({ txSeq: 1, block: 1, sender: ALICE, values: [put(entry('alice', [1, 0, 0]))] })
    .controls({
      txSeq: 2,
      block: 2,
      sender: ALICE,
      ops: [{ Type: AccessControlType.GrantWriteRole, StreamId: MEMORIES, Account: MALLORY }],
    })
    .writes({ txSeq: 3, block: 3, sender: MALLORY, values: [put(entry('mallory', [0, 1, 0]))] });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  assert.equal(node.stats()[0]!.size, 2, 'the grant took effect for the next submission');
  assert.deepEqual(
    node.similaritySearch('memories', [0, 1, 0], 1).map((h) => h.id),
    ['mallory'],
  );
});

test('a second sync only scans blocks it has not seen', async () => {
  const log = new FakeLog().writes({
    txSeq: 1,
    block: 1,
    sender: ALICE,
    values: [put(entry('first', [1, 0, 0]))],
  });

  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();
  assert.deepEqual(log.fetched, [1]);

  log.writes({ txSeq: 2, block: 2, sender: ALICE, values: [put(entry('second', [0, 1, 0]))] });
  await node.sync();

  assert.deepEqual(log.fetched, [1, 2], 'the first submission was not downloaded twice');
  assert.equal(node.stats()[0]!.size, 2);
});

test('a checkpointed node resumes and replays only what arrived since', async () => {
  await withTempDir(async (dir) => {
    const log = new FakeLog().writes({
      txSeq: 1,
      block: 1,
      sender: ALICE,
      values: [put(entry('cat', [1, 0, 0], { kind: 'animal' }))],
    });

    const first = new KnitNode({ collections: ['memories'], source: log, checkpointDir: dir });
    await first.sync();
    assert.equal(first.stats()[0]!.size, 1);

    // A new submission lands while the node is down.
    log.writes({ txSeq: 2, block: 2, sender: ALICE, values: [put(entry('kitten', [0.9, 0.1, 0]))] });

    const resumed = new KnitNode({ collections: ['memories'], source: log, checkpointDir: dir });
    assert.equal(resumed.stats()[0]!.size, 1, 'restored from the snapshot before syncing');
    await resumed.sync();

    assert.deepEqual(log.fetched, [1, 2], 'the replayed submission was not fetched again');
    assert.equal(resumed.stats()[0]!.size, 2);
    assert.deepEqual(
      resumed.similaritySearch('memories', [0.95, 0.05, 0], 2).map((h) => h.id).sort(),
      ['cat', 'kitten'],
    );
  });
});

test('replayed access control survives a restart through the checkpoint', async () => {
  await withTempDir(async (dir) => {
    // Alice is bootstrapped as admin by the first submission. If the ACL were
    // not persisted, the resumed node would forget and treat Mallory's later
    // write as the stream's first — bootstrapping *her* as admin instead.
    const log = new FakeLog().writes({
      txSeq: 1,
      block: 1,
      sender: ALICE,
      values: [put(entry('alice', [1, 0, 0]))],
    });

    const first = new KnitNode({ collections: ['memories'], source: log, checkpointDir: dir });
    await first.sync();

    log.writes({ txSeq: 2, block: 2, sender: MALLORY, values: [put(entry('mallory', [0, 1, 0]))] });

    const resumed = new KnitNode({ collections: ['memories'], source: log, checkpointDir: dir });
    await resumed.sync();

    assert.equal(resumed.stats()[0]!.size, 1, 'Mallory is still not authorized');
    assert.deepEqual(
      resumed.similaritySearch('memories', [1, 0, 0], 5).map((h) => h.id),
      ['alice'],
    );
  });
});
