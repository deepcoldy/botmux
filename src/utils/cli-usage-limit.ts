export type CliUsageLimitKind = 'usage' | 'rate';

export interface CliUsageLimitState {
  limited: true;
  kind: CliUsageLimitKind;
  retryAtMs: number;
  retryLabel: string;
  retryReady: boolean;
  /** Stable identity of one relative-countdown refusal, persisted so a
   * reattached worker cannot move its already-observed reset deadline. */
  relativeResetKey?: string;
  /** A confirmed native quota composer must survive unrelated PTY output. */
  source?: 'antigravity-error-composer';
}

export interface CliUsageLimitNotDetected {
  limited: false;
}

export type CliUsageLimitDetection = CliUsageLimitState | CliUsageLimitNotDetected;

const USAGE_LIMIT_PATTERNS = [
  /\bhit (?:your )?(?:usage )?limits?\b/i,
  /\busage limits?.*(?:reached|exceeded|try again)\b/i,
  /\b(?:quota|limit) (?:reached|exceeded)\b/i,
  /\b(?:reached|exceeded) (?:your )?(?:usage )?(?:limit|quota)\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate limits?.*(?:reached|exceeded)\b/i,
  /\brate limited\b/i,
  // HTTP-style hard rate limits from CLI/provider retries (Codex/OpenAI path).
  // Anchor 429 to rate-limit context. A bare /\b429\b/ (or a bare "too many
  // requests") false-positives on ordinary TUI content — port numbers, log
  // line numbers, and especially agent command output (e.g. code/docs that
  // literally print "Too Many Requests"). This detector runs on every screen
  // frame, so keep it tight: only 429 that sits next to a status word or the
  // full "429 Too Many Requests" phrase, plus the explicit retry-exhaustion line.
  /status:\s*429\b/i,
  /\b429\s+too many requests\b/i,
  /\bexceeded retry limit\b/i,
];

// Hard rate-limit signatures that often omit a wall-clock retry time.
// Only these get the fixed-cooldown fallback so generic "try again later"
// usage copy stays non-blocking (existing product decision). Same tightened
// contexts as above — never a bare 429 / bare "too many requests".
const HARD_RATE_LIMIT_WITHOUT_TIME_PATTERNS = [
  /status:\s*429\b/i,
  /\b429\s+too many requests\b/i,
  /\bexceeded retry limit\b/i,
];

// Quantized cooldown for hard 429-style errors without a parseable clock time.
// Bucketed so repeated screen ticks produce a stable usageLimitStateKey.
export const HARD_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

const RETRY_TIME_PATTERNS = [
  /\btry\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
  /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
];

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function parseMeridiemTime(text: string, now: Date): { retryAtMs: number; retryLabel: string } | null {
  for (const pattern of RETRY_TIME_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const rawHour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3].toLowerCase().replace(/\./g, '');
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

    let hour = rawHour % 12;
    if (meridiem === 'pm') hour += 12;

    const retryAt = new Date(now);
    retryAt.setHours(hour, minute, 0, 0);
    // CLI output only includes a wall-clock time, not a date. Roll passed AM
    // times into tomorrow because afternoon→midnight resets are common. Passed
    // PM times stay on today: they might mean "just reset" or "tomorrow PM",
    // and a wrong ready state self-heals when the CLI rejects the retry again.
    if (retryAt.getTime() < now.getTime() && hour < 12) {
      retryAt.setDate(retryAt.getDate() + 1);
    }

    return {
      retryAtMs: retryAt.getTime(),
      retryLabel: match[0].replace(/^(?:try\s+again\s+at|resets?(?:\s+at)?)\s+/i, '').trim(),
    };
  }
  return null;
}

function parseRelativeReset(text: string, now: Date): {
  retryAtMs: number; retryLabel: string; relativeResetKey: string;
} | null {
  const match = /\bresets?\s+in\s+((?:\d+(?:\.\d+)?[dhms]\s*)+)(?=$|[.,!;)\]\r\n])/i.exec(text);
  if (!match) return null;
  const label = match[1]!.replace(/\s+/g, '');
  const scales: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let duration = 0;
  let previousScale = Infinity;
  for (const part of label.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)) {
    const scale = scales[part[2]!.toLowerCase()]!;
    if (scale >= previousScale) return null;
    previousScale = scale;
    duration += Number(part[1]) * scale;
  }
  const retryAtMs = now.getTime() + duration;
  if (!Number.isSafeInteger(duration) || !Number.isFinite(new Date(retryAtMs).getTime())) return null;
  const errorId = /(?:^|\n)[ \t]*Error ID:[ \t]*([a-zA-Z0-9-]+)/.exec(text)?.[1] ?? '';
  return { retryAtMs, retryLabel: label, relativeResetKey: `${duration}:${errorId}` };
}

