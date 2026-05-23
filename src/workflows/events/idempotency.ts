import { createHash } from 'node:crypto';

// ─── canonical JSON ─────────────────────────────────────────────────────────

/**
 * Serialize `value` to canonical JSON (deterministic across object key order
 * and identical-content equality).  Used by:
 *   - `computeInputHash` to derive inputHash for attempt input immutability
 *     checks (events doc §4.2 + §3.6).
 *   - any code path that needs hash-stable serialization of structured data.
 *
 * Rules:
 *   - Object keys are sorted ascending (lexicographic on UTF-16 code units,
 *     matching JS's default Array.sort).
 *   - `undefined` properties are dropped (matches `JSON.stringify` behaviour
 *     for plain objects).
 *   - `null` is preserved as `"null"`.
 *   - Arrays preserve order — they're ordered data, not bags.
 *   - Strings, numbers, booleans use `JSON.stringify` (handles escapes).
 *   - Non-finite numbers (`NaN`, `±Infinity`), BigInt, Function, Symbol,
 *     Date, and class instances throw.  Dates would need a project-wide
 *     decision on epoch-ms vs ISO string; v0 throws so the caller is forced
 *     to normalize upstream.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`canonicalJson: non-finite number (${String(v)}) not serializable`);
    }
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => serialize(x)).join(',') + ']';
  }
  if (typeof v === 'object') {
    // Reject anything that's not a plain object.  This guards against Date,
    // Map, Set, Buffer, class instances etc. that would otherwise leak
    // internal state into the hash.
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new Error(
        `canonicalJson: non-plain-object (${v?.constructor?.name ?? 'unknown'}) not serializable — normalize upstream`,
      );
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
  }
  if (typeof v === 'bigint') {
    throw new Error('canonicalJson: bigint not serializable — convert to string upstream');
  }
  // function, symbol, undefined at the root
  throw new Error(`canonicalJson: cannot serialize ${typeof v}`);
}

// ─── idempotency key derivation (5-tuple → ≤ 50-char uuid) ──────────────────

/**
 * The 5-tuple that anchors workflow idempotency (events doc §3.2 / §4.2).
 * Each attempt is uniquely identified by this combination; the derived
 * key feeds into provider uuid fields (Feishu IM uuid, schedule-store id).
 */
export type IdempotencyKeyTuple = {
  workflowId: string;
  revisionId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
};

export type DeriveIdempotencyKeyOptions = {
  /**
   * String prefix prepended to the truncated hash.  Defaults to `wf_`,
   * which keeps workflow-generated ids in a separate namespace from
   * randomUUID-derived ids (events doc §2.2 schedule case).  Pass empty
   * string to disable.  Must be ≤ `maxLength - 1`.
   */
  namespace?: string;
  /**
   * Max output length.  Defaults to 50 to match Feishu IM uuid field's
   * documented upper bound (spike report §1.2).
   */
  maxLength?: number;
};

/**
 * Deterministically derive an idempotency key from the 5-tuple.  Same tuple
 * always produces the same key; collisions are bounded by the truncated
 * SHA-256 birthday term.  With default namespace `wf_` and maxLength 50:
 *
 *   key = "wf_" + sha256(workflowId:revisionId:runId:nodeId:attemptId)[:47]
 *
 * 47 hex chars = 188 bits of entropy, ample for collision-free workflow
 * lifetimes.
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
  for (const [k, v] of Object.entries(tuple)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`deriveIdempotencyKey: tuple.${k} must be non-empty string, got ${String(v)}`);
    }
  }
  // Codex round 4 minor: original implementation `${a}:${b}:${c}:${d}:${e}`
  // had a theoretical collision: two distinct tuples whose fields happen
  // to span `:` boundaries differently can produce the same seed (e.g.
  // `{a:'x:y', b:'z', ...}` collides with `{a:'x', b:'y:z', ...}`).
  // Hashing canonicalJson(tuple) — same canonical form used everywhere
  // else for hash-stable serialization — closes the hole without any
  // call-site change.
  const seed = canonicalJson(tuple);
  const hash = createHash('sha256').update(seed, 'utf-8').digest('hex');
  return namespace + hash.substring(0, maxLength - namespace.length);
}

// ─── input hash (canonical full-field sha256) ───────────────────────────────

/**
 * Hash an attempt's canonical input.  Returned in `sha256:<hex>` form so
 * it slots directly into event payloads (`effectAttempted.inputHash` and
 * resume reconcile evidence).
 *
 * The hash is over the **full canonical input** — for send/reply that
 * includes `receive_id`, `root_message_id?`, `msg_type`, `content`; for
 * schedule it includes the entire create-task input.  Spike report §1.3
 * + reply test 3c proved partial hashes leak silent state drift.
 *
 * inputHash is **separate** from idempotencyKey by design (codex v0.1.1
 * round 2): mixing content into the key would convert "input changed" into
 * "new effect", bypassing attempt-immutability.  inputHash lives as a
 * post-fact validator: same attemptId must always produce the same
 * inputHash; mismatches trigger `IdempotencyInputMismatch` (events doc
 * §4.2).
 */
export function computeInputHash(input: unknown): string {
  const canonical = canonicalJson(input);
  const hex = createHash('sha256').update(canonical, 'utf-8').digest('hex');
  return `sha256:${hex}`;
}
