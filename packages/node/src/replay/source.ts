/**
 * The boundary between replay and the chain.
 *
 * Everything the {@link ReplayEngine} needs from the outside world is here:
 * how far the log goes, which submissions are in a block range, and the bytes
 * behind one. Ordering, tag filtering, access control and the fold into an
 * index are all on the replay side of this line, so they can be exercised
 * against a source that never touches a network.
 */

/** One Flow submission, reduced to what replay cares about. */
export interface LogSubmission {
  /** Submission index on the Log Layer. This *is* the deterministic order. */
  txSeq: number;
  /** Flow submission sender — the identity access control authorizes against. */
  sender: string;
  /** Stream ids named in the submission's tags. Lowercased, 0x-prefixed. */
  streamIds: string[];
}

export interface ReplaySource {
  /** Highest block currently readable. Replay never scans past it. */
  head(): Promise<number>;

  /**
   * Every stream submission in `[from, to]`, in any order — the engine sorts
   * by `txSeq` itself, since that is what determinism rests on.
   *
   * Async-iterable rather than an array because a cold start scans from
   * genesis: an implementation pages the range internally and yields as it
   * goes, so the caller holds only the submissions it actually wants.
   */
  submissions(from: number, to: number): AsyncIterable<LogSubmission>;

  /**
   * The raw `StreamData` bytes for a submission. Implementations may block
   * while the file finalizes; the engine treats this as "eventually returns or
   * throws".
   */
  data(txSeq: number): Promise<Uint8Array>;
}
