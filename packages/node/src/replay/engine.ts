import { decodeStreamData, type StreamWrite } from './streamdata.js';
import { AccessControlSet, processSubmission } from './acl.js';
import type { LogSubmission, ReplaySource } from './source.js';

/** A KV write, tagged with the log height it was applied at (for ordering). */
export interface ReplayWrite extends StreamWrite {
  /** Submission index on the Log Layer == deterministic insertion order. */
  logHeight: number;
  /** Flow submission sender (tx.sender), lowercased 0x address. */
  sender: string;
}

export interface ReplayEngineOpts {
  /** Where submissions come from. Inject a fake to replay without a chain. */
  source: ReplaySource;
  /** Stream ids to keep (others on the log are skipped). */
  watchedStreamIds: Iterable<string>;
  /** First block to scan. */
  startBlock: number;
  /**
   * Enforce 0G stream access control on replay (default true): only writes from
   * an authorized sender reach the handler. Disable to index every write blindly.
   */
  enforceAcl?: boolean;
  /** Resume ACL state from a checkpoint. Fresh (empty) if omitted. */
  initialAcl?: AccessControlSet;
  onLog?: (msg: string) => void;
}

/**
 * The replay engine: the TypeScript re-implementation of the 0G KV node's read
 * loop. It asks a {@link ReplaySource} what is on the log, keeps the
 * submissions whose tags target a watched stream, decodes each one's
 * `StreamData`, and hands the writes back in strict log-height order.
 *
 * Nothing here knows about a chain. The network lives behind the source, which
 * is what lets the parts that actually define the protocol — ordering, tag
 * filtering, access control — be replayed offline and asserted on.
 */
export class ReplayEngine {
  private readonly watched: Set<string>;
  private readonly source: ReplaySource;
  /** Next block to scan; advances as we catch up. */
  private cursor: number;
  private readonly enforceAcl: boolean;
  private readonly acl: AccessControlSet;

  constructor(private readonly opts: ReplayEngineOpts) {
    this.source = opts.source;
    this.enforceAcl = opts.enforceAcl ?? true;
    this.acl = opts.initialAcl ?? new AccessControlSet();
    this.watched = new Set([...opts.watchedStreamIds].map((s) => s.toLowerCase()));
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

  /**
   * Scan from the current cursor to chain head, yielding every write to a
   * watched stream, ordered by log height. Advances the cursor so a subsequent
   * call only processes new blocks (this is how continuous replay works).
   */
  async catchUp(handler: (write: ReplayWrite) => void | Promise<void>): Promise<number> {
    const head = await this.source.head();
    if (this.cursor > head) return head;

    // Collect matching submissions across the whole range first, then process
    // in strict logHeight order — determinism depends on insertion order, and
    // a source is free to yield submissions in whatever order it finds them.
    const pending: LogSubmission[] = [];
    for await (const sub of this.source.submissions(this.cursor, head)) {
      if (sub.streamIds.some((id) => this.watched.has(id))) pending.push(sub);
    }

    pending.sort((a, b) => a.txSeq - b.txSeq);
    this.log(`${pending.length} matching submission(s) to replay`);

    let denied = 0;
    for (const item of pending) {
      const bytes = await this.source.data(item.txSeq);
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
}
