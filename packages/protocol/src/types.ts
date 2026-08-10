/**
 * A single vector entry as it lives in a KnitNode collection.
 *
 * This is the logical shape; the on-wire binary layout is defined in
 * {@link ./entry.ts}. One entry maps to exactly one KV write on the 0G Log
 * Layer: the KV *key* is the UTF-8 encoding of {@link VectorEntry.id}, and the
 * KV *value* is the binary encoding of the whole entry.
 */
export interface VectorEntry {
  /** Application-chosen unique id. Doubles as the KV key (updates overwrite). */
  id: string;
  /** Vector dimensionality. Must equal `vector.length`. */
  dim: number;
  /** The embedding itself, stored as raw little-endian float32. */
  vector: Float32Array;
  /** Arbitrary structured metadata, CBOR-encoded on the wire. */
  metadata: Record<string, unknown>;
}

/** A decoded tombstone: a write that removes {@link id} from its collection. */
export interface TombstoneEntry {
  id: string;
  deleted: true;
}

/** The result of decoding a value: either a vector entry or a tombstone. */
export type DecodedEntry = VectorEntry | TombstoneEntry;

/** A single hit returned by a similarity search. */
export interface SearchHit {
  id: string;
  /**
   * Distance under the collection's metric (lower = closer). For cosine and
   * inner-product spaces this is `1 - similarity`.
   */
  distance: number;
  metadata: Record<string, unknown>;
}

/** Distance metric for a collection's index. Mirrors hnswlib space names. */
export type Metric = 'l2' | 'ip' | 'cosine';
