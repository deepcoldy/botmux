import { describe, expect, it } from 'vitest'
import {
  resolveOrcaBotmuxSurfaceForOpenFile,
  stampFromOrcaBotmuxHostSurface
} from './orca-botmux-open-file-surface'
import {
  bindOrcaBotmuxHostTabSession,
  ensureOrcaBotmuxAgentWorktree,
  setOrcaBotmuxHostActiveSession,
  worktreeIdForOrcaBotmuxAgent
} from '../../../shared/orca-botmux-main-terminal-host'

describe('resolveOrcaBotmuxSurfaceForOpenFile', () => {
  it('restores stamped session + cwd', () => {
    expect(
      resolveOrcaBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: 'orca_botmux:agent:ssh%3Ax~~claude',
          orcaBotmuxSessionId: 'sess-a',
          orcaBotmuxSurfaceCwd: '/root/a',
          filePath: '/root/a/src/main.ts'
        }
      })
    ).toEqual({ sessionId: 'sess-a', cwd: '/root/a' })
  })

  it('matches file path to deepest session cwd when unstamped', () => {
    const wt = ensureOrcaBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-file',
      agentLabel: 'relay',
      cwd: '/root/workspace',
      sshTargetId: 'ssh-d2'
    })
    bindOrcaBotmuxHostTabSession(wt.id, 'tab-a', 'sess-a', '/root/workspace')
    bindOrcaBotmuxHostTabSession(wt.id, 'tab-b', 'sess-b', '/root/workspace/orca_botmux')
    setOrcaBotmuxHostActiveSession(wt.id, { sessionId: 'sess-b', cwd: '/root/workspace/orca_botmux' })

    expect(
      resolveOrcaBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: wt.id,
          filePath: '/root/workspace/orca_botmux/src/x.ts'
        }
      })
    ).toEqual({ sessionId: 'sess-b', cwd: '/root/workspace/orca_botmux' })
  })

  it('returns null for normal project worktrees', () => {
    expect(
      resolveOrcaBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: 'repo::/path/to/wt',
          filePath: '/path/to/wt/a.ts',
          orcaBotmuxSessionId: 'sess'
        }
      })
    ).toBeNull()
  })
})

describe('stampFromOrcaBotmuxHostSurface', () => {
  it('stamps session from live surface on agent hosts only', () => {
    const agentId = worktreeIdForOrcaBotmuxAgent('ssh:d2', 'cli:x')
    expect(
      stampFromOrcaBotmuxHostSurface({
        worktreeId: agentId,
        surface: { sessionId: 's1', cwd: '/root/w' }
      })
    ).toEqual({ orcaBotmuxSessionId: 's1', orcaBotmuxSurfaceCwd: '/root/w' })
    expect(
      stampFromOrcaBotmuxHostSurface({
        worktreeId: 'repo::/x',
        surface: { sessionId: 's1', cwd: '/root/w' }
      })
    ).toEqual({})
  })
})
