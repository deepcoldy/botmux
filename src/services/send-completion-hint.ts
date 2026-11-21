/** Spawn-time snapshot of the session's replyDelivery for the CLI process
 *  (worker.ts injects it next to the other per-session snapshots). Only the
 *  post-send hint below reads it; absent or unknown means `send`. */
export const REPLY_DELIVERY_ENV = 'BOTMUX_REPLY_DELIVERY';

export type SendCompletionHintKey =
  | 'ai.send.after_success_steer_advanced' | 'ai.send.after_success_hint'
  | 'ai.send.after_success_unified' | 'ai.send.after_success_progress' | 'ai.send.after_success_auxiliary'
  | 'ai.send.after_success_steer_advanced_transcript' | 'ai.send.after_success_unified_transcript'
  | 'ai.send.after_success_progress_transcript' | 'ai.send.after_success_auxiliary_transcript';

/** Read the env snapshot; anything but an exact `transcript` is `send`. */
export function replyDeliveryFromEnv(env: NodeJS.ProcessEnv): 'send' | 'transcript' {
  return env[REPLY_DELIVERY_ENV] === 'transcript' ? 'transcript' : 'send';
}

/** Choose post-send guidance from the acknowledged send kind, not card style.
 * A progress/auxiliary receipt is never permission to end the original task.
 * A promoted successor owns the next response even after a final was sent.
 *
 * `transcript`: the daemon forwards this session's final reply by itself, so
 * the non-final hints stop asking for `botmux send --response-kind final` and
 * instead say the answer belongs in the final reply and progress needs no
 * send — the gentle nudge against narrating a turn through repeated sends.
 * A declared final keeps the shared wording: its marker already retires the
 * transcript final in both modes. */
export function sendCompletionHintKey(
  kind: 'progress' | 'final' | 'auxiliary',
  unifiedReplyUsed: boolean,
  advancedNextTurnId?: string,
  replyDelivery: 'send' | 'transcript' = 'send',
): SendCompletionHintKey {
  const transcript = replyDelivery === 'transcript';
  if (advancedNextTurnId) {
    return transcript ? 'ai.send.after_success_steer_advanced_transcript' : 'ai.send.after_success_steer_advanced';
  }
  if (kind === 'final') return 'ai.send.after_success_hint';
  if (kind === 'auxiliary') {
    return transcript ? 'ai.send.after_success_auxiliary_transcript' : 'ai.send.after_success_auxiliary';
  }
  if (unifiedReplyUsed) {
    return transcript ? 'ai.send.after_success_unified_transcript' : 'ai.send.after_success_unified';
  }
  return transcript ? 'ai.send.after_success_progress_transcript' : 'ai.send.after_success_progress';
}
