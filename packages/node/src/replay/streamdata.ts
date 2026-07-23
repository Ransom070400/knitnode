/**
 * Decoder for the 0G `StreamData` wire format and the Flow `submit` tag blob.
 *
 * The 0G TS SDK ships `StreamData.encode()` but no decoder — the Rust KV node
 * owns the read side. To replay in TypeScript we reimplement the inverse. This
 * is verified byte-for-byte against the SDK's own `encode()` in the test at the
 * bottom of the repo's example run; the layout below mirrors `kv/types.js`.
 *
 * All integers are BIG-endian (the SDK uses `DataView.setUintXX(.., false)`).
 *
 * StreamData layout:
 *   version      u64
 *   readsCount   u32
 *     read*      { streamId[32], keySize u24, key[keySize] }
 *   writesCount  u32
 *     writeHdr*  { streamId[32], keySize u24, key[keySize], dataSize u64 }
 *     <all write payloads concatenated, in write order>
 *   controlsCount u32
 *     control*   { type u8, streamId[32], [keySize u24, key], [account[20]] }
 */

/** sha256("STREAM") — prefixes the Flow tag blob for any stream submission. */
export const STREAM_DOMAIN = new Uint8Array([
  0xdf, 0x2f, 0xf3, 0xbb, 0x0a, 0xf3, 0x6c, 0x63, 0x84, 0xe6, 0x20, 0x65, 0x52,
  0xa4, 0xed, 0x80, 0x7f, 0x6f, 0x6a, 0x26, 0xe7, 0xd0, 0xaa, 0x6b, 0xff, 0x77,
  0x2d, 0xdc, 0x9d, 0x43, 0x07, 0xaa,
]);

export interface StreamWrite {
  streamId: string; // 0x-prefixed 32-byte hex
  key: Uint8Array;
  data: Uint8Array;
}

export interface DecodedStreamData {
  version: number;
  writes: StreamWrite[];
}

function toHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Sequential big-endian reader with bounds checks. */
class Reader {
  private off = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly view: DataView = new DataView(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength,
    ),
  ) {}

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new Error(
        `StreamData truncated: need ${n} bytes at offset ${this.off}, have ${
          this.buf.length - this.off
        }`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.off++);
  }

  u24(): number {
    this.need(3);
    const a = this.view.getUint8(this.off);
    const b = this.view.getUint8(this.off + 1);
    const c = this.view.getUint8(this.off + 2);
    this.off += 3;
    return (a << 16) | (b << 8) | c;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.off, false);
    this.off += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = this.view.getBigUint64(this.off, false);
    this.off += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`StreamData u64 ${v} exceeds MAX_SAFE_INTEGER`);
    }
    return Number(v);
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }
}

/** Does an AccessControl of this type carry a key / an account on the wire? */
function controlLayout(type: number): { key: boolean; account: boolean } {
  switch (type) {
    case 0: // GrantAdminRole
    case 32: // GrantWriteRole
    case 33: // RevokeWriteRole
      return { key: false, account: true };
    case 1: // RenounceAdminRole
    case 34: // RenounceWriteRole
      return { key: false, account: false };
    case 16: // SetKeyToSpecial
    case 17: // SetKeyToNormal
    case 50: // RenounceSpecialWriteRole
      return { key: true, account: false };
    case 48: // GrantSpecialWriteRole
    case 49: // RevokeSpecialWriteRole
      return { key: true, account: true };
    default:
      throw new Error(`unknown AccessControl type ${type}`);
  }
}

/**
 * Decode a `StreamData` blob. We only surface writes — reads and access-control
 * ops don't mutate vector state — but the whole structure is walked so offsets
 * stay correct even when a submission mixes them in.
 */
export function decodeStreamData(buf: Uint8Array): DecodedStreamData {
  const r = new Reader(buf);
  const version = r.u64();

  // reads — walked and discarded
  const readsCount = r.u32();
  for (let i = 0; i < readsCount; i++) {
    r.bytes(32); // streamId
    const keySize = r.u24();
    r.bytes(keySize);
  }

  // write headers first...
  const writesCount = r.u32();
  const headers: { streamId: string; key: Uint8Array; dataSize: number }[] = [];
  for (let i = 0; i < writesCount; i++) {
    const streamId = toHex(r.bytes(32));
    const keySize = r.u24();
    const key = r.bytes(keySize);
    const dataSize = r.u64();
    headers.push({ streamId, key, dataSize });
  }
  // ...then all payloads, concatenated in write order.
  const writes: StreamWrite[] = headers.map((h) => ({
    streamId: h.streamId,
    key: h.key,
    data: r.bytes(h.dataSize),
  }));

  // controls — walked and discarded (Phase 1 has no ACL semantics)
  const controlsCount = r.u32();
  for (let i = 0; i < controlsCount; i++) {
    const type = r.u8();
    r.bytes(32); // streamId
    const layout = controlLayout(type);
    if (layout.key) {
      const keySize = r.u24();
      r.bytes(keySize);
    }
    if (layout.account) r.bytes(20);
  }

  return { version, writes };
}

/**
 * Decode the Flow submission `tags` blob into the set of stream ids it targets.
 * Returns [] if the blob isn't a well-formed stream tag (wrong domain / length),
 * which is how we cheaply skip non-KV submissions on the log.
 */
export function decodeStreamTags(tags: Uint8Array): string[] {
  if (tags.length === 0 || tags.length % 32 !== 0) return [];
  for (let i = 0; i < 32; i++) {
    if (tags[i] !== STREAM_DOMAIN[i]) return [];
  }
  const ids: string[] = [];
  for (let off = 32; off < tags.length; off += 32) {
    ids.push(toHex(tags.subarray(off, off + 32)));
  }
  return ids;
}
