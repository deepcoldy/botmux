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
 * By construction a remote CLI's id and its backendType share a name, so both
 * helpers can consult the same set.
 */
const REMOTE_CLI_IDS: ReadonlySet<string> = new Set(['riff', 'mojo']);

/** True for a backend that runs the agent off-box (no local PTY to own). */
export function isRemoteBackendId(type: string): boolean {
  return REMOTE_CLI_IDS.has(type);
}

/** True for a CLI whose backend is remote. */
export function isRemoteCliId(cliId: string | undefined): boolean {
  return cliId !== undefined && REMOTE_CLI_IDS.has(cliId);
}