/** Stable fixed cooldown pinned to wall-clock buckets for hard 429 fallbacks. */
function hardRateLimitFallbackTime(now: Date): { retryAtMs: number; retryLabel: string } {
  const nowMs = now.getTime();
  const bucketStart = Math.floor(nowMs / HARD_RATE_LIMIT_COOLDOWN_MS) * HARD_RATE_LIMIT_COOLDOWN_MS;
  // End of the *next* full bucket so the wait is always in (5min, 10min].
  // Within one bucket every screen tick returns the same retryAtMs/key.
  const retryAtMs = bucketStart + 2 * HARD_RATE_LIMIT_COOLDOWN_MS;
  return {
    retryAtMs,
    // Label reflects the real (5min, 10min] window, not an optimistic "~5 min":
    // the card's countdown text must not undersell how long the wait can be.
    retryLabel: '5-10 min',
  };
}

export interface DetectUsageLimitOptions {
  /**
   * Suppress the screen-scan `rate` verdict entirely. Set for CLIs that have an
   * authoritative structured rate-limit signal (Claude family via transcript
   * `error:"rate_limit"`): there, scraping the screen for "429" / "rate limit"
   * only produces false positives (the model's own output, or a dev editing
   * rate-limit code, puts those phrases on screen). `usage` quota detection is
   * unaffected — it has no structured equivalent yet.
   */
  suppressRateKind?: boolean;
  /**
   * Whether the CLI is demonstrably producing output (PTY activity within the
   * caller's freshness window). The active-work gate in detectScreenUsageLimit
   * only suppresses the verdict while this is true. `working`/`analyzing`
   * alone do not prove output is progressing — `working` is the default
   * projection whenever promptReady === false — so a non-structured CLI
   * blocked at a rate/quota error screen that never renders its configured
   * ready prompt stays `working` forever (only Codex App projects `stalled`),
   * and a genuine blocking 429 would be suppressed indefinitely. Pass `false`
   * when PTY output has been quiescent past the window so the detector still
   * runs on a parked error screen. Omit (or pass `true`) to keep the
   * conservative suppress-on-working behavior.
   */
  outputActive?: boolean;
}

/**
 * Whether a runtime screen status proves the CLI is actively doing work.
 *
 * The screen-scan detector cannot tell a live limit block from limit-shaped
 * text the CLI itself put on screen — a model answer quoting a business 429,
 * tool output, docs, test fixtures. The runtime status disambiguates: a
 * rate/usage limit blocks the CLI, and a blocked CLI sits at an error/prompt
 * screen (`idle`/`stalled`); it does not keep producing output. So while the
 * CLI is `working`/`analyzing`, any "429 / rate limit / usage limit" text on
 * screen is the CLI's own output or a transient retry it is handling
 * internally, and a screen-scan verdict must be suppressed. Root cause of the
 * "CLI 还在跑却提示限额已达" false reports (Codex/Hermes, 2026-08).
 *
 * Caveat (refined by detectScreenUsageLimit's `outputActive` option): in this
 * worker `working` is the DEFAULT projection whenever promptReady === false,
 * not proof that output is progressing. A non-structured CLI blocked at a
 * rate-limit error screen that never renders its ready prompt stays `working`
 * forever (only Codex App projects `stalled`), so the status alone is not a
 * safe suppression gate — pair it with an output-activity signal.
 */
export function isActiveWorkRuntimeStatus(status: string | null | undefined): boolean {
  return status === 'working' || status === 'analyzing';
}

