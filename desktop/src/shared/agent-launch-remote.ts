/**
 * Why: a repo reached over SSH runs the OrcaBotmux CLI through the relay shim, which
 * is always deployed as plain `orca_botmux` (Unix) / `orca_botmux.cmd` (Windows). The
 * Linux-only `orca-botmux-ide` rename — which exists solely to avoid shadowing the
 * GNOME OrcaBotmux screen reader on a local desktop — must not be applied to those
 * remotes, or `orca-botmux-ide claude-teams` lands on a PATH where it does not exist.
 * `connectionId` is the SSH signal; WSL and local stay false.
 */
export function repoIsRemote(repo: { connectionId?: string | null }): boolean {
  return Boolean(repo.connectionId)
}
