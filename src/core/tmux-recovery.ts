/**
 * Deterministic restart jitter for tmux-backed workers.
 *
 * A shared tmux outage makes many worker processes emit `claude_exit` together.
 * Delaying teardown by a target-specific amount prevents all of them from
 * running kill-session / has-session / functional probes in the same instant.
 * Deterministic jitter is preferable to Math.random here: the value is easy to
 * unit-test and still distributes independent bmx-* session ids uniformly.
 */
export function tmuxRestartJitterMs(sessionId: string, restartOrdinal: number): number {
  const input = `${sessionId}:${restartOrdinal}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 250 + ((hash >>> 0) % 1750);
}
