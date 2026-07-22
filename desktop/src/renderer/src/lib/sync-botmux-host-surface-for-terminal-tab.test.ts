import { describe, it, expect, beforeEach } from 'vitest'
import {
  bindBotmuxHostTabSession,
  ensureBotmuxAgentWorktree,
  getBotmuxSessionHostMeta
} from '../../../shared/botmux-main-terminal-host'
import { resolveBotmuxHostSurfaceForTerminalTab } from './sync-botmux-host-surface-for-terminal-tab'

describe('resolveBotmuxHostSurfaceForTerminalTab', () => {
  const hostId = 'ssh:d2-test'
  let worktreeId = ''

  beforeEach(() => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId,
      hostLabel: 'd2',
      title: 'sess-a',
      cwd: '/root/workspace/a',
      agentKey: 'claude-code'
    })
    worktreeId = wt.id
    bindBotmuxHostTabSession(worktreeId, 'tab-a', 'sess-a', '/root/workspace/a')
    bindBotmuxHostTabSession(worktreeId, 'tab-b', 'sess-b', '/root/workspace/b')
  })

  it('resolves session from tab stamp', () => {
    const surface = resolveBotmuxHostSurfaceForTerminalTab({
      worktreeId,
      terminalTabId: 'tab-a',
      hostTabs: [
        { id: 'tab-a', botmuxSessionId: 'sess-a' },
        { id: 'tab-b', botmuxSessionId: 'sess-b' }
      ]
    })
    expect(surface).toEqual({ sessionId: 'sess-a', cwd: '/root/workspace/a' })
  })

  it('falls back to meta.sessionIdsByTabId when stamp missing', () => {
    const surface = resolveBotmuxHostSurfaceForTerminalTab({
      worktreeId,
      terminalTabId: 'tab-b',
      hostTabs: [{ id: 'tab-b' }]
    })
    expect(surface).toEqual({ sessionId: 'sess-b', cwd: '/root/workspace/b' })
    expect(getBotmuxSessionHostMeta(worktreeId)?.sessionIdsByTabId['tab-b']).toBe('sess-b')
  })

  it('returns null for non-botmux worktrees', () => {
    expect(
      resolveBotmuxHostSurfaceForTerminalTab({
        worktreeId: 'normal-repo::/path',
        terminalTabId: 'tab-a',
        hostTabs: [{ id: 'tab-a', botmuxSessionId: 'sess-a' }]
      })
    ).toBeNull()
  })
})
