/**
 * Session environment overlay — the user-managed layers between the inherited
 * baseline and botmux's own per-session injection:
 *
 *   inherited baseline → global layer → bot layer → botmux reserved
 *
 * Each layer is `{ set, unset }`. A higher layer's entry for a key replaces any
 * lower entry for that key; removing an entry ("restore") falls back to the
 * layer below. Storage:
 *   - global: `~/.botmux/config.json` → `sessionEnv: { set, unset }`
 *   - bot:    `bots.json` entry → `env` (= set, the historical field, unchanged)
 *             + `envUnset` (= unset)
 * Bots that configure neither new field compose to exactly the legacy env.
 *
 * Pure and dependency-free apart from the lock rule, so the daemon, worker,
 * dashboard process and the web bundle all share one implementation.
 */
import { sanitizePerBotEnv, sessionEnvLock, type SessionEnvLock, type SessionEnvLockContext } from './per-bot-env.js';

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const utf8 = new TextEncoder();
/** Every name lands in the pane argv (`env -u NAME`), which tmux caps at one
 *  16 KiB IPC message; real variable names are far shorter. */
export const MAX_SESSION_ENV_NAME_LENGTH = 256;

/** A name the session-env layers accept (shape + byte length; locks are
 *  separate). ENV_NAME_RE admits ASCII only, so the byte count equals its
 *  character count — it is written explicitly to match envLayerArgvBytes. */
export function isSessionEnvName(key: unknown): key is string {
  return typeof key === 'string' && utf8.encode(key).length <= MAX_SESSION_ENV_NAME_LENGTH && ENV_NAME_RE.test(key);
}
/**
 * Byte budget for one layer — `KEY=VAL` per set entry plus `-u KEY` per
 * removal. tmux / zellij / zmx put the composed overlay into the pane start
 * command, which tmux refuses past ~16 KiB ("command too long", a
 * deterministic launch failure, measured between 16.3 and 16.5 KiB). Two full
 * layers (8 KiB) plus the wrapper script (~2.6 KiB) and botmux's own per-session
 * values + CLI argv leave ~1.5 KiB measured headroom; see the real-tmux fit
 * test in session-env-backends.test.ts.
 */
export const MAX_SESSION_ENV_LAYER_BYTES = 4 * 1024;
/** One value can never exceed the whole layer budget, counted in UTF-8 bytes
 *  (the pane argv is a byte channel; 4096 CJK chars are 12 KiB). */
export const MAX_SESSION_ENV_VALUE_BYTES = MAX_SESSION_ENV_LAYER_BYTES;
const MAX_SESSION_ENV_OPS = 500;

export interface EnvLayer {
  set: Record<string, string>;
  unset: string[];
}

export function emptyEnvLayer(): EnvLayer {
  return { set: {}, unset: [] };
}

export function isEmptyEnvLayer(layer: EnvLayer): boolean {
  return Object.keys(layer.set).length === 0 && layer.unset.length === 0;
}

/**
 * Lenient read of a stored layer: drops invalid names, reserved names and
 * non-primitive values; dedupes + sorts `unset`. A name present in both lists
 * (only possible by hand-editing) keeps its `set` entry — for a bot that is the
 * legacy `env` field, whose meaning must not change.
 */
export function normalizeEnvLayer(rawSet: unknown, rawUnset: unknown): EnvLayer {
  const set = sanitizePerBotEnv(rawSet);
  const unset = Array.isArray(rawUnset)
    ? [...new Set(rawUnset.filter((k): k is string =>
      isSessionEnvName(k) && !(k in set) && sessionEnvLock(k) === null))].sort()
    : [];
  return { set, unset };
}

/** Keys a hand-edited layer lists in both `set` and `unset` (set wins). */
export function conflictingEnvLayerKeys(rawSet: unknown, rawUnset: unknown): string[] {
  const set = sanitizePerBotEnv(rawSet);
  return Array.isArray(rawUnset)
    ? [...new Set(rawUnset.filter((k): k is string => typeof k === 'string' && k in set))].sort()
    : [];
}

/** `config.json` → `sessionEnv`. */
export function globalEnvLayer(raw: unknown): EnvLayer {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return normalizeEnvLayer(obj.set, obj.unset);
}

