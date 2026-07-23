import { KnitNode } from './knitnode.js';
import { startRpcServer } from './server.js';
import { GALILEO_TESTNET } from './config.js';

/**
 * CLI entrypoint: `tsx src/main.ts <collection> [<collection> ...]`
 *
 * Env:
 *   KNIT_PORT           RPC port (default 3939)
 *   KNIT_POLL_MS        replay poll interval (default 5000)
 *   KNIT_START_BLOCK    first Flow block to scan (default 0)
 *   KNIT_CHECKPOINT_DIR persist index + cursor here; resumes on restart
 *   KNIT_*              network overrides (see config.ts)
 */
async function main(): Promise<void> {
  const collections = process.argv.slice(2);
  if (collections.length === 0) {
    console.error('usage: tsx src/main.ts <collection> [<collection> ...]');
    process.exit(1);
  }

  const port = Number(process.env.KNIT_PORT ?? 3939);
  const pollMs = Number(process.env.KNIT_POLL_MS ?? 5000);

  const node = new KnitNode({
    network: GALILEO_TESTNET,
    collections,
    checkpointDir: process.env.KNIT_CHECKPOINT_DIR,
    onLog: (msg) => console.log(`[knitnode] ${msg}`),
  });

  const server = startRpcServer(node, port);
  console.log(`[knitnode] JSON-RPC listening on http://localhost:${port}`);
  console.log(`[knitnode] watching: ${collections.join(', ')}`);

  const controller = new AbortController();
  const shutdown = () => {
    console.log('\n[knitnode] shutting down');
    controller.abort();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await node.watch(pollMs, controller.signal);
}

main().catch((err) => {
  console.error('[knitnode] fatal:', err);
  process.exit(1);
});
