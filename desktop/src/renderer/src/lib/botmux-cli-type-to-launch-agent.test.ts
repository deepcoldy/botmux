import { describe, expect, it } from 'vitest'
import { resolveBotmuxCliTypeToLaunchAgent } from './botmux-cli-type-to-launch-agent'

describe('resolveBotmuxCliTypeToLaunchAgent', () => {
  it('maps daemon product ids and common aliases to TuiAgent', () => {
    expect(resolveBotmuxCliTypeToLaunchAgent('claude-code')).toBe('claude')
    expect(resolveBotmuxCliTypeToLaunchAgent('claude')).toBe('claude')
    expect(resolveBotmuxCliTypeToLaunchAgent('Claude-Code')).toBe('claude')
    expect(resolveBotmuxCliTypeToLaunchAgent('codex')).toBe('codex')
    expect(resolveBotmuxCliTypeToLaunchAgent('openclaude')).toBe('openclaude')
    expect(resolveBotmuxCliTypeToLaunchAgent('grok')).toBe('grok')
  })

  it('returns null for unknown or empty cli types', () => {
    expect(resolveBotmuxCliTypeToLaunchAgent(null)).toBeNull()
    expect(resolveBotmuxCliTypeToLaunchAgent(undefined)).toBeNull()
    expect(resolveBotmuxCliTypeToLaunchAgent('')).toBeNull()
    expect(resolveBotmuxCliTypeToLaunchAgent('coco')).toBeNull()
    expect(resolveBotmuxCliTypeToLaunchAgent('riff')).toBeNull()
  })
})
