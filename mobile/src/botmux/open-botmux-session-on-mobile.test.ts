import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  botmuxMobileAttachTabTitle,
  botmuxMobileTmuxSessionName,
  findExistingBotmuxAttachTab,
  openBotmuxSessionOnMobile,
  pickWorktreeForBotmuxSession,
  resolveBotmuxAttachCommandForWorktree
} from './open-botmux-session-on-mobile'
import type { BotmuxTmuxAttachSpec } from './botmux-bridge-rpc'

vi.mock('./botmux-bridge-rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botmux-bridge-rpc')>()
  return {
    ...actual,
    botmuxBridgeTmuxAttachSpec: vi.fn()
  }
})

import { botmuxBridgeTmuxAttachSpec } from './botmux-bridge-rpc'

const sshAttach = {
  ok: true as const,
  attachKind: 'ssh' as const,
  tmuxSessionName: 'bmx-abc',
  shellCommand: "ssh -tt root@10.0.0.1 'tmux attach-session -t bmx-abc'",
  remoteShellCommand: 'tmux attach-session -t bmx-abc',
  title: 'd2 · bmx-abc'
} satisfies Extract<BotmuxTmuxAttachSpec, { ok: true }>

describe('botmuxMobileTmuxSessionName', () => {
  it('uses the first 8 chars of the session id', () => {
    expect(botmuxMobileTmuxSessionName('f6a95eed-1c18-41b3')).toBe('bmx-f6a95eed')
  })
})

describe('findExistingBotmuxAttachTab', () => {
  const session = {
    sessionId: 'f6a95eed-1c18-41b3-acdf-6179e28de1be',
    title: '讲讲 LangChain'
  }

  it('matches stamped attach titles', () => {
    const tab = findExistingBotmuxAttachTab(
      [
        { id: 't1', type: 'terminal', title: 'Terminal 1' },
        {
          id: 't2',
          type: 'terminal',
          title: botmuxMobileAttachTabTitle(session),
          terminal: 'pty-1'
        }
      ],
      session
    )
    expect(tab?.id).toBe('t2')
  })

  it('matches OSC titles that still contain the short session id', () => {
    const tab = findExistingBotmuxAttachTab(
      [{ id: 't1', type: 'terminal', title: 'root@10.37.200.253 · bmx-f6a95eed' }],
      session
    )
    expect(tab?.id).toBe('t1')
  })

  it('ignores non-terminal tabs', () => {
    expect(
      findExistingBotmuxAttachTab(
        [{ id: 'b1', type: 'browser', title: 'bmx-f6a95eed' }],
        session
      )
    ).toBeNull()
  })
})

describe('pickWorktreeForBotmuxSession', () => {
  const trees = [
    {
      worktreeId: 'wt-root',
      path: '/root/workspace',
      hostId: 'ssh:ssh-d2',
      displayName: 'workspace'
    },
    {
      worktreeId: 'wt-nested',
      path: '/root/workspace/agent-session-insights',
      hostId: 'ssh:ssh-d2',
      displayName: 'insights'
    },
    {
      worktreeId: 'wt-local',
      path: '/Users/me/code',
      hostId: 'local',
      displayName: 'local'
    }
  ]

  it('prefers the deepest path under the session cwd', () => {
    const picked = pickWorktreeForBotmuxSession(
      { cwd: '/root/workspace/agent-session-insights/src', hostId: 'ssh:ssh-d2' },
      trees
    )
    expect(picked?.worktreeId).toBe('wt-nested')
  })

  it('prefers botmux agent worktrees over ordinary repo worktrees', () => {
    const withAgent = [
      ...trees,
      {
        worktreeId: 'botmux:agent:ssh:d2~~claude::sess',
        path: '/root/workspace/agent-session-insights',
        hostId: 'ssh:ssh-d2',
        displayName: 'agent'
      }
    ]
    const picked = pickWorktreeForBotmuxSession(
      { cwd: '/root/workspace/agent-session-insights', hostId: 'ssh:ssh-d2' },
      withAgent
    )
    expect(picked?.worktreeId).toBe('botmux:agent:ssh:d2~~claude::sess')
  })

  it('honors preferred worktree id when present', () => {
    const picked = pickWorktreeForBotmuxSession(
      { cwd: '/root/workspace/agent-session-insights', hostId: 'ssh:ssh-d2' },
      trees,
      'wt-root'
    )
    expect(picked?.worktreeId).toBe('wt-root')
  })

  it('falls back to first worktree when cwd missing', () => {
    const picked = pickWorktreeForBotmuxSession({ hostId: 'ssh:ssh-d2' }, trees)
    expect(picked?.worktreeId).toBe('wt-root')
  })
})

describe('resolveBotmuxAttachCommandForWorktree', () => {
  it('uses remote tmux attach on SSH worktrees', () => {
    expect(
      resolveBotmuxAttachCommandForWorktree(sshAttach, {
        worktreeId: 'wt',
        path: '/root/workspace',
        hostId: 'ssh:ssh-d2'
      })
    ).toBe('tmux attach-session -t bmx-abc')
  })

  it('uses local ssh -tt line on local worktrees', () => {
    expect(
      resolveBotmuxAttachCommandForWorktree(sshAttach, {
        worktreeId: 'wt',
        path: '/Users/me/code',
        hostId: 'local'
      })
    ).toContain('ssh -tt')
  })
})

describe('openBotmuxSessionOnMobile', () => {
  beforeEach(() => {
    vi.mocked(botmuxBridgeTmuxAttachSpec).mockReset()
    vi.mocked(botmuxBridgeTmuxAttachSpec).mockResolvedValue(sshAttach)
  })

  it('activates the worktree without notifying desktop clients (no bare auto-terminal)', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'worktree.activate') return { ok: true, result: {} }
      if (method === 'session.tabs.list') return { ok: true, result: { tabs: [] } }
      if (method === 'session.tabs.createTerminal') {
        return {
          ok: true,
          result: {
            tab: {
              id: 'tab-attach',
              type: 'terminal',
              title: 'Terminal',
              terminal: 'pty-1'
            }
          }
        }
      }
      if (method === 'terminal.rename') return { ok: true, result: {} }
      return { ok: true, result: {} }
    })

    const opened = await openBotmuxSessionOnMobile({
      client: { sendRequest } as never,
      mobileHostId: 'host-1',
      session: {
        sessionId: 'abc12345-xxxx',
        title: 'd2',
        hostId: 'ssh:ssh-d2',
        cwd: '/root/workspace'
      },
      worktrees: [
        {
          worktreeId: 'botmux:agent:wt',
          path: '/root/workspace',
          hostId: 'ssh:ssh-d2'
        }
      ]
    })

    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.sessionPath).toContain('botmuxOpen=1')
    expect(sendRequest).toHaveBeenCalledWith('worktree.activate', {
      worktree: 'id:botmux:agent:wt',
      notifyClients: false
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({
        command: 'tmux attach-session -t bmx-abc',
        activate: false
      })
    )
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.activate', {
      worktree: 'id:botmux:agent:wt',
      tabId: 'tab-attach',
      notifyClients: false
    })
  })
})
