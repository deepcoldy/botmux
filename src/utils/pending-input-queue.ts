import type { CodexAppTurnInput, VcMeetingImTurnOrigin } from '../types.js';

export interface PendingCliInput {
  content: string;
  /** The real user turn represented by `content` when delivery uses a short
   * adapter command. Transcript bridges fingerprint this value, while the PTY
   * receives `content`. */
  logicalContent?: string;
  turnId?: string;
  replyTurnId?: string;
  dispatchAttempt?: number;
  codexAppDispatchId?: string;
  /** Explicit positive steer authorization copied from the daemon ledger entry
   * (plain-human-interactive turns only). Missing/false ⇒ forced serial. */
  codexAppSteerable?: true;
  queuedActivationToken?: string;
  vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
  codexAppInput?: CodexAppTurnInput;
  /**
   * mojo only: the credential snapshot that arrived WITH this turn.
   *
   * Carried on the queue item rather than applied at IPC-receive time because the
   * two are not simultaneous — a turn can sit queued while later messages arrive.
   * Applying on receipt made two queued credential turns collapse: queueing B then
   * C executed as A → C → C instead of A → B → C, because both patches landed
   * before either turn ran.
   */
  mojoLivePatch?: import('../adapters/backend/mojo-types.js').MojoLivePatch;
  /** Per-item at-most-once marker: an input carrying this must NEVER be replayed
   *  onto an auto-restarted CLI — excluded from both the pendingMessages drain and
   *  the InflightInputTracker carry-over (codex #776 round-7 finding #1). Set on
   *  the KEYED idempotency-lease init prompt (from init.atMostOnce); scoped
   *  per-item so a later PLAIN follow-up turn folded into the same http_async_
   *  session is NOT dropped (codex #776 round-8). The worker's CLI-exit carry
   *  predicate and pending-drop both honor it. */
  noReplay?: boolean;
}

/**
 * Run a synchronous CLI/backend reset without losing inputs that have not yet
 * been dequeued for a PTY write. The reset path intentionally clears the live
 * queue; restoring the snapshot afterwards keeps those messages distinct from
 * InflightInputTracker carry-over, which spawnCli prepends ahead of them.
 */
export function resetPreservingPendingCliInputs(
  pending: PendingCliInput[],
  reset: () => void,
): void {
  const queued = pending.splice(0);
  try {
    reset();
  } finally {
    pending.unshift(...queued);
  }
}

/**
 * A natural managed-CLI exit transfers every durable receipt owned by that
 * worker generation back to the daemon/hub replay loop. Remove those definitely
 * unwritten queued copies before the same Node worker auto-restarts, otherwise
 * attempt N can survive locally while the hub dispatches N+1. An intentional
 * in-worker restart emits no generation-exit reconciliation, so it preserves
 * the complete queue instead.
 */
export function handoffQueuedDurableInputsOnBackendExit(
  pending: PendingCliInput[],
  opts: { intentionalRestart: boolean },
): PendingCliInput[] {
  if (opts.intentionalRestart) return [];

  const handedOff: PendingCliInput[] = [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const item = pending[index]!;
    if (item.dispatchAttempt === undefined) continue;
    pending.splice(index, 1);
    handedOff.unshift(item);
  }
  return handedOff;
}

export function mergeQueuedCliInput(
  pending: PendingCliInput[],
  next: PendingCliInput,
): boolean {
  const tail = pending[pending.length - 1];
  if (!tail) return false;
  // A durable delivery is an immutable envelope. Neither a later IM message
  // nor another delivery may be concatenated into it (and a durable `next`
  // must likewise start its own turn). Structured Codex App turns also carry
  // per-message attribution/context, so concatenating only their visible text
  // would drop or mis-attach the sidecar.
  if (tail.dispatchAttempt !== undefined || next.dispatchAttempt !== undefined
    || tail.codexAppDispatchId || next.codexAppDispatchId
    || tail.queuedActivationToken || next.queuedActivationToken
    || tail.vcMeetingImTurnOrigin || next.vcMeetingImTurnOrigin
    || tail.codexAppInput || next.codexAppInput
    || tail.logicalContent || next.logicalContent) return false;
  tail.content = `${tail.content}\n\n${next.content}`;
  tail.turnId = next.turnId ?? tail.turnId;
  return true;
}

/** Durable delivery and ordinary IM turns share one CLI but must not steer
 *  into each other. Adapter type-ahead remains available only while neither
 *  the active turn nor the next queued input is a durable attempt. */
export function pendingInputAllowsTypeAhead(
  adapterSupportsTypeAhead: boolean,
  durableTurnInFlight: boolean,
  next: PendingCliInput | undefined,
): boolean {
  return adapterSupportsTypeAhead
    && !durableTurnInFlight
    && next?.dispatchAttempt === undefined
    && !next?.vcMeetingImTurnOrigin;
}

/** Args-baked first prompts bypass `flushPending`, which is where durable HOL
 * ownership is normally established. Route a durable cold-start prompt through
 * the regular queue instead so `durableTurnInFlight` is set before any later IM
 * input can type-ahead/steer into it. Ordinary first prompts keep the adapter's
 * launch-argument path; adopt observes an already-running process. */
export function shouldDeferArgsBakedDurablePrompt(opts: {
  passesInitialPromptViaArgs: boolean;
  adoptMode: boolean;
  dispatchAttempt?: number;
  queuedActivationToken?: string;
}): boolean {
  return opts.passesInitialPromptViaArgs
    && !opts.adoptMode
    && (opts.dispatchAttempt !== undefined || !!opts.queuedActivationToken);
}

