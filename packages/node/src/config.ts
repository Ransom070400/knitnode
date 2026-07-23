/**
 * 0G Galileo testnet (V3) defaults. These rotate — always cross-check against
 * docs.0g.ai/developer-hub/testnet/testnet-overview. Overridable via env so the
 * demo and CI can point at a different network without code changes.
 */
export interface NetworkConfig {
  /** EVM JSON-RPC used for reading Flow `Submit` logs. */
  evmRpc: string;
  /** 0G Flow (log layer) contract — the `submit()` target we scan for tags. */
  flowContract: string;
  /** Storage indexer used to locate nodes and download files by root hash. */
  indexerRpc: string;
  /** Chain id, for sanity checks and signer wiring. */
  chainId: number;
}

export const GALILEO_TESTNET: NetworkConfig = {
  evmRpc: process.env.KNIT_EVM_RPC ?? 'https://evmrpc-testnet.0g.ai',
  flowContract:
    process.env.KNIT_FLOW_CONTRACT ??
    '0x22E03a6A89B950F1c82ec5e74F8eCa321a105296',
  indexerRpc:
    process.env.KNIT_INDEXER_RPC ??
    'https://indexer-storage-testnet-turbo.0g.ai',
  chainId: Number(process.env.KNIT_CHAIN_ID ?? 16601),
};

/**
 * Deterministic HNSW parameters. These are part of the protocol contract: any
 * two nodes replaying the same stream MUST use identical params (plus identical
 * insertion order) to produce identical top-k. Do not make these configurable
 * per-node without also versioning them into the tag.
 */
export const HNSW_PARAMS = {
  M: 16,
  efConstruction: 200,
  /** Fixed RNG seed — the whole point of determinism. */
  randomSeed: 100,
  /** Search-time breadth. Also fixed so recall is reproducible. */
  efSearch: 200,
} as const;

/**
 * Block from which to begin scanning Flow logs. 0 = genesis (correct but slow
 * on a busy chain). For the demo we start near head via env to keep cold-start
 * replay fast; a production node would checkpoint this.
 */
export const DEFAULT_START_BLOCK = Number(process.env.KNIT_START_BLOCK ?? 0);
