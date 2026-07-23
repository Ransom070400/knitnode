import { existsSync } from 'node:fs';
import { ethers } from 'ethers';
import { KnitNode, publishEntries, GALILEO_TESTNET } from '@knitnode/node';
import type { VectorEntry } from '@knitnode/protocol';

// Load .env if present (dep-free; Node 20.12+/22+).
if (existsSync(new URL('../.env', import.meta.url))) {
  process.loadEnvFile(new URL('../.env', import.meta.url));
}

const COLLECTION = 'demo-animals';

/**
 * Four toy 4-dim "embeddings" with two obvious clusters: animals live along the
 * first two axes, vehicles along the last two. A feline query should return the
 * cats before the dog and never a vehicle.
 */
const ENTRIES: VectorEntry[] = [
  { id: 'cat', dim: 4, vector: Float32Array.from([1.0, 0.0, 0.0, 0.0]), metadata: { text: 'cat', kind: 'animal' } },
  { id: 'kitten', dim: 4, vector: Float32Array.from([0.9, 0.1, 0.0, 0.0]), metadata: { text: 'kitten', kind: 'animal' } },
  { id: 'dog', dim: 4, vector: Float32Array.from([0.7, 0.3, 0.0, 0.0]), metadata: { text: 'dog', kind: 'animal' } },
  { id: 'car', dim: 4, vector: Float32Array.from([0.0, 0.0, 1.0, 0.0]), metadata: { text: 'car', kind: 'vehicle' } },
  { id: 'truck', dim: 4, vector: Float32Array.from([0.0, 0.0, 0.9, 0.1]), metadata: { text: 'truck', kind: 'vehicle' } },
];

const QUERY = [0.95, 0.05, 0.0, 0.0]; // "feline-ish"

async function main(): Promise<void> {
  const pk = process.env.KNIT_PRIVATE_KEY;
  if (!pk || pk.includes('YOUR_TESTNET')) {
    throw new Error(
      'Set KNIT_PRIVATE_KEY to a funded Galileo testnet key (see examples/basic/.env.example)',
    );
  }

  // 1) Note the current block BEFORE writing, so replay only scans a tiny recent
  //    range instead of the whole chain from genesis.
  const provider = new ethers.JsonRpcProvider(GALILEO_TESTNET.evmRpc);
  const startBlock = Math.max(0, (await provider.getBlockNumber()) - 5);
  console.log(`▸ current block ${startBlock + 5}; replay will scan from ${startBlock}`);

  // 2) WRITE: publish the entries as one tagged KV submission on 0G.
  console.log(`▸ publishing ${ENTRIES.length} entries to collection "${COLLECTION}"...`);
  const pub = await publishEntries(GALILEO_TESTNET, pk, COLLECTION, ENTRIES);
  console.log(`  txHash=${pub.txHash}`);
  console.log(`  root=${pub.rootHash}`);
  console.log(`  streamId=${pub.streamId}`);

  // 3) REPLAY: spin up a KnitNode pointed at the same stream and rebuild the index.
  console.log('▸ starting KnitNode and replaying the stream...');
  const node = new KnitNode({
    network: GALILEO_TESTNET,
    collections: [COLLECTION],
    startBlock,
    onLog: (m) => console.log(`  [knitnode] ${m}`),
  });
  await node.sync();

  // 4) QUERY: top-k similarity search over the replayed index.
  console.log(`▸ similaritySearch("${COLLECTION}", [${QUERY.join(', ')}], k=3):`);
  const hits = node.similaritySearch(COLLECTION, QUERY, 3);
  for (const [i, h] of hits.entries()) {
    console.log(
      `   ${i + 1}. ${h.id.padEnd(8)} distance=${h.distance.toFixed(4)}  ${JSON.stringify(h.metadata)}`,
    );
  }

  const top = hits[0]?.id;
  if (top === 'cat' || top === 'kitten') {
    console.log('\n✓ end-to-end write → replay → query loop succeeded.');
  } else {
    console.log(`\n⚠ unexpected top hit "${top}" — check replay/download.`);
  }
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
