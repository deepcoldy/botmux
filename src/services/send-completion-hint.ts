/** Spawn-time snapshot of the session's replyDelivery for the CLI process
 *  (worker.ts injects it next to the other per-session snapshots). Used by
 *  `botmux send` for its post-send output and by warm-reattach pane detection;
 *  absent or unknown means `send`. */
export const REPLY_DELIVERY_ENV = 'BOTMUX_REPLY_DELIVERY';

export type SendCompletionHintKey =
  | 'ai.send.after_success_steer_advanced' | 'ai.send.after_success_hint'
  | 'ai.send.after_success_unified' | 'ai.send.after_success_progress' | 'ai.send.after_success_auxiliary'
  | 'ai.send.after_success_steer_advanced_transcript';

/** Read the env snapshot; anything but an exact `transcript` is `send`. */
export function replyDeliveryFromEnv(env: NodeJS.ProcessEnv): 'send' | 'transcript' {
  return env[REPLY_DELIVERY_ENV] === 'transcript' ? 'transcript' : 'send';
}

/** Choose post-send guidance from the acknowledged send kind, not card style.
 * A progress/auxiliary receipt is never permission to end the original task.
 * A promoted successor owns the next response even after a final was sent.
 *
 * `transcript` (auto-forward final reply): do not append extra prompt /
 * persuasion text after a normal `botmux send` (the factual `✓ 已发送 ...`
 * receipt and JSON stdout suffice). Only a promoted queued turn emits a short
 * factual state-transition notice so the model knows the turn advanced. */
export function sendCompletionHintKey(
  kind: 'progress' | 'final' | 'auxiliary',
  unifiedReplyUsed: boolean,
  advancedNextTurnId?: string,
  replyDelivery: 'send' | 'transcript' = 'send',
): SendCompletionHintKey | null {
  if (replyDelivery === 'transcript') {
    return advancedNextTurnId ? 'ai.send.after_success_steer_advanced_transcript' : null;
  }
  if (advancedNextTurnId) return 'ai.send.after_success_steer_advanced';
  if (kind === 'final') return 'ai.send.after_success_hint';
  if (kind === 'auxiliary') return 'ai.send.after_success_auxiliary';
  return unifiedReplyUsed ? 'ai.send.after_success_unified' : 'ai.send.after_success_progress';
}
