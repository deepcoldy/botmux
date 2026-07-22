import { describe, expect, it } from 'vitest'
import {
  botmuxSessionStatusLabel,
  resolveBotmuxSessionStatusTone
} from './BotmuxSessionStatusDot'

describe('resolveBotmuxSessionStatusTone', () => {
  it('maps live CLI activity to the working ring', () => {
    expect(resolveBotmuxSessionStatusTone('working')).toBe('working')
    expect(resolveBotmuxSessionStatusTone('starting')).toBe('working')
  })

  it('maps prompt-idle and analyzing to the active dot', () => {
    expect(resolveBotmuxSessionStatusTone('idle')).toBe('active')
    expect(resolveBotmuxSessionStatusTone('analyzing')).toBe('active')
  })

  it('maps usage-limited to the warning dot', () => {
    expect(resolveBotmuxSessionStatusTone('limited')).toBe('warning')
  })

  it('maps dormant, closed, missing, and unknown statuses to inactive', () => {
    expect(resolveBotmuxSessionStatusTone('dormant')).toBe('inactive')
    expect(resolveBotmuxSessionStatusTone('closed')).toBe('inactive')
    expect(resolveBotmuxSessionStatusTone(undefined)).toBe('inactive')
    expect(resolveBotmuxSessionStatusTone('whatever-next')).toBe('inactive')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveBotmuxSessionStatusTone(' Working ')).toBe('working')
    expect(resolveBotmuxSessionStatusTone('CLOSED')).toBe('inactive')
  })
})

describe('botmuxSessionStatusLabel', () => {
  // Test env has no locale catalog loaded, so translate() yields fallbacks.
  it('labels known statuses with their English fallback', () => {
    expect(botmuxSessionStatusLabel('working')).toBe('Working')
    expect(botmuxSessionStatusLabel('starting')).toBe('Starting')
    expect(botmuxSessionStatusLabel('analyzing')).toBe('Analyzing')
    expect(botmuxSessionStatusLabel('idle')).toBe('Idle')
    expect(botmuxSessionStatusLabel('limited')).toBe('Limited')
    expect(botmuxSessionStatusLabel('dormant')).toBe('Dormant')
    expect(botmuxSessionStatusLabel('closed')).toBe('Closed')
  })

  it('falls back to the raw status for unrecognized values', () => {
    expect(botmuxSessionStatusLabel('paused')).toBe('paused')
    expect(botmuxSessionStatusLabel(undefined)).toBe('Unknown')
    expect(botmuxSessionStatusLabel('  ')).toBe('Unknown')
  })
})
