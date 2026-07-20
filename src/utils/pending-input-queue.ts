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
  queuedActivationToken?: string;
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
