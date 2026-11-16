/**
 * "Resume fell back to a fresh session" — gate, copy, and the daemon handler.
 *
 * The worker reports the FACT (it knows why the demotion happened); the daemon
 * owns DELIVERY. Two reasons, both learned the hard way:
 *
 *  - `/restart` forks a new worker, so a worker-level "already notified" latch
 *    re-posts the notice on every restart. The latch therefore lives on the
 *    daemon session.
 *  - A brand-new topic whose first `/restart` lands on a fresh spawn has no
 *    history to lose; announcing "history won't come back" is noise. Only a
 *    session that really held a CLI conversation gets the notice.
 *
 * The fact itself is never swallowed: every report is logged, including the
 * ones whose user notice is suppressed, so a second fallback stays auditable.
 */

/** Where the demotion came from:
 *  - `no-exact-id`: adapter needs a precise native id and none was persisted
 *    (Tier 0). Nothing failed — we simply cannot address the old session.
 *  - `probe-missing`: the adapter proved the resume target is gone (Tier 1).
 *  - `restart-loop`: 2nd consecutive in-worker restart; resume already failed
 *    once (Tier 2). */
export type ResumeFallbackTier = 'no-exact-id' | 'probe-missing' | 'restart-loop';

/** User-facing copy for one demotion.
 *
 * Tier 0 is deliberately NEUTRAL: botmux never had the CLI-native id, so a
 * fresh session is the honest outcome rather than a launch failure. "启动失败"
 * is reserved for a resume that was actually attempted and failed (Tier 1/2),
 * where the user's expectation of restored context was broken by an error. */
export function resumeFallbackNotice(tier: ResumeFallbackTier): string {
  if (tier === 'no-exact-id') {
    return '本次未能精确定位原会话，已开启新会话；历史上下文不会恢复。';
  }
  return '⚠️ 会话启动失败，正在尝试以新会话重新启动。\n'
    + '这次重试不会恢复历史上下文；如需继续之前的任务，请补充背景。';
}

/** The session state the gate may look at (a `DaemonSession` satisfies it).
 *
 * `hasHistory` is deliberately NOT authoritative: the restore path sets it
 * `true` for EVERY persisted session, so a restored session that never ran a
 * turn would otherwise announce a history loss it never had. The top-level
 * `lastUserPrompt` / `lastCliInput` mirrors are runtime-only (absent right
 * after a restore) and are not authoritative either.
 */
export interface ResumeFallbackSessionState {
  /** In-memory once-per-daemon-session notice latch. */
  resumeFreshFallbackNotified?: boolean;
  /** Ignored: restore sets it true unconditionally. Kept in the type so the
   *  caller can pass the whole session and tests can pin the rule. */
  hasHistory?: boolean;
  /** Ignored: runtime mirrors, absent after a restore. */
  lastUserPrompt?: string;
  lastCliInput?: string;
  /** PERSISTED evidence — the only authoritative source. */
  session?: {
    /** Never sufficient on its own: the first message (e.g. an alert card) is
     *  recorded here before any CLI turn runs. */
    lastUserPrompt?: string;
    /** The one signal that proves a CLI turn ran (and thus that there is
     *  conversation context to lose). `/clear` wipes it, which is exactly why
     *  a cleared session correctly stops notifying. */
    lastCliInput?: string;
  };
}

export function sessionHasResumeHistory(source: ResumeFallbackSessionState): boolean {
  // Primary evidence only. `lastUserPrompt` alone means "the topic received an
  // input" but says nothing about the CLI having produced history, and
  // `hasHistory` is polluted by restore — both must stay out of this decision.
  return !!source.session?.lastCliInput?.trim();
}

export interface ResumeFallbackReport {
  tier: ResumeFallbackTier;
  reason?: string;
  turnId?: string;
  /** Worker knowledge: false when nothing user-visible was ever produced (a
   *  claude-family first-turn launch failure whose transcript never existed). */
  lost?: boolean;
}

export interface ResumeFallbackDecisionInput extends ResumeFallbackReport {
  /** Session had a conversation to lose (see {@link sessionHasResumeHistory}). */
  hasSessionHistory: boolean;
  /** This session already received its one and only notice. */
  alreadyNotified: boolean;
  /** The owning turn is auxiliary-UI suppressed (a silent scheduled run, a
   *  meeting-driven turn, a message-listener session, a no-transport bot). The
   *  notice then stays in the log and the per-session latch is NOT spent, so a
   *  later human-visible turn on the same session still gets its one warning.
   *  Transport only: it never turns a noise report into an attention signal. */
  auxUiSuppressed?: boolean;
}

