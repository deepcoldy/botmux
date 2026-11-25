import { createHash } from 'node:crypto';

/** Serialize plain JSON data with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number (${String(value)}) not serializable`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => serialize(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(
        `canonicalJson: non-plain-object (${value?.constructor?.name ?? 'unknown'}) not serializable — normalize upstream`,
      );
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + serialize(object[key])).join(',') + '}';
  }
  if (typeof value === 'bigint') {
    throw new Error('canonicalJson: bigint not serializable — convert to string upstream');
  }
  throw new Error(`canonicalJson: cannot serialize ${typeof value}`);
}

/** SHA-256 of the full canonical JSON input, in `sha256:<hex>` form. */
export function computeInputHash(input: unknown): string {
  const canonical = canonicalJson(input);
  const hex = createHash('sha256').update(canonical, 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Raw lowercase-hex SHA-256 of a UTF-8 string (no `sha256:` prefix).
 *
 * Used for content-addressed identities whose values must be bare hex —
 * collab initId / configVersion / createUuid (design 2026-11-20-dm-collab-group
 * §5.1) — as opposed to `computeInputHash`, which is deliberately `sha256:`
 * prefixed for its own callers. Callers pass an already-canonical string
 * (via `canonicalJson`) rather than the raw value, so this never re-serializes.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}
