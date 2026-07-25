# knitnode

[![CI](https://github.com/Ransom070400/knitnode/actions/workflows/ci.yml/badge.svg)](https://github.com/Ransom070400/knitnode/actions/workflows/ci.yml)

**A decentralized vector-search layer on [0G Storage](https://0g.ai).**

knitnode is a KV node with a twist: instead of replaying a tagged 0G KV stream
into a key→value map, it replays it into an **HNSW vector index** — so the same
decentralized log that backs a key-value store also backs *similarity search*.

Writers publish vector entries as ordinary tagged KV writes on the 0G Log Layer.
Any node, given only a collection name, derives the same stream id, replays the
same writes in the same order, and builds a **byte-identical** index answering
identical top-k queries. No coordination, no central index server.

```
   writer                      0G Storage                     KnitNode
  ┌──────┐   publishEntries   ┌────────────┐   replay      ┌─────────────┐
  │vectors│ ───────────────▶ │ tagged KV   │ ───────────▶ │ HNSW index  │ ──▶ top-k
  └──────┘   (Flow submit)    │ log stream  │  scan+decode  │ per collection│
                              └────────────┘               └─────────────┘
```

## Why

A vector index is just a deterministic fold over an ordered write log. If the log
is decentralized and the fold is deterministic, the index needs no trusted host —
anyone can rebuild and verify it. knitnode is that fold for HNSW on 0G.

## Layout

This is a pnpm monorepo (`type: module`, Node ≥ 20).

| Package | What |
|---|---|
| `packages/protocol` | Binary entry codec, collection tags, deterministic stream-id derivation. Zero network deps. |
| `packages/node` | `KnitNode` replay engine, `CollectionIndex` (HNSW), `writer`, JSON-RPC `server`, `KnitStore` façade, checkpointing. |
| `examples/basic` | Low-level end-to-end demo: `publishEntries` → `KnitNode` → `similaritySearch`. |
| `examples/store` | Ergonomic demo: `KnitStore.add`/`sync`/`search`, with a persistent checkpoint. |

## Install & build

```bash
pnpm install       # hnswlib-node compiles a native addon here (needs a C++ toolchain)
pnpm typecheck
pnpm test          # 19 offline tests — no network or testnet key required
pnpm build
```

> **Native addon note.** `hnswlib-node` builds `addon.node` at install time. If it's
> missing (`Could not locate the bindings file`), rebuild it:
> ```bash
> cd node_modules/.pnpm/hnswlib-node@*/node_modules/hnswlib-node && npx node-gyp rebuild
> ```

## Quickstart

### Ergonomic: `KnitStore` (recommended)

One object bound to a single collection handles both writing and reading.

```ts
import { KnitStore } from '@knitnode/node';

const store = new KnitStore({
  collection: 'memories',
  privateKey: process.env.KNIT_PRIVATE_KEY, // funded Galileo testnet key
  checkpointDir: '.knit-checkpoints',       // optional: persist + resume
});

// WRITE — publish vectors to the collection's 0G stream
await store.upsert('cat', [1, 0, 0], { kind: 'animal' });
await store.add([
  { id: 'kitten', dim: 3, vector: Float32Array.from([0.9, 0.1, 0]), metadata: {} },
]);

// READ — replay the stream back into a local index, then search
await store.sync();
store.search([0.95, 0.05, 0], 5);
// → [{ id: 'cat', distance: …, metadata: { kind: 'animal' } }, …]
```

A store built without a `privateKey` is read-only: `sync`/`search` work, `add` throws.

### Low-level: split writer + node

`KnitStore` is a façade over two independent halves you can use directly:

```ts
import { publishEntries, KnitNode, GALILEO_TESTNET } from '@knitnode/node';

await publishEntries(GALILEO_TESTNET, privateKey, 'memories', entries);

const node = new KnitNode({ collections: ['memories'], startBlock });
await node.sync();
node.similaritySearch('memories', [0.95, 0.05, 0], 5);
```

See `examples/basic` and `examples/store`. Both need a funded testnet key — copy
`.env.example` to `.env` and set `KNIT_PRIVATE_KEY` (faucet:
<https://docs.0g.ai/developer-hub/testnet/faucet>). Run with `pnpm --filter @knitnode/example-store dev`.

## Running a node

```bash
KNIT_CHECKPOINT_DIR=.knit-checkpoints pnpm --filter @knitnode/node start memories other-collection
```

Serves JSON-RPC 2.0 over HTTP (default `:3939`) and continuously replays new
submissions:

| Method | Params | Returns |
|---|---|---|
| `similaritySearch` | `{ collection, queryVector, k }` | `SearchHit[]` |
| `collections` | — | per-collection `{ collection, dim, size, metric }` |

`GET /health` → `{ status: "ok" }`.

```bash
curl -s localhost:3939 -d '{"jsonrpc":"2.0","id":1,"method":"similaritySearch",
  "params":{"collection":"memories","queryVector":[0.95,0.05,0],"k":3}}'
```

### Environment

| Var | Default | Meaning |
|---|---|---|
| `KNIT_PRIVATE_KEY` | — | Funded Galileo key (writes only) |
| `KNIT_PORT` | `3939` | RPC port |
| `KNIT_POLL_MS` | `5000` | Replay poll interval |
| `KNIT_START_BLOCK` | `0` | First Flow block to scan on cold start |
| `KNIT_CHECKPOINT_DIR` | — | Persist index + cursor here; resume on restart |
| `KNIT_ENFORCE_ACL` | `true` | `false` indexes every write, skipping access control |
| `KNIT_EVM_RPC` / `KNIT_FLOW_CONTRACT` / `KNIT_INDEXER_RPC` / `KNIT_CHAIN_ID` | Galileo V3 | Network overrides |

## Checkpointing

Cold start replays from `KNIT_START_BLOCK` (0 = genesis, slow on a busy chain).
Set `checkpointDir` / `KNIT_CHECKPOINT_DIR` and a node saves, after each catch-up,
a binary HNSW snapshot per collection plus the next-block cursor (`manifest.json`).
On restart it restores the snapshots and resumes scanning from the saved cursor
instead of re-deriving from the log. Snapshot metadata must be JSON-serializable.

Each snapshot carries a **content digest** — a sha256 over dim, metric, and every
point in label order (id, vector, canonical metadata), recorded in the sidecar
and the manifest. `loadFrom` recomputes it and refuses a snapshot whose `.hnsw`
or `.json` was corrupted or altered. Because it's deterministic, two nodes that
replayed the same log produce the **same digest** — a cross-node agreement
fingerprint. (It's an integrity checksum, not a signature; authenticating a
snapshot against a forging peer needs a signed manifest — future work.)

## Access control

Replay enforces 0G stream access control, so a collection isn't a free-for-all —
only authorized senders' vectors are indexed (default on; disable with
`enforceAcl: false`). The rules mirror the 0G KV node:

- The **first sender** to write a stream is bootstrapped as its **admin**. In the
  common single-writer case this is transparent — you write your own collection
  and everything you publish is indexed.
- A write to a **normal** key needs admin or a stream **write role**; a **special**
  key needs admin or that key's **special-write role**.
- Admins grant/revoke roles and mark keys special via control ops carried in the
  same `StreamData`; unauthorized writes and ops are silently dropped on replay.

The authorization identity is the **Flow submission's sender**. ACL state is part
of replay state and is persisted in checkpoints, so a resumed node keeps enforcing
correctly instead of forgetting who is admin.

## Determinism

Reproducible indexes are the whole point, so these are part of the protocol
contract, not tunables:

- **Insertion order** = Log-Layer submission order. The replay engine collects all
  matching submissions, sorts by log height, then applies them.
- **Fixed HNSW params + seed** (`M`, `efConstruction`, `efSearch`, `randomSeed` in
  `config.ts`). Changing them forks the index; version them into the tag if you must.
- **Little-endian, fixed-width wire format** (`protocol/entry.ts`) so bytes are
  identical across architectures.

## Wire format

- **Collection tag** — `knitnode:v1:<collection>`, projected to a 32-byte 0G stream
  id via `keccak256`.
- **Entry** — `[version | flags | dim | idLen | metaLen | id(utf8) | vector(f32 LE) | metadata(CBOR)]`.
- **StreamData** — knitnode ships a decoder for 0G's `StreamData` blob (the SDK
  provides only the encoder); it's tested byte-for-byte against the SDK's `encode()`.

## Status

Phase 1 (write path + replay + search + RPC) and Phase 2 (`KnitStore`) are done,
with checkpointing, content-digest–verified snapshots, and replay-time access
control. Remaining: a signed snapshot manifest (authentication, not just
integrity), and horizontal scale-out (sharding a collection across nodes).

## License

[MIT](./LICENSE) © Eze Ransom
