/**
 * Right-sidebar tooling context when the active surface is a botmux session host.
 *
 * FileExplorer prefers `orcaBotmuxSurfaceByHostId.cwd` for the tree root.
 * Git / SC / Checks bind to:
 *  1. matched project worktree when session cwd is under a known worktree, else
 *  2. the synthetic botmux host itself (ephemeral git surface) using remote FS
 *     via `filesystemConnectionId` + session cwd — same path FileExplorer uses.
 */
import {
  getOrcaBotmuxFilesystemConnectionId,
  isOrcaBotmuxControlPlaneHostId
} from '../../../shared/orca-botmux-main-terminal-host'
import type { Repo, Worktree } from '../../../shared/types'
import type { AppState } from '@/store/types'
import { basename } from '@/lib/path'

export type OrcaBotmuxToolingContext = {
  /** Synthetic botmux host currently selected in the terminal strip. */
  hostWorktreeId: string | null
  isBotmuxHost: boolean
  /** Session cwd stamped on the host surface (FileExplorer root). */
  surfaceCwd: string | null
  /** Matched project worktree for git/SC/checks (may be null). */
  matchedWorktreeId: string | null
  /**
   * Worktree id tool panels should key git status / PR state on:
   * matched project when available; otherwise the botmux host id when we have
   * a session cwd (ephemeral remote-git surface).
   */
  toolingWorktreeId: string | null
  /**
   * True when tooling binds to the botmux host itself (no registered project
   * match) — SC uses an ephemeral Repo + remote FS git.
   */
  isEphemeralGitSurface: boolean
  /** SSH target for remote FS / remote git (botmux host meta or matched repo). */
  filesystemConnectionId: string | null
}

type ToolingState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'orcaBotmuxHighlightedWorktreeId'
  | 'orcaBotmuxSurfaceByHostId'
  | 'repos'
  | 'worktreesByRepo'
> & {
  getKnownWorktreeById: (worktreeId: string) => Worktree | undefined
}

export function resolveOrcaBotmuxToolingContext(state: ToolingState): OrcaBotmuxToolingContext {
  const hostWorktreeId = state.activeWorktreeId
  if (!hostWorktreeId) {
    return {
      hostWorktreeId: null,
      isBotmuxHost: false,
      surfaceCwd: null,
      matchedWorktreeId: null,
      toolingWorktreeId: null,
      isEphemeralGitSurface: false,
      filesystemConnectionId: null
    }
  }

  const isBotmuxHost = isOrcaBotmuxControlPlaneHostId(hostWorktreeId)
  if (!isBotmuxHost) {
    const worktree = state.getKnownWorktreeById(hostWorktreeId)
    const repo = worktree ? state.repos.find((r) => r.id === worktree.repoId) : null
    return {
      hostWorktreeId,
      isBotmuxHost: false,
      surfaceCwd: null,
      matchedWorktreeId: null,
      toolingWorktreeId: hostWorktreeId,
      isEphemeralGitSurface: false,
      filesystemConnectionId: repo?.connectionId ?? null
    }
  }

  const surfaceCwd =
    state.orcaBotmuxSurfaceByHostId[hostWorktreeId]?.cwd?.trim() ||
    state.getKnownWorktreeById(hostWorktreeId)?.path?.trim() ||
    null
  const matchedWorktreeId = state.orcaBotmuxHighlightedWorktreeId
  const fsFromHost = getOrcaBotmuxFilesystemConnectionId(hostWorktreeId)
  let filesystemConnectionId = fsFromHost
  if (!filesystemConnectionId && matchedWorktreeId) {
    const matched = state.getKnownWorktreeById(matchedWorktreeId)
    const repo = matched ? state.repos.find((r) => r.id === matched.repoId) : null
    filesystemConnectionId = repo?.connectionId ?? null
  }

  const isEphemeralGitSurface = !matchedWorktreeId && Boolean(surfaceCwd)
  const toolingWorktreeId = matchedWorktreeId ?? (surfaceCwd ? hostWorktreeId : null)

  return {
    hostWorktreeId,
    isBotmuxHost: true,
    surfaceCwd,
    matchedWorktreeId,
    toolingWorktreeId,
    isEphemeralGitSurface,
    filesystemConnectionId
  }
}

/** Path for file search / tree / git status root. */
export function resolveRightSidebarToolingPath(state: ToolingState): string | null {
  const ctx = resolveOrcaBotmuxToolingContext(state)
  if (ctx.surfaceCwd) return ctx.surfaceCwd
  if (!ctx.toolingWorktreeId) return null
  const worktree = state.getKnownWorktreeById(ctx.toolingWorktreeId)
  const path = worktree?.path?.trim()
  return path || null
}

/**
 * Synthetic Repo so Source Control can treat an unmatched botmux session cwd as
 * a git project over the same SSH FS connection FileExplorer already uses.
 * Not persisted into `state.repos`.
 */
export function buildOrcaBotmuxEphemeralRepo(args: {
  worktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'path'>
  connectionId: string | null
  surfaceCwd: string
}): Repo {
  const path = args.surfaceCwd.trim() || args.worktree.path
  const name =
    args.worktree.displayName?.trim() ||
    (path ? basename(path) : 'Botmux session') ||
    'Botmux session'
  return {
    id: args.worktree.repoId,
    path,
    displayName: name,
    badgeColor: '#6b7280',
    addedAt: 0,
    kind: 'git',
    connectionId: args.connectionId,
    executionHostId: args.connectionId ? `ssh:${args.connectionId}` : 'local'
  }
}
