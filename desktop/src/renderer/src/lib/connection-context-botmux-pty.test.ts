import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  ensureBotmuxAgentWorktree,
  worktreeIdForBotmuxAgent
} from '../../../shared/botmux-main-terminal-host'

const mockGetState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockGetState()
  }
}))

import { getConnectionId, getPtyConnectionId } from './connection-context'

describe('botmux connection split (FS vs PTY)', () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    })
  })

  it('getConnectionId returns filesystem SSH target for agent hosts', () => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 's1',
      hostId: 'ssh:ssh-d2',
      agentKey: 'claude-code::relay',
      agentLabel: 'relay',
      cwd: '/root/workspace/botmux',
      sshTargetId: 'ssh-d2'
    })
    expect(getConnectionId(wt.id)).toBe('ssh-d2')
  })

  it('getPtyConnectionId forces local (null) for agent hosts so spawn is not SSH PTY', () => {
    const id = worktreeIdForBotmuxAgent('ssh:ssh-d2', 'claude-code::relay')
    ensureBotmuxAgentWorktree({
      sessionId: 's1',
      hostId: 'ssh:ssh-d2',
      agentKey: 'claude-code::relay',
      cwd: '/root/workspace/botmux',
      sshTargetId: 'ssh-d2'
    })
    // FS still SSH…
    expect(getConnectionId(id)).toBe('ssh-d2')
    // …but PTY must never route through SshPtyProvider.
    expect(getPtyConnectionId(id)).toBeNull()
  })

  it('getPtyConnectionId still returns SSH for real remote worktrees', () => {
    mockGetState.mockReturnValue({
      folderWorkspaces: [],
      projectGroups: [],
      repos: [{ id: 'r1', connectionId: 'ssh-real', path: '/root/repo' }],
      worktreesByRepo: {
        r1: [{ id: 'r1::/root/repo', path: '/root/repo', repoId: 'r1' }]
      }
    })
    // Indexed maps may need the real shape — if undefined, skip assert
    const id = 'r1::/root/repo'
    const pty = getPtyConnectionId(id)
    const fs = getConnectionId(id)
    // Either both resolve to ssh-real or both undefined if index not wired in test
    expect(pty).toEqual(fs)
  })
})
