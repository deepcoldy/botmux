/**
 * Worker input-gate — decide whether an incoming Lark message is written to the
 * CLI's PTY now, or queued until the CLI is ready.
 *
 * `pendingMessages` always buffers the message; this only decides whether to
 * kick `flushPending()` immediately. Three "write now" cases:
 *
 *  - `isPromptReady`  — the CLI is idle and waiting for input.
 *  - `isFlushing`     — a drain loop is already running; let it pick this up.
 *  - type-ahead       — the adapter (Codex/CoCo/Claude) can accept input while
 *                       BUSY: the TUI parks it in its own queue / steers it into
 *                       the active turn.
 *
 * The catch the type-ahead case must respect: parking only works once the TUI
 * is actually up. During STARTUP (and tmux re-attach) the input box doesn't
 * exist yet, so a write is silently dropped — this is exactly how dispatch's
 * brief reached Codex ~6s before its first idle and never landed. `awaitingFirstPrompt`
 * is the worker's "hasn't reached ready even once" flag; while it's true we must
 * QUEUE even type-ahead messages and let `markPromptReady()`'s flush deliver them.
 */
export function shouldWriteNow(state: {
  /** CLI is idle, waiting for input. */
  isPromptReady: boolean;
  /** A flushPending() drain loop is already in progress. */
  isFlushing: boolean;
  /** Adapter accepts input while the CLI is mid-turn (type-ahead). */
  supportsTypeAhead: boolean;
  /** True until the CLI has reached its first ready state (boot / re-attach window). */
  awaitingFirstPrompt: boolean;
  /** A stale Codex App runner must not receive normal or type-ahead input. */
  holdForRunnerReload?: boolean;
}): boolean {
  if (state.holdForRunnerReload) return false;
  if (state.isPromptReady || state.isFlushing) return true;
  // Type-ahead is only safe after the TUI has booted at least once.
  return state.supportsTypeAhead && !state.awaitingFirstPrompt;
}

/**
 * Claude runs every matching SessionStart hook in parallel and waits for all of
 * them before it renders the real input prompt. Botmux's own hook can therefore
 * finish while a slower project hook is still running. During the first prompt,
 * treat the signal as an outer-selector boundary only and wait for fresh prompt
 * evidence emitted after that boundary.
 *
 * Other ready-integrated CLIs (notably Hermes) emit their signal only once their
 * prompt is usable, so their established authoritative-signal behavior stays
 * unchanged.
 */
export function shouldWaitForPostSessionStartPromptEvidence(state: {
  isClaudeFamily: boolean;
  hasReadyPattern: boolean;
  awaitingFirstPrompt: boolean;
  isPromptReady: boolean;
  alreadyWaiting: boolean;
}): boolean {
  return state.isClaudeFamily
    && state.hasReadyPattern
    && state.awaitingFirstPrompt
    && !state.isPromptReady
    && !state.alreadyWaiting;
}

/**
 * Whether the "accept a prompt that is ALREADY on screen" fallback
 * (decidePostHookPromptEvidence) may be armed for THIS SessionStart signal.
 *
 * The fallback exists only for `source=startup`: a brand-new session paints its
 * prompt before the hooks finish and never redraws, so the fresh-evidence fence
 * would otherwise wait out the full first-prompt timeout. Every OTHER source
 * (resume/clear/compact) replays or reprints its transcript AFTER the boundary,
 * so a genuinely fresh ❯ redraw arrives on its own in ~2s — the fence resolves
 * without help. Arming the fallback there would instead let a >2s pause over a
 * REPLAYED historical ❯ (still on the viewport during replay) satisfy the quiet
 * gate and accept a pre-boundary prompt, defeating the very fence resume relies
 * on. So the fallback is startup-only; the fence itself stays for all sources.
 *
 * Fail-safe: an unknown/absent source is NOT startup, so it does not arm — the
 * signal simply falls back to the existing first-prompt timeout (status quo),
 * never a new premature-delivery path.
 */
