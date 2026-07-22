/**
 * Why: a repo reached over SSH runs the Botmux CLI through the relay shim, which
 * is always deployed as plain `botmux` (Unix) / `botmux.cmd` (Windows). The
 * Linux-local packaged command `botmux-ide` must not be applied to those remotes,
 * or `botmux-ide claude-teams` lands on a PATH where it does not exist.
 * `connectionId` is the SSH signal; WSL and local stay false.
 */
export function repoIsRemote(repo: { connectionId?: string | null }): boolean {
  return Boolean(repo.connectionId)
}
