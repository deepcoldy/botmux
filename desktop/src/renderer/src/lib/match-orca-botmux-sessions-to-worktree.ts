/**
 * Match orca_botmux sessions to an OrcaBotmux worktree by host + workingDir path prefix.
 * Implementation lives in shared so runtime RPC / mobile cannot drift.
 */
import type { OrcaBotmuxSessionLeaf } from '@/lib/orca-botmux-session-tree'
import {
  botmuxSessionBelongsToWorktree,
  filterBotmuxSessionsForWorktree,
  isBotmuxPathInsideOrEqual,
  normalizeBotmuxMatchPath,
  orcaBotmuxHostIdForRepoConnection as sharedHostIdForRepoConnection
} from '../../../shared/botmux-session-worktree-match'

export type WorktreeMatchTarget = {
  worktreeId: string
  path: string
  /** OrcaBotmux endpoint hostId this worktree lives on. */
  orcaBotmuxHostId: string
}

/** Normalize path for prefix comparison (local or remote POSIX). */
export function normalizeMatchPath(path: string): string {
  return normalizeBotmuxMatchPath(path)
}

export function orcaBotmuxHostIdForRepoConnection(connectionId?: string | null): string {
  return sharedHostIdForRepoConnection(connectionId)
}

export function isPathInsideOrEqual(child: string, parent: string): boolean {
  return isBotmuxPathInsideOrEqual(child, parent)
}

export function sessionBelongsToWorktree(
  session: Pick<OrcaBotmuxSessionLeaf, 'hostId' | 'cwd'>,
  worktree: Pick<WorktreeMatchTarget, 'path' | 'orcaBotmuxHostId'>
): boolean {
  return botmuxSessionBelongsToWorktree(session, worktree)
}

export function filterSessionsForWorktree(
  sessions: OrcaBotmuxSessionLeaf[],
  worktree: WorktreeMatchTarget
): OrcaBotmuxSessionLeaf[] {
  return filterBotmuxSessionsForWorktree(sessions, worktree)
}

export function partitionSessionsByWorktree(
  sessions: OrcaBotmuxSessionLeaf[],
  worktree: WorktreeMatchTarget | null
): { matched: OrcaBotmuxSessionLeaf[]; other: OrcaBotmuxSessionLeaf[] } {
  if (!worktree) {
    return { matched: [], other: sessions }
  }
  const matched: OrcaBotmuxSessionLeaf[] = []
  const other: OrcaBotmuxSessionLeaf[] = []
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
  session: Pick<OrcaBotmuxSessionLeaf, 'hostId' | 'cwd'>,
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
  sessions: OrcaBotmuxSessionLeaf[],
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