export function shouldArmPostHookPromptEvidenceFallback(state: {
  /** shouldWaitForPostSessionStartPromptEvidence already said we're fencing. */
  waitingForPostHookPrompt: boolean;
  /** The SessionStart hook payload's `source` field (Claude: startup/resume/…). */
  source: string | undefined;
}): boolean {
  return state.waitingForPostHookPrompt && state.source === 'startup';
}

/**
 * How long after the SessionStart boundary the fallback starts polling.
 *
 * The boundary also resets the quiescence baseline (`lastPtyOutputAtMs`), so the
 * quiet window can never be satisfied before `POST_HOOK_EVIDENCE_QUIET_MS` has
 * passed — polling earlier than that only burns a wakeup. Polling LATER just
 * adds dead time to every new session, so this tracks the quiet threshold.
 */
export const POST_HOOK_EVIDENCE_FALLBACK_MS = 2_000;
/** PTY must be silent at least this long before the screen is trusted. */
export const POST_HOOK_EVIDENCE_QUIET_MS = 2_000;
/** Past this the fallback gives up and hands back to the first-prompt timeout. */
export const POST_HOOK_EVIDENCE_MAX_WAIT_MS = 10_000;
/** Re-poll delay when the PTY is quiet enough but the prompt isn't on screen yet. */
export const POST_HOOK_EVIDENCE_RETRY_MS = 500;

/**
 * SessionStart boundary fallback — accept a prompt that is ALREADY on screen.
 *
 * At the boundary `resetReadyEvidence()` drops old evidence and waits for a
 * freshly rendered ❯. Resume replays its transcript, so it redraws and the real
 * evidence arrives in ~2s. A `source=startup` session does not redraw at all:
 * the prompt was painted before the hooks finished and the TUI has no reason to
 * paint it again. `!readySeen` then suppresses the idle detector's quiescence
 * strategy permanently and every new topic waits out the full first-prompt
 * timeout before its first message is forced in.
 *
 * So the wait window gets a second, independent criterion: the screen has been
 * quiet long enough AND the prompt is visible on the CURRENT screen — no longer
 * depending on a redraw that may never happen.
 *
 * What keeps a startup selector's look-alike ❯ out is NOT the quiet window — a
 * selector sitting there waiting for a keypress is perfectly quiet. It is the
 * arming point: the caller only arms this fallback once the SessionStart ready
 * signal has arrived, and that hook does not fire while the selector is still
 * up. Outside that window the fallback never runs at all.
 *
 * The caller must read the prompt from the rendered viewport
 * (`renderer.rawSnapshot()`), NOT from the appended PTY log: after ANSI erase
 * sequences are stripped, a ❯ the TUI already wiped still matches, which would
 * accept a prompt that is no longer there.
 *
 * Returns the action for the polling timer:
 *   - `accept` — seed the ready evidence; the idle detector still runs a full
 *                quiescence check (spinner guard included) on top of it.
 *   - `retry`  — re-arm after `retryInMs`.
 *   - `stop`   — real evidence won the race, or the window expired; hand back
 *                to the existing first-prompt timeout rather than poll forever.
 */
export function decidePostHookPromptEvidence(state: {
  /** The worker is still waiting for post-boundary prompt evidence. */
  stillWaiting: boolean;
  /** Milliseconds since the fallback was armed at the SessionStart boundary. */
  elapsedMs: number;
  /** Milliseconds since the last PTY byte. */
  quietMs: number;
  /** The CURRENT rendered screen matches the adapter's readyPattern. */
  screenHasReadyPattern: boolean;
  maxWaitMs?: number;
  quietThresholdMs?: number;
}): { action: 'accept' | 'retry' | 'stop'; retryInMs?: number } {
  const maxWaitMs = state.maxWaitMs ?? POST_HOOK_EVIDENCE_MAX_WAIT_MS;
  const quietThresholdMs = state.quietThresholdMs ?? POST_HOOK_EVIDENCE_QUIET_MS;
  // Real evidence arrived — the fallback steps aside.
  if (!state.stillWaiting) return { action: 'stop' };
  if (state.elapsedMs >= maxWaitMs) return { action: 'stop' };
  if (state.quietMs < quietThresholdMs) {
    // Wait out the remainder of the quiet window, plus a small margin so the
    // next poll lands after the threshold rather than exactly on it.
    return { action: 'retry', retryInMs: quietThresholdMs - state.quietMs + 100 };
  }
  if (!state.screenHasReadyPattern) return { action: 'retry', retryInMs: POST_HOOK_EVIDENCE_RETRY_MS };
  return { action: 'accept' };
}

