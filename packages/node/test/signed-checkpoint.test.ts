import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { CollectionIndex } from '../src/index-store.js';
import { KnitNode } from '../src/knitnode.js';
import { KnitStore } from '../src/store.js';
import type { CheckpointManifest } from '../src/manifest.js';
import { ALICE, entry, FakeLog, put } from './fake-log.js';

/**
 * Signing through the checkpoint path. The property worth proving is not that a
 * signature verifies — it is that the signature *reaches the snapshots*: the
 * manifest is signed, the manifest records each snapshot's digest, and loading
 * recomputes that digest. Break any link and a forged index gets in.
 */

const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const ADDR_A = new ethers.Wallet(KEY_A).address;
const ADDR_B = new ethers.Wallet(KEY_B).address;

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'knit-signed-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Produce a real checkpoint by replaying a synthetic log, optionally signed. */
async function makeCheckpoint(dir: string, signingKey?: string): Promise<void> {
  const log = new FakeLog().writes({
    txSeq: 1,
    block: 1,
    sender: ALICE,
    values: [put(entry('cat', [1, 0, 0], { kind: 'animal' })), put(entry('car', [0, 0, 1]))],
  });
  const node = new KnitNode({
    collections: ['memories'],
    checkpointDir: dir,
    source: log,
    signingKey,
  });
  await node.sync();
}

function readManifest(dir: string): CheckpointManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

test('a signing key produces an attributable checkpoint', async () => {
  await withTempDir(async (dir) => {
    await makeCheckpoint(dir, KEY_A);

    const manifest = readManifest(dir);
    assert.equal(manifest.signer, ADDR_A);
    assert.ok(manifest.signature?.startsWith('0x'));

    const logs: string[] = [];
    const reopened = new KnitNode({
      collections: ['memories'],
      checkpointDir: dir,
      trustedSigners: [ADDR_A],
      onLog: (m) => logs.push(m),
    });
    assert.equal(reopened.stats()[0]!.size, 2);
    assert.ok(logs.some((m) => m.includes(`signed by ${ADDR_A}`)));
  });
});

test('a checkpoint signed by an untrusted key is refused', async () => {
  await withTempDir(async (dir) => {
    await makeCheckpoint(dir, KEY_B);

    assert.throws(
      () =>
        new KnitNode({
          collections: ['memories'],
          checkpointDir: dir,
          trustedSigners: [ADDR_A],
        }),
      /not a trusted signer/,
    );

    // Without a policy, the same checkpoint loads — it is signed, just by
    // someone this node has expressed no opinion about.
    assert.equal(
      new KnitNode({ collections: ['memories'], checkpointDir: dir }).stats()[0]!.size,
      2,
    );
  });
});

test('an unsigned checkpoint is refused once trusted signers are named', async () => {
  await withTempDir(async (dir) => {
    await makeCheckpoint(dir); // no signing key

    const logs: string[] = [];
    const permissive = new KnitNode({
      collections: ['memories'],
      checkpointDir: dir,
      onLog: (m) => logs.push(m),
    });
    assert.equal(permissive.stats()[0]!.size, 2, 'unsigned is fine by default');
    assert.ok(logs.some((m) => /unsigned/.test(m)), 'but it says so');

    assert.throws(
      () =>
        new KnitNode({
          collections: ['memories'],
          checkpointDir: dir,
          trustedSigners: [ADDR_A],
        }),
      /unsigned, but this node only loads/,
    );
  });
});

test('an edited manifest is rejected even though its files are intact', async () => {
  await withTempDir(async (dir) => {
    await makeCheckpoint(dir, KEY_A);

    // Rewind the cursor so a resumed node would re-scan blocks it already
    // replayed — the kind of edit that is invisible to a digest check, because
    // no snapshot byte changed.
    const manifest = readManifest(dir);
    manifest.nextBlock = 0;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));

    assert.throws(
      () =>
        new KnitNode({
          collections: ['memories'],
          checkpointDir: dir,
          trustedSigners: [ADDR_A],
        }),
      /altered after signing|not a trusted signer/,
    );
  });
});

test('a self-consistent forged snapshot cannot be swapped in under a valid signature', async () => {
  await withTempDir(async (dir) => {
    await makeCheckpoint(dir, KEY_A);
    const manifest = readManifest(dir);
    const genDir = join(dir, `gen-${manifest.generation}`);
    const base = manifest.collections[0]!.base;

    // Build a *different* index and save it over the snapshot. Its sidecar
    // carries its own matching digest, so the pair agrees with itself — this is
    // exactly what a forger would produce, and what the sidecar check alone
    // cannot catch.
    const forged = new CollectionIndex('memories', 3, 'cosine');
    forged.upsert(entry('cat', [0, 1, 0], { kind: 'not-really-a-cat' }));
    forged.upsert(entry('car', [0, 0, 1]));
    forged.saveTo(genDir, base);

    // The manifest was never touched, so its signature still verifies — and it
    // is precisely the digest inside that signed manifest which rejects this.
    assert.throws(
      () =>
        new KnitNode({
          collections: ['memories'],
          checkpointDir: dir,
          trustedSigners: [ADDR_A],
        }),
      /not the one the manifest describes/,
    );

    // The binding holds regardless of trust policy: it is an integrity check
    // that the signature merely makes attributable.
    assert.throws(
      () => new KnitNode({ collections: ['memories'], checkpointDir: dir }),
      /not the one the manifest describes/,
    );
  });
});

test('a store signs its checkpoints with the key it writes under', async () => {
  await withTempDir(async (dir) => {
    const log = new FakeLog().writes({
      txSeq: 1,
      block: 1,
      sender: ALICE,
      values: [put(entry('cat', [1, 0, 0]))],
    });
    const store = new KnitStore({
      collection: 'memories',
      privateKey: KEY_A,
      checkpointDir: dir,
      source: log,
    });
    await store.sync();

    assert.equal(readManifest(dir).signer, ADDR_A, 'the write key vouches for the snapshot');
    assert.equal(store.size, 1);
  });
});

test('a store can opt out of signing', async () => {
  await withTempDir(async (dir) => {
    const log = new FakeLog().writes({
      txSeq: 1,
      block: 1,
      sender: ALICE,
      values: [put(entry('cat', [1, 0, 0]))],
    });
    const store = new KnitStore({
      collection: 'memories',
      privateKey: KEY_A,
      signingKey: null,
      checkpointDir: dir,
      source: log,
    });
    await store.sync();

    assert.equal(readManifest(dir).signature, undefined);
  });
});
