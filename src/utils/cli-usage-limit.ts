export type CliUsageLimitKind = 'usage' | 'rate';
export type CliUsageLimitSource = 'antigravity-error-composer' | 'antigravity-native-log';

/** Serializable transcript position sampled immediately before an Antigravity
 * input was written. A no-output/answered proof may only use USER_INPUT records
 * at or after this boundary, including when the full/compact view changes. */
export interface AntigravityTranscriptWriteBoundary {
  readonly sampledTranscriptPath?: string;
  readonly minByteOffset: number;
  readonly skipPriorMatches?: number;
}

export function sameAntigravityTranscriptWriteBoundary(
  a: AntigravityTranscriptWriteBoundary | undefined,
  b: AntigravityTranscriptWriteBoundary | undefined,
): boolean {
  return a === b || Boolean(a && b
    && a.sampledTranscriptPath === b.sampledTranscriptPath
    && a.minByteOffset === b.minByteOffset
    && (a.skipPriorMatches ?? 0) === (b.skipPriorMatches ?? 0));
}

export interface CliUsageLimitState {
  limited: true;
  kind: CliUsageLimitKind;
  retryAtMs: number;
  retryLabel: string;
  retryReady: boolean;
  /** Stable identity of one relative-countdown refusal, persisted so a
   * reattached worker cannot move its already-observed reset deadline. */
  relativeResetKey?: string;
  /** A confirmed native quota source must survive unrelated PTY output. */
  source?: CliUsageLimitSource;
  /** Canonical primary native episode key: `log:<glog-ts>` when log-backed,
   *  else `composer:<errorId>`. Independent of countdown wording. */
  nativeEpisodeKey?: string;
  /** Companion native key when one episode was observed simultaneously on both
   *  a footerless composer and a native executor log (`composer:<errorId>`).
   *  Never populated for replacement logs on an already-known composer. */
  linkedNativeEpisodeKey?: string;
  /** Paired native transcript proof that the turn produced zero output or side
   *  effects after USER_INPUT and may be safely auto-replayed after rotation. */
  directFailure?: true;
  /** Current-turn pre-write boundary backing directFailure. It is persisted
   *  alongside the provisional failed turn so daemon settlement re-proves the
   *  same input window instead of accepting an older identical prompt. */
  antigravityWriteBoundary?: AntigravityTranscriptWriteBoundary;
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
const HARD_RATE_LIMIT_FALLBACK_LABEL = '5-10 min';

/** A rate limit that carried no provider reset time, so botmux applied its own
 * cooldown: usually transient, unlike a quota with a stated reset clock. */
export function isTransientRateLimit(state: CliUsageLimitState): boolean {
  return state.kind === 'rate' && state.retryLabel === HARD_RATE_LIMIT_FALLBACK_LABEL;
}

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
    retryLabel: HARD_RATE_LIMIT_FALLBACK_LABEL,
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

export function isAntigravityNativeLimit(state: CliUsageLimitState | undefined): boolean {
  return state?.source === 'antigravity-error-composer' || state?.source === 'antigravity-native-log';
}

export function isExpiredNativeAntigravityQuota(
  limit: CliUsageLimitState | undefined,
  nowMs = Date.now(),
): boolean {
  return isAntigravityNativeLimit(limit) && Boolean(limit?.relativeResetKey) && limit!.retryAtMs <= nowMs;
}

function legacyComposerKeyFromRelativeReset(state: CliUsageLimitState | undefined): string | undefined {
  if (state?.source !== 'antigravity-error-composer' || !state.relativeResetKey) return undefined;
  const first = state.relativeResetKey.indexOf(':');
  const second = first >= 0 ? state.relativeResetKey.indexOf(':', first + 1) : -1;
  const errorId = second >= 0 ? state.relativeResetKey.slice(second + 1) : '';
  return errorId ? `composer:${errorId}` : undefined;
}

/** All native episode keys carried by a confirmed Antigravity limit state.
 *  Falls back to deriving `composer:<errorId>` from legacy `relativeResetKey`
 *  so persisted pre-refactor rows match new rows with zero migration. */
export function cliUsageLimitNativeKeys(state: CliUsageLimitState | undefined): string[] {
  if (!state) return [];
  const keys: string[] = [];
  if (state.nativeEpisodeKey) keys.push(state.nativeEpisodeKey);
  if (state.linkedNativeEpisodeKey && !keys.includes(state.linkedNativeEpisodeKey)) {
    keys.push(state.linkedNativeEpisodeKey);
  }
  if (keys.length === 0) {
    const legacy = legacyComposerKeyFromRelativeReset(state);
    if (legacy) keys.push(legacy);
  }
  return keys;
}

/** Canonical primary episode key across worker, daemon, history, tombstones,
 *  and notifications. Always prefers `log:*` over `composer:*`, then falls back
 *  to `relativeResetKey` for generic/legacy states. */
export function cliUsageLimitEpisodeKey(state: CliUsageLimitState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.nativeEpisodeKey?.startsWith('log:')) return state.nativeEpisodeKey;
  if (state.linkedNativeEpisodeKey?.startsWith('log:')) return state.linkedNativeEpisodeKey;
  return state.nativeEpisodeKey
    ?? state.linkedNativeEpisodeKey
    ?? legacyComposerKeyFromRelativeReset(state)
    ?? state.relativeResetKey;
}

