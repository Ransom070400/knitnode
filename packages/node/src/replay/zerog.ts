import { ethers } from 'ethers';
import {
  Indexer,
  StorageNode,
  FixedPriceFlow__factory,
} from '@0gfoundation/0g-storage-ts-sdk';
import type { NetworkConfig } from '../config.js';
import { decodeStreamTags } from './streamdata.js';
import type { LogSubmission, ReplaySource } from './source.js';

/** Some RPCs cap how many blocks a single `getLogs` may span. */
const DEFAULT_PAGE = 5000;

export interface ZeroGSourceOpts {
  network: NetworkConfig;
  /** `getLogs` window. Lower it if the RPC rejects wide ranges. */
  blockPageSize?: number;
  onLog?: (msg: string) => void;
}

/**
 * The real {@link ReplaySource}: 0G's Log Layer, read through Flow `Submit`
 * events and the storage indexer.
 *
 * This is the half the SDK does not ship. The SDK encodes tags and StreamData
 * and downloads files by root hash; walking the log to find which submissions
 * carry stream writes, and pulling their bytes back, is ours — as is the
 * patience for a chain that finalizes and indexes on its own schedule.
 */
export class ZeroGSource implements ReplaySource {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly flow: ReturnType<typeof FixedPriceFlow__factory.connect>;
  private readonly indexer: Indexer;
  private readonly pageSize: number;
  private nodes: StorageNode[] = [];

  constructor(private readonly opts: ZeroGSourceOpts) {
    this.pageSize = opts.blockPageSize ?? DEFAULT_PAGE;
    this.provider = new ethers.JsonRpcProvider(opts.network.evmRpc);
    // Cast around the SDK/ethers ESM-vs-CJS dual-package type mismatch; a
    // read-only provider is a valid ContractRunner at runtime.
    this.flow = FixedPriceFlow__factory.connect(
      opts.network.flowContract,
      this.provider as unknown as Parameters<typeof FixedPriceFlow__factory.connect>[1],
    );
    this.indexer = new Indexer(opts.network.indexerRpc);
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  async head(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Walk `[from, to]` in `getLogs`-sized pages, yielding every submission whose
   * tags parse as stream ids. Paging is this source's concern — it exists
   * because of an RPC limit, not because replay wants it — so the engine sees
   * one flat stream and only holds what it keeps.
   */
  async *submissions(from: number, to: number): AsyncIterable<LogSubmission> {
    const filter = this.flow.filters.Submit();
    for (let start = from; start <= to; start += this.pageSize) {
      const end = Math.min(start + this.pageSize - 1, to);
      const events = await this.flow.queryFilter(filter, start, end);
      for (const ev of events) {
        const parsed = parseSubmit(ev);
        if (parsed) yield parsed;
      }
      this.log(`scanned blocks ${start}..${end} (${events.length} submissions)`);
    }
  }

  /**
   * Fetch the raw file bytes for a submission by its txSeq. Resolves the file's
   * merkle root + size from a storage node, then pulls the bytes via the
   * indexer. Retries while the file is still finalizing.
   */
  async data(txSeq: number): Promise<Uint8Array> {
    const nodes = await this.ensureNodes();

    let root: string | undefined;
    let size: number | undefined;
    for (let attempt = 0; attempt < 30 && root === undefined; attempt++) {
      for (const node of nodes) {
        const info = await node.getFileInfoByTxSeq(txSeq).catch(() => null);
        if (info?.finalized) {
          root = info.tx.dataMerkleRoot;
          size = info.tx.size;
          break;
        }
      }
      if (root === undefined) {
        this.log(`txSeq ${txSeq} not finalized yet, waiting...`);
        await delay(2000);
      }
    }
    if (root === undefined) {
      throw new Error(`file for txSeq ${txSeq} never finalized`);
    }

    // Indexer file-location registration can lag finalization; retry a few times.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 15; attempt++) {
      const [blob, err] = await this.indexer.downloadToBlob(root);
      if (!err) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return size !== undefined && size < bytes.length
          ? bytes.subarray(0, size)
          : bytes;
      }
      lastErr = err;
      this.log(`download of ${root} not ready (attempt ${attempt + 1}), retrying...`);
      await delay(2000);
    }
    throw new Error(`download of ${root} failed: ${lastErr}`);
  }

  /** Lazily select a covering set of storage nodes for downloads. */
  private async ensureNodes(): Promise<StorageNode[]> {
    if (this.nodes.length > 0) return this.nodes;
    const [nodes, err] = await this.indexer.selectNodes(1);
    if (err || nodes.length === 0) {
      throw new Error(`failed to select storage nodes: ${err ?? 'none available'}`);
    }
    this.nodes = nodes;
    return nodes;
  }
}

/** Decode a Submit event into txSeq, sender, and the stream ids it tags. */
// `ev` is a TypedEventLog; typed loosely to sidestep the ethers dual-package
// .d.ts mismatch between the SDK (CJS) and our (ESM) ethers resolution.
function parseSubmit(ev: { args?: Record<string | number, unknown> }): LogSubmission | null {
  if (!ev.args) return null;
  const args = ev.args as {
    sender?: string;
    submissionIndex?: bigint;
    submission?: { tags?: string };
    [k: number]: unknown;
  };
  const submission = (args.submission ?? args[5]) as { tags?: string } | undefined;
  const submissionIndex = (args.submissionIndex ?? args[2]) as bigint | undefined;
  const sender = (args.sender ?? args[0]) as string | undefined;
  if (submission?.tags == null || submissionIndex == null || sender == null) return null;

  const tagBytes = ethers.getBytes(submission.tags);
  const streamIds = decodeStreamTags(tagBytes).map((s) => s.toLowerCase());
  if (streamIds.length === 0) return null;
  return { txSeq: Number(submissionIndex), sender: sender.toLowerCase(), streamIds };
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
