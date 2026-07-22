/**
 * Persisted view prefs for the mobile Botmux sessions screen (AsyncStorage):
 * group-by mode + collapsed section ids. Mirrors the desktop sidebar's
 * localStorage persistence (lib/orca-botmux-sidebar-view-state.ts).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export type BotmuxMobileGroupBy = 'host' | 'agent'

export type BotmuxMobileViewState = {
  groupBy: BotmuxMobileGroupBy
  /** Collapsed section ids (`host:<hostId>` or `agent:<agentKey>`). */
  collapsed: string[]
}

const STORAGE_KEY = 'botmux.mobile.sessionsView.v1'

export const DEFAULT_BOTMUX_MOBILE_VIEW_STATE: BotmuxMobileViewState = {
  groupBy: 'host',
  collapsed: []
}

export async function loadBotmuxMobileViewState(): Promise<BotmuxMobileViewState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BOTMUX_MOBILE_VIEW_STATE }
    const parsed = JSON.parse(raw) as Partial<BotmuxMobileViewState> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_BOTMUX_MOBILE_VIEW_STATE }
    return {
      groupBy: parsed.groupBy === 'agent' ? 'agent' : 'host',
      collapsed: Array.isArray(parsed.collapsed)
        ? parsed.collapsed.filter((v): v is string => typeof v === 'string')
        : []
    }
  } catch {
    return { ...DEFAULT_BOTMUX_MOBILE_VIEW_STATE }
  }
}

export async function saveBotmuxMobileViewState(state: BotmuxMobileViewState): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // View prefs are best-effort.
  }
}