/** `bots.json` entry → `env` + `envUnset`. */
export function botEnvLayer(bot: { env?: unknown; envUnset?: unknown }): EnvLayer {
  return normalizeEnvLayer(bot.env, bot.envUnset);
}

export type EnvOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'unset'; key: string }
  /** Remove this layer's entry: the value falls back to the layer below. */
  | { op: 'reset'; key: string };

export type EnvOpsError = 'invalid_ops' | 'invalid_key' | 'invalid_value' | 'reserved_key' | 'unset_forbidden' | 'layer_too_large';

/** Strict validation for the write path (Dashboard / IPC). */
export function parseEnvOps(
  raw: unknown,
  ctx: SessionEnvLockContext = {},
): { ok: true; ops: EnvOp[] } | { ok: false; error: EnvOpsError; key?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SESSION_ENV_OPS) return { ok: false, error: 'invalid_ops' };
  const ops: EnvOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_ops' };
    const { op, key, value } = item as { op?: unknown; key?: unknown; value?: unknown };
    if (op !== 'set' && op !== 'unset' && op !== 'reset') return { ok: false, error: 'invalid_ops' };
    // Never echo an invalid key: a pasted line may carry a secret in the name slot.
    if (!isSessionEnvName(key)) return { ok: false, error: 'invalid_key' };
    if (op === 'reset') { ops.push({ op, key }); continue; }
    const lock = sessionEnvLock(key, ctx);
    if (lock === 'reserved' || lock === 'identity') return { ok: false, error: 'reserved_key', key };
    if (op === 'unset') {
      if (lock === 'no-unset') return { ok: false, error: 'unset_forbidden', key };
      ops.push({ op, key });
      continue;
    }
    if (typeof value !== 'string' || value.includes('\0') || utf8.encode(value).length > MAX_SESSION_ENV_VALUE_BYTES) {
      return { ok: false, error: 'invalid_value', key };
    }
    ops.push({ op, key, value });
  }
  return { ok: true, ops };
}

/** Pane argv bytes a layer adds (`KEY=VAL\0` per set, `-u\0KEY\0` per unset;
 *  names are ASCII by ENV_NAME_RE, values are UTF-8 encoded like the byte
 *  channel that carries them). */
export function envLayerArgvBytes(layer: EnvLayer): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(layer.set)) bytes += utf8.encode(key).length + 1 + utf8.encode(value).length + 1;
  for (const key of layer.unset) bytes += 3 + utf8.encode(key).length + 1;
  return bytes;
}

/**
 * A write may not grow a layer past {@link MAX_SESSION_ENV_LAYER_BYTES}.
 * Shrinking stays allowed, so a layer that is already oversized (legacy
 * `env` written by an older path) can always be cleaned up.
 */
export function envLayerWithinBudget(prev: EnvLayer, next: EnvLayer): boolean {
  const size = envLayerArgvBytes(next);
  return size <= MAX_SESSION_ENV_LAYER_BYTES || size <= envLayerArgvBytes(prev);
}

/** Apply validated ops to one layer; later ops win. Returns a new layer. */
export function applyEnvOps(layer: EnvLayer, ops: readonly EnvOp[]): EnvLayer {
  const set = { ...layer.set };
  const unset = new Set(layer.unset);
  for (const op of ops) {
    delete set[op.key];
    unset.delete(op.key);
    if (op.op === 'set') set[op.key] = op.value;
    else if (op.op === 'unset') unset.add(op.key);
  }
  return { set, unset: [...unset].sort() };
}

/** What a session receives on top of its inherited baseline. */
export interface ComposedSessionEnv {
  set: Record<string, string>;
  unset: string[];
}

/**
 * Fold layers low → high. Within a layer `unset` applies before `set`, matching
 * {@link normalizeEnvLayer}. Locked keys are dropped last so neither layer can
 * reach a botmux-owned name, whatever was stored.
 */
export function composeSessionEnv(layers: readonly EnvLayer[], ctx: SessionEnvLockContext = {}): ComposedSessionEnv {
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  for (const layer of layers) {
    for (const key of layer.unset) { delete set[key]; unset.add(key); }
    for (const [key, value] of Object.entries(layer.set)) { set[key] = value; unset.delete(key); }
  }
  for (const key of Object.keys(set)) {
    const lock = sessionEnvLock(key, ctx);
    if (lock === 'reserved' || lock === 'identity') delete set[key];
  }
  return {
    set,
    unset: [...unset].filter(key => sessionEnvLock(key, ctx) === null).sort(),
  };
}

