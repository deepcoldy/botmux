import type { ActiveRightSidebarTab, RightSidebarExplorerView } from '../../../shared/types'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
}

function normalizeRightSidebarExplorerView(view: unknown): RightSidebarExplorerView {
  return view === 'search' ? 'search' : 'files'
}

export function normalizeRightSidebarRoute(
  tab: unknown,
  explorerView?: unknown
): RightSidebarRoute {
  // Why: older builds persisted Search as a standalone activity tab.
  if (tab === 'search') {
    return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' }
  }
  if (
    tab === 'explorer' ||
    tab === 'vault' ||
    tab === 'workspaces' ||
    tab === 'pr-checks' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports' ||
    // Why: botmux control-plane panel is a first-class activity tab; omitting it
    // made normalize fall back to explorer so clicking the radio icon never stuck.
    tab === 'botmux'
  ) {
    return {
      rightSidebarTab: tab,
      rightSidebarExplorerView:
        tab === 'explorer' ? normalizeRightSidebarExplorerView(explorerView) : 'files'
    }
  }
  return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
}