/**
 * Screen-frame detection: `detectCliUsageLimit` gated on the frame's runtime
 * status. The worker's per-frame classify path goes through here so a single
 * choke point owns the "active work suppresses the verdict" policy — keeping
 * it out of the pure text classifier, whose existing callers (turn-start
 * stale-banner snapshot) have no fresh status context.
 *
 * The suppression requires BOTH an active-work status AND actively progressing
 * output (`outputActive !== false`). When `outputActive` is `false` the CLI is
 * parked (PTY quiescent) even though the status says `working` — a blocked
 * non-structured CLI's error screen — so the detector must still run. Callers
 * that cannot assess output activity omit the hint and keep suppressing on
 * working/analyzing (the conservative default).
 */
export function detectScreenUsageLimit(
  text: string,
  status: string | null | undefined,
  now: Date = new Date(),
  opts: DetectUsageLimitOptions = {},
): CliUsageLimitDetection {
  if (isActiveWorkRuntimeStatus(status) && opts.outputActive !== false) {
    return { limited: false };
  }
  return detectCliUsageLimit(text, now, opts);
}

/**
 * Whether a CLI adapter is authoritative for structured rate limits — i.e. it
 * actually PUBLISHES a `limited` screen_update from a machine signal in its
 * transcript rather than from scraping screen text. Two families qualify:
 *
 *  - The Claude family (`claudeDataDir`): the worker's
 *    `maybeEmitStructuredRateLimit` reads the transcript's `error:"rate_limit"`
 *    record on the `bridgeJsonlPath` path.
 *  - Codex (`emitsStructuredRateLimit`): `maybeEmitCodexStructuredRateLimit`
 *    reads the rollout's `codex_rate_limited` terminal (`isCodexRateLimitEvent`)
 *    and emits `limited`. This emit runs only under the `structuredBridgeIsCodex`
 *    gate, so among codexBridgeQueue CLIs only codex sets the flag.
 *
 * When true the worker passes `suppressRateKind` so the screen-scan `rate`
 * verdict is dropped in favor of the structured signal — otherwise the model's
 * own output (or a dev editing rate-limit code) puts "429" / "exceeded retry
 * limit" on screen and the scraper cannot tell a printed 429 from a request
 * that actually returned 429.
 *
 * The other codexBridgeQueue CLIs (grok / traex / pi / hermes / mtr / cursor)
 * emit NO structured `limited` state, so they must keep screen-scanning: set
 * neither field on them or a real 429 silently loses its backoff + Dashboard
 * 「需要你」signal. Most set `reliableTurnTerminal`, so gating on that flag would
 * wrongly suppress them; gating on these two explicit capability fields keeps
 * the split exact. Extracted as a pure predicate so it has a direct unit-test
 * surface (see cli-usage-limit.test.ts) — a future adapter can't silently
 * re-broaden it.
 */
export function isStructuredRateLimitAuthoritative(
  adapter: { readonly claudeDataDir?: string; readonly emitsStructuredRateLimit?: boolean } | null | undefined,
): boolean {
  return !!adapter?.claudeDataDir || !!adapter?.emitsStructuredRateLimit;
}

export function detectCliUsageLimit(
  text: string,
  now = new Date(),
  opts: DetectUsageLimitOptions = {},
): CliUsageLimitDetection {
  // Hot path: runs on every screen tick for every active session. Gate heavier
  // regex work behind one cheap scan for the >99% no-limit case.
  // Include 429 / retry-limit tokens — "retry" does not contain "again".
  if (!/again|reset|429|too many requests|rate limit|retry limit/i.test(text)) {
    return { limited: false };
  }

  // A viewport may retain several refusals. Parse the newest matching line
  // and the reset/Error ID below it, never a previous episode above it.
  const lastRefusalLine = (patterns: RegExp[]): number => {
    let start = -1;
    for (const pattern of patterns) {
      for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
        start = Math.max(start, text.lastIndexOf('\n', match.index - 1) + 1);
      }
    }
    return start;
  };
  const rateLine = lastRefusalLine(RATE_LIMIT_PATTERNS);
  const usageLine = lastRefusalLine(USAGE_LIMIT_PATTERNS);
  const start = Math.max(rateLine, usageLine);
  if (start < 0) return { limited: false };
  const latest = text.slice(start);
  const isRate = rateLine >= 0 && rateLine >= usageLine;
  if (isRate && opts.suppressRateKind) return { limited: false };
  const isUsage = !isRate && usageLine >= 0;
  const time = parseMeridiemTime(latest, now) ?? parseRelativeReset(latest, now);
  if (!isRate && !isUsage) return { limited: false };

  if (time) {
    return {
      limited: true,
      kind: isRate ? 'rate' : 'usage',
      retryAtMs: time.retryAtMs,
      retryLabel: time.retryLabel,
      retryReady: now.getTime() >= time.retryAtMs,
      ...('relativeResetKey' in time ? { relativeResetKey: `${isRate ? 'rate' : 'usage'}:${time.relativeResetKey}` } : {}),
    };
  }

  // Usage limits without a concrete clock time stay non-blocking (existing tests).
  // Hard HTTP 429 / exceeded-retry-limit paths get a stable cooldown fallback so
  // the session can still surface as limited → Dashboard「需要你」.
  if (isRate && hasPattern(latest, HARD_RATE_LIMIT_WITHOUT_TIME_PATTERNS)) {
    const fallback = hardRateLimitFallbackTime(now);
    return {
      limited: true,
      kind: 'rate',
      retryAtMs: fallback.retryAtMs,
      retryLabel: fallback.retryLabel,
      retryReady: now.getTime() >= fallback.retryAtMs,
    };
  }

  return { limited: false };
}

