import { describe, expect, it } from 'vitest'
import { readRepoIdentity } from './github-pr-value-readers'

describe('readRepoIdentity', () => {
  it('parses a valid owner/repo identity', () => {
    expect(readRepoIdentity({ owner: 'octo', repo: 'botmux-app' })).toEqual({
      owner: 'octo',
      repo: 'botmux-app'
    })
  })

  it('drops a non-record value', () => {
    expect(readRepoIdentity(null)).toBeUndefined()
    expect(readRepoIdentity('octo/botmux')).toBeUndefined()
  })

  it('drops a missing owner or repo', () => {
    expect(readRepoIdentity({ repo: 'botmux-app' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo' })).toBeUndefined()
  })

  it('drops an empty owner or repo as malformed', () => {
    expect(readRepoIdentity({ owner: '', repo: 'botmux-app' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo', repo: '' })).toBeUndefined()
  })
})
