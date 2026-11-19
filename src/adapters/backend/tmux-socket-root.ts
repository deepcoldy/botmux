/**
 * Where tmux ACTUALLY puts its server socket.
 *
 * `tmux -L <label>` creates the socket at `<root>/tmux-<uid>/<label>`, where
 * `<root>` is `$TMUX_TMPDIR` resolved the way tmux itself resolves it.
 * Measured on tmux 3.3a (the version this host runs):
 *
 *   TMUX_TMPDIR unset/empty          → /tmp/tmux-<uid>/<label>
 *   TMUX_TMPDIR=/existing (any type) → realpath($TMUX_TMPDIR) used verbatim
 *   TMUX_TMPDIR=/missing             → /tmp/tmux-<uid>/<label>      (silently)
 *   TMUX_TMPDIR=/a:/b                → /tmp/tmux-<uid>/<label>      (silently)
 *   TMUX_TMPDIR=<regular file>       → NO fallback: tmux fails hard with
 *                                      "couldn't create directory <file>/tmux-<uid>
 *                                       (Not a directory)"
 *
 * Two details bite:
 *   - tmux's boundary is whether the value RESOLVES, not whether it already
 *     is a directory. Any resolvable path (file or directory, through
 *     symlinks, realpaths to its canonical form) is used verbatim; tmux then
 *     creates the per-uid subdirectory inside it and fails hard when that
 *     mkdir fails — a file or read-only root never silently reaches /tmp.
 *     Only a value that does not resolve at all (missing, dangling symlink,
 *     colon string, unreadable) silently falls back to /tmp.
 *   - a RELATIVE value resolves against the cwd of the tmux INVOCATION, not
 *     the daemon's cwd. A launch with `cwd: opts.cwd` (e.g. a sandbox
 *     cold start) resolves `rel` under opts.cwd; callers must pass that same
 *     cwd here or the two sides compute different roots.
 *
 * Why this module exists: the anti-fork gate probes a socket path and the
 * tmux client then talks to whatever tmux itself resolves. If the two
 * disagree (different cwd, or a value one side can resolve and the other
 * cannot), the owner probe fails, the listener census reads an empty path
 * and the gate allows a cold start — next to a live server on the path tmux
 * really uses. That is exactly the fork the gate exists to prevent, so the
 * resolution lives in ONE place and every caller uses it.
 */

import { realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { SessionProbe } from './types.js';

/** Socket root tmux uses when $TMUX_TMPDIR does not resolve. */
export const TMUX_DEFAULT_SOCKET_ROOT = '/tmp';

/**
 * The socket root tmux will use for `env` when its client runs with cwd
 * `cwd` (defaults to this process's cwd).
 *
 * Mirrors tmux's own rule (see the module doc): the raw value is resolved
 * against `cwd` through symlinks; a value that does not resolve at all makes
 * tmux silently use /tmp.
 */
export function resolveTmuxSocketRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const raw = env.TMUX_TMPDIR;
  if (!raw) return TMUX_DEFAULT_SOCKET_ROOT;
  try {
    return realpathSync(resolvePath(cwd, raw));
  } catch {
    return TMUX_DEFAULT_SOCKET_ROOT;
  }
}

/** Filesystem pathname of a tmux server socket under `root`. */
export function tmuxSocketPathIn(root: string, uid: number, socketName?: string): string {
  return join(root, `tmux-${uid}`, socketName || 'default');
}

export interface TmuxLegacyRootProbe {
  probe: SessionProbe;
  /** Set only when a live legacy session was found and should be reattached. */
  legacySocketRoot?: string;
}

/**
 * Probe the pre-PR strict-session default root before allowing a cold spawn.
 * Current-root `missing` is the ONLY state that may trigger the legacy probe;
 * an `unknown` legacy answer stays unknown (reattach bias), never permission to
 * create a second session. The caller applies legacySocketRoot on `exists`.
 * `legacyRoot` defaults to /tmp; tests use a private root to stay off the host.
 */
export function probeTmuxSessionWithLegacyRoot(opts: {
  strict: boolean;
  socketName?: string;
  legacyRoot?: string;
  probe: (socketName: string | undefined) => SessionProbe;
}): TmuxLegacyRootProbe {
  const current = opts.probe(opts.socketName);
  const currentRoot = process.env.TMUX_TMPDIR;
  const legacyRoot = opts.legacyRoot ?? TMUX_DEFAULT_SOCKET_ROOT;
  if (!opts.strict || current !== 'missing' || !currentRoot || currentRoot === legacyRoot) {
    return { probe: current };
  }
  process.env.TMUX_TMPDIR = legacyRoot;
  try {
    const legacy = opts.probe(opts.socketName);
    if (legacy === 'exists') return { probe: legacy, legacySocketRoot: legacyRoot };
    if (legacy === 'unknown') return { probe: legacy };
    return { probe: current };
  } finally {
    process.env.TMUX_TMPDIR = currentRoot;
  }
}
