/**
 * Persisted view state for the Botmux sidebar tree (localStorage).
 * Only UI prefs — never connection state (that lives in main-process userData).
 */
export type BotmuxSidebarGroupBy = 'host' | 'agent'

export type BotmuxSidebarViewState = {
  /** hostId → collapsed; hosts default to expanded. */
  collapsedHosts: Record<string, boolean>
  showClosed: boolean
  sectionOpen: boolean
  /** Tree shape: flat host → sessions, or host → agent → sessions. */
  groupBy: BotmuxSidebarGroupBy
}

const STORAGE_KEY = 'botmux.sidebar.view.v1'

export const DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE: BotmuxSidebarViewState = {
  collapsedHosts: {},
  showClosed: false,
  sectionOpen: true,
  groupBy: 'host'
}

export function loadBotmuxSidebarViewState(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()
): BotmuxSidebarViewState {
  if (!storage) return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
    const parsed = JSON.parse(raw) as Partial<BotmuxSidebarViewState> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
    return {
      collapsedHosts:
        parsed.collapsedHosts && typeof parsed.collapsedHosts === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.collapsedHosts).filter(([, v]) => typeof v === 'boolean')
            )
          : {},
      showClosed: parsed.showClosed === true,
      sectionOpen: parsed.sectionOpen !== false,
      groupBy: parsed.groupBy === 'agent' ? 'agent' : 'host'
    }
  } catch {
    return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
  }
}

export function saveBotmuxSidebarViewState(
  state: BotmuxSidebarViewState,
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota/private-mode — view prefs are best-effort.
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
