import { execFileSync } from 'node:child_process';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../../src/adapters/backend/tmux-socket.js';

/**
 * Best-effort cleanup of a `bmx-*` session a WORKER created. New sessions sit on
 * the managed server (`-L botmux`, see tmux-socket.ts); a worker running with
 * `BOTMUX_TMUX_SOCKET=default` — or an older build — uses the default one. A
 * bare `kill-session` silently misses the managed server and leaves the CLI
 * running for the rest of the file, so clear both.
 */
export function killWorkerTmuxSession(name: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const socket of new Set([undefined, preferredManagedTmuxSocket(env)])) {
    try {
      execFileSync('tmux', [...tmuxSocketArgs(socket), 'kill-session', '-t', name], { stdio: 'ignore', env });
    } catch { /* not on this server / already gone */ }
  }
}

/** `tmux` argv prefix for observing a session a worker created (managed server). */
export function workerTmuxArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return tmuxSocketArgs(preferredManagedTmuxSocket(env));
}
