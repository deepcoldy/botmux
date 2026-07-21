import { describe, expect, it } from 'vitest'
import {
  ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
} from './constants'
import {
  bindOrcaBotmuxHostTabSession,
  collectOrcaBotmuxWorkspaceSurfaceIds,
  ensureOrcaBotmuxAgentWorktree,
  findOrcaBotmuxHostTabForSession,
  findOrcaBotmuxSessionIdForTab,
  getOrcaBotmuxFilesystemConnectionId,
  isOrcaBotmuxAgentHostId,
  isOrcaBotmuxControlPlaneHostId,
  resolveOrcaBotmuxBoundTabIdForSession,
  resolveOrcaBotmuxTerminalSpawnPath,
  setOrcaBotmuxHostActiveSession,
  worktreeIdForOrcaBotmuxAgent,
  worktreeIdForOrcaBotmuxSession
} from './orca-botmux-main-terminal-host'

describe('resolveOrcaBotmuxTerminalSpawnPath', () => {
  it('returns real paths unchanged', () => {
    expect(resolveOrcaBotmuxTerminalSpawnPath('repo::/path', '/path')).toBe('/path')
  })

  it('uses local spawn cwd for orca_botmux control-plane even when path is remote', () => {
    const sessionId = worktreeIdForOrcaBotmuxSession('sess-abc')
    expect(sessionId).toBe('orca_botmux:session:sess-abc')
    expect(resolveOrcaBotmuxTerminalSpawnPath(sessionId, '')).toBe('.')
    expect(resolveOrcaBotmuxTerminalSpawnPath(sessionId, '/root/workspace/orca_botmux')).toBe('.')
    expect(resolveOrcaBotmuxTerminalSpawnPath(ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID, '')).toBe('.')
    const agentId = worktreeIdForOrcaBotmuxAgent('ssh:ssh-d2', 'claude-code::relay')
    expect(resolveOrcaBotmuxTerminalSpawnPath(agentId, '/root/workspace')).toBe('.')
    // Prefix-only ids (no cache): still force local spawn cwd
    expect(resolveOrcaBotmuxTerminalSpawnPath('orca_botmux:agent:ssh%3Ax::cli%3Ay', '')).toBe('.')
    expect(resolveOrcaBotmuxTerminalSpawnPath('orca_botmux:session:deadbeef', '/remote/path')).toBe('.')
  })

  it('refuses empty path for non-orca_botmux hosts (no terminal mount)', () => {
    expect(resolveOrcaBotmuxTerminalSpawnPath('repo::/missing', '')).toBeNull()
    expect(resolveOrcaBotmuxTerminalSpawnPath(FLOATING_TERMINAL_WORKTREE_ID, '')).toBeNull()
  })
})

describe('collectOrcaBotmuxWorkspaceSurfaceIds', () => {
  it('includes orca_botmux tab hosts and active control-plane id', () => {
    const agent = worktreeIdForOrcaBotmuxAgent('ssh:d2', 'cli:codex')
    const ids = collectOrcaBotmuxWorkspaceSurfaceIds(
      ['repo::/a', 'orca_botmux:session:one', agent, 'global-floating-terminal'],
      'orca_botmux:session:two'
    )
    expect(ids.sort()).toEqual(['orca_botmux:session:one', 'orca_botmux:session:two', agent].sort())
  })

  it('returns empty when no orca_botmux hosts', () => {
    expect(collectOrcaBotmuxWorkspaceSurfaceIds(['repo::/a'], null)).toEqual([])
  })
})