/** Some backends (tmux in particular) reject long launch command strings before
 *  the spawned CLI ever sees argv. For adapters that normally bake the first
 *  prompt into args, route over-limit prompts through the regular input queue
 *  instead. The comparison is strictly `>` so a prompt exactly at the adapter's
 *  declared budget keeps legacy args-baked behavior. */
export function shouldDeferInitialPromptForArgLimit(opts: {
  passesInitialPromptViaArgs: boolean;
  prompt?: string;
  maxInitialPromptArgBytes?: number;
}): boolean {
  if (!opts.passesInitialPromptViaArgs) return false;
  if (!opts.prompt) return false;
  const limit = opts.maxInitialPromptArgBytes;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return false;
  return Buffer.byteLength(opts.prompt, 'utf8') > limit;
}

/** Resolve the physical first-prompt transport after worker defer policy is
 * known. A transformed argv prompt can provide a short deferred command while
 * retaining the original text for bridge attribution. Other adapters keep the
 * legacy behavior: argv when not deferred, original text in the queue when
 * deferred. */
export function resolveInitialPromptDelivery(opts: {
  originalPrompt?: string;
  preparedArg?: string;
  preparedDeferredContent?: string;
  defer: boolean;
}): {
  argvPrompt?: string;
  queuedContent?: string;
  logicalContent?: string;
} {
  if (!opts.originalPrompt) return {};
  if (!opts.defer) {
    return { argvPrompt: opts.preparedArg ?? opts.originalPrompt };
  }
  const queuedContent = opts.preparedDeferredContent ?? opts.originalPrompt;
  return {
    queuedContent,
    ...(queuedContent !== opts.originalPrompt
      ? { logicalContent: opts.originalPrompt }
      : {}),
  };
}

/**
 * Whether this spawn baked a non-empty first prompt into argv (not the write
 * queue). Shared base for both Grok pre-exec busy arming and the card-off
 * "seed working before first idle" path for quiescence argv adapters.
 *
 * Riff has passesInitialPromptViaArgs=false → false (queue-after-spawn).
 */
export function shouldTrackArgvBakedFirstPrompt(opts: {
  passesInitialPromptViaArgs: boolean;
  preparedInitialPrompt?: string | null;
  queuedInitialPrompt?: string | null;
}): boolean {
  if (!opts.passesInitialPromptViaArgs) return false;
  if (!opts.preparedInitialPrompt?.trim()) return false;
  if (opts.queuedInitialPrompt) return false;
  return true;
}

/**
 * Whether markPromptReady must treat the first post-spawn ready as
 * "pre-execution SessionStart" (report working, keep busy) rather than true
 * end-of-turn idle.
 *
 * Strict conditions (PR #633 review):
 *  - adapter actually bakes the first prompt into argv (`passesInitialPromptViaArgs`)
 *  - an argv prompt exists and was NOT deferred to the write queue
 *  - SessionStart ready exists (`injectsReadyHook`) so first ready ≠ completion
 *  - turn terminal is authoritative (`reliableTurnTerminal`) so a later
 *    assistant_final/fireIdle will produce a real idle edge
 *
 * Riff (and any queue-after-spawn adapter) has passesInitialPromptViaArgs=false
 * — must return false, or the first markPromptReady would clear isPromptReady
 * and leave the post-spawn queue flush never firing.
 * Gemini/Pi/MTR/OpenCode pass prompt via argv but use quiescence as the sole
 * idle signal — first ready IS completion; must return false or they stick
 * (use {@link shouldTrackArgvBakedFirstPrompt} + seed working→idle instead).
 */
export function shouldArmSpawnArgvInitialPromptBusy(opts: {
  passesInitialPromptViaArgs: boolean;
  preparedInitialPrompt?: string | null;
  queuedInitialPrompt?: string | null;
  injectsReadyHook: boolean;
  reliableTurnTerminal: boolean;
}): boolean {
  if (!shouldTrackArgvBakedFirstPrompt(opts)) return false;
  if (!opts.injectsReadyHook) return false;
  if (!opts.reliableTurnTerminal) return false;
  return true;
}

/** Once either side of a queue boundary is durable, stop this batch and wait
 *  for the next reliable idle edge before writing the following turn. */
export function shouldStopPendingBatch(
  written: PendingCliInput,
  next: PendingCliInput | undefined,
): boolean {
  return written.dispatchAttempt !== undefined
    || next?.dispatchAttempt !== undefined
    || !!written.queuedActivationToken
    || !!next?.queuedActivationToken
    || !!written.vcMeetingImTurnOrigin
    || !!next?.vcMeetingImTurnOrigin;
}

/** A durable attempt is a hard head-of-line barrier even if screen detection
 * says the CLI looks idle. Only its exact terminal may release the queue. */
export function pendingInputMayFlush(durableTurnInFlight: boolean): boolean {
  return !durableTurnInFlight;
}

export function terminalReleasesDurableTurn(
  current: { turnId?: string; dispatchAttempt?: number },
  terminal: { turnId: string; dispatchAttempt?: number },
): boolean {
  return terminal.dispatchAttempt !== undefined
    && current.turnId === terminal.turnId
    && current.dispatchAttempt === terminal.dispatchAttempt;
}
