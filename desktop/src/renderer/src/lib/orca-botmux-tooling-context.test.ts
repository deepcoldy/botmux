import { describe, expect, it } from 'vitest'
import {
  buildOrcaBotmuxEphemeralRepo,
  resolveOrcaBotmuxToolingContext,
  resolveRightSidebarToolingPath
} from './orca-botmux-tooling-context'
import type { Worktree } from '../../../shared/types'

function makeState(partial: {
  activeWorktreeId: string | null
  orcaBotmuxHighlightedWorktreeId?: string | null
  orcaBotmuxSurfaceByHostId?: Record<string, { sessionId: string; cwd?: string; hostId?: string }>
  worktrees?: Worktree[]
  repos?: Array<{ id: string; connectionId?: string | null }>
}) {
  const worktrees = partial.worktrees ?? []
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const wt of worktrees) {
    ;(worktreesByRepo[wt.repoId] ??= []).push(wt)
  }
  const byId = new Map(worktrees.map((wt) => [wt.id, wt]))
  return {
    activeWorktreeId: partial.activeWorktreeId,
    orcaBotmuxHighlightedWorktreeId: partial.orcaBotmuxHighlightedWorktreeId ?? null,
    orcaBotmuxSurfaceByHostId: partial.orcaBotmuxSurfaceByHostId ?? {},
    repos: (partial.repos ?? []).map((r) => ({
      id: r.id,
      path: `/repo/${r.id}`,
      displayName: r.id,
      connectionId: r.connectionId ?? null
    })),
    worktreesByRepo,
    getKnownWorktreeById: (id: string) => byId.get(id)
  } as unknown as Parameters<typeof resolveOrcaBotmuxToolingContext>[0]
}

describe('resolveOrcaBotmuxToolingContext', () => {
  it('passes through normal worktree ids', () => {
    const wt = {
      id: 'repo::/path',
      repoId: 'repo',
      path: '/path',
      branch: 'main'
    } as Worktree
    const ctx = resolveOrcaBotmuxToolingContext(
      makeState({
        activeWorktreeId: 'repo::/path',
        worktrees: [wt],
        repos: [{ id: 'repo', connectionId: 'ssh-1' }]
      })
    )
    expect(ctx.isBotmuxHost).toBe(false)
    expect(ctx.toolingWorktreeId).toBe('repo::/path')
    expect(ctx.filesystemConnectionId).toBe('ssh-1')
  })

  it('uses matched project worktree on botmux hosts', () => {
    const wt = {
      id: 'repo::/remote/proj',
      repoId: 'repo',
      path: '/remote/proj',
      branch: 'main'
    } as Worktree
    const hostId = 'orca_botmux:agent:d2~~claude'
    const ctx = resolveOrcaBotmuxToolingContext(
      makeState({
        activeWorktreeId: hostId,
        orcaBotmuxHighlightedWorktreeId: 'repo::/remote/proj',
        orcaBotmuxSurfaceByHostId: {
          [hostId]: { sessionId: 's1', cwd: '/remote/proj/src' }
        },
        worktrees: [wt],
        repos: [{ id: 'repo', connectionId: 'ssh-d2' }]
      })
    )
    expect(ctx.isBotmuxHost).toBe(true)
    expect(ctx.surfaceCwd).toBe('/remote/proj/src')
    expect(ctx.toolingWorktreeId).toBe('repo::/remote/proj')
    expect(ctx.filesystemConnectionId).toBe('ssh-d2')
  })

  it('falls back to host worktree for ephemeral git when no project match', () => {
    const hostId = 'orca_botmux:agent:d2~~claude'
    const ctx = resolveOrcaBotmuxToolingContext(
      makeState({
        activeWorktreeId: hostId,
        orcaBotmuxHighlightedWorktreeId: null,
        orcaBotmuxSurfaceByHostId: {
          [hostId]: { sessionId: 's1', cwd: '/tmp/elsewhere' }
        }
      })
    )
    expect(ctx.isBotmuxHost).toBe(true)
    expect(ctx.isEphemeralGitSurface).toBe(true)
    expect(ctx.toolingWorktreeId).toBe(hostId)
    expect(
      resolveRightSidebarToolingPath(
        makeState({
          activeWorktreeId: hostId,
          orcaBotmuxSurfaceByHostId: {
            [hostId]: { sessionId: 's1', cwd: '/tmp/elsewhere' }
          }
        })
      )
    ).toBe('/tmp/elsewhere')
  })

  it('builds an ephemeral git repo for remote FS tooling', () => {
    const repo = buildOrcaBotmuxEphemeralRepo({
      worktree: {
        id: 'orca_botmux:agent:x',
        repoId: 'orca_botmux:agent-repo:x',
        displayName: 'd2 · sess',
        path: '/root/wt'
      },
      connectionId: 'ssh-1',
      surfaceCwd: '/root/wt'
    })
    expect(repo.kind).toBe('git')
    expect(repo.connectionId).toBe('ssh-1')
    expect(repo.executionHostId).toBe('ssh:ssh-1')
    expect(repo.path).toBe('/root/wt')
  })
})