export function usageLimitStateKey(state: CliUsageLimitState): string {
  const key = `${state.kind}:${state.retryAtMs}:${state.retryLabel}`;
  return state.relativeResetKey ? `${key}:${state.relativeResetKey}` : key;
}

/** Repeated screenshots contain the same relative duration, not a new reset.
 * Keep the first deadline, including after session-state restore. Clearing the
 * prior state or seeing a new error episode starts a fresh deadline. */
export function reconcileUsageLimitState(
  previous: CliUsageLimitState | undefined,
  incoming: CliUsageLimitState,
  nowMs = Date.now(),
): CliUsageLimitState {
  if (!incoming.relativeResetKey || previous?.relativeResetKey !== incoming.relativeResetKey
    || previous.kind !== incoming.kind || !Number.isFinite(previous.retryAtMs)) return incoming;
  return {
    ...incoming,
    retryAtMs: previous.retryAtMs,
    retryReady: previous.retryReady || nowMs >= previous.retryAtMs,
    ...(previous.source ? { source: previous.source } : {}),
  };
}

/**
 * Build a rate-limit state from a STRUCTURED signal (e.g. Claude Code's
 * transcript `error: "rate_limit"` record) instead of screen text.
 *
 * The caller has already decided this IS a rate limit via a machine field, so
 * unlike detectCliUsageLimit() there is no pattern gate here — we only need to
 * fix the retry time. Claude's rate-limit records usually carry a human clock
 * in their text ("You've hit your session limit · resets 10:40pm"); when
 * `text` yields a parseable time we honor it (accurate retry_ready flip),
 * otherwise we reuse the same wall-clock-bucketed fallback the screen-text
 * hard-429 path uses so the usageLimitStateKey stays stable across repeated
 * ticks within a bucket (no persist/timer churn on the daemon side).
 */
export function structuredRateLimitState(text = '', now = new Date()): CliUsageLimitState {
  const parsed = parseMeridiemTime(text, now);
  const { retryAtMs, retryLabel } = parsed ?? hardRateLimitFallbackTime(now);
  return {
    limited: true,
    kind: 'rate',
    retryAtMs,
    retryLabel,
    retryReady: now.getTime() >= retryAtMs,
  };
}

/**
 * Same as structuredRateLimitState, but keeps the quota/rate distinction.
 * Codex reports both 429s and account quota exhaustion ("You’ve hit your usage
 * limit … try again at 9:00 AM") through one structured `codex_rate_limited`
 * terminal. `kind` is the reader's structured verdict (from the raw error's
 * `codex_error_info` / message) and wins; `text` is only the redacted display
 * summary — it supplies the retry time, and the kind only when none was given.
 */
export function structuredCodexLimitState(
  text = '',
  kind?: CliUsageLimitKind,
  now = new Date(),
): CliUsageLimitState {
  const state = structuredRateLimitState(text, now);
  const resolved = kind
    ?? (!hasPattern(text, RATE_LIMIT_PATTERNS) && hasPattern(text, USAGE_LIMIT_PATTERNS) ? 'usage' : 'rate');
  return { ...state, kind: resolved };
}
