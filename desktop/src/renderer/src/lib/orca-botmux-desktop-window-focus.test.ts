import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  openOrcaBotmuxSessionInMainWorkspace,
  requestOrcaBotmuxDesktopWindowFocus,
  resolveOrcaBotmuxDesktopFocusCall
} from './open-orca-botmux-session-in-workspace'

describe('resolveOrcaBotmuxDesktopFocusCall', () => {
  it('binds api.ui.focus (not top-level api.focus)', () => {
    const uiFocus = vi.fn()
    const topFocus = vi.fn()
    const call = resolveOrcaBotmuxDesktopFocusCall({
      focus: topFocus,
      ui: { focus: uiFocus }
    })
    expect(call).not.toBeNull()
    call?.()
    expect(uiFocus).toHaveBeenCalledTimes(1)
    expect(topFocus).not.toHaveBeenCalled()
  })

  it('returns null when ui.focus is missing', () => {
    expect(resolveOrcaBotmuxDesktopFocusCall({ focus: vi.fn() })).toBeNull()
    expect(resolveOrcaBotmuxDesktopFocusCall(null)).toBeNull()
  })
})

describe('requestOrcaBotmuxDesktopWindowFocus', () => {
  const originalApi = (globalThis as { window?: { api?: unknown } }).window

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    if (originalApi) {
      ;(globalThis as { window: { api?: unknown } }).window = originalApi as Window & {
        api?: unknown
      }
    }
  })

  it('invokes window.api.ui.focus on the real open-path helper', () => {
    const uiFocus = vi.fn()
    const winFocus = vi.fn()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: { ui: { focus: uiFocus } },
        focus: winFocus
      }
    })

    requestOrcaBotmuxDesktopWindowFocus()

    expect(uiFocus).toHaveBeenCalledTimes(1)
    expect(winFocus).toHaveBeenCalledTimes(1)
  })

  it('openOrcaBotmuxSessionInMainWorkspace calls api.ui.focus at entry', async () => {
    const uiFocus = vi.fn()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          ui: { focus: uiFocus },
          // No orcaBotmuxBridge → open fails after focus (still proves call order)
          orcaBotmuxBridge: undefined
        },
        focus: vi.fn(),
        performance: { now: () => 0 }
      }
    })

    const result = await openOrcaBotmuxSessionInMainWorkspace({
      sessionId: 'sess-focus',
      hostId: 'local',
      hostLabel: 'local'
    })

    expect(uiFocus).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
  })
})
