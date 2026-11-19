/**
 * Whether an in-worker CLI restart spends the tier-2 "second consecutive
 * restart forces a FRESH session" budget (worker.ts restartCliProcess).
 *
 * The budget exists to stop a resume that keeps crashing from looping forever.
 * Two kinds of restart are not evidence that the resume target is bad, so they
 * must not move a session toward dropping its context:
 *  - `skipRestartBudget`: a user-initiated respawn (role switch cwd move);
 *  - the previous exit was the tmux server being lost (another server answers
 *    on the socket): every pane on that server vanished at once, the CLI did
 *    not fail. On 2026-11-06 one such loss took the respawned panes down a
 *    second time while the server was being re-created, and 71 sessions fell
 *    back to a fresh conversation.
 * Real CLI exits (a status code, a dead pane, or an unreadable verdict) still
 * count, so a genuinely broken resume keeps its fallback.
 */
export function restartSpendsFreshBudget(input: {
  skipRestartBudget?: boolean;
  previousExitServerReplaced: boolean;
}): boolean {
  return !input.skipRestartBudget && !input.previousExitServerReplaced;
}

/**
 * Whether an observed backend exit should latch the "server was replaced"
 * marker. A user/worker-intentional restart (respawn, role-switch cwd move)
 * never marks: that exit was caused by botmux itself, regardless of what the
 * backend reports.
 */
export function exitMarksServerReplaced(input: {
  intentionalRestart: boolean;
  backendReportsServerReplaced: boolean;
}): boolean {
  return !input.intentionalRestart && input.backendReportsServerReplaced;
}
