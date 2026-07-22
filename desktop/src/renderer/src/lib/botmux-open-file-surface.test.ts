import { describe, expect, it } from 'vitest'
import {
  resolveBotmuxSurfaceForOpenFile,
  stampFromBotmuxHostSurface
} from './botmux-open-file-surface'
import {
  bindBotmuxHostTabSession,
  ensureBotmuxAgentWorktree,
  setBotmuxHostActiveSession,
  worktreeIdForBotmuxAgent
} from '../../../shared/botmux-main-terminal-host'

describe('resolveBotmuxSurfaceForOpenFile', () => {
  it('restores stamped session + cwd', () => {
    expect(
      resolveBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: 'botmux:agent:ssh%3Ax~~claude',
          botmuxSessionId: 'sess-a',
          botmuxSurfaceCwd: '/root/a',
          filePath: '/root/a/src/main.ts'
        }
      })
    ).toEqual({ sessionId: 'sess-a', cwd: '/root/a' })
  })

  it('matches file path to deepest session cwd when unstamped', () => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-file',
      agentLabel: 'relay',
      cwd: '/root/workspace',
      sshTargetId: 'ssh-d2'
    })
    bindBotmuxHostTabSession(wt.id, 'tab-a', 'sess-a', '/root/workspace')
    bindBotmuxHostTabSession(wt.id, 'tab-b', 'sess-b', '/root/workspace/botmux')
    setBotmuxHostActiveSession(wt.id, { sessionId: 'sess-b', cwd: '/root/workspace/botmux' })

    expect(
      resolveBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: wt.id,
          filePath: '/root/workspace/botmux/src/x.ts'
        }
      })
    ).toEqual({ sessionId: 'sess-b', cwd: '/root/workspace/botmux' })
  })

  it('returns null for normal project worktrees', () => {
    expect(
      resolveBotmuxSurfaceForOpenFile({
        file: {
          worktreeId: 'repo::/path/to/wt',
          filePath: '/path/to/wt/a.ts',
          botmuxSessionId: 'sess'
        }
      })
    ).toBeNull()
  })
})

describe('stampFromBotmuxHostSurface', () => {
  it('stamps session from live surface on agent hosts only', () => {
    const agentId = worktreeIdForBotmuxAgent('ssh:d2', 'cli:x')
    expect(
      stampFromBotmuxHostSurface({
        worktreeId: agentId,
        surface: { sessionId: 's1', cwd: '/root/w' }
      })
    ).toEqual({ botmuxSessionId: 's1', botmuxSurfaceCwd: '/root/w' })
    expect(
      stampFromBotmuxHostSurface({
        worktreeId: 'repo::/x',
        surface: { sessionId: 's1', cwd: '/root/w' }
      })
    ).toEqual({})
  })
})
