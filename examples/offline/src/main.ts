import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { KnitNode, MemorySource, startRpcServer } from '@knitnode/node';
import type { VectorEntry } from '@knitnode/protocol';

/**
 * knitnode end to end, with no chain and no funded key.
 *
 * A KnitNode is a deterministic fold over an ordered log. `MemorySource`
 * supplies that log from memory instead of 0G, so everything downstream is the
 * real thing — the same tag filtering, submission ordering, access control,
 * binary decoding, HNSW indexing and checkpointing that runs against Galileo.
 * Only the network is absent.
 *
 *   pnpm --filter @knitnode/example-offline dev
 *   pnpm --filter @knitnode/example-offline serve   # …and leave the console up
 */

const COLLECTION = 'memories';

// Two identities. The first to write a stream is bootstrapped as its admin;
// the other is a stranger, and replay should ignore what it publishes.
const OWNER = new ethers.Wallet('0x' + '11'.repeat(32));
const STRANGER = new ethers.Wallet('0x' + '22'.repeat(32));

/** Toy 3-dim "embeddings" so the geometry is readable: animals vs vehicles. */
function vec(id: string, v: [number, number, number], kind: string): VectorEntry {
  return { id, dim: 3, vector: Float32Array.from(v), metadata: { kind } };
}

const log = new MemorySource()
  // txSeq 1 — the owner writes four vectors, and becomes the stream's admin.
  .publish({
    txSeq: 1,
    block: 10,
    sender: OWNER.address,
    collection: COLLECTION,
    entries: [
      vec('cat', [1, 0, 0], 'animal'),
      vec('kitten', [0.9, 0.1, 0], 'animal'),
      vec('dog', [0.7, 0.3, 0], 'animal'),
      vec('car', [0, 0, 1], 'vehicle'),
    ],
  })
  // txSeq 2 — a stranger tries to write. Not authorized; replay drops it.
  .publish({
    txSeq: 2,
    block: 11,
    sender: STRANGER.address,
    collection: COLLECTION,
    entries: [vec('trojan', [1, 0, 0], 'not-really-a-cat')],
  })
  // txSeq 3 — the owner corrects a vector and retires another. Both are
  // ordinary writes: an overwrite reuses the id, a delete is a tombstone.
  .publish({
    txSeq: 3,
    block: 12,
    sender: OWNER.address,
    collection: COLLECTION,
    entries: [vec('dog', [0.6, 0.4, 0], 'animal')],
    deletes: ['kitten'],
  });

const checkpointDir = mkdtempSync(join(tmpdir(), 'knit-offline-'));
const serve = process.argv.includes('--serve');

async function main(): Promise<void> {
  const node = new KnitNode({
    collections: [COLLECTION],
    source: log,
    checkpointDir,
    signingKey: OWNER.privateKey,
    onLog: (m) => console.log(`  [node] ${m}`),
  });

  console.log('\n1. Replaying the log\n');
  await node.sync();

  const stats = node.status();
  console.log(`\n   scanned to block ${stats.nextBlock}, ${stats.collections[0]?.size} vectors indexed`);
  console.log("   'trojan' is absent — the stranger was never an authorized writer");
  console.log("   'kitten' is absent — tombstoned in the same submission that moved 'dog'");

  console.log('\n2. Searching near the animal cluster\n');
  for (const hit of node.similaritySearch(COLLECTION, [0.95, 0.05, 0], 3)) {
    console.log(`   ${hit.id.padEnd(8)} distance ${hit.distance.toFixed(6)}  ${JSON.stringify(hit.metadata)}`);
  }

  console.log('\n3. Restarting from the signed checkpoint\n');
  const resumed = new KnitNode({
    collections: [COLLECTION],
    source: log,
    checkpointDir,
    // Load only what this key vouched for. Point it at another address and the
    // node refuses to start rather than trusting the snapshot on disk.
    trustedSigners: [OWNER.address],
    onLog: (m) => console.log(`  [node] ${m}`),
  });
  await resumed.sync();
  console.log(`\n   resumed with ${resumed.status().collections[0]?.size} vectors, without re-reading the log`);

  console.log('\n4. Determinism\n');
  // A second node, no checkpoint, replaying the same log from scratch. Same
  // writes in the same order, so the same index and the same answers — this is
  // the property the whole design exists to provide, so actually check it.
  const independent = new KnitNode({ collections: [COLLECTION], source: log });
  await independent.sync();

  const query = [0.95, 0.05, 0];
  const mine = node.similaritySearch(COLLECTION, query, 3);
  const theirs = independent.similaritySearch(COLLECTION, query, 3);
  const agree =
    JSON.stringify(mine.map((h) => [h.id, h.distance])) ===
    JSON.stringify(theirs.map((h) => [h.id, h.distance]));

  console.log(`   this node:        ${JSON.stringify(mine.map((h) => h.id))}`);
  console.log(`   independent node: ${JSON.stringify(theirs.map((h) => h.id))}`);
  console.log(`   identical ids and distances: ${agree ? 'yes' : 'NO'}`);
  if (!agree) throw new Error('determinism check failed — two replays of one log disagreed');

  if (!serve) {
    rmSync(checkpointDir, { recursive: true, force: true });
    console.log('\nDone. Re-run with --serve to keep the console open.\n');
    return;
  }

  const port = Number(process.env.KNIT_PORT ?? 3939);
  startRpcServer(node, port);
  console.log(`\n5. Console at http://localhost:${port}  (ctrl-c to stop)\n`);
  process.on('SIGINT', () => {
    rmSync(checkpointDir, { recursive: true, force: true });
    process.exit(0);
  });
}

main().catch((err) => {
  rmSync(checkpointDir, { recursive: true, force: true });
  console.error('failed:', err);
  process.exit(1);
});
