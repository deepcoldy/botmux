import { describe, expect, it } from 'vitest'
import {
  botmuxHostIdForRepoConnection,
  countSessionsByWorktreeId,
  filterSessionsForWorktree,
  isPathInsideOrEqual,
  normalizeMatchPath,
  partitionSessionsByWorktree,
  pickDeepestWorktreeMatch,
  sessionBelongsToWorktree
} from './match-botmux-sessions-to-worktree'

describe('normalizeMatchPath', () => {
  it('strips trailing slash and normalizes separators', () => {
    expect(normalizeMatchPath('/foo/bar/')).toBe('/foo/bar')
    expect(normalizeMatchPath('C:\\foo\\bar')).toBe('C:/foo/bar')
  })
})

describe('isPathInsideOrEqual', () => {
  it('matches equal and nested paths without prefix false positives', () => {
    expect(isPathInsideOrEqual('/a/b', '/a/b')).toBe(true)
    expect(isPathInsideOrEqual('/a/b/c', '/a/b')).toBe(true)
    expect(isPathInsideOrEqual('/a/bc', '/a/b')).toBe(false)
  })
})

describe('sessionBelongsToWorktree', () => {
  it('requires same host and cwd under worktree path', () => {
    const wt = { path: '/home/u/code/app', botmuxHostId: 'local' }
    expect(
      sessionBelongsToWorktree(
        { hostId: 'local', cwd: '/home/u/code/app/packages/web' },
        wt
      )
    ).toBe(true)
    expect(
      sessionBelongsToWorktree({ hostId: 'ssh:other', cwd: '/home/u/code/app' }, wt)
    ).toBe(false)
    expect(sessionBelongsToWorktree({ hostId: 'local' }, wt)).toBe(false)
  })
})

describe('botmuxHostIdForRepoConnection', () => {
  it('maps connection ids to bridge endpoint ids', () => {
    expect(botmuxHostIdForRepoConnection(null)).toBe('local')
    expect(botmuxHostIdForRepoConnection('ssh-abc')).toBe('ssh:ssh-abc')
  })
})

describe('pickDeepestWorktreeMatch', () => {
  it('picks the longest matching worktree path', () => {
    const worktrees = [
      { worktreeId: 'root', path: '/repo', botmuxHostId: 'local' },
      { worktreeId: 'pkg', path: '/repo/packages/app', botmuxHostId: 'local' }
    ]
    const hit = pickDeepestWorktreeMatch(
      { hostId: 'local', cwd: '/repo/packages/app/src' },
      worktrees
    )
    expect(hit?.worktreeId).toBe('pkg')
  })
})

describe('partition and count', () => {
  const sessions = [
    {
      sessionId: 's1',
      hostId: 'local',
      hostLabel: 'Local',
      cwd: '/repo/a',
      title: 'A'
    },
    {
      sessionId: 's2',
      hostId: 'local',
      hostLabel: 'Local',
      cwd: '/other',
      title: 'B'
    },
    {
      sessionId: 's3',
      hostId: 'ssh:x',
      hostLabel: 'Remote',
      cwd: '/repo/a',
      title: 'C'
    }
  ]
  const wt = { worktreeId: 'wt1', path: '/repo', botmuxHostId: 'local' }

  it('filters and partitions', () => {
    expect(filterSessionsForWorktree(sessions, wt).map((s) => s.sessionId)).toEqual(['s1'])
    const { matched, other } = partitionSessionsByWorktree(sessions, wt)
    expect(matched.map((s) => s.sessionId)).toEqual(['s1'])
    expect(other.map((s) => s.sessionId).sort()).toEqual(['s2', 's3'])
  })

  it('counts by deepest worktree', () => {
    const counts = countSessionsByWorktreeId(sessions, [
      wt,
      { worktreeId: 'wt2', path: '/other', botmuxHostId: 'local' }
    ])
    expect(counts.get('wt1')).toBe(1)
    expect(counts.get('wt2')).toBe(1)
  })
})