/**
 * Delete composed `unset` keys from an env object in place. Re-checks the lock
 * (values cross the daemon → worker IPC boundary) so a malformed list can never
 * remove a botmux-owned variable or PATH/HOME.
 */
export function applySessionEnvUnset(env: NodeJS.ProcessEnv, unset: readonly string[] | undefined): void {
  if (!unset) return;
  for (const key of unset) {
    if (isSessionEnvName(key) && sessionEnvLock(key) === null) delete env[key];
  }
}

/** One env object for a local child: base − removals + per-bot/overlay `set`. */
export function sessionChildEnvWithInject(opts: {
  env: Record<string, string>;
  injectEnv?: Record<string, string>;
  unsetEnv?: readonly string[];
}): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...opts.env };
  applySessionEnvUnset(env, opts.unsetEnv);
  return Object.assign(env, opts.injectEnv ?? {}) as Record<string, string>;
}

/** The exact `-u KEY` flags for `/usr/bin/env` (same filter as {@link applySessionEnvUnset}). */
export function sessionEnvUnsetFlags(unset: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const key of unset ?? []) {
    if (isSessionEnvName(key) && sessionEnvLock(key) === null) out.push('-u', key);
  }
  return out;
}

// ─── Masking ────────────────────────────────────────────────────────────────

/** Name fragments that mark a credential. Matched per `_` segment: a segment
 *  CONTAINING one of these (AUTHTOKEN, CLIENTSECRET, APIKEY…) counts. */
const SENSITIVE_FRAGMENT_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|JWT|APIKEY|PRIVATEKEY/;
/** Whole segments only — as substrings they over-match (AUTHOR, PRIVATELY,
 *  KEYBOARD). KEY anywhere covers OPENAI_API_KEY, AWS_ACCESS_KEY_ID, …. */
const SENSITIVE_SEGMENTS = new Set(['AUTH', 'AUTHORIZATION', 'PRIVATE', 'KEY']);
/** Last segment only (too short to trust elsewhere). */
const SENSITIVE_LAST_SEGMENTS = new Set(['AK', 'SK', 'PAT', 'PASS']);
const JWT_VALUE_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
const URL_USERINFO_RE = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^:@/\s]*):([^@/\s]+)@/;
const MASK = '••••••';

export function isSensitiveEnvKey(key: string): boolean {
  const segments = key.toUpperCase().split('_').filter(Boolean);
  if (segments.some(s => SENSITIVE_FRAGMENT_RE.test(s) || SENSITIVE_SEGMENTS.has(s))) return true;
  return SENSITIVE_LAST_SEGMENTS.has(segments[segments.length - 1] ?? '');
}

export interface MaskedEnvValue {
  /** What the list shows. Never the original when `masked`. */
  value: string;
  /** The original differs from `value`; the Dashboard can request it. */
  masked: boolean;
}

/**
 * Display form of one value. Credentials (by name or JWT shape) show only the
 * last four characters of a 12+ character value; a URL keeps everything except
 * the userinfo password. `maskAll` masks every non-empty value (audiences
 * without reveal rights must not depend on the name heuristic).
 */
export function maskEnvValue(key: string, value: string, opts: { maskAll?: boolean } = {}): MaskedEnvValue {
  if (!value) return { value, masked: false };
  const full = (): MaskedEnvValue => ({ value: MASK + (value.length >= 12 ? value.slice(-4) : ''), masked: true });
  if (isSensitiveEnvKey(key) || JWT_VALUE_RE.test(value)) return full();
  const url = URL_USERINFO_RE.exec(value);
  if (url) {
    // A credential-bearing URL leaves nothing safe to show to a no-reveal viewer.
    if (opts.maskAll) return { value: MASK, masked: true };
    return { value: `${url[1]}${url[2]}:${MASK}@${value.slice(url[0].length)}`, masked: true };
  }
  if (opts.maskAll) return full();
  return { value, masked: false };
}

