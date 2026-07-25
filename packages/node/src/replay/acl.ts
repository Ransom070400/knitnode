import type { StreamControl } from './streamdata.js';

/**
 * 0G KV access-control op codes (mirrors the Rust KV node's AccessControlType).
 * The high nibble groups an op with its renounce/counterpart.
 */
export const AccessControlType = {
  GrantAdminRole: 0x00,
  RenounceAdminRole: 0x01,
  SetKeyToSpecial: 0x10,
  SetKeyToNormal: 0x11,
  GrantWriteRole: 0x20,
  RevokeWriteRole: 0x21,
  RenounceWriteRole: 0x22,
  GrantSpecialWriteRole: 0x30,
  RevokeSpecialWriteRole: 0x31,
  RenounceSpecialWriteRole: 0x32,
} as const;

/** A submission's writes/controls plus the identity that authorized them. */
export interface Submission {
  logHeight: number;
  /** Flow submission sender (tx.sender), lowercased 0x address. */
  sender: string;
  /** Stream ids declared in the submission tags (drives admin bootstrap). */
  streamIds: string[];
  writes: { streamId: string; key: Uint8Array }[];
  controls: StreamControl[];
}

/** Serializable snapshot of an {@link AccessControlSet}, for checkpoints. */
export interface AccessControlState {
  admins: string[];
  writers: string[];
  specialKeys: string[];
  specialWriters: string[];
  knownStreams: string[];
}

function keyHex(key?: Uint8Array): string {
  if (!key) return '';
  let s = '';
  for (const b of key) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * The per-stream access-control state, replayed deterministically alongside the
 * index. Faithful to the 0G KV replayer:
 *
 * - The first sender to touch a stream is auto-granted admin (bootstrap).
 * - A write to a normal key needs admin or stream-writer; to a special key,
 *   admin or that key's special-writer.
 * - Admin ops need admin; granting write/special-write also allows an existing
 *   writer/key-writer; renounce ops act on the sender itself.
 *
 * Because it is part of replay state, it is serialized into checkpoints — a
 * node that resumes without it would forget who is admin and reject valid
 * writes. Determinism: same log, same order ⇒ same ACL state.
 */
export class AccessControlSet {
  private admins = new Set<string>(); // `${stream}|${account}`
  private writers = new Set<string>(); // `${stream}|${account}`
  private specialKeys = new Set<string>(); // `${stream}|${keyHex}`
  private specialWriters = new Set<string>(); // `${stream}|${keyHex}|${account}`
  private knownStreams = new Set<string>(); // streams that have an admin

  private static norm(s: string): string {
    return s.toLowerCase();
  }

  /** First sender to touch a stream becomes its admin (0G bootstrap rule). */
  bootstrapIfNew(streamId: string, sender: string): void {
    const stream = AccessControlSet.norm(streamId);
    if (this.knownStreams.has(stream)) return;
    this.knownStreams.add(stream);
    this.admins.add(`${stream}|${AccessControlSet.norm(sender)}`);
  }

  isAdmin(streamId: string, account: string): boolean {
    return this.admins.has(`${AccessControlSet.norm(streamId)}|${AccessControlSet.norm(account)}`);
  }

  /** May `sender` write `key` in `streamId` under the current state? */
  hasWritePermission(sender: string, streamId: string, key: Uint8Array): boolean {
    const stream = AccessControlSet.norm(streamId);
    const acct = AccessControlSet.norm(sender);
    if (this.admins.has(`${stream}|${acct}`)) return true;
    if (this.specialKeys.has(`${stream}|${keyHex(key)}`)) {
      return this.specialWriters.has(`${stream}|${keyHex(key)}|${acct}`);
    }
    return this.writers.has(`${stream}|${acct}`);
  }

  /**
   * Apply one control op if `sender` is authorized for it; unauthorized ops are
   * ignored (matching replay semantics — an invalid op is a no-op, not a halt).
   * Returns whether it was applied.
   */
  applyControl(sender: string, c: StreamControl): boolean {
    const stream = AccessControlSet.norm(c.streamId);
    const from = AccessControlSet.norm(sender);
    const admin = this.admins.has(`${stream}|${from}`);
    const account = c.account ? AccessControlSet.norm(c.account) : from;
    const kh = keyHex(c.key);

    switch (c.type) {
      case AccessControlType.GrantAdminRole:
        if (!admin) return false;
        this.admins.add(`${stream}|${account}`);
        return true;
      case AccessControlType.RenounceAdminRole:
        this.admins.delete(`${stream}|${from}`);
        return true;
      case AccessControlType.SetKeyToSpecial:
        if (!admin) return false;
        this.specialKeys.add(`${stream}|${kh}`);
        return true;
      case AccessControlType.SetKeyToNormal:
        if (!admin) return false;
        this.specialKeys.delete(`${stream}|${kh}`);
        return true;
      case AccessControlType.GrantWriteRole:
        if (!admin && !this.writers.has(`${stream}|${from}`)) return false;
        this.writers.add(`${stream}|${account}`);
        return true;
      case AccessControlType.RevokeWriteRole:
        if (!admin) return false;
        this.writers.delete(`${stream}|${account}`);
        return true;
      case AccessControlType.RenounceWriteRole:
        this.writers.delete(`${stream}|${from}`);
        return true;
      case AccessControlType.GrantSpecialWriteRole:
        if (!admin && !this.specialWriters.has(`${stream}|${kh}|${from}`)) return false;
        this.specialWriters.add(`${stream}|${kh}|${account}`);
        return true;
      case AccessControlType.RevokeSpecialWriteRole:
        if (!admin) return false;
        this.specialWriters.delete(`${stream}|${kh}|${account}`);
        return true;
      case AccessControlType.RenounceSpecialWriteRole:
        this.specialWriters.delete(`${stream}|${kh}|${from}`);
        return true;
      default:
        return false; // unknown op — ignore
    }
  }

  toState(): AccessControlState {
    return {
      admins: [...this.admins],
      writers: [...this.writers],
      specialKeys: [...this.specialKeys],
      specialWriters: [...this.specialWriters],
      knownStreams: [...this.knownStreams],
    };
  }

  static fromState(s: AccessControlState): AccessControlSet {
    const acl = new AccessControlSet();
    acl.admins = new Set(s.admins);
    acl.writers = new Set(s.writers);
    acl.specialKeys = new Set(s.specialKeys);
    acl.specialWriters = new Set(s.specialWriters);
    acl.knownStreams = new Set(s.knownStreams);
    return acl;
  }
}

/**
 * Process one submission against the ACL, in 0G replay order: bootstrap admin
 * for any new stream, validate each write (emitting only authorized ones), then
 * apply the control ops (which affect subsequent submissions). Returns the
 * number of writes rejected for lack of permission.
 */
export function processSubmission<W extends { streamId: string; key: Uint8Array }>(
  acl: AccessControlSet,
  sub: Omit<Submission, 'writes'> & { writes: W[] },
  emit: (write: W) => void,
): number {
  for (const streamId of sub.streamIds) acl.bootstrapIfNew(streamId, sub.sender);

  let denied = 0;
  for (const w of sub.writes) {
    if (acl.hasWritePermission(sub.sender, w.streamId, w.key)) emit(w);
    else denied++;
  }

  for (const c of sub.controls) acl.applyControl(sub.sender, c);
  return denied;
}
