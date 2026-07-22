import { describe, expect, it } from 'vitest'
import {
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from './github-work-item-source-errors'

describe('extractGitHubIssueSourceError', () => {
  it('keeps the failing issue source slug with the repo that produced it', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/botmux-app' },
        {
          sources: { issues: { owner: 'upstream', repo: 'botmux-app' } },
          errors: { issues: { message: 'HTTP 403: resource not accessible' } }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/botmux-app',
      source: { owner: 'upstream', repo: 'botmux-app' },
      message: 'HTTP 403: resource not accessible'
    })
  })

  it('drops issue errors when the source slug is unavailable', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/botmux-app' },
        {
          sources: { issues: null },
          errors: { issues: { message: 'failed' } }
        }
      )
    ).toBeNull()
  })

  it('returns null when the envelope has no issue-side error', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/botmux-app' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'botmux-app' } }
        }
      )
    ).toBeNull()
  })
})

describe('extractGitHubIssueSourceFallback', () => {
  it('reports the repo whose upstream issue source fell back to origin', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/botmux-app', displayName: 'botmux-app' },
        {
          issueSourceFellBack: true,
          sources: {
            issues: { owner: 'stablyai', repo: 'botmux-fork' },
            prs: { owner: 'stablyai', repo: 'botmux-app' }
          }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/botmux-app',
      repoLabel: 'stablyai/botmux-app'
    })
  })

  it('uses the Botmux repo display name when the PR source is unavailable', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/botmux-app', displayName: 'botmux-app' },
        {
          issueSourceFellBack: true,
          sources: { issues: null, prs: null }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/botmux-app',
      repoLabel: 'botmux-app'
    })
  })

  it('returns null when the source resolver did not fall back', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/botmux-app', displayName: 'botmux-app' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'botmux-app' } }
        }
      )
    ).toBeNull()
  })
})
