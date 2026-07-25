import { ethers } from 'ethers';
import {
  Indexer,
  StorageNode,
  FixedPriceFlow__factory,
} from '@0gfoundation/0g-storage-ts-sdk';
import type { NetworkConfig } from '../config.js';
import { decodeStreamData, decodeStreamTags, type StreamWrite } from './streamdata.js';
import { AccessControlSet, processSubmission } from './acl.js';

/** A KV write, tagged with the log height it was applied at (for ordering). */
export interface ReplayWrite extends StreamWrite {
  /** Submission index on the Log Layer == deterministic insertion order. */
  logHeight: number;
  /** Flow submission sender (tx.sender), lowercased 0x address. */
  sender: string;
}

export interface ReplayEngineOpts {
  network: NetworkConfig;
  /** Stream ids to keep (others on the log are skipped). */
  watchedStreamIds: Iterable<string>;
  /** First block to scan. */
  startBlock: number;
  /** getLogs window; some RPCs cap the block span per call. */
  blockPageSize?: number;
  /**
   * Enforce 0G stream access control on replay (default true): only writes from
   * an authorized sender reach the handler. Disable to index every write blindly.
   */
  enforceAcl?: boolean;
  /** Resume ACL state from a checkpoint. Fresh (empty) if omitted. */
  initialAcl?: AccessControlSet;
  onLog?: (msg: string) => void;
}

const DEFAULT_PAGE = 5000;

/**
 * The replay engine: the TypeScript re-implementation of the 0G KV node's read
 * loop. It scans Flow `Submit` events, keeps the ones whose tags target a
 * watched stream, downloads each tagged `StreamData` file, decodes it, and
 * hands the writes back in strict log-height order.
 *
 * This is the piece the SDK does NOT ship — the SDK gives us tag/StreamData
 * encoding and file download; the scan→match→download→decode pipeline is ours.
 */
export class ReplayEngine {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly flow: ReturnType<typeof FixedPriceFlow__factory.connect>;
  private readonly indexer: Indexer;
  private readonly watched: Set<string>;
  private nodes: StorageNode[] = [];
  /** Next block to scan; advances as we catch up. */
  private cursor: number;
  private readonly enforceAcl: boolean;
  private readonly acl: AccessControlSet;

  constructor(private readonly opts: ReplayEngineOpts) {
    this.enforceAcl = opts.enforceAcl ?? true;
    this.acl = opts.initialAcl ?? new AccessControlSet();
    this.provider = new ethers.JsonRpcProvider(opts.network.evmRpc);
    // Cast around the SDK/ethers ESM-vs-CJS dual-package type mismatch; a
    // read-only provider is a valid ContractRunner at runtime.
    this.flow = FixedPriceFlow__factory.connect(
      opts.network.flowContract,
      this.provider as unknown as Parameters<typeof FixedPriceFlow__factory.connect>[1],
    );
    this.indexer = new Indexer(opts.network.indexerRpc);
    this.watched = new Set(
      [...opts.watchedStreamIds].map((s) => s.toLowerCase()),
    );
    this.cursor = opts.startBlock;
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  /** Next block to scan. Persist this to resume replay without rescanning. */
  get nextBlock(): number {
    return this.cursor;
  }

  /** The replayed access-control state. Persist alongside the cursor. */
  get accessControl(): AccessControlSet {
    return this.acl;
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

  /**
   * Scan from the current cursor to chain head, yielding every write to a
   * watched stream, ordered by log height. Advances the cursor so a subsequent
   * call only processes new blocks (this is how continuous replay works).
   */
  async catchUp(handler: (write: ReplayWrite) => void | Promise<void>): Promise<number> {
    const head = await this.provider.getBlockNumber();
    if (this.cursor > head) return head;

    const page = this.opts.blockPageSize ?? DEFAULT_PAGE;
    const filter = this.flow.filters.Submit();

    // Collect matching submissions across all pages first, then process in
    // strict logHeight order — determinism depends on insertion order.
    const pending: { txSeq: number; sender: string; streamIds: string[] }[] = [];

    for (let from = this.cursor; from <= head; from += page) {
      const to = Math.min(from + page - 1, head);
      const events = await this.flow.queryFilter(filter, from, to);
      for (const ev of events) {
        const parsed = this.parseSubmit(ev);
        if (!parsed) continue;
        if (!parsed.streamIds.some((id) => this.watched.has(id))) continue;
        pending.push(parsed);
      }
      this.log(`scanned blocks ${from}..${to} (${events.length} submissions)`);
    }

    pending.sort((a, b) => a.txSeq - b.txSeq);
    this.log(`${pending.length} matching submission(s) to replay`);

    let denied = 0;
    for (const item of pending) {
      const bytes = await this.downloadFile(item.txSeq);
      const { writes, controls } = decodeStreamData(bytes);
      const isWatched = (id: string) => this.watched.has(id.toLowerCase());

      const watchedWrites = writes.filter((w) => isWatched(w.streamId));
      const emit = (w: StreamWrite) =>
        handler({ ...w, logHeight: item.txSeq, sender: item.sender });

      if (this.enforceAcl) {
        denied += processSubmission(
          this.acl,
          {
            logHeight: item.txSeq,
            sender: item.sender,
            streamIds: item.streamIds.filter(isWatched),
            writes: watchedWrites,
            controls: controls.filter((c) => isWatched(c.streamId)),
          },
          (w) => void emit(w),
        );
      } else {
        for (const w of watchedWrites) await emit(w);
      }
    }
    if (denied > 0) this.log(`ACL: rejected ${denied} unauthorized write(s)`);

    this.cursor = head + 1;
    return head;
  }

  /** Decode a Submit event into txSeq, sender, and the stream ids it tags. */
  // `ev` is a TypedEventLog; typed loosely to sidestep the ethers dual-package
  // .d.ts mismatch between the SDK (CJS) and our (ESM) ethers resolution.
  private parseSubmit(
    ev: { args?: Record<string | number, unknown> },
  ): { txSeq: number; sender: string; streamIds: string[] } | null {
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

  /**
   * Fetch the raw file bytes for a submission by its txSeq. Resolves the file's
   * merkle root + size from a storage node, then pulls the bytes via the
   * indexer. Retries while the file is still finalizing.
   */
  private async downloadFile(txSeq: number): Promise<Uint8Array> {
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
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
