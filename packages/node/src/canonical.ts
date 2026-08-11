/**
 * Stable JSON: object keys sorted recursively, so the same logical value always
 * produces the same bytes.
 *
 * Used everywhere a structure has to be hashed or signed. `JSON.stringify`
 * preserves insertion order, which means two nodes that built equal metadata by
 * different routes would disagree on its digest — and a signature is only worth
 * anything if the thing it covers serializes one way.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
