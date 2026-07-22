/**
 * Pure session↔worktree path matching for Botmux bridge sessions.
 * Keep in sync with botmux/desktop/src/shared/botmux-session-worktree-match.ts
 * (same rules; duplicated so Expo does not import Electron desktop packages).
 */

export type BotmuxSessionPathHost = {
  hostId: string
  cwd?: string | null
}

export type BotmuxWorktreeScope = {
  path: string
  botmuxHostId: string
}

export function normalizeBotmuxMatchPath(path: string): string {
  let p = path.replace(/\\/g, '/').trim()
  if (!p) {
    return ''
  }
  p = p.replace(/\/{2,}/g, (m, offset) => (offset === 0 ? m : '/'))
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1)
  }
  return p
}

export function botmuxHostIdForRepoConnection(connectionId?: string | null): string {
  const id = connectionId?.trim()
  if (id) {
    return `ssh:${id}`
  }
  return 'local'
}

/** Map mobile ExecutionHostId (`local` | `ssh:…`) to bridge endpoint host id. */
export function botmuxHostIdFromExecutionHost(
  hostId?: string | null,
  connectionId?: string | null
): string {
  if (connectionId?.trim()) {
    return botmuxHostIdForRepoConnection(connectionId)
  }
  const h = hostId?.trim()
  if (!h || h === 'local') {
    return 'local'
  }
  if (h.startsWith('ssh:')) {
    return h
  }
  return botmuxHostIdForRepoConnection(h)
}

export function isBotmuxPathInsideOrEqual(child: string, parent: string): boolean {
  const c = normalizeBotmuxMatchPath(child)
  const p = normalizeBotmuxMatchPath(parent)
  if (!c || !p) {
    return false
  }
  if (c === p) {
    return true
  }
  return c.startsWith(`${p}/`)
}

export function botmuxSessionBelongsToWorktree(
  session: BotmuxSessionPathHost,
  worktree: BotmuxWorktreeScope
): boolean {
  if (session.hostId !== worktree.botmuxHostId) {
    return false
  }
  const cwd = session.cwd?.trim()
  if (!cwd) {
    return false
  }
  return isBotmuxPathInsideOrEqual(cwd, worktree.path)
}

export function filterBotmuxSessionsForWorktree<T extends BotmuxSessionPathHost>(
  sessions: readonly T[],
  worktree: BotmuxWorktreeScope
): T[] {
  return sessions.filter((s) => botmuxSessionBelongsToWorktree(s, worktree))
}
