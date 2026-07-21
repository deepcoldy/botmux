/**
 * Pure path+host matching for Botmux bridge sessions ↔ project worktrees.
 * Shared by desktop renderer, runtime RPC, and mobile clients so scopes cannot drift.
 */

export type BotmuxSessionPathHost = {
  hostId: string
  cwd?: string | null
}

export type BotmuxWorktreeScope = {
  /** Absolute/worktree path on the Botmux host. */
  path: string
  /**
   * Bridge endpoint host id: `local` | `ssh:<sshTargetId>` | `platform:…`
   * Must match session.hostId.
   */
  orcaBotmuxHostId: string
}

/** Normalize path for prefix comparison (local or remote POSIX). */
export function normalizeBotmuxMatchPath(path: string): string {
  let p = path.replace(/\\/g, '/').trim()
  if (!p) return ''
  p = p.replace(/\/{2,}/g, (m, offset) => (offset === 0 ? m : '/'))
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

export function orcaBotmuxHostIdForRepoConnection(connectionId?: string | null): string {
  const id = connectionId?.trim()
  if (id) return `ssh:${id}`
  return 'local'
}

export function isBotmuxPathInsideOrEqual(child: string, parent: string): boolean {
  const c = normalizeBotmuxMatchPath(child)
  const p = normalizeBotmuxMatchPath(parent)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(`${p}/`)
}

export function botmuxSessionBelongsToWorktree(
  session: BotmuxSessionPathHost,
  worktree: BotmuxWorktreeScope
): boolean {
  if (session.hostId !== worktree.orcaBotmuxHostId) return false
  const cwd = session.cwd?.trim()
  if (!cwd) return false
  return isBotmuxPathInsideOrEqual(cwd, worktree.path)
}

export function filterBotmuxSessionsForWorktree<T extends BotmuxSessionPathHost>(
  sessions: readonly T[],
  worktree: BotmuxWorktreeScope
): T[] {
  return sessions.filter((s) => botmuxSessionBelongsToWorktree(s, worktree))
}

/**
 * Apply optional worktree scope to a full session list (runtime RPC / mobile).
 * When path or host is missing/blank, returns sessions unchanged.
 */
export function applyBotmuxSessionWorktreeScope<T extends BotmuxSessionPathHost>(
  sessions: readonly T[],
  scope?: { worktreePath?: string | null; orcaBotmuxHostId?: string | null } | null
): T[] {
  const path = scope?.worktreePath?.trim()
  const host = scope?.orcaBotmuxHostId?.trim()
  if (!path || !host) return [...sessions]
  return filterBotmuxSessionsForWorktree(sessions, { path, orcaBotmuxHostId: host })
}
