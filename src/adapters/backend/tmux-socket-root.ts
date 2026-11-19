/**
 * Where tmux ACTUALLY puts its server socket.
 *
 * `tmux -L <label>` creates the socket at `<root>/tmux-<uid>/<label>`, where
 * `<root>` is `$TMUX_TMPDIR` — but only when that value names an existing
 * directory. Measured on tmux 3.3a (the version this host runs):
 *
 *   TMUX_TMPDIR unset        → /tmp/tmux-<uid>/<label>
 *   TMUX_TMPDIR=/existing    → /existing/tmux-<uid>/<label>
 *   TMUX_TMPDIR=/missing     → /tmp/tmux-<uid>/<label>      (silently)
 *   TMUX_TMPDIR=/a:/b        → /tmp/tmux-<uid>/<label>      (silently)
 *
 * Two details bite:
 *   - tmux uses $TMUX_TMPDIR as ONE path, not a colon separated list. The
 *     man page calls it "the parent directory of the directory containing the
 *     server sockets"; a colon makes the whole string a path that does not
 *     resolve, so tmux falls back to /tmp. (A test fence that split the value
 *     on ':' and took the first entry that resolved therefore resolved a
 *     DIFFERENT socket than tmux did.)
 *   - a value that names an existing directory is used verbatim; tmux then
 *     creates the per-uid subdirectory inside it (and fails hard if that
 *     mkdir fails — a read-only root never reaches /tmp).
 *
 * Why this module exists: the anti-fork gate probes a socket path and the
 * tmux client then talks to whatever tmux itself resolves. If the two
 * disagree, the owner probe fails, the listener census reads an empty path
 * and the gate allows a cold start — next to a live server on the path tmux
 * really uses. That is exactly the fork the gate exists to prevent, so the
 * resolution lives in ONE place and every caller uses it.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

/** Socket root tmux uses when $TMUX_TMPDIR does not name an existing directory. */
export const TMUX_DEFAULT_SOCKET_ROOT = '/tmp';

/**
 * The socket root tmux will use for `env`.
 *
 * Mirrors tmux's own rule: the raw $TMUX_TMPDIR is used verbatim when it is
 * an existing directory, otherwise tmux silently falls back to /tmp.
 */
export function resolveTmuxSocketRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TMUX_TMPDIR;
  if (!raw) return TMUX_DEFAULT_SOCKET_ROOT;
  try {
    if (statSync(raw).isDirectory()) return raw;
  } catch {
    // Not resolvable as a directory — tmux ignores the value and uses /tmp.
  }
  return TMUX_DEFAULT_SOCKET_ROOT;
}

/** Filesystem pathname of a tmux server socket under `root`. */
export function tmuxSocketPathIn(root: string, uid: number, socketName?: string): string {
  return join(root, `tmux-${uid}`, socketName || 'default');
}
