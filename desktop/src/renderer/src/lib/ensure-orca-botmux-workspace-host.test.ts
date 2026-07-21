import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
} from '../../../shared/constants'

const mockGetState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockGetState()
  }
}))

vi.mock('@/lib/floating-terminal', () => ({
  openFloatingTerminalPanel: vi.fn()
}))

import {
  ensureOrcaBotmuxWorkspaceHost,
  resolveOrcaBotmuxSessionTabHost
} from './ensure-orca-botmux-workspace-host'
import { openFloatingTerminalPanel } from '@/lib/floating-terminal'

function baseStore(overrides: Record<string, unknown> = {}) {
  return {
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    worktreesByRepo: {},
    folderWorkspaces: [],
    repos: [],
    getKnownWorktreeById: () => undefined,
    allWorktrees: () => [],
    setActiveWorktree: vi.fn(),
    setActiveFolderWorkspace: vi.fn(),
    setActiveView: vi.fn(),
    setActiveTabType: vi.fn(),
    ...overrides
  }
}

describe('resolveOrcaBotmuxSessionTabHost', () => {
  beforeEach(() => {
    mockGetState.mockReset()
    vi.mocked(openFloatingTerminalPanel).mockClear()
  })

  it('skips matched SSH worktree and uses orca_botmux:agent local PTY', () => {
    mockGetState.mockReturnValue(
      baseStore({
        repos: [{ id: 'r-ssh', connectionId: 'ssh-d2' }],
        sshConnectionStates: new Map([['ssh-d2', { status: 'connected' }]]),
        allWorktrees: () => [
          { id: 'wt-d2-orca_botmux', path: '/root/workspace/orca_botmux', repoId: 'r-ssh' }
        ],
        getKnownWorktreeById: (id: string) =>
          id === 'wt-d2-orca_botmux'
            ? { id: 'wt-d2-orca_botmux', path: '/root/workspace/orca_botmux', repoId: 'r-ssh' }
            : undefined
      })
    )
    const host = resolveOrcaBotmuxSessionTabHost({
      sessionId: 'sess-1',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      botName: 'relay-loopy',
      cliType: 'claude-code',
      cwd: '/root/workspace/orca_botmux/packages/app'
    })
    // Why: even when SSH status is connected, remote PTY provider may be missing.
    expect(host.ok).toBe(true)
    if (host.ok) {
      expect(host.remotePty).toBe(false)
      expect(host.reason).toBe('orca-botmux-session')
      expect(host.worktreeId.startsWith('orca_botmux:agent:')).toBe(true)
    }
    expect(openFloatingTerminalPanel).not.toHaveBeenCalled()
  })

  it('uses orca_botmux:agent host with local PTY when no worktree match', () => {
    mockGetState.mockReturnValue(baseStore())
    const host = resolveOrcaBotmuxSessionTabHost({
      sessionId: 'abc-def-999',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      title: 'my agent',
      botName: 'codex(d2)',
      cliType: 'codex',
      cwd: '/root/workspace/orca_botmux'
    })
    expect(host.ok).toBe(true)
    if (host.ok) {
      expect(host.surface).toBe('worktree')
      expect(host.remotePty).toBe(false)
      expect(host.reason).toBe('orca-botmux-session')
      expect(host.worktreeId.startsWith('orca_botmux:agent:')).toBe(true)
      expect(host.worktreeId).not.toBe(FLOATING_TERMINAL_WORKTREE_ID)
    }
    expect(openFloatingTerminalPanel).not.toHaveBeenCalled()
  })

  it('aggregates two sessions of the same agent onto one worktree id', () => {
    mockGetState.mockReturnValue(baseStore())
    const a = resolveOrcaBotmuxSessionTabHost({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      botName: 'relay-loopy',
      cliType: 'claude-code',
      cwd: '/root/workspace/orca_botmux'
    })
    const b = resolveOrcaBotmuxSessionTabHost({
      sessionId: 'sess-b',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      botName: 'relay-loopy',
      cliType: 'claude-code',
      cwd: '/root/workspace/other'
    })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.worktreeId).toBe(b.worktreeId)
    }
  })

  it('uses local worktree match when path is local', () => {
    mockGetState.mockReturnValue(
      baseStore({
        repos: [{ id: 'r1', connectionId: null }],
        allWorktrees: () => [{ id: 'wt-local', path: '/Users/me/orca_botmux', repoId: 'r1' }],
        getKnownWorktreeById: (id: string) =>
          id === 'wt-local' ? { id: 'wt-local', path: '/Users/me/orca_botmux', repoId: 'r1' } : undefined
      })
    )
    const host = resolveOrcaBotmuxSessionTabHost({
      sessionId: 's-local',
      hostId: 'local',
      cwd: '/Users/me/orca_botmux/src'
    })
    expect(host).toMatchObject({
      ok: true,
      worktreeId: 'wt-local',
      remotePty: false,
      reason: 'session-cwd'
    })
  })
})

describe('ensureOrcaBotmuxWorkspaceHost', () => {
  it('falls back to main host without session id', async () => {
    mockGetState.mockReturnValue(baseStore())
    const host = await ensureOrcaBotmuxWorkspaceHost()
    expect(host).toMatchObject({
      ok: true,
      worktreeId: ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
      reason: 'orca-botmux-main'
    })
  })
})
