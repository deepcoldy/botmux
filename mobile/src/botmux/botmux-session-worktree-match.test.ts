import { describe, expect, it } from 'vitest'
import {
  filterBotmuxSessionsForWorktree,
  orcaBotmuxHostIdFromExecutionHost
} from './botmux-session-worktree-match'

describe('mobile botmux session worktree match', () => {
  it('maps execution host / connection to bridge host id', () => {
    expect(orcaBotmuxHostIdFromExecutionHost('local')).toBe('local')
    expect(orcaBotmuxHostIdFromExecutionHost(undefined, 'ssh-1')).toBe('ssh:ssh-1')
    expect(orcaBotmuxHostIdFromExecutionHost('ssh:ssh-1')).toBe('ssh:ssh-1')
  })

  it('filters sessions under worktree path on same host', () => {
    const host = 'ssh:t1'
    const sessions = [
      { sessionId: 'a', hostId: host, cwd: '/proj/src' },
      { sessionId: 'b', hostId: host, cwd: '/other' }
    ]
    expect(
      filterBotmuxSessionsForWorktree(sessions, {
        path: '/proj',
        orcaBotmuxHostId: host
      }).map((s) => s.sessionId)
    ).toEqual(['a'])
  })
})
