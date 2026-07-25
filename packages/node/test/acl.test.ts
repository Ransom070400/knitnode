import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccessControlSet,
  AccessControlType as T,
  processSubmission,
  type Submission,
} from '../src/replay/acl.js';
import type { StreamControl } from '../src/replay/streamdata.js';

const S = '0x' + '11'.repeat(32); // a stream id
const ADMIN = '0x' + 'a1'.repeat(20);
const BOB = '0x' + 'b0'.repeat(20);
const EVE = '0x' + 'ee'.repeat(20);
const K = Uint8Array.from([1, 2, 3]);

function sub(sender: string, over: Partial<Submission> = {}): Submission {
  return {
    logHeight: over.logHeight ?? 0,
    sender,
    streamIds: over.streamIds ?? [S],
    writes: over.writes ?? [],
    controls: over.controls ?? [],
  };
}

function emitted(acl: AccessControlSet, s: Submission): string[] {
  const out: string[] = [];
  processSubmission(acl, s, (w) => out.push(Buffer.from(w.key).toString('hex')));
  return out;
}

test('first sender to a stream is bootstrapped as admin and can write', () => {
  const acl = new AccessControlSet();
  const got = emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  assert.deepEqual(got, ['010203']);
  assert.ok(acl.isAdmin(S, ADMIN));
});

test('a non-admin, non-writer cannot write; denied writes are not emitted', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] })); // ADMIN bootstraps
  const got = emitted(acl, sub(EVE, { writes: [{ streamId: S, key: K }] }));
  assert.deepEqual(got, [], 'Eve has no role — her write is rejected');
});

test('admin can grant a write role, then that account can write', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  const applied = acl.applyControl(ADMIN, { type: T.GrantWriteRole, streamId: S, account: BOB });
  assert.equal(applied, true);
  assert.deepEqual(emitted(acl, sub(BOB, { writes: [{ streamId: S, key: K }] })), ['010203']);
});

test('a non-admin cannot grant roles (op ignored)', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  assert.equal(acl.applyControl(EVE, { type: T.GrantWriteRole, streamId: S, account: EVE }), false);
  assert.deepEqual(emitted(acl, sub(EVE, { writes: [{ streamId: S, key: K }] })), []);
});

test('revoke removes a write role', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  acl.applyControl(ADMIN, { type: T.GrantWriteRole, streamId: S, account: BOB });
  acl.applyControl(ADMIN, { type: T.RevokeWriteRole, streamId: S, account: BOB });
  assert.deepEqual(emitted(acl, sub(BOB, { writes: [{ streamId: S, key: K }] })), []);
});

test('special keys require a special-writer role (or admin)', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  acl.applyControl(ADMIN, { type: T.GrantWriteRole, streamId: S, account: BOB }); // normal writer
  acl.applyControl(ADMIN, { type: T.SetKeyToSpecial, streamId: S, key: K });

  // Bob is a normal writer — the now-special key is off-limits to him.
  assert.deepEqual(emitted(acl, sub(BOB, { writes: [{ streamId: S, key: K }] })), []);
  // Admin can still write it.
  assert.deepEqual(emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] })), ['010203']);
  // Grant Bob special-write for exactly this key.
  acl.applyControl(ADMIN, { type: T.GrantSpecialWriteRole, streamId: S, key: K, account: BOB });
  assert.deepEqual(emitted(acl, sub(BOB, { writes: [{ streamId: S, key: K }] })), ['010203']);
  // But a different special key is still denied to Bob.
  const K2 = Uint8Array.from([9, 9]);
  acl.applyControl(ADMIN, { type: T.SetKeyToSpecial, streamId: S, key: K2 });
  assert.deepEqual(emitted(acl, sub(BOB, { writes: [{ streamId: S, key: K2 }] })), []);
});

test('renounce acts on the sender itself', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  acl.applyControl(ADMIN, { type: T.RenounceAdminRole, streamId: S });
  assert.equal(acl.isAdmin(S, ADMIN), false);
  // No longer admin, no writer role → own writes now rejected.
  assert.deepEqual(emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] })), []);
});

test('controls in a submission affect only later submissions, not its own writes', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  // In ONE submission, Bob (unauthorized) both writes and is granted a role by
  // himself — the self-grant is unauthorized, and the write is checked first.
  const out = emitted(
    acl,
    sub(BOB, {
      writes: [{ streamId: S, key: K }],
      controls: [{ type: T.GrantWriteRole, streamId: S, account: BOB }],
    }),
  );
  assert.deepEqual(out, []);
});

test('state serializes and restores exactly', () => {
  const acl = new AccessControlSet();
  emitted(acl, sub(ADMIN, { writes: [{ streamId: S, key: K }] }));
  acl.applyControl(ADMIN, { type: T.GrantWriteRole, streamId: S, account: BOB });
  acl.applyControl(ADMIN, { type: T.SetKeyToSpecial, streamId: S, key: K });

  const restored = AccessControlSet.fromState(JSON.parse(JSON.stringify(acl.toState())));
  assert.ok(restored.isAdmin(S, ADMIN));
  assert.deepEqual(emitted(restored, sub(BOB, { writes: [{ streamId: S, key: Uint8Array.from([7]) }] })), ['07']);
  assert.deepEqual(emitted(restored, sub(BOB, { writes: [{ streamId: S, key: K }] })), []); // special key still blocks Bob
});
