import { describe, expect, it } from 'vitest'
import {
  orcaBotmuxSessionStatusLabel,
  resolveOrcaBotmuxSessionStatusTone
} from './OrcaBotmuxSessionStatusDot'

describe('resolveOrcaBotmuxSessionStatusTone', () => {
  it('maps live CLI activity to the working ring', () => {
    expect(resolveOrcaBotmuxSessionStatusTone('working')).toBe('working')
    expect(resolveOrcaBotmuxSessionStatusTone('starting')).toBe('working')
  })

  it('maps prompt-idle and analyzing to the active dot', () => {
    expect(resolveOrcaBotmuxSessionStatusTone('idle')).toBe('active')
    expect(resolveOrcaBotmuxSessionStatusTone('analyzing')).toBe('active')
  })

  it('maps usage-limited to the warning dot', () => {
    expect(resolveOrcaBotmuxSessionStatusTone('limited')).toBe('warning')
  })

  it('maps dormant, closed, missing, and unknown statuses to inactive', () => {
    expect(resolveOrcaBotmuxSessionStatusTone('dormant')).toBe('inactive')
    expect(resolveOrcaBotmuxSessionStatusTone('closed')).toBe('inactive')
    expect(resolveOrcaBotmuxSessionStatusTone(undefined)).toBe('inactive')
    expect(resolveOrcaBotmuxSessionStatusTone('whatever-next')).toBe('inactive')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveOrcaBotmuxSessionStatusTone(' Working ')).toBe('working')
    expect(resolveOrcaBotmuxSessionStatusTone('CLOSED')).toBe('inactive')
  })
})

describe('orcaBotmuxSessionStatusLabel', () => {
  // Test env has no locale catalog loaded, so translate() yields fallbacks.
  it('labels known statuses with their English fallback', () => {
    expect(orcaBotmuxSessionStatusLabel('working')).toBe('Working')
    expect(orcaBotmuxSessionStatusLabel('starting')).toBe('Starting')
    expect(orcaBotmuxSessionStatusLabel('analyzing')).toBe('Analyzing')
    expect(orcaBotmuxSessionStatusLabel('idle')).toBe('Idle')
    expect(orcaBotmuxSessionStatusLabel('limited')).toBe('Limited')
    expect(orcaBotmuxSessionStatusLabel('dormant')).toBe('Dormant')
    expect(orcaBotmuxSessionStatusLabel('closed')).toBe('Closed')
  })

  it('falls back to the raw status for unrecognized values', () => {
    expect(orcaBotmuxSessionStatusLabel('paused')).toBe('paused')
    expect(orcaBotmuxSessionStatusLabel(undefined)).toBe('Unknown')
    expect(orcaBotmuxSessionStatusLabel('  ')).toBe('Unknown')
  })
})
