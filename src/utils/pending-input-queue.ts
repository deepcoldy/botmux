import type { CodexAppTurnInput, VcMeetingImTurnOrigin } from '../types.js';

export interface PendingCliInput {
  content: string;
  turnId?: string;
  dispatchAttempt?: number;
  vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
  codexAppInput?: CodexAppTurnInput;
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
    || tail.vcMeetingImTurnOrigin || next.vcMeetingImTurnOrigin
    || tail.codexAppInput || next.codexAppInput) return false;
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
}): boolean {
  return opts.passesInitialPromptViaArgs
    && !opts.adoptMode
    && opts.dispatchAttempt !== undefined;
}

/** Once either side of a queue boundary is durable, stop this batch and wait
 *  for the next reliable idle edge before writing the following turn. */
export function shouldStopPendingBatch(
  written: PendingCliInput,
  next: PendingCliInput | undefined,
): boolean {
  return written.dispatchAttempt !== undefined
    || next?.dispatchAttempt !== undefined
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
