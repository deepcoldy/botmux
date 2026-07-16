import { createHash } from 'node:crypto';

import { canonicalJson } from '../../utils/canonical-input-hash.js';

/** Stable identity tuple used for provider-side deduplication. */
export type IdempotencyKeyTuple = {
  workflowId: string;
  revisionId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
};

export type DeriveIdempotencyKeyOptions = {
  namespace?: string;
  maxLength?: number;
};

/**
 * Deterministically derive the provider key from the canonical tuple.
 * Keep this byte-for-byte compatible with the former v2 events helper:
 * persisted provider keys must remain valid across the v2 retirement.
 */
export function deriveIdempotencyKey(
  tuple: IdempotencyKeyTuple,
  opts: DeriveIdempotencyKeyOptions = {},
): string {
  const namespace = opts.namespace ?? 'wf_';
  const maxLength = opts.maxLength ?? 50;
  if (namespace.length >= maxLength) {
    throw new Error(
      `deriveIdempotencyKey: namespace '${namespace}' (${namespace.length} chars) leaves no room for hash in maxLength ${maxLength}`,
    );
  }
  for (const [key, value] of Object.entries(tuple)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `deriveIdempotencyKey: tuple.${key} must be non-empty string, got ${String(value)}`,
      );
    }
  }
  const seed = canonicalJson(tuple);
  const hash = createHash('sha256').update(seed, 'utf-8').digest('hex');
  return namespace + hash.substring(0, maxLength - namespace.length);
}
