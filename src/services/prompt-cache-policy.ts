/**
 * Claude Code prompt-cache policy: cache lifetime (TTL) and idle keep-alive.
 *
 * Two layers share one shape: the machine-wide default in `~/.botmux/config.json`
 * (`promptCache`) and the per-bot override in `bots.json` (`promptCache`). Every
 * field resolves independently — bot value, else global value, else built-in
 * default — so a bot can turn keep-alive off under a global "on", or change just
 * the idle interval while inheriting the rest. Everything is OFF by default:
 * with neither layer configured, no TTL is requested and no keep-alive is sent.
 *
 * Why keep-alive exists: a subscription account's quota is dominated by cache
 * WRITES, and a long Claude session that sits idle past the cache lifetime has
 * to rewrite its whole prefix on the next turn. A keep-alive is one tiny turn,
 * injected shortly before the cache expires, that reads the prefix and so
 * refreshes its lifetime. It only makes sense with the 1h lifetime (54 idle
 * minutes between pings), which is why enabling keep-alive implies `ttl: '1h'`
 * unless a layer pins `ttl` explicitly.
 */
import type { Locale } from '../i18n/types.js';

export type PromptCacheTtl = '5m' | '1h';

export interface PromptCacheKeepaliveConfig {
  enabled?: boolean;
  /** Idle minutes before each keep-alive; must stay below the TTL. */
  idleMinutes?: number;
  /** Keep-alives per idle stretch; afterwards the cache expires naturally. */
  maxPings?: number;
  /** Local `HH:MM-HH:MM` window judged at each wake (start included, end not;
   *  may cross midnight). Empty/absent = all day. */
  activeHours?: string;
  /** Sessions whose context is smaller than this are not kept alive (a small
   *  prefix is cheap to rewrite). 0 = no minimum. */
  minContextTokens?: number;
}

export interface PromptCacheConfig {
  /** Prompt-cache lifetime Claude Code requests for the main conversation
   *  (`promptCacheTtl` setting). Absent = Claude Code's own default. */
  ttl?: PromptCacheTtl;
  keepalive?: PromptCacheKeepaliveConfig;
}

export interface ResolvedPromptCachePolicy {
  ttl?: PromptCacheTtl;
  keepalive: {
    enabled: boolean;
    idleMinutes: number;
    maxPings: number;
    /** Parsed window in minutes since local midnight; absent = all day. */
    activeHours?: { start: number; end: number };
    minContextTokens: number;
  };
}

export const PROMPT_CACHE_TTLS: readonly PromptCacheTtl[] = ['5m', '1h'];
export const DEFAULT_KEEPALIVE_IDLE_MINUTES_1H = 54;
export const DEFAULT_KEEPALIVE_IDLE_MINUTES_5M = 4;
export const DEFAULT_KEEPALIVE_MAX_PINGS = 2;
export const DEFAULT_KEEPALIVE_MIN_CONTEXT_TOKENS = 50_000;
export const MAX_KEEPALIVE_IDLE_MINUTES = 59;
export const MAX_KEEPALIVE_PINGS = 24;
export const MAX_KEEPALIVE_MIN_CONTEXT_TOKENS = 2_000_000;
/** A keep-alive the CLI never visibly ran stops blocking the next one after this. */
export const KEEPALIVE_IN_FLIGHT_STALE_MS = 10 * 60_000;

const TOP_KEYS = new Set(['ttl', 'keepalive']);
const KEEPALIVE_KEYS = new Set(['enabled', 'idleMinutes', 'maxPings', 'activeHours', 'minContextTokens']);

export function ttlMinutes(ttl: PromptCacheTtl | undefined): number {
  return ttl === '1h' ? 60 : 5;
}

/** Parse `HH:MM-HH:MM` (hours 0–24, `24:00` only as an end) into minutes since
 *  midnight. Empty string → undefined (all day). Returns null when malformed. */
export function parseActiveHours(text: string): { start: number; end: number } | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const toMinutes = (h: string, mm: string, allow24: boolean): number | null => {
    const hours = Number(h);
    const minutes = Number(mm);
    if (minutes > 59) return null;
    if (hours === 24) return allow24 && minutes === 0 ? 24 * 60 : null;
    return hours <= 23 ? hours * 60 + minutes : null;
  };
  const start = toMinutes(m[1], m[2], false);
  const end = toMinutes(m[3], m[4], true);
  if (start === null || end === null) return null;
  return { start, end };
}

/** Start included, end excluded; `start === end` (e.g. 00:00-24:00 folds to
 *  0–1440, 09:00-09:00) means all day; `start > end` crosses midnight. */
function isAllDayWindow(window: { start: number; end: number }): boolean {
  return window.start === window.end || (window.start === 0 && window.end === 24 * 60);
}

