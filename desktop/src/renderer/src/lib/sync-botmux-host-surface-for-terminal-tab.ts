/**
 * Resolve the Botmux session surface (sessionId + cwd) for a terminal tab so
 * left-session highlight and right FileExplorer stay aligned when focus moves.
 *
 * Why: setActiveTab already retargets the surface; focusGroup (clicking a split
 * terminal body without clicking the tab chrome) must use the same resolution.
 */
import {
  getBotmuxSessionHostMeta,
  isBotmuxControlPlaneHostId
} from '../../../shared/botmux-main-terminal-host'

export type BotmuxTerminalSurfaceTarget = {
  sessionId: string
  cwd: string | null
}

export function resolveBotmuxHostSurfaceForTerminalTab(args: {
  worktreeId: string
  terminalTabId: string
  hostTabs: ReadonlyArray<{ id: string; botmuxSessionId?: string | null }>
}): BotmuxTerminalSurfaceTarget | null {
  if (!isBotmuxControlPlaneHostId(args.worktreeId)) {
    return null
  }
  const tabId = String(args.terminalTabId ?? '').trim()
  if (!tabId) {
    return null
  }
  const tab = args.hostTabs.find((candidate) => candidate.id === tabId)
  const meta = getBotmuxSessionHostMeta(args.worktreeId)
  const sessionId =
    (typeof tab?.botmuxSessionId === 'string' && tab.botmuxSessionId.trim()) ||
    meta?.sessionIdsByTabId[tabId] ||
    meta?.sessionId ||
    ''
  if (!sessionId) {
    return null
  }
  const cwd = meta?.cwdBySessionId[sessionId] ?? null
  return { sessionId, cwd }
}
