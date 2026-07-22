/**
 * Match botmux sessions to an Botmux worktree by host + workingDir path prefix.
 * Implementation lives in shared so runtime RPC / mobile cannot drift.
 */
import type { BotmuxSessionLeaf } from '@/lib/botmux-session-tree'
import {
  botmuxSessionBelongsToWorktree,
  filterBotmuxSessionsForWorktree,
  isBotmuxPathInsideOrEqual,
  normalizeBotmuxMatchPath,
  botmuxHostIdForRepoConnection as sharedHostIdForRepoConnection
} from '../../../shared/botmux-session-worktree-match'

export type WorktreeMatchTarget = {
  worktreeId: string
  path: string
  /** Botmux endpoint hostId this worktree lives on. */
  botmuxHostId: string
}

/** Normalize path for prefix comparison (local or remote POSIX). */
export function normalizeMatchPath(path: string): string {
  return normalizeBotmuxMatchPath(path)
}

export function botmuxHostIdForRepoConnection(connectionId?: string | null): string {
  return sharedHostIdForRepoConnection(connectionId)
}

export function isPathInsideOrEqual(child: string, parent: string): boolean {
  return isBotmuxPathInsideOrEqual(child, parent)
}

export function sessionBelongsToWorktree(
  session: Pick<BotmuxSessionLeaf, 'hostId' | 'cwd'>,
  worktree: Pick<WorktreeMatchTarget, 'path' | 'botmuxHostId'>
): boolean {
  return botmuxSessionBelongsToWorktree(session, worktree)
}

export function filterSessionsForWorktree(
  sessions: BotmuxSessionLeaf[],
  worktree: WorktreeMatchTarget
): BotmuxSessionLeaf[] {
  return filterBotmuxSessionsForWorktree(sessions, worktree)
}

export function partitionSessionsByWorktree(
  sessions: BotmuxSessionLeaf[],
  worktree: WorktreeMatchTarget | null
): { matched: BotmuxSessionLeaf[]; other: BotmuxSessionLeaf[] } {
  if (!worktree) {
    return { matched: [], other: sessions }
  }
  const matched: BotmuxSessionLeaf[] = []
  const other: BotmuxSessionLeaf[] = []
  for (const s of sessions) {
    if (sessionBelongsToWorktree(s, worktree)) matched.push(s)
    else other.push(s)
  }
  return { matched, other }
}

/**
 * Among worktrees that contain session.cwd on the same host, pick the deepest
 * (longest path). Used for badges when nested worktrees exist.
 */
export function pickDeepestWorktreeMatch(
  session: Pick<BotmuxSessionLeaf, 'hostId' | 'cwd'>,
  worktrees: WorktreeMatchTarget[]
): WorktreeMatchTarget | null {
  const cwd = session.cwd?.trim()
  if (!cwd) return null
  let best: WorktreeMatchTarget | null = null
  let bestLen = -1
  for (const wt of worktrees) {
    if (!sessionBelongsToWorktree(session, wt)) continue
    const len = normalizeMatchPath(wt.path).length
    if (len > bestLen) {
      best = wt
      bestLen = len
    }
  }
  return best
}

export function countSessionsByWorktreeId(
  sessions: BotmuxSessionLeaf[],
  worktrees: WorktreeMatchTarget[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const hit = pickDeepestWorktreeMatch(s, worktrees)
    if (!hit) continue
    counts.set(hit.worktreeId, (counts.get(hit.worktreeId) ?? 0) + 1)
  }
  return counts
}