/** Whether two usage-limit states represent the same underlying episode.
 *  Conflicting `log:*` keys never match even if they share a composer Error ID;
 *  linked `log:* <-> composer:*` pairs match bidirectionally. */
export function isSameUsageLimitEpisode(
  a: CliUsageLimitState | undefined,
  b: CliUsageLimitState | undefined,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  const aKeys = cliUsageLimitNativeKeys(a);
  const bKeys = cliUsageLimitNativeKeys(b);
  if (aKeys.length > 0 && bKeys.length > 0) {
    const aLog = aKeys.find(k => k.startsWith('log:'));
    const bLog = bKeys.find(k => k.startsWith('log:'));
    if (aLog && bLog) return aLog === bLog;
    return aKeys.some(k => bKeys.includes(k));
  }
  if (aKeys.length > 0 || bKeys.length > 0) return false;
  if (a.relativeResetKey || b.relativeResetKey) {
    return a.relativeResetKey === b.relativeResetKey;
  }
  return a.source === b.source && a.retryLabel === b.retryLabel && a.retryAtMs === b.retryAtMs;
}

/** Exact structural equality for persistence diffing and skip-write guards. */
export function sameUsageLimit(
  a: CliUsageLimitState | undefined,
  b: CliUsageLimitState | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind
    && a.retryAtMs === b.retryAtMs
    && a.retryLabel === b.retryLabel
    && a.retryReady === b.retryReady
    && a.relativeResetKey === b.relativeResetKey
    && a.source === b.source
    && a.nativeEpisodeKey === b.nativeEpisodeKey
    && a.linkedNativeEpisodeKey === b.linkedNativeEpisodeKey
    && a.directFailure === b.directFailure
    && sameAntigravityTranscriptWriteBoundary(a.antigravityWriteBoundary, b.antigravityWriteBoundary);
}

/** Whether any native key of `state` is present in the durable consumed set. */
export function isAntigravityEpisodeConsumed(
  consumedKeys: readonly string[] | undefined,
  state: CliUsageLimitState | undefined,
): boolean {
  if (!consumedKeys?.length || !state) return false;
  const keys = cliUsageLimitNativeKeys(state);
  if (keys.length === 0) return false;
  return keys.some(key => consumedKeys.includes(key));
}

/** Append all native keys of one or more settled episodes into a bounded FIFO
 *  consumed list (default cap 32), avoiding duplicates. */
