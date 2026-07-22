import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/botmux-app', displayName: 'botmux-app' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' StablyAI/Botmux ')).toBe('stablyai/botmux')
    expect(normalizeGitHubRepositorySlug('botmux-app')).toBeNull()
    expect(normalizeGitHubRepositorySlug('stablyai/botmux/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/botmux-app', repos, {
        'repo-1': { path: '/Users/me/botmux-app', slug: 'stablyai/botmux-app' }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/botmux-app', repos, {
        'repo-1': { path: '/Users/me/botmux-app', slug: 'stablyai/botmux-app' },
        'repo-2': { path: '/Users/me/other', slug: 'stablyai/botmux-app' }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/botmux-app', [
        { id: 'repo-1', path: '/Users/me/stablyai/botmux-app', displayName: 'botmux-app' }
      ])
    ).toEqual({ id: 'repo-1', path: '/Users/me/stablyai/botmux-app', displayName: 'botmux-app' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('stablyai/botmux-app', [
        { id: 'repo-1', path: 'C:\\Users\\me\\stablyai\\botmux-app', displayName: 'botmux-app' }
      ])
    ).toEqual({
      id: 'repo-1',
      path: 'C:\\Users\\me\\stablyai\\botmux-app',
      displayName: 'botmux-app'
    })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'stablyai/botmux-app',
        [{ id: 'repo-1', path: '/Users/me/stablyai/botmux-app', displayName: 'botmux-app' }],
        {
          'repo-1': { path: '/Users/me/stablyai/botmux-app', slug: 'fork/botmux-app' }
        }
      )
    ).toBeNull()
  })

  it('filters project rows to rows backed by open repositories', () => {
    const rows = [
      { id: 'row-1', content: { repository: 'stablyai/botmux-app' } },
      { id: 'row-2', content: { repository: 'other/missing' } },
      { id: 'row-3', content: { repository: null } }
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': { path: '/Users/me/botmux-app', slug: 'stablyai/botmux-app' }
      }).map((row) => row.id)
    ).toEqual(['row-1'])
  })
})