describe('isOrcaBotmuxControlPlaneHostId', () => {
  it('recognizes main, session, and agent hosts', () => {
    expect(isOrcaBotmuxControlPlaneHostId(ORCA_BOTMUX_MAIN_TERMINAL_WORKTREE_ID)).toBe(true)
    expect(isOrcaBotmuxControlPlaneHostId('orca_botmux:session:x')).toBe(true)
    expect(isOrcaBotmuxAgentHostId(worktreeIdForOrcaBotmuxAgent('ssh:d2', 'cli:codex'))).toBe(true)
    expect(isOrcaBotmuxControlPlaneHostId(worktreeIdForOrcaBotmuxAgent('ssh:d2', 'cli:codex'))).toBe(true)
    expect(isOrcaBotmuxControlPlaneHostId(FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
    expect(isOrcaBotmuxControlPlaneHostId(null)).toBe(false)
  })
})

describe('worktreeIdForOrcaBotmuxAgent', () => {
  it('never embeds OrcaBotmux worktree :: separator (would be parsed as path)', () => {
    const id = worktreeIdForOrcaBotmuxAgent('ssh:ssh-d2', 'claude-code::relay-loopy(d2)')
    expect(id.startsWith('orca_botmux:agent:')).toBe(true)
    // Encoded agent key may contain %3A%3A but the host/agent join must not use ::
    expect(id.includes('::')).toBe(false)
    expect(id).toContain('~~')
  })
})

describe('tab↔session binding', () => {
  it('maps sessions to distinct tabs and reverse-lookup', () => {
    const wt = ensureOrcaBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay',
      agentLabel: 'relay · claude-code',
      cwd: '/root/a',
      sshTargetId: 'ssh-d2'
    })
    bindOrcaBotmuxHostTabSession(wt.id, 'tab-a', 'sess-a', '/root/a')
    bindOrcaBotmuxHostTabSession(wt.id, 'tab-b', 'sess-b', '/root/b')
    expect(findOrcaBotmuxHostTabForSession(wt.id, 'sess-a')).toBe('tab-a')
    expect(findOrcaBotmuxHostTabForSession(wt.id, 'sess-b')).toBe('tab-b')
    expect(findOrcaBotmuxSessionIdForTab(wt.id, 'tab-a')).toBe('sess-a')
    expect(findOrcaBotmuxSessionIdForTab(wt.id, 'tab-b')).toBe('sess-b')
    expect(findOrcaBotmuxSessionIdForTab(wt.id, 'tab-missing')).toBeNull()
  })

  it('resolveOrcaBotmuxBoundTabIdForSession prefers live host tab stamps', () => {
    const wt = ensureOrcaBotmuxAgentWorktree({
      sessionId: 'sess-a',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-2',
      agentLabel: 'relay · claude-code',
      cwd: '/root/a',
      sshTargetId: 'ssh-d2'
    })
    bindOrcaBotmuxHostTabSession(wt.id, 'tab-stale', 'sess-a', '/root/a')
    // Tab stamp on live tab wins when meta points at closed tab id not in hostTabs
    expect(
      resolveOrcaBotmuxBoundTabIdForSession({
        worktreeId: wt.id,
        sessionId: 'sess-a',
        hostTabs: [{ id: 'tab-live', orcaBotmuxSessionId: 'sess-a' }]
      })
    ).toBe('tab-live')
  })
})

describe('ensureOrcaBotmuxAgentWorktree', () => {
  it('plants session cwd and filesystem connection for FileExplorer', () => {
    const wt = ensureOrcaBotmuxAgentWorktree({
      sessionId: 'sess-1',
      hostId: 'ssh:ssh-d2',
      hostLabel: 'd2',
      agentKey: 'claude-code::relay-loopy',
      agentLabel: 'relay-loopy · claude-code',
      cwd: '/root/workspace/orca_botmux',
      sshTargetId: 'ssh-d2'
    })
    expect(wt.id).toBe(worktreeIdForOrcaBotmuxAgent('ssh:ssh-d2', 'claude-code::relay-loopy'))
    expect(wt.id.includes('::')).toBe(false)
    expect(wt.path).toBe('/root/workspace/orca_botmux')
    expect(wt.displayName).toContain('relay-loopy')
    expect(getOrcaBotmuxFilesystemConnectionId(wt.id)).toBe('ssh-d2')

    setOrcaBotmuxHostActiveSession(wt.id, {
      sessionId: 'sess-2',
      cwd: '/root/workspace/other'
    })
    expect(wt.path).toBe('/root/workspace/other')
  })
})