export function appendConsumedAntigravityQuotaKeys(
  existing: readonly string[] | undefined,
  episodes: readonly (CliUsageLimitState | undefined)[],
  limit = 32,
): readonly string[] | undefined {
  const next = existing ? [...existing] : [];
  let changed = false;
  for (const episode of episodes) {
    for (const key of cliUsageLimitNativeKeys(episode)) {
      if (!next.includes(key)) {
        next.push(key);
        changed = true;
      }
    }
  }
  if (!changed) return existing;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function usageLimitStateKey(state: CliUsageLimitState): string {
  const key = `${state.kind}:${state.retryAtMs}:${state.retryLabel}`;
  const episode = cliUsageLimitEpisodeKey(state);
  return episode ? `${key}:${episode}` : key;
}

/** Stable worker-side evidence fingerprint for frame deduplication. Omits
 *  per-tick recomputed `retryAtMs` when an explicit episode key exists or the
 *  state is a synthetic bare-429 cooldown, preventing per-tick IPC spam while
 *  still firing on proof, source, episode, or `retryReady` transitions. */
export function usageLimitEvidenceKey(state: CliUsageLimitState | undefined): string {
  if (!state) return '';
  const episode = cliUsageLimitEpisodeKey(state);
  const includeRetryAt = !episode && !isTransientRateLimit(state);
  return JSON.stringify([
    state.kind,
    includeRetryAt ? state.retryAtMs : null,
    state.retryLabel,
    state.retryReady,
    state.source ?? null,
    state.nativeEpisodeKey ?? null,
    state.linkedNativeEpisodeKey ?? null,
    state.relativeResetKey ?? null,
    state.directFailure === true,
    state.antigravityWriteBoundary
      ? [
        state.antigravityWriteBoundary.sampledTranscriptPath ?? null,
        state.antigravityWriteBoundary.minByteOffset,
        state.antigravityWriteBoundary.skipPriorMatches ?? 0,
      ]
      : null,
  ]);
}

/** Semantic dedup suffix folded into screenshot pixel keys so static-pixel
 *  frames still emit on proof, episode, expiry, or recovery transitions. */
export function screenshotUsageLimitDedupSuffix(frame: {
  status: string;
  usageLimit?: CliUsageLimitState;
  expiredAntigravityQuota?: CliUsageLimitState;
  usageLimitRecovery?: string;
}): string {
  const parts: string[] = [];
  if (frame.status === 'limited' || frame.usageLimit) {
    parts.push(`status=${frame.status}`);
    parts.push(`limit=${usageLimitEvidenceKey(frame.usageLimit)}`);
  }
  if (frame.expiredAntigravityQuota) {
    parts.push(`expired=${cliUsageLimitEpisodeKey(frame.expiredAntigravityQuota) ?? usageLimitStateKey(frame.expiredAntigravityQuota)}`);
  }
  if (frame.usageLimitRecovery) {
    parts.push(`recovery=${frame.usageLimitRecovery}`);
  }
  return parts.length > 0 ? `:${parts.join(':')}` : '';
}

/** Stable scope identifying the logical turn / direct-input generation that
 *  produced a usage-limit observation. Used to pin synthetic bare-429 cooldowns
 *  within a single turn without leaking expired cooldowns across turns. */
export function computeUsageLimitTurnScope(
  turnId: string | undefined,
  dispatchAttempt: number | undefined,
  directInputEpoch: number | undefined,
): string {
  return JSON.stringify([turnId ?? null, dispatchAttempt ?? null, directInputEpoch ?? 0]);
}

export interface ReconcileUsageLimitOptions {
  nowMs?: number;
  /** Explicitly opt into pinning synthetic `5-10 min` hard-429 cooldowns across
   *  5-minute bucket rollovers ONLY within the same turn/input generation.
   *  Defaults fail-closed to `false` so new turns never inherit expired cooldowns. */
  sameTransientTurn?: boolean;
}

/** Repeated screenshots contain the same relative duration, not a new reset.
 * Keep the first deadline, including after session-state restore. Clearing the
 * prior state or seeing a new error episode starts a fresh deadline. */
export function reconcileUsageLimitState(
  previous: CliUsageLimitState | undefined,
  incoming: CliUsageLimitState,
  nowMsOrOpts: number | ReconcileUsageLimitOptions = Date.now(),
): CliUsageLimitState {
  if (!previous || !Number.isFinite(previous.retryAtMs)) return incoming;
  const nowMs = typeof nowMsOrOpts === 'number' ? nowMsOrOpts : (nowMsOrOpts.nowMs ?? Date.now());
  const sameTransientTurn = typeof nowMsOrOpts === 'number' ? false : nowMsOrOpts.sameTransientTurn === true;

  if (sameTransientTurn && isTransientRateLimit(previous) && isTransientRateLimit(incoming)) {
    return {
      ...incoming,
      retryAtMs: previous.retryAtMs,
      retryReady: previous.retryReady || nowMs >= previous.retryAtMs,
    };
  }

  const prevKeys = cliUsageLimitNativeKeys(previous);
  const nextKeys = cliUsageLimitNativeKeys(incoming);

  // 1. Same native or linked episode, or same generic relativeResetKey.
  if (isSameUsageLimitEpisode(previous, incoming)) {
    const mergedKeys = [...new Set([...nextKeys, ...prevKeys])];
    const logKey = mergedKeys.find(k => k.startsWith('log:'));
    const composerKey = mergedKeys.find(k => k.startsWith('composer:'));
    const primaryKey = logKey ?? composerKey;
    const linkedKey = logKey && composerKey ? composerKey : undefined;
    const source = incoming.source ?? previous.source;
    const next: CliUsageLimitState = {
      ...incoming,
      retryAtMs: previous.retryAtMs,
      retryReady: previous.retryReady || nowMs >= previous.retryAtMs,
      ...(source ? { source } : {}),
    };
    if (primaryKey) next.nativeEpisodeKey = primaryKey;
    else delete next.nativeEpisodeKey;
    if (linkedKey) next.linkedNativeEpisodeKey = linkedKey;
    else delete next.linkedNativeEpisodeKey;
    return next;
  }

  // 2. Generic partial frame upgraded to a confirmed native episode on the same relativeResetKey.
  if (
    prevKeys.length === 0
    && nextKeys.length > 0
    && previous.kind === incoming.kind
    && Boolean(previous.relativeResetKey && previous.relativeResetKey === incoming.relativeResetKey)
  ) {
    return {
      ...incoming,
      retryAtMs: previous.retryAtMs,
      retryReady: previous.retryReady || nowMs >= previous.retryAtMs,
    };
  }

  // 3. Active (unexpired) native episode followed by a partial generic frame on the same relativeResetKey:
  //    keep first deadline and native provenance so a truncated capture cannot strip native identity.
  if (
    prevKeys.length > 0
    && nextKeys.length === 0
    && previous.kind === incoming.kind
    && Boolean(previous.relativeResetKey && previous.relativeResetKey === incoming.relativeResetKey)
    && !isExpiredNativeAntigravityQuota(previous, nowMs)
  ) {
    return {
      ...incoming,
      retryAtMs: previous.retryAtMs,
      retryReady: previous.retryReady || nowMs >= previous.retryAtMs,
      ...(previous.source ? { source: previous.source } : {}),
      ...(previous.nativeEpisodeKey ? { nativeEpisodeKey: previous.nativeEpisodeKey } : {}),
      ...(previous.linkedNativeEpisodeKey ? { linkedNativeEpisodeKey: previous.linkedNativeEpisodeKey } : {}),
    };
  }

  return incoming;
}

export type UsageLimitTriggerEdge =
  | { readonly kind: 'entered'; readonly notificationKey: string }
  | { readonly kind: 'replaced_expired'; readonly notificationKey: string }
  | { readonly kind: 'native_confirmation'; readonly notificationKey: string }
  | { readonly kind: 'replaced_native'; readonly notificationKey: string }
  | { readonly kind: 'replaced_transient_turn'; readonly notificationKey: string };

/** Single canonical daemon trigger-edge classifier shared by `screen_update`
 *  and `screenshot_uploaded`. Returns an edge iff rotation / fallback / owner
 *  notification should be evaluated for this state transition. */
export function classifyUsageLimitTriggerEdge(input: {
  prevStatus?: string;
  prevLimit?: CliUsageLimitState;
  prevTurnScope?: string;
  nextLimit: CliUsageLimitState;
  nextTurnScope?: string;
  nowMs?: number;
}): UsageLimitTriggerEdge | undefined {
  const { prevStatus, prevLimit, prevTurnScope, nextLimit, nextTurnScope } = input;
  const nowMs = input.nowMs ?? Date.now();
  const nextKey = usageLimitStateKey(nextLimit);

  if (prevStatus !== 'limited' || !prevLimit) {
    return { kind: 'entered', notificationKey: nextKey };
  }
  if (isExpiredNativeAntigravityQuota(prevLimit, nowMs) && !isSameUsageLimitEpisode(prevLimit, nextLimit)) {
    return { kind: 'replaced_expired', notificationKey: nextKey };
  }
  if (!isAntigravityNativeLimit(prevLimit) && isAntigravityNativeLimit(nextLimit)) {
    const sameBanner = prevLimit.kind === nextLimit.kind
      && prevLimit.retryLabel === nextLimit.retryLabel
      && prevLimit.relativeResetKey === nextLimit.relativeResetKey;
    return {
      kind: 'native_confirmation',
      notificationKey: sameBanner ? usageLimitStateKey(prevLimit) : nextKey,
    };
  }
  if (isAntigravityNativeLimit(nextLimit) && !isSameUsageLimitEpisode(prevLimit, nextLimit)) {
    return { kind: 'replaced_native', notificationKey: nextKey };
  }
  if (
    isTransientRateLimit(prevLimit)
    && isTransientRateLimit(nextLimit)
    && prevTurnScope !== undefined
    && nextTurnScope !== undefined
    && prevTurnScope !== nextTurnScope
  ) {
    return { kind: 'replaced_transient_turn', notificationKey: `${nextKey}@${nextTurnScope}` };
  }
  if (
    isTransientRateLimit(prevLimit)
    && isTransientRateLimit(nextLimit)
    && prevLimit.retryReady
    && !nextLimit.retryReady
  ) {
    return {
      kind: 'replaced_transient_turn',
      notificationKey: nextTurnScope ? `${nextKey}@${nextTurnScope}` : nextKey,
    };
  }
  return undefined;
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
