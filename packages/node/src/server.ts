import { createServer, type Server } from 'node:http';
import type { KnitNode } from './knitnode.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

/**
 * Minimal JSON-RPC 2.0 endpoint over HTTP (POST /). No framework — Node's http
 * is enough for Phase 1. Methods:
 *   - similaritySearch({ collection, queryVector, k }) -> SearchHit[]
 *   - collections() -> stats[]
 *
 * Also serves GET /health for liveness checks.
 */
export function startRpcServer(node: KnitNode, port: number): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(body);
      } catch {
        return reply(res, null, undefined, { code: -32700, message: 'parse error' });
      }
      const id = rpc.id ?? null;
      try {
        const result = dispatch(node, rpc);
        reply(res, id, result);
      } catch (err) {
        reply(res, id, undefined, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
  server.listen(port);
  return server;
}

function dispatch(node: KnitNode, rpc: JsonRpcRequest): unknown {
  switch (rpc.method) {
    case 'similaritySearch': {
      const p = (rpc.params ?? {}) as {
        collection?: string;
        queryVector?: number[];
        k?: number;
      };
      if (!p.collection || !Array.isArray(p.queryVector)) {
        throw new Error('similaritySearch requires { collection, queryVector, k }');
      }
      return node.similaritySearch(p.collection, p.queryVector, p.k ?? 10);
    }
    case 'collections':
      return node.stats();
    default:
      throw new Error(`unknown method "${rpc.method}"`);
  }
}

function reply(
  res: import('node:http').ServerResponse,
  id: string | number | null | undefined,
  result?: unknown,
  error?: { code: number; message: string },
): void {
  res.writeHead(error ? 400 : 200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      error
        ? { jsonrpc: '2.0', id: id ?? null, error }
        : { jsonrpc: '2.0', id: id ?? null, result },
    ),
  );
}
