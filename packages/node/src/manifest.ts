import { ethers } from 'ethers';
import { canonicalJson } from './canonical.js';
import type { AccessControlState } from './replay/acl.js';

/**
 * Domain tag for the signing payload. Prefixing it means a checkpoint signature
 * can never be replayed as a signature over something else this key signs — a
 * transaction, a login challenge — and vice versa.
 */
const SIGNING_DOMAIN = 'knitnode-checkpoint-manifest-v1';

/** One collection's snapshot within a generation: `<base>.hnsw` + `<base>.json`. */
export interface CheckpointEntry {
  name: string;
  base: string;
  /** Content digest of the snapshot, recomputed and checked when it loads. */
  digest: string;
}

/**
 * On-disk record tying a saved cursor to the collection snapshots it describes.
 *
 * The manifest is the only file at the root of a checkpoint directory; every
 * snapshot lives in a generation subdirectory it names. Replacing the manifest
 * is therefore the single commit point for a whole checkpoint.
 *
 * `signature` and `signer` are additive and optional: a manifest without them
 * is a valid unsigned checkpoint, which is why adding them did not need a
 * format-version bump.
 */
export interface CheckpointManifest {
  version: number;
  /** Generation subdirectory (`gen-<n>`) holding this manifest's snapshots. */
  generation: number;
  /** Next Flow block to scan — replay resumes here instead of from genesis. */
  nextBlock: number;
  collections: CheckpointEntry[];
  /** Replayed access-control state, so a resumed node keeps enforcing correctly. */
  acl?: AccessControlState;
  /** EIP-191 signature over {@link signingPayload}. */
  signature?: string;
  /**
   * Address the producer claims. A label for humans and for picking a key to
   * check against — verification recovers the address from the signature and
   * compares, so a lie here is caught rather than believed.
   */
  signer?: string;
}

/** The manifest fields a signature covers: everything except the signature itself. */
type SignableManifest = Omit<CheckpointManifest, 'signature' | 'signer'>;

/**
 * The exact bytes a signature is taken over: a domain tag plus the canonical
 * form of every other field.
 *
 * Canonical rather than the raw file text, because JSON formatting is not
 * stable across writers — and covering *all* remaining fields rather than a
 * hand-picked list, so a field added later is signed automatically instead of
 * silently escaping the signature.
 */
export function signingPayload(manifest: CheckpointManifest): string {
  const { signature: _sig, signer: _signer, ...signable } = manifest;
  return `${SIGNING_DOMAIN}\n${canonicalJson(signable as SignableManifest)}`;
}

/**
 * Sign a manifest, returning it with `signature` and `signer` filled in.
 * Synchronous: checkpointing happens on the replay path, which is not async.
 */
export function signManifest(manifest: CheckpointManifest, privateKey: string): CheckpointManifest {
  // ethers requires a 0x-prefixed key; tolerate a bare 64-char hex string.
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  const signed: CheckpointManifest = { ...manifest, signer: wallet.address };
  signed.signature = wallet.signMessageSync(signingPayload(signed));
  return signed;
}

export interface VerifyOpts {
  /**
   * Addresses whose checkpoints this node will load. When set, an unsigned
   * manifest is refused too — "I trust these signers" is meaningless if
   * anything unsigned still gets in.
   */
  trustedSigners?: string[];
}

/**
 * Check a manifest's signature and return the address that produced it, or
 * undefined if it is unsigned and unsigned is acceptable.
 *
 * A signature that is present but does not verify is always fatal, whatever the
 * trust policy: it means the manifest was altered after signing, and the
 * distinction between "not vouched for" and "vouched for and then edited"
 * matters. Only the question of whether an *absent* signature is acceptable
 * depends on {@link VerifyOpts.trustedSigners}.
 */
export function verifyManifest(manifest: CheckpointManifest, opts: VerifyOpts = {}): string | undefined {
  const trusted = opts.trustedSigners?.map((a) => a.toLowerCase());

  if (!manifest.signature) {
    if (trusted?.length) {
      throw new Error(
        'checkpoint manifest is unsigned, but this node only loads checkpoints ' +
          `signed by: ${opts.trustedSigners!.join(', ')}`,
      );
    }
    return undefined;
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(signingPayload(manifest), manifest.signature);
  } catch (err) {
    throw new Error(`checkpoint manifest signature is malformed: ${err}`);
  }

  // The manifest states who signed it; the signature says who actually did.
  if (manifest.signer && manifest.signer.toLowerCase() !== recovered.toLowerCase()) {
    throw new Error(
      `checkpoint manifest claims signer ${manifest.signer} but is signed by ${recovered} ` +
        '— it was altered after signing',
    );
  }

  if (trusted?.length && !trusted.includes(recovered.toLowerCase())) {
    throw new Error(
      `checkpoint manifest is signed by ${recovered}, which is not a trusted signer ` +
        `(${opts.trustedSigners!.join(', ')})`,
    );
  }

  return recovered;
}
