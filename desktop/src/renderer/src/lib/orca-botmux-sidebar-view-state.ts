/**
 * Persisted view state for the OrcaBotmux sidebar tree (localStorage).
 * Only UI prefs — never connection state (that lives in main-process userData).
 */
export type OrcaBotmuxSidebarGroupBy = 'host' | 'agent'

export type OrcaBotmuxSidebarViewState = {
  /** hostId → collapsed; hosts default to expanded. */
  collapsedHosts: Record<string, boolean>
  showClosed: boolean
  sectionOpen: boolean
  /** Tree shape: flat host → sessions, or host → agent → sessions. */
  groupBy: OrcaBotmuxSidebarGroupBy
}

const STORAGE_KEY = 'orca_botmux.sidebar.view.v1'

export const DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE: OrcaBotmuxSidebarViewState = {
  collapsedHosts: {},
  showClosed: false,
  sectionOpen: true,
  groupBy: 'host'
}

export function loadOrcaBotmuxSidebarViewState(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()
): OrcaBotmuxSidebarViewState {
  if (!storage) return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BOTMUX_SIDEBAR_VIEW_STATE }
    const parsed = JSON.parse(raw) as Partial<OrcaBotmuxSidebarViewState> | null
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

export function saveOrcaBotmuxSidebarViewState(
  state: OrcaBotmuxSidebarViewState,
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
