/**
 * Env for a test that drives a PRIVATE tmux server through TMUX_TMPDIR.
 *
 * An inherited TMUX (the suite launched from inside a tmux pane) makes every
 * tmux client ignore TMUX_TMPDIR and talk to the CALLER's server instead — a
 * cleanup `tmux kill-server` then kills the host's live sessions. 2026-10-20:
 * a full run started from a pane on the shared default server took that server
 * down, and every bot session on it lost its pane. Always strip TMUX / TMUX_PANE.
 */
export function privateTmuxEnv(tmuxTmpDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}
