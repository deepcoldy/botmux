import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('gives macOS developers the helper build and restart step', () => {
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'run pnpm build:computer-macos and restart OrcaBotmux from this worktree'
    )
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'OrcaBotmux Computer Use.app was not found or this macOS version is unsupported'
    )
  })

  it('keeps unsupported platforms explicit', () => {
    expect(computerProviderUnavailableMessage('freebsd')).toBe(
      'computer-use has no native provider for freebsd'
    )
  })
})
