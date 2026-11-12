/** Choose post-send guidance from the acknowledged send kind, not card style.
 * A progress/auxiliary receipt is never permission to end the original task.
 * A promoted successor owns the next response even after a final was sent. */
export function sendCompletionHintKey(
  kind: 'progress' | 'final' | 'auxiliary',
  unifiedReplyUsed: boolean,
  advancedNextTurnId?: string,
): 'ai.send.after_success_steer_advanced' | 'ai.send.after_success_hint'
  | 'ai.send.after_success_unified' | 'ai.send.after_success_progress' | 'ai.send.after_success_auxiliary' {
  if (advancedNextTurnId) return 'ai.send.after_success_steer_advanced';
  if (kind === 'final') return 'ai.send.after_success_hint';
  if (kind === 'auxiliary') return 'ai.send.after_success_auxiliary';
  return unifiedReplyUsed ? 'ai.send.after_success_unified' : 'ai.send.after_success_progress';
}
