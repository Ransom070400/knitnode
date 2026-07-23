import { existsSync } from 'node:fs';
import { ethers } from 'ethers';
import { KnitStore, GALILEO_TESTNET } from '@knitnode/node';
import type { VectorEntry } from '@knitnode/protocol';

// Load env (dep-free; Node 20.12+/22+). `.env.local` (gitignored — put your
// real key there) is loaded first; loadEnvFile keeps the first value set, so it
// wins over the committed `.env` template.
for (const name of ['.env.local', '.env']) {
  const url = new URL(`../${name}`, import.meta.url);
  if (existsSync(url)) process.loadEnvFile(url);
}

const COLLECTION = 'demo-fruit';

// Six toy 3-dim "embeddings": sweet fruit cluster on axis 0, citrus on axis 1,
// a lone vegetable on axis 2. A "sweet" query should surface the sweet fruit.
const ENTRIES: VectorEntry[] = [
  { id: 'apple', dim: 3, vector: Float32Array.from([1.0, 0.0, 0.0]), metadata: { text: 'apple', taste: 'sweet' } },
  { id: 'pear', dim: 3, vector: Float32Array.from([0.9, 0.1, 0.0]), metadata: { text: 'pear', taste: 'sweet' } },
  { id: 'lemon', dim: 3, vector: Float32Array.from([0.1, 0.9, 0.0]), metadata: { text: 'lemon', taste: 'sour' } },
  { id: 'lime', dim: 3, vector: Float32Array.from([0.0, 1.0, 0.0]), metadata: { text: 'lime', taste: 'sour' } },
  { id: 'kale', dim: 3, vector: Float32Array.from([0.0, 0.0, 1.0]), metadata: { text: 'kale', taste: 'bitter' } },
];

const QUERY = [0.95, 0.05, 0.0]; // "sweet-ish"

async function main(): Promise<void> {
  const pk = process.env.KNIT_PRIVATE_KEY;
  if (!pk || pk.includes('YOUR_TESTNET')) {
    throw new Error(
      'Set KNIT_PRIVATE_KEY to a funded Galileo testnet key (see examples/store/.env.example)',
    );
  }
  const checkpointDir = process.env.KNIT_CHECKPOINT_DIR ?? '.knit-checkpoints';

  // Cold start: begin scanning near head so replay is fast. On a resumed run
  // the checkpoint's saved cursor overrides this, so the value is only used the
  // first time.
  const provider = new ethers.JsonRpcProvider(GALILEO_TESTNET.evmRpc);
  const startBlock = Math.max(0, (await provider.getBlockNumber()) - 5);

  // One object binds the write path (add) and the read path (sync/search) to a
  // single collection, and persists to `checkpointDir`.
  const store = new KnitStore({
    collection: COLLECTION,
    privateKey: pk,
    startBlock,
    checkpointDir,
    onLog: (m) => console.log(`  [knitstore] ${m}`),
  });

  // If the checkpoint already holds this collection, skip the write and just
  // catch up — this is the resume path. Otherwise publish the seed entries.
  if (store.size > 0) {
    console.log(`▸ resumed ${store.size} entries from checkpoint "${checkpointDir}" — skipping write`);
  } else {
    console.log(`▸ publishing ${ENTRIES.length} entries to "${COLLECTION}"...`);
    const pub = await store.add(ENTRIES);
    console.log(`  txHash=${pub.txHash}  root=${pub.rootHash}`);
  }

  console.log('▸ syncing (replaying the stream into the local index)...');
  await store.sync();

  console.log(`▸ search([${QUERY.join(', ')}], k=3):`);
  for (const [i, h] of store.search(QUERY, 3).entries()) {
    console.log(
      `   ${i + 1}. ${h.id.padEnd(6)} distance=${h.distance.toFixed(4)}  ${JSON.stringify(h.metadata)}`,
    );
  }

  const top = store.search(QUERY, 1)[0]?.id;
  if (top === 'apple' || top === 'pear') {
    console.log('\n✓ KnitStore add → sync → search succeeded. Re-run to see the checkpoint resume.');
  } else {
    console.log(`\n⚠ unexpected top hit "${top}" — check replay/download.`);
  }
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
