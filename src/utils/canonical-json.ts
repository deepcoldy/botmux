/**
 * Stable JSON encoding used by persisted content-addressed contracts.
 *
 * Object keys are sorted recursively, array order is preserved, and the
 * result is compact. Keep this implementation byte-for-byte compatible:
 * workflow revision ids, migration-ledger hashes, and v2 run archive ids all
 * derive from these bytes.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
  return sorted;
}
