import { describe, expect, it } from 'vitest'
import {
  applyBotmuxSessionWorktreeScope,
  botmuxSessionBelongsToWorktree,
  filterBotmuxSessionsForWorktree,
  normalizeBotmuxMatchPath,
  botmuxHostIdForRepoConnection
} from './botmux-session-worktree-match'

describe('botmux-session-worktree-match', () => {
  const host = 'ssh:ssh-1'
  const worktree = { path: '/root/workspace/botmux', botmuxHostId: host }

  it('normalizes trailing slashes and backslashes', () => {
    expect(normalizeBotmuxMatchPath('/a/b/')).toBe('/a/b')
    expect(normalizeBotmuxMatchPath('C:\\a\\b')).toBe('C:/a/b')
  })

  it('maps repo connectionId to ssh host id', () => {
    expect(botmuxHostIdForRepoConnection('ssh-1')).toBe('ssh:ssh-1')
    expect(botmuxHostIdForRepoConnection(null)).toBe('local')
  })

  it('matches session cwd equal or under worktree path on same host', () => {
    expect(
      botmuxSessionBelongsToWorktree({ hostId: host, cwd: '/root/workspace/botmux' }, worktree)
    ).toBe(true)
    expect(
      botmuxSessionBelongsToWorktree(
        { hostId: host, cwd: '/root/workspace/botmux/src' },
        worktree
      )
    ).toBe(true)
    expect(
      botmuxSessionBelongsToWorktree(
        { hostId: host, cwd: '/root/workspace/botmux-wt-other' },
        worktree
      )
    ).toBe(false)
    expect(
      botmuxSessionBelongsToWorktree(
        { hostId: 'local', cwd: '/root/workspace/botmux' },
        worktree
      )
    ).toBe(false)
  })

  it('filters a mixed session list to worktree scope', () => {
    const sessions = [
      { sessionId: 'in', hostId: host, cwd: '/root/workspace/botmux/app' },
      { sessionId: 'out', hostId: host, cwd: '/tmp/elsewhere' },
      { sessionId: 'wrong-host', hostId: 'local', cwd: '/root/workspace/botmux' }
    ]
    const filtered = filterBotmuxSessionsForWorktree(sessions, worktree)
    expect(filtered.map((s) => s.sessionId)).toEqual(['in'])
  })

  it('applyBotmuxSessionWorktreeScope no-ops without path/host', () => {
    const sessions = [{ sessionId: 'a', hostId: host, cwd: '/x' }]
    expect(applyBotmuxSessionWorktreeScope(sessions, null)).toEqual(sessions)
    expect(applyBotmuxSessionWorktreeScope(sessions, {})).toEqual(sessions)
  })

  it('applyBotmuxSessionWorktreeScope drops out-of-path sessions', () => {
    const sessions = [
      { sessionId: 'keep', hostId: host, cwd: '/root/workspace/botmux/x' },
      { sessionId: 'drop', hostId: host, cwd: '/var/log' }
    ]
    const out = applyBotmuxSessionWorktreeScope(sessions, {
      worktreePath: '/root/workspace/botmux',
      botmuxHostId: host
    })
    expect(out.map((s) => s.sessionId)).toEqual(['keep'])
  })
})
