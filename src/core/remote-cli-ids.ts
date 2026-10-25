/**
 * The single source of truth for "which CLIs run their agent off-box".
 *
 * A dependency-free leaf on purpose. This used to live in persistent-backend,
 * which pulls in every PTY backend class — so a light consumer like the Lark
 * card builder could not import it and open-coded `cliId !== 'riff'` instead.
 * That is exactly how adding mojo left the card rendering 11 PTY quick-action
 * buttons that silently do nothing: a remote backend has no terminal to drive.
 *
 * Adding a remote CLI means adding it HERE, once.
 *
 * Orca's two engine choices share the existing structured Remote Runner backend.
 */
const REMOTE_CLI_IDS: ReadonlySet<string> = new Set(['riff', 'mojo', 'remote-runner']);
const CLI_BACKENDS: Readonly<Record<string, string>> = {
  riff: 'riff', mojo: 'mojo', 'remote-runner': 'remote-runner',
  'orca-codex': 'remote-runner', 'orca-claude': 'remote-runner',
};

/** True for a backend that runs the agent off-box (no local PTY to own). */
export function isRemoteBackendId(type: string): boolean {
  return REMOTE_CLI_IDS.has(type);
}

/** True for a CLI whose backend is remote. */
export function isRemoteCliId(cliId: string | undefined): boolean {
  return cliId !== undefined && Object.hasOwn(CLI_BACKENDS, cliId);
}

/**
 * The spawn-time CLI/backend pairing, pure (no backend classes) so the
 * Dashboard can apply the SAME rule the worker spawns with. persistent-backend's
 * reconcileRiffBackendType delegates here:
 *   - a remote CLI dictates its own backend (same name by construction);
 *   - a non-remote CLI resolved onto a remote backend falls back to the daemon
 *     default, or to pty when that default is itself remote.
 */
export function reconcilePairedBackendId(cliId: string, resolved: string, defaultType: string): string {
  if (isRemoteCliId(cliId)) return CLI_BACKENDS[cliId];
  if (isRemoteBackendId(resolved)) return !isRemoteBackendId(defaultType) ? defaultType : 'pty';
  return resolved;
}

/**
 * The backend a NEW session of this bot would spawn on: the bot's override,
 * else the daemon default, then {@link reconcilePairedBackendId}. Returns
 * undefined when neither is known (an older daemon that does not report its
 * default), so callers keep their previous "backend unknown" behaviour.
 */
export function resolvePairedBackendId(
  cliId: string | undefined,
  override: string | null | undefined,
  daemonDefault: string | null | undefined,
): string | undefined {
  if (cliId && isRemoteCliId(cliId)) return CLI_BACKENDS[cliId];
  const resolved = override || daemonDefault || undefined;
  if (!resolved) return undefined;
  return reconcilePairedBackendId(cliId ?? '', resolved, daemonDefault || 'pty');
}
