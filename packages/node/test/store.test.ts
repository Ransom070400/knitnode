import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnitStore } from '../src/store.js';

// These exercise the ergonomic surface without any network I/O: ethers
// providers are lazy, so constructing a store and hitting its write guard
// never reaches the chain.

test('a read-only store (no privateKey) refuses to publish', async () => {
  const store = new KnitStore({ collection: 'memories' });
  assert.equal(store.collection, 'memories');
  assert.equal(store.size, 0); // nothing synced yet
  await assert.rejects(
    () => store.upsert('a', [1, 0, 0]),
    /read-only/,
  );
});

test('store exposes its underlying KnitNode', () => {
  const store = new KnitStore({ collection: 'memories', privateKey: '0x'.padEnd(66, '1') });
  assert.equal(store.knitNode.stats().length, 0);
});