export function isWithinActiveHours(window: { start: number; end: number } | undefined, minuteOfDay: number): boolean {
  if (!window || isAllDayWindow(window)) return true;
  const { start, end } = window;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Strict normalizer for writes (dashboard PUT, `/config set`, bots.json load):
 * unknown keys and out-of-range values throw so a typo never silently turns into
 * "use the default". `undefined`/`null` clears the layer.
 */
export function normalizePromptCacheConfig(value: unknown): PromptCacheConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('promptCache must be an object');
  const input = value as Record<string, unknown>;
  const unknownTop = Object.keys(input).find(key => !TOP_KEYS.has(key));
  if (unknownTop) throw new Error(`Unknown promptCache field: ${unknownTop}`);
  const out: PromptCacheConfig = {};
  if (input.ttl !== undefined && input.ttl !== null) {
    if (!PROMPT_CACHE_TTLS.includes(input.ttl as PromptCacheTtl)) throw new Error('promptCache.ttl must be "5m" or "1h"');
    out.ttl = input.ttl as PromptCacheTtl;
  }
  if (input.keepalive !== undefined && input.keepalive !== null) {
    const raw = input.keepalive;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('promptCache.keepalive must be an object');
    const k = raw as Record<string, unknown>;
    const unknownKey = Object.keys(k).find(key => !KEEPALIVE_KEYS.has(key));
    if (unknownKey) throw new Error(`Unknown promptCache.keepalive field: ${unknownKey}`);
    const keepalive: PromptCacheKeepaliveConfig = {};
    if (k.enabled !== undefined) {
      if (typeof k.enabled !== 'boolean') throw new Error('promptCache.keepalive.enabled must be boolean');
      keepalive.enabled = k.enabled;
    }
    if (k.idleMinutes !== undefined) {
      if (!isIntIn(k.idleMinutes, 1, MAX_KEEPALIVE_IDLE_MINUTES)) {
        throw new Error(`promptCache.keepalive.idleMinutes must be an integer between 1 and ${MAX_KEEPALIVE_IDLE_MINUTES}`);
      }
      keepalive.idleMinutes = k.idleMinutes;
    }
    if (k.maxPings !== undefined) {
      if (!isIntIn(k.maxPings, 1, MAX_KEEPALIVE_PINGS)) {
        throw new Error(`promptCache.keepalive.maxPings must be an integer between 1 and ${MAX_KEEPALIVE_PINGS}`);
      }
      keepalive.maxPings = k.maxPings;
    }
    if (k.activeHours !== undefined) {
      if (typeof k.activeHours !== 'string' || parseActiveHours(k.activeHours) === null) {
        throw new Error('promptCache.keepalive.activeHours must look like "09:00-21:30" (empty = all day)');
      }
      if (k.activeHours.trim()) keepalive.activeHours = k.activeHours.trim();
    }
    if (k.minContextTokens !== undefined) {
      if (!isIntIn(k.minContextTokens, 0, MAX_KEEPALIVE_MIN_CONTEXT_TOKENS)) {
        throw new Error(`promptCache.keepalive.minContextTokens must be an integer between 0 and ${MAX_KEEPALIVE_MIN_CONTEXT_TOKENS}`);
      }
      keepalive.minContextTokens = k.minContextTokens;
    }
    if (Object.keys(keepalive).length > 0) out.keepalive = keepalive;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lenient reader for `config.json`: a malformed block is ignored as a whole
 *  rather than taking the config reader down. */
export function readPromptCacheConfig(raw: unknown): PromptCacheConfig | undefined {
  try { return normalizePromptCacheConfig(raw); } catch { return undefined; }
}

/** Field-wise merge: bot value, else global value, else built-in default. */
export function resolvePromptCachePolicy(
  globalLayer: PromptCacheConfig | undefined,
  botLayer: PromptCacheConfig | undefined,
): ResolvedPromptCachePolicy {
  const g = globalLayer?.keepalive ?? {};
  const b = botLayer?.keepalive ?? {};
  const enabled = (b.enabled ?? g.enabled) === true;
  const explicitTtl = botLayer?.ttl ?? globalLayer?.ttl;
  const ttl = explicitTtl ?? (enabled ? '1h' : undefined);
  const lifetime = ttlMinutes(ttl);
  const defaultIdle = ttl === '1h' ? DEFAULT_KEEPALIVE_IDLE_MINUTES_1H : DEFAULT_KEEPALIVE_IDLE_MINUTES_5M;
  // A ping after the cache already expired rewrites the prefix instead of
  // reading it, so the interval is clamped below the lifetime.
  const idleMinutes = Math.min(b.idleMinutes ?? g.idleMinutes ?? defaultIdle, lifetime - 1);
  const activeHoursText = b.activeHours ?? g.activeHours;
  const parsedHours = activeHoursText ? parseActiveHours(activeHoursText) ?? undefined : undefined;
  // `00:00-24:00` / `09:00-09:00` are spelled-out "all day": resolve them to no
  // window so every consumer (gate, Dashboard summary) treats them alike.
  const activeHours = parsedHours && !isAllDayWindow(parsedHours) ? parsedHours : undefined;
  return {
    ...(ttl ? { ttl } : {}),
    keepalive: {
      enabled,
      idleMinutes,
      maxPings: b.maxPings ?? g.maxPings ?? DEFAULT_KEEPALIVE_MAX_PINGS,
      ...(activeHours ? { activeHours } : {}),
      minContextTokens: b.minContextTokens ?? g.minContextTokens ?? DEFAULT_KEEPALIVE_MIN_CONTEXT_TOKENS,
    },
  };
}

/** Per-session keep-alive bookkeeping (daemon memory only). */
export interface PromptCacheKeepaliveState {
  /** Keep-alives the worker confirmed it injected in this idle stretch. */
  pings: number;
  /** When the last keep-alive was sent; the next interval counts from here. */
  lastPingAt?: number;
  /** Set while a keep-alive is on its way / running; cleared on its idle edge. */
  inFlightSince?: number;
  /** The `idleSinceAt` of the real idle stretch. A keep-alive's own
   *  working→idle edge would otherwise restart the idle-suspend clock. */
  idleSinceAt: number;
}

export type PromptCacheKeepaliveSkipReason =
  | 'disabled'
  | 'not_idle'
  | 'in_flight'
  | 'max_pings'
  | 'not_yet'
  | 'cache_expired'
  | 'off_hours'
  | 'context_unknown'
  | 'small_context';

export interface PromptCacheKeepaliveProbe {
  now: number;
  /** Local minutes since midnight at `now`. */
  minuteOfDay: number;
  /** Start of the current idle stretch; undefined when the session is not idle. */
  idleSinceAt?: number;
  state?: PromptCacheKeepaliveState;
  /** Current context size in tokens; undefined when unknown. */
  contextTokens?: number;
}

/**
 * Whether a keep-alive is due now. Due only inside `[idleMinutes, ttl)` since
 * the last cache read (the idle start, or the last keep-alive): earlier wastes a
 * turn, later finds the cache already gone — a session that was idle past its
 * lifetime when the feature turned on is left alone rather than rewritten.
 */
export function decidePromptCacheKeepalive(
  policy: ResolvedPromptCachePolicy,
  probe: PromptCacheKeepaliveProbe,
): { due: true } | { due: false; reason: PromptCacheKeepaliveSkipReason } {
  const k = policy.keepalive;
  if (!k.enabled) return { due: false, reason: 'disabled' };
  if (probe.idleSinceAt === undefined) return { due: false, reason: 'not_idle' };
  const state = probe.state;
  if (state?.inFlightSince !== undefined && probe.now - state.inFlightSince < KEEPALIVE_IN_FLIGHT_STALE_MS) {
    return { due: false, reason: 'in_flight' };
  }
  const pings = state?.pings ?? 0;
  if (pings >= k.maxPings) return { due: false, reason: 'max_pings' };
  const lastRead = state?.lastPingAt ?? state?.idleSinceAt ?? probe.idleSinceAt;
  const elapsed = probe.now - lastRead;
  if (elapsed < k.idleMinutes * 60_000) return { due: false, reason: 'not_yet' };
  if (elapsed >= ttlMinutes(policy.ttl) * 60_000) return { due: false, reason: 'cache_expired' };
  if (!isWithinActiveHours(k.activeHours, probe.minuteOfDay)) return { due: false, reason: 'off_hours' };
  if (k.minContextTokens > 0) {
    if (probe.contextTokens === undefined) return { due: false, reason: 'context_unknown' };
    if (probe.contextTokens < k.minContextTokens) return { due: false, reason: 'small_context' };
  }
  return { due: true };
}

/**
 * The single line typed into the CLI. It must be one line (the injection path
 * writes a literal command line) and must keep the model silent: botmux's system
 * prompt otherwise asks for a `botmux send` reply on every message, and
 * `BOTMUX_NOTHING_TO_SEND` is the existing "deliberately nothing to deliver"
 * sentinel every delivery path already honours.
 */
export function buildPromptCacheKeepalivePrompt(locale?: Locale): string {
  if (locale === 'en') {
    return '<botmux_cache_keepalive>Automatic prompt-cache keep-alive from botmux, not a user message and not a new task. '
      + 'Do not call any tool, do not run botmux send, do not resume earlier work; reply with exactly BOTMUX_NOTHING_TO_SEND.</botmux_cache_keepalive>';
  }
  return '<botmux_cache_keepalive>这是 botmux 自动发送的提示缓存保活消息，不是用户消息，也不是新任务。'
    + '不要调用任何工具，不要执行 botmux send，不要继续之前的工作，只回复 BOTMUX_NOTHING_TO_SEND。</botmux_cache_keepalive>';
}
