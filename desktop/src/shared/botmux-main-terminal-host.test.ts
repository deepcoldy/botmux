import { describe, expect, it } from 'vitest'
import {
  BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
} from './constants'
import {
  bindBotmuxHostTabSession,
  collectBotmuxWorkspaceSurfaceIds,
  ensureBotmuxAgentWorktree,
  findBotmuxHostTabForSession,
  findBotmuxSessionIdForTab,
  getBotmuxFilesystemConnectionId,
  isBotmuxAgentHostId,
  isBotmuxControlPlaneHostId,
  resolveBotmuxBoundTabIdForSession,
  resolveBotmuxTerminalSpawnPath,
  setBotmuxHostActiveSession,
  worktreeIdForBotmuxAgent,
  worktreeIdForBotmuxSession
} from './botmux-main-terminal-host'

describe('resolveBotmuxTerminalSpawnPath', () => {
  it('returns real paths unchanged', () => {
    expect(resolveBotmuxTerminalSpawnPath('repo::/path', '/path')).toBe('/path')
  })

  it('uses local spawn cwd for botmux control-plane even when path is remote', () => {
    const sessionId = worktreeIdForBotmuxSession('sess-abc')
    expect(sessionId).toBe('botmux:session:sess-abc')
    expect(resolveBotmuxTerminalSpawnPath(sessionId, '')).toBe('.')
    expect(resolveBotmuxTerminalSpawnPath(sessionId, '/root/workspace/botmux')).toBe('.')
    expect(resolveBotmuxTerminalSpawnPath(BOTMUX_MAIN_TERMINAL_WORKTREE_ID, '')).toBe('.')
    const agentId = worktreeIdForBotmuxAgent('ssh:ssh-d2', 'claude-code::relay')
    expect(resolveBotmuxTerminalSpawnPath(agentId, '/root/workspace')).toBe('.')
    // Prefix-only ids (no cache): still force local spawn cwd
    expect(resolveBotmuxTerminalSpawnPath('botmux:agent:ssh%3Ax::cli%3Ay', '')).toBe('.')
    expect(resolveBotmuxTerminalSpawnPath('botmux:session:deadbeef', '/remote/path')).toBe('.')
  })

  it('refuses empty path for non-botmux hosts (no terminal mount)', () => {
    expect(resolveBotmuxTerminalSpawnPath('repo::/missing', '')).toBeNull()
    expect(resolveBotmuxTerminalSpawnPath(FLOATING_TERMINAL_WORKTREE_ID, '')).toBeNull()
  })
})

describe('collectBotmuxWorkspaceSurfaceIds', () => {
  it('includes botmux tab hosts and active control-plane id', () => {
    const agent = worktreeIdForBotmuxAgent('ssh:d2', 'cli:codex')
    const ids = collectBotmuxWorkspaceSurfaceIds(
      ['repo::/a', 'botmux:session:one', agent, 'global-floating-terminal'],
      'botmux:session:two'
    )
    expect(ids.sort()).toEqual(['botmux:session:one', 'botmux:session:two', agent].sort())
  })

  it('returns empty when no botmux hosts', () => {
    expect(collectBotmuxWorkspaceSurfaceIds(['repo::/a'], null)).toEqual([])
  })
})

describe('isBotmuxControlPlaneHostId', () => {
  it('recognizes main, session, and agent hosts', () => {
    expect(isBotmuxControlPlaneHostId(BOTMUX_MAIN_TERMINAL_WORKTREE_ID)).toBe(true)
    expect(isBotmuxControlPlaneHostId('botmux:session:x')).toBe(true)
    expect(isBotmuxAgentHostId(worktreeIdForBotmuxAgent('ssh:d2', 'cli:codex'))).toBe(true)
    expect(isBotmuxControlPlaneHostId(worktreeIdForBotmuxAgent('ssh:d2', 'cli:codex'))).toBe(true)
    expect(isBotmuxControlPlaneHostId(FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
    expect(isBotmuxControlPlaneHostId(null)).toBe(false)
  })
})

describe('worktreeIdForBotmuxAgent', () => {
  it('never embeds Botmux worktree :: separator (would be parsed as path)', () => {
    const id = worktreeIdForBotmuxAgent('ssh:ssh-d2', 'claude-code::relay-loopy(d2)')
    expect(id.startsWith('botmux:agent:')).toBe(true)
    // Encoded agent key may contain %3A%3A but the host/agent join must not use ::
    expect(id.includes('::')).toBe(false)
    expect(id).toContain('~~')
  })
})

describe('tab↔session binding', () => {
  it('maps sessions to distinct tabs and reverse-lookup', () => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay',
      agentLabel: 'relay · claude-code',
      cwd: '/root/a',
      sshTargetId: 'ssh-d2'
    })
    bindBotmuxHostTabSession(wt.id, 'tab-a', 'sess-a', '/root/a')
    bindBotmuxHostTabSession(wt.id, 'tab-b', 'sess-b', '/root/b')
    expect(findBotmuxHostTabForSession(wt.id, 'sess-a')).toBe('tab-a')
    expect(findBotmuxHostTabForSession(wt.id, 'sess-b')).toBe('tab-b')
    expect(findBotmuxSessionIdForTab(wt.id, 'tab-a')).toBe('sess-a')
    expect(findBotmuxSessionIdForTab(wt.id, 'tab-b')).toBe('sess-b')
    expect(findBotmuxSessionIdForTab(wt.id, 'tab-missing')).toBeNull()
  })

  it('resolveBotmuxBoundTabIdForSession prefers live host tab stamps', () => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-2',
      agentLabel: 'relay · claude-code',
      cwd: '/root/a',
      sshTargetId: 'ssh-d2'
    })
    bindBotmuxHostTabSession(wt.id, 'tab-stale', 'sess-a', '/root/a')
    // Tab stamp on live tab wins when meta points at closed tab id not in hostTabs
    expect(
      resolveBotmuxBoundTabIdForSession({
        worktreeId: wt.id,
        sessionId: 'sess-a',
        hostTabs: [{ id: 'tab-live', botmuxSessionId: 'sess-a' }]
      })
    ).toBe('tab-live')
  })
})

describe('ensureBotmuxAgentWorktree', () => {
  it('plants session cwd and filesystem connection for FileExplorer', () => {
    const wt = ensureBotmuxAgentWorktree({
      sessionId: 'sess-1',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-loopy',
      agentLabel: 'relay-loopy · claude-code',
      cwd: '/root/workspace/botmux',
      sshTargetId: 'ssh-d2'
    })
    expect(wt.id).toBe(worktreeIdForBotmuxAgent('ssh:ssh-d2', 'claude-code::relay-loopy'))
    expect(wt.id.includes('::')).toBe(false)
    expect(wt.path).toBe('/root/workspace/botmux')
    expect(wt.displayName).toContain('relay-loopy')
    expect(getBotmuxFilesystemConnectionId(wt.id)).toBe('ssh-d2')

    setBotmuxHostActiveSession(wt.id, {
      sessionId: 'sess-2',
      cwd: '/root/workspace/other'
    })
    expect(wt.path).toBe('/root/workspace/other')
  })
})