// ─── View model (Dashboard) ─────────────────────────────────────────────────

/** Which layer produced a row's effective state. */
export type SessionEnvSource = 'host' | 'global' | 'bot';

export interface SessionEnvRow {
  key: string;
  /** set = a layer sets it; unset = a layer removes it; inherited = baseline as-is. */
  state: 'set' | 'unset' | 'inherited';
  source: SessionEnvSource;
  /** Display value: the effective value, or for `unset` the value being removed. */
  value?: string;
  masked?: boolean;
  /** For a layer entry: what it replaces (lower layer / baseline). */
  lower?: { source: SessionEnvSource; state: 'set' | 'unset' | 'inherited'; value?: string; masked?: boolean };
  /** Entry of the layer being edited, if any (drives the「恢复继承」action). */
  entry?: 'set' | 'unset';
  lock?: SessionEnvLock;
}

/**
 * Rows for one editing scope. `layers` are low → high and the last one is the
 * scope being edited (global scope: `[global]`; bot scope: `[global, bot]`).
 * Locked keys never appear as rows — botmux owns them and the Dashboard lists
 * them separately — except PATH/HOME, which stay editable with `no-unset`.
 */
export function buildSessionEnvRows(input: {
  baseline: Record<string, string | undefined>;
  layers: ReadonlyArray<{ source: Exclude<SessionEnvSource, 'host'>; layer: EnvLayer }>;
  ctx?: SessionEnvLockContext;
  mask: (key: string, value: string) => MaskedEnvValue;
}): SessionEnvRow[] {
  type State = { state: 'set' | 'unset' | 'inherited'; source: SessionEnvSource; value?: string };
  const keys = new Set<string>(Object.keys(input.baseline).filter(k => input.baseline[k] !== undefined));
  for (const { layer } of input.layers) {
    for (const k of Object.keys(layer.set)) keys.add(k);
    for (const k of layer.unset) keys.add(k);
  }
  const edited = input.layers[input.layers.length - 1];
  const rows: SessionEnvRow[] = [];
  for (const key of [...keys].sort()) {
    const lock = sessionEnvLock(key, input.ctx);
    if (lock === 'reserved' || lock === 'identity') continue;
    const base = input.baseline[key];
    let cur: State | undefined = base !== undefined ? { state: 'inherited', source: 'host', value: base } : undefined;
    let prev: State | undefined;
    for (const { source, layer } of input.layers) {
      const next: State | undefined = key in layer.set
        ? { state: 'set', source, value: layer.set[key] }
        : layer.unset.includes(key) && lock !== 'no-unset'
          ? { state: 'unset', source, value: cur?.value }
          : undefined;
      if (next) { prev = cur; cur = next; }
    }
    if (!cur) continue;
    const show = (value: string | undefined) => value === undefined ? {} : (() => {
      const m = input.mask(key, value);
      return { value: m.value, ...(m.masked ? { masked: true } : {}) };
    })();
    const entryState = edited
      ? key in edited.layer.set ? 'set' as const : edited.layer.unset.includes(key) && lock !== 'no-unset' ? 'unset' as const : undefined
      : undefined;
    rows.push({
      key,
      state: cur.state,
      source: cur.source,
      ...show(cur.value),
      ...(prev && cur.state !== 'inherited' ? { lower: { source: prev.source, state: prev.state, ...show(prev.value) } } : {}),
      ...(entryState ? { entry: entryState } : {}),
      ...(lock ? { lock } : {}),
    });
  }
  return rows;
}

/**
 * The raw value behind a row's display value (`reveal`). Same walk as
 * {@link buildSessionEnvRows}: the effective value, or for a removed variable
 * the value it removes. `undefined` when the row has no value.
 */
export function sessionEnvRowRawValue(input: {
  key: string;
  baseline: Record<string, string | undefined>;
  layers: ReadonlyArray<{ layer: EnvLayer }>;
  ctx?: SessionEnvLockContext;
}): string | undefined {
  const lock = sessionEnvLock(input.key, input.ctx);
  if (lock === 'reserved' || lock === 'identity') return undefined;
  let value = input.baseline[input.key];
  for (const { layer } of input.layers) {
    if (input.key in layer.set) value = layer.set[input.key];
  }
  return value;
}
