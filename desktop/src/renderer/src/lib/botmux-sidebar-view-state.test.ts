import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE,
  loadBotmuxSidebarViewState,
  saveBotmuxSidebarViewState
} from './botmux-sidebar-view-state'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map)
  }
}

describe('loadBotmuxSidebarViewState', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadBotmuxSidebarViewState(memoryStorage())).toEqual(
      DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE
    )
  })

  it('round-trips saved state', () => {
    const storage = memoryStorage()
    saveBotmuxSidebarViewState(
      { collapsedHosts: { local: true }, showClosed: true, sectionOpen: false, groupBy: 'agent' },
      storage
    )
    expect(loadBotmuxSidebarViewState(storage)).toEqual({
      collapsedHosts: { local: true },
      showClosed: true,
      sectionOpen: false,
      groupBy: 'agent'
    })
  })

  it('drops malformed entries instead of throwing', () => {
    const storage = memoryStorage({
      'botmux.sidebar.view.v1': JSON.stringify({
        collapsedHosts: { a: true, b: 'yes' },
        showClosed: 'no',
        sectionOpen: true,
        groupBy: 'everything'
      })
    })
    expect(loadBotmuxSidebarViewState(storage)).toEqual({
      collapsedHosts: { a: true },
      showClosed: false,
      sectionOpen: true,
      groupBy: 'host'
    })
  })

  it('survives corrupt JSON', () => {
    const storage = memoryStorage({ 'botmux.sidebar.view.v1': '{nope' })
    expect(loadBotmuxSidebarViewState(storage)).toEqual(DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE)
  })

  it('sectionOpen defaults to true unless explicitly false', () => {
    const storage = memoryStorage({ 'botmux.sidebar.view.v1': '{}' })
    expect(loadBotmuxSidebarViewState(storage).sectionOpen).toBe(true)
  })
})
