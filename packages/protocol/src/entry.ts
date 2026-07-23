import { Encoder } from 'cbor-x';
import type { VectorEntry } from './types.js';

/**
 * Per-entry binary format version. Independent of the tag version (`v1`): the
 * tag namespaces the *stream*, this byte namespaces a single value's layout so
 * a replayer can reject or up-convert entries it doesn't understand.
 */
export const ENTRY_FORMAT_VERSION = 1;

/** Header is fixed-width; variable sections follow it in order. */
const HEADER_SIZE = 10;
const MAX_DIM = 0xffff; // uint16
const MAX_ID_BYTES = 0xffff; // uint16

/**
 * CBOR codec for metadata. `useRecords: false` keeps output as standard CBOR
 * maps (no cbor-x record extension), so entries stay portable across any CBOR
 * reader — not just cbor-x. `variableMapSize` trims the map-length encoding.
 */
const cbor = new Encoder({ useRecords: false, variableMapSize: true });

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Binary layout (all multi-byte integers little-endian):
 *
 * ```
 * offset  size  field
 * 0       1     formatVersion (uint8)
 * 1       1     flags (uint8, reserved — 0)
 * 2       2     dim (uint16)
 * 4       2     idLen (uint16, bytes)
 * 6       4     metaLen (uint32, bytes)
 * 10      idLen        id (utf-8)
 * ..      dim*4        vector (float32[])
 * ..      metaLen      metadata (CBOR)
 * ```
 */
export function encodeEntry(entry: VectorEntry): Uint8Array {
  const { id, dim, vector, metadata } = entry;

  if (!id) throw new Error('entry.id must be non-empty');
  if (vector.length !== dim) {
    throw new Error(`vector length ${vector.length} does not match dim ${dim}`);
  }
  if (dim < 1 || dim > MAX_DIM) {
    throw new Error(`dim must be in 1..${MAX_DIM} (got ${dim})`);
  }

  const idBytes = utf8Encoder.encode(id);
  if (idBytes.length > MAX_ID_BYTES) {
    throw new Error(`id is too long: ${idBytes.length} bytes (max ${MAX_ID_BYTES})`);
  }
  const metaBytes: Uint8Array = cbor.encode(metadata ?? {});

  const total = HEADER_SIZE + idBytes.length + dim * 4 + metaBytes.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint8(0, ENTRY_FORMAT_VERSION);
  view.setUint8(1, 0); // flags
  view.setUint16(2, dim, true);
  view.setUint16(4, idBytes.length, true);
  view.setUint32(6, metaBytes.length, true);

  let off = HEADER_SIZE;
  bytes.set(idBytes, off);
  off += idBytes.length;

  // Write float32s explicitly little-endian so the bytes are identical
  // regardless of host architecture.
  for (let i = 0; i < dim; i++) {
    view.setFloat32(off + i * 4, vector[i]!, true);
  }
  off += dim * 4;

  bytes.set(metaBytes, off);
  return bytes;
}

export function decodeEntry(input: Uint8Array): VectorEntry {
  if (input.length < HEADER_SIZE) {
    throw new Error(`entry too short: ${input.length} < ${HEADER_SIZE}`);
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);

  const formatVersion = view.getUint8(0);
  if (formatVersion !== ENTRY_FORMAT_VERSION) {
    throw new Error(`unsupported entry format version ${formatVersion}`);
  }
  const dim = view.getUint16(2, true);
  const idLen = view.getUint16(4, true);
  const metaLen = view.getUint32(6, true);

  const expected = HEADER_SIZE + idLen + dim * 4 + metaLen;
  if (input.length !== expected) {
    throw new Error(`entry length mismatch: got ${input.length}, expected ${expected}`);
  }

  let off = HEADER_SIZE;
  const id = utf8Decoder.decode(input.subarray(off, off + idLen));
  off += idLen;

  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vector[i] = view.getFloat32(off + i * 4, true);
  }
  off += dim * 4;

  const metaBytes = input.subarray(off, off + metaLen);
  const metadata =
    metaLen === 0 ? {} : (cbor.decode(metaBytes) as Record<string, unknown>);

  return { id, dim, vector, metadata };
}

/** The KV key under which an entry is stored: the UTF-8 bytes of its id. */
export function entryKey(id: string): Uint8Array {
  return utf8Encoder.encode(id);
}
