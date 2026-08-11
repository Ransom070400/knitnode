import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  signManifest,
  signingPayload,
  verifyManifest,
  type CheckpointManifest,
} from '../src/manifest.js';

/**
 * The digest tells you a snapshot is intact. The signature tells you *whose* it
 * is — which is the part that matters once a checkpoint might have come from
 * somewhere other than your own disk.
 */

const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const ADDR_A = new ethers.Wallet(KEY_A).address;
const ADDR_B = new ethers.Wallet(KEY_B).address;

function manifest(): CheckpointManifest {
  return {
    version: 2,
    generation: 3,
    nextBlock: 900,
    collections: [
      { name: 'memories', base: 'col-0', digest: 'a'.repeat(64) },
      { name: 'notes', base: 'col-1', digest: 'b'.repeat(64) },
    ],
    acl: {
      admins: [`0xstream|${ADDR_A.toLowerCase()}`],
      writers: [],
      specialKeys: [],
      specialWriters: [],
      knownStreams: ['0xstream'],
    },
  };
}

test('a signed manifest verifies and recovers its signer', () => {
  const signed = signManifest(manifest(), KEY_A);
  assert.equal(signed.signer, ADDR_A);
  assert.ok(signed.signature);
  assert.equal(verifyManifest(signed), ADDR_A);
});

test('signing tolerates a bare hex key', () => {
  const bare = signManifest(manifest(), '11'.repeat(32));
  assert.equal(bare.signer, ADDR_A);
  assert.equal(verifyManifest(bare), ADDR_A);
});

test('the payload covers every field, so any edit breaks the signature', () => {
  const signed = signManifest(manifest(), KEY_A);

  const edits: [string, (m: CheckpointManifest) => void][] = [
    ['nextBlock', (m) => (m.nextBlock = 901)],
    ['generation', (m) => (m.generation = 4)],
    ['version', (m) => (m.version = 3)],
    ['a snapshot digest', (m) => (m.collections[0]!.digest = 'c'.repeat(64))],
    ['a snapshot base', (m) => (m.collections[0]!.base = 'col-9')],
    ['a collection name', (m) => (m.collections[0]!.name = 'other')],
    ['collection order', (m) => m.collections.reverse()],
    ['an added collection', (m) => m.collections.push({ name: 'x', base: 'col-2', digest: 'd' })],
    ['the ACL', (m) => m.acl!.admins.push(`0xstream|${ADDR_B.toLowerCase()}`)],
  ];

  for (const [what, edit] of edits) {
    const tampered: CheckpointManifest = JSON.parse(JSON.stringify(signed));
    edit(tampered);

    // Under a trust policy — the way this is actually deployed — every edit is
    // refused outright.
    assert.throws(
      () => verifyManifest(tampered, { trustedSigners: [ADDR_A] }),
      `editing ${what} must be refused`,
    );

    // With no policy the manifest is still never attributed to the original
    // signer: either it is rejected, or it recovers to some other address that
    // nobody has any reason to trust.
    let recovered: string | undefined;
    try {
      recovered = verifyManifest(tampered);
    } catch {
      continue; // rejected outright, which is the stronger outcome
    }
    assert.notEqual(recovered, ADDR_A, `editing ${what} still verified as ${ADDR_A}`);
  }
});

test('a manifest that lies about its signer is rejected', () => {
  const signed = signManifest(manifest(), KEY_A);
  const forged = { ...signed, signer: ADDR_B };
  assert.throws(() => verifyManifest(forged), /claims signer .* but is signed by/);
});

test('a malformed signature is rejected rather than ignored', () => {
  const signed = signManifest(manifest(), KEY_A);
  assert.throws(() => verifyManifest({ ...signed, signature: '0xdeadbeef' }), /malformed/);
});

test('trustedSigners admits the listed keys and refuses the rest', () => {
  const byA = signManifest(manifest(), KEY_A);

  assert.equal(verifyManifest(byA, { trustedSigners: [ADDR_A] }), ADDR_A);
  assert.equal(
    verifyManifest(byA, { trustedSigners: [ADDR_B, ADDR_A] }),
    ADDR_A,
    'any listed signer is enough',
  );
  assert.equal(
    verifyManifest(byA, { trustedSigners: [ADDR_A.toLowerCase()] }),
    ADDR_A,
    'address comparison is case-insensitive',
  );
  assert.throws(
    () => verifyManifest(byA, { trustedSigners: [ADDR_B] }),
    /not a trusted signer/,
  );
});

test('an unsigned manifest is allowed by default but refused once signers are named', () => {
  const plain = manifest();
  assert.equal(verifyManifest(plain), undefined, 'unsigned is not an error on its own');
  assert.equal(verifyManifest(plain, { trustedSigners: [] }), undefined, 'an empty list is no policy');
  assert.throws(
    () => verifyManifest(plain, { trustedSigners: [ADDR_A] }),
    /unsigned, but this node only loads/,
  );
});

test('the signing payload is domain-separated and canonical', () => {
  const m = manifest();
  assert.match(signingPayload(m), /^knitnode-checkpoint-manifest-v1\n/);

  // Key order in the source object must not change the bytes that get signed.
  const reordered: CheckpointManifest = {
    collections: m.collections,
    acl: m.acl,
    nextBlock: m.nextBlock,
    generation: m.generation,
    version: m.version,
  };
  assert.equal(signingPayload(reordered), signingPayload(m));

  // And the signature itself is not part of what it covers.
  const signed = signManifest(m, KEY_A);
  assert.equal(signingPayload({ ...signed, signature: '0x00' }), signingPayload(signed));
});
