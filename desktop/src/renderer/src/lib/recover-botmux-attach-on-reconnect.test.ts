import { describe, expect, it, vi } from 'vitest'
import {
  hostIdFromBotmuxAgentWorktreeId,
  recoverBotmuxAttachOnReconnect,
  resolveBotmuxSessionIdForAttachRecovery,
  sessionIdHintFromBotmuxTabLabel
} from './recover-botmux-attach-on-reconnect'
import { worktreeIdForBotmuxAgent } from '../../../shared/botmux-main-terminal-host'

describe('sessionIdHintFromBotmuxTabLabel', () => {
  it('extracts bmx fragment from product labels', () => {
    expect(sessionIdHintFromBotmuxTabLabel('d2 · bmx-f6a95eed')).toBe('f6a95eed')
    expect(sessionIdHintFromBotmuxTabLabel('bmx-87cc0ea8')).toBe('87cc0ea8')
  })

  it('returns null without bmx token', () => {
    expect(sessionIdHintFromBotmuxTabLabel('..ebug-userdata')).toBeNull()
    expect(sessionIdHintFromBotmuxTabLabel(null)).toBeNull()
  })
})

describe('hostIdFromBotmuxAgentWorktreeId', () => {
  it('decodes hostId from agent worktree id', () => {
    const wt = worktreeIdForBotmuxAgent('ssh:ssh-1784658421178-0n0sdo', 'claude-code::relay-loopy(d2)')
    expect(hostIdFromBotmuxAgentWorktreeId(wt)).toBe('ssh:ssh-1784658421178-0n0sdo')
  })
})

describe('resolveBotmuxSessionIdForAttachRecovery', () => {
  it('prefers stamped botmuxSessionId', () => {
    const wt = worktreeIdForBotmuxAgent('ssh:ssh-1', 'agent')
    expect(
      resolveBotmuxSessionIdForAttachRecovery({
        worktreeId: wt,
        tab: {
          id: 'tab-1',
          botmuxSessionId: 'full-session-uuid-1234',
          quickCommandLabel: 'd2 · bmx-f6a95eed'
        }
      })
    ).toBe('full-session-uuid-1234')
  })

  it('falls back to bmx fragment from quickCommandLabel', () => {
    const wt = worktreeIdForBotmuxAgent('ssh:ssh-1', 'agent')
    expect(
      resolveBotmuxSessionIdForAttachRecovery({
        worktreeId: wt,
        tab: {
          id: 'tab-1',
          quickCommandLabel: 'd2 · bmx-f6a95eed',
          title: '..ebug-userdata'
        }
      })
    ).toBe('f6a95eed')
  })
})

describe('recoverBotmuxAttachOnReconnect', () => {
  it('queues attach shell and clears pty bindings', async () => {
    const wt = worktreeIdForBotmuxAgent('ssh:ssh-1', 'agent')
    const queueTabStartupCommand = vi.fn()
    const clearTabPtyBindings = vi.fn()
    const tmuxAttachSpec = vi.fn().mockResolvedValue({
      ok: true,
      shellCommand: "ssh -tt root@host 'tmux attach-session -t bmx-f6a95eed'",
      cliShellCommand: "ssh -tt root@host 'tmux attach-session -t bmx-f6a95eed'"
    })

    const recovered = await recoverBotmuxAttachOnReconnect({
      worktreeId: wt,
      tabs: [
        {
          id: 'tab-1',
          quickCommandLabel: 'd2 · bmx-f6a95eed',
          title: '..ebug-userdata',
          ptyId: 'stale-local-pty'
        }
      ],
      deps: { queueTabStartupCommand, tmuxAttachSpec, clearTabPtyBindings }
    })

    expect(recovered).toEqual(['tab-1'])
    expect(tmuxAttachSpec).toHaveBeenCalledWith({
      sessionId: 'f6a95eed',
      hostId: 'ssh:ssh-1'
    })
    expect(clearTabPtyBindings).toHaveBeenCalledWith('tab-1')
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "ssh -tt root@host 'tmux attach-session -t bmx-f6a95eed'"
    })
  })

  it('no-ops for non-control-plane worktrees', async () => {
    const queueTabStartupCommand = vi.fn()
    const recovered = await recoverBotmuxAttachOnReconnect({
      worktreeId: 'repo-1::/path',
      tabs: [{ id: 'tab-1', quickCommandLabel: 'd2 · bmx-f6a95eed' }],
      deps: {
        queueTabStartupCommand,
        tmuxAttachSpec: vi.fn()
      }
    })
    expect(recovered).toEqual([])
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
  })
})
