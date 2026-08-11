import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { KnitNode } from '../src/knitnode.js';
import { startRpcServer } from '../src/server.js';
import { ALICE, entry, FakeLog, put } from './fake-log.js';

/** The RPC surface and the console it serves, over a real socket. */

let server: Server;
let base: string;

before(async () => {
  const log = new FakeLog().writes({
    txSeq: 1,
    block: 7,
    sender: ALICE,
    values: [
      put(entry('cat', [1, 0, 0], { kind: 'animal' })),
      put(entry('car', [0, 0, 1], { kind: 'vehicle' })),
    ],
  });
  const node = new KnitNode({ collections: ['memories'], source: log });
  await node.sync();

  // Port 0: let the OS pick, so tests never collide with a running node.
  server = startRpcServer(node, 0);
  await new Promise<void>((res) => server.once('listening', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function rpc(method: string, params?: unknown) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test('GET / serves the console', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  const html = await res.text();
  assert.match(html, /knitnode console/);
  // The console must be self-contained: it is served over plain http from a
  // local node, so anything fetched from elsewhere would be a broken or
  // insecure dependency.
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
});

test('GET /health reports liveness, unknown paths 404', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(base, { method: 'PUT' })).status, 405);
});

test('status reports replay progress and collections', async () => {
  const { body } = await rpc('status');
  assert.equal(body.result.nextBlock, 8, 'scanned through block 7');
  assert.equal(body.result.applied, 2);
  assert.deepEqual(body.result.collections, [
    { collection: 'memories', dim: 3, size: 2, metric: 'cosine' },
  ]);
});

test('similaritySearch returns ranked hits', async () => {
  const { body } = await rpc('similaritySearch', {
    collection: 'memories',
    queryVector: [0.95, 0.05, 0],
    k: 2,
  });
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.result[0].id, 'cat');
  assert.equal(body.result[0].metadata.kind, 'animal');
  assert.ok(body.result[0].distance <= body.result[1].distance);
});

test('collections mirrors the node stats', async () => {
  const { body } = await rpc('collections');
  assert.deepEqual(body.result, [
    { collection: 'memories', dim: 3, size: 2, metric: 'cosine' },
  ]);
});

test('bad requests come back as JSON-RPC errors, not crashes', async () => {
  const unknown = await rpc('nope');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.message, /unknown method/);

  const missingParams = await rpc('similaritySearch', { collection: 'memories' });
  assert.match(missingParams.body.error.message, /requires/);

  const badCollection = await rpc('similaritySearch', {
    collection: 'nope',
    queryVector: [1, 0, 0],
  });
  assert.match(badCollection.body.error.message, /unknown or empty collection/);

  const wrongDim = await rpc('similaritySearch', {
    collection: 'memories',
    queryVector: [1, 0],
  });
  assert.match(wrongDim.body.error.message, /does not match collection dim/);

  const parse = await fetch(base, { method: 'POST', body: 'not json' });
  assert.equal((await parse.json() as any).error.code, -32700);
});
