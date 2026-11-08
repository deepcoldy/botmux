/**
 * Which tmux server a botmux-managed (`bmx-*`) session lives on.
 *
 * Managed sessions used to share the host's DEFAULT server
 * (`$TMUX_TMPDIR/tmux-<uid>/default`) with every other tmux user. One
 * `tmux kill-server` there took down every bot session at once — 2026-10-20
 * it happened eight times in a day: an agent "cleaning up stale servers" from
 * inside its own pane (botmux unsets TMUX in the pane, so a bare client lands
 * on the default socket), and a test whose TMUX_TMPDIR pointed at a directory
 * it never created (tmux silently falls back to /tmp for a TMUX_TMPDIR that
 * does not resolve). New sessions therefore go to a dedicated `-L botmux`
 * server; the default server keeps only the user's own sessions (and /adopt
 * keeps reading it).
 *
 * The socket is frozen per session in `persistentBackendTarget.socketName`
 * (same idea as ZMX's `socketDir`): a target WITHOUT `socketName` means the
 * default server — every row written before this change, and the explicit
 * opt-out below. A live legacy session therefore keeps running where it is;
 * it only moves when it has to be created again (CLI restart, cold resume).
 *
 * TMUX_TMPDIR is still honoured: `-L` only picks the socket NAME inside
 * `$TMUX_TMPDIR/tmux-<uid>/`, so private test roots stay private.
 */

/** Env override for the socket NEW managed sessions use. `default` opts out. */
export const MANAGED_TMUX_SOCKET_ENV = 'BOTMUX_TMUX_SOCKET';
export const DEFAULT_MANAGED_TMUX_SOCKET = 'botmux';

const SOCKET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Socket names travel through shell command strings and log lines — keep them plain. */
export function isValidTmuxSocketName(name: string): boolean {
  return SOCKET_NAME_RE.test(name) && name !== '.' && name !== '..';
}

/**
 * Socket for a session that is being CREATED now. `undefined` = the default
 * server (`BOTMUX_TMUX_SOCKET=default`, the pre-isolation behaviour). An
 * unusable value falls back to the dedicated socket rather than to the shared
 * default server: a typo must not silently undo the isolation.
 */
export function preferredManagedTmuxSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[MANAGED_TMUX_SOCKET_ENV]?.trim();
  if (!raw) return DEFAULT_MANAGED_TMUX_SOCKET;
  if (raw === 'default') return undefined;
  return isValidTmuxSocketName(raw) ? raw : DEFAULT_MANAGED_TMUX_SOCKET;
}

/**
 * Normalise a socket name read back from a persisted target. `default` and
 * blank mean the default server; anything that is not a plain name is refused
 * (never guessed onto another server).
 */
export function normaliseTmuxSocketName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === 'default') return undefined;
  if (!isValidTmuxSocketName(trimmed)) throw new Error(`invalid tmux socket name: ${JSON.stringify(name)}`);
  return trimmed;
}

/**
 * Servers a managed session's pane may live on, in probe order: the recorded
 * socket (or, with none recorded, the default server) first, then the socket
 * new sessions use. Deduplicated; `undefined` = default server.
 */
export function managedTmuxCandidateSockets(
  recordedSocketName: string | undefined,
  preferred: string | undefined,
): Array<string | undefined> {
  const order = [recordedSocketName, preferred];
  return order.filter((socket, i) => order.indexOf(socket) === i);
}

/** Leading tmux argv selecting the server (`[]` = default server). */
export function tmuxSocketArgs(socketName?: string): string[] {
  return socketName ? ['-L', socketName] : [];
}

/** `tmux` / `tmux -L <name>` for shell command strings and user-facing hints. */
export function tmuxCommand(socketName?: string): string {
  return socketName ? `tmux -L ${socketName}` : 'tmux';
}

/** Human-readable server label for logs. */
export function tmuxServerLabel(socketName?: string): string {
  return socketName ? `-L ${socketName}` : 'default server';
}