export interface ResumeFallbackOutcome {
  /** The structured fact. Present on EVERY report — never suppressed, so the
   *  daemon log answers "did this session fall back again?" even after the
   *  user-visible notice was already spent. */
  structured: ResumeFallbackReport & {
    kind: 'resume_fallback';
    suppressed?: 'no-history' | 'nothing-lost' | 'already-notified' | 'aux-ui-suppressed';
    deliveryFailed?: true;
  };
  /** Notice text to post, or undefined when the report must stay in the log. */
  notice?: string;
  /** The report cleared the CONTENT gates (something was lost and this
   *  session has not been told yet), whether or not the transport lets the
   *  notice out. Drives `session.requires_attention`, exactly as the transport
   *  gate never silences that hook for other user_notify kinds. A noise report
   *  (nothing lost / no history / already told) is not an attention event. */
  attention: boolean;
}

export function decideResumeFallbackReport(input: ResumeFallbackDecisionInput): ResumeFallbackOutcome {
  const base: ResumeFallbackReport = {
    tier: input.tier,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
  };
  // Content gates first: they decide whether there is anything to tell a human
  // at all (and so whether this is an attention event).
  if (input.lost === false) {
    return { structured: { kind: 'resume_fallback', ...base, suppressed: 'nothing-lost' }, attention: false };
  }
  if (!input.hasSessionHistory) {
    return { structured: { kind: 'resume_fallback', ...base, suppressed: 'no-history' }, attention: false };
  }
  if (input.alreadyNotified) {
    return { structured: { kind: 'resume_fallback', ...base, suppressed: 'already-notified' }, attention: false };
  }
  // Then transport: a turn whose auxiliary UI is suppressed must never surface
  // a Lark message, and must not spend the latch a visible turn owns.
  if (input.auxUiSuppressed) {
    return { structured: { kind: 'resume_fallback', ...base, suppressed: 'aux-ui-suppressed' }, attention: true };
  }
  return {
    structured: { kind: 'resume_fallback', ...base },
    notice: resumeFallbackNotice(input.tier),
    attention: true,
  };
}

export interface ResumeFallbackHandlerInput {
  ds: ResumeFallbackSessionState;
  report: ResumeFallbackReport;
  /** See {@link ResumeFallbackDecisionInput.auxUiSuppressed}. When true the
   *  report is logged only, sends nothing, and does not spend the latch. */
  auxUiSuppressed?: boolean;
  /** Raise the lifecycle attention signal; called once, before any send, iff
   *  {@link ResumeFallbackOutcome.attention}. */
  onAttention?: () => void;
  /** Deliver the one notice. A rejection releases the latch (retryable). */
  send: (notice: string) => Promise<void>;
  /** Structured record for every report, delivered or suppressed. */
  log: (line: string) => void;
}

export interface ResumeFallbackHandlerResult {
  outcome: ResumeFallbackOutcome;
  delivered: boolean;
}

/**
 * Daemon-side handler for one demotion report.
 *
 * Order of the log lines is load-bearing: the "attempting" record is written
 * BEFORE delivery and "delivered" only after the await resolves, so a failed
 * send can never appear as "delivered" followed by "failed".
 */
export async function handleResumeFallbackReport(
  input: ResumeFallbackHandlerInput,
): Promise<ResumeFallbackHandlerResult> {
  const { ds, report, send, log, auxUiSuppressed, onAttention } = input;
  const outcome = decideResumeFallbackReport({
    ...report,
    hasSessionHistory: sessionHasResumeHistory(ds),
    alreadyNotified: ds.resumeFreshFallbackNotified === true,
    auxUiSuppressed,
  });
  const fact = `resume fallback → fresh (tier=${outcome.structured.tier}`
    + (outcome.structured.reason ? `, reason: ${outcome.structured.reason}` : '') + ')';
  if (outcome.attention) onAttention?.();
  if (!outcome.notice) {
    // Suppressed reports are recorded immediately: nothing is pending.
    log(`${fact}: notice suppressed (${outcome.structured.suppressed})`);
    return { outcome, delivered: false };
  }
  // Claim the once-per-session slot BEFORE the await so a concurrent report
  // cannot slip through; release it if delivery fails.
  ds.resumeFreshFallbackNotified = true;
  log(`${fact}: notice attempting`);
  try {
    await send(outcome.notice);
  } catch (err) {
    ds.resumeFreshFallbackNotified = false;
    log(`${fact}: notice delivery failed (${(err as Error).message}); latch released for retry`);
    return {
      outcome: { structured: { ...outcome.structured, deliveryFailed: true }, attention: outcome.attention },
      delivered: false,
    };
  }
  log(`${fact}: notice delivered`);
  return { outcome, delivered: true };
}