export function shouldReleaseFirstPromptTimeout(state: {
  /** Adapter wants the soft timeout to wait for a real readyPattern. */
  deferFirstPromptTimeoutUntilReady: boolean;
  /** There is a readyPattern that can eventually prove the input box exists. */
  hasReadyPattern: boolean;
  /** Milliseconds elapsed since this CLI spawn armed the first-prompt timer. */
  elapsedMs: number;
  /** Absolute hard cap for keeping the first prompt queued. */
  hardTimeoutMs: number;
}): boolean {
  if (!state.deferFirstPromptTimeoutUntilReady) return true;
  if (!state.hasReadyPattern) return true;
  return state.elapsedMs >= state.hardTimeoutMs;
}

/**
 * After the ready-gate releases (SessionStart/direct-ready signal OR the timeout
 * fallback), the worker settles for PTY quiescence and then decides whether to
 * mark the prompt ready (which flushes for ALL adapters) vs. just calling
 * flushPending() (which only flushes for type-ahead adapters). Marking ready is
 * correct when ANY of these hold:
 *   - promptReadyAfterSettle         — an authoritative direct ready command
 *                                      fired (Hermes). Claude passes false here
 *                                      and waits for post-hook PTY evidence.
 *   - promptReadyDetectedDuringSettle — the idle detector fired during the
 *                                      settle (a readyPattern/idle proved readiness).
 *   - readyPatternSeenDuringHold      — a readyPattern fired WHILE the gate was
 *                                      holding (markPromptReady was blocked by
 *                                      readyGate.shouldHold()). The input box
 *                                      exists; the gate only deferred delivery.
 *
 * Pins the Hermes regression: a non-type-ahead adapter that renders its prompt
 * (❯) during the hold but never fires the SessionStart signal must be marked
 * ready at settle — otherwise settle calls flushPending(), which bails on
 * !isPromptReady && !typeAheadAllowed and leaves the first message queued until
 * the hard timeout (and, before the hard-timeout fix, forever).
 */
export function decideSettleMarkReady(state: {
  promptReadyAfterSettle: boolean;
  promptReadyDetectedDuringSettle: boolean;
  readyPatternSeenDuringHold: boolean;
}): boolean {
  return state.promptReadyAfterSettle || state.promptReadyDetectedDuringSettle || state.readyPatternSeenDuringHold;
}

/**
 * At the first-prompt hard timeout the worker has waited the full cap. For
 * type-ahead adapters flushPending() drains the queue even while !isPromptReady
 * (the TUI parks input in its own queue). For non-type-ahead adapters
 * flushPending() bails on !isPromptReady && !typeAheadAllowed, so the worker
 * must mark the prompt ready first (markPromptReady() then flushes).
 * Returns the action the worker must take:
 *   - 'flush'      — call flushPending() (type-ahead adapters).
 *   - 'mark-ready' — call markPromptReady() (non-type-ahead adapters).
 *
 * Pins the regression where non-type-ahead adapters only logged "forcing
 * queued message flush" at the hard timeout without actually delivering the
 * held first message.
 */
export function decideHardTimeoutAction(supportsTypeAhead: boolean): 'flush' | 'mark-ready' {
  return supportsTypeAhead ? 'flush' : 'mark-ready';
}
