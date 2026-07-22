/**
 * Restore botmux explorer/session surface when an editor tab is activated.
 * Pure helpers so unit tests cover the decision without Electron.
 */
import {
  getBotmuxSessionHostMeta,
  isBotmuxControlPlaneHostId,
  type BotmuxSessionHostMeta
} from '../../../shared/botmux-main-terminal-host'
import { isPathInsideOrEqual, normalizeMatchPath } from './match-botmux-sessions-to-worktree'

export type BotmuxOpenFileSurfaceStamp = {
  botmuxSessionId?: string | null
  botmuxSurfaceCwd?: string | null
  filePath?: string | null
  worktreeId?: string | null
}

export type ResolvedBotmuxFileSurface = {
  sessionId: string
  cwd: string
}

/**
 * Decide which botmux session surface an open file should restore on activate.
 */
export function resolveBotmuxSurfaceForOpenFile(args: {
  file: BotmuxOpenFileSurfaceStamp
  hostMeta?: BotmuxSessionHostMeta | null
}): ResolvedBotmuxFileSurface | null {
  const worktreeId = String(args.file.worktreeId ?? '').trim()
  if (!worktreeId || !isBotmuxControlPlaneHostId(worktreeId)) {
    return null
  }
  const meta = args.hostMeta ?? getBotmuxSessionHostMeta(worktreeId)
  const stampedSession = String(args.file.botmuxSessionId ?? '').trim()
  if (stampedSession) {
    const cwd = (
      args.file.botmuxSurfaceCwd ??
      meta?.cwdBySessionId[stampedSession] ??
      ''
    ).trim()
    return { sessionId: stampedSession, cwd }
  }

  const filePath = normalizeMatchPath(String(args.file.filePath ?? ''))
  if (!meta || !filePath) return null

  let best: { sessionId: string; cwd: string; len: number } | null = null
  for (const [sessionId, cwdRaw] of Object.entries(meta.cwdBySessionId)) {
    const cwd = normalizeMatchPath(cwdRaw || '')
    if (!cwd) continue
    if (filePath === cwd || isPathInsideOrEqual(filePath, cwd)) {
      if (!best || cwd.length > best.len) {
        best = { sessionId, cwd, len: cwd.length }
      }
    }
  }
  return best ? { sessionId: best.sessionId, cwd: best.cwd } : null
}

/** Stamp taken from the live host surface when opening a file under a botmux host. */
export function stampFromBotmuxHostSurface(args: {
  worktreeId: string
  surface?: { sessionId?: string; cwd?: string } | null
}): Pick<BotmuxOpenFileSurfaceStamp, 'botmuxSessionId' | 'botmuxSurfaceCwd'> {
  if (!isBotmuxControlPlaneHostId(args.worktreeId)) {
    return {}
  }
  const sessionId = String(args.surface?.sessionId ?? '').trim()
  const cwd = String(args.surface?.cwd ?? '').trim()
  if (!sessionId && !cwd) {
    const meta = getBotmuxSessionHostMeta(args.worktreeId)
    if (meta?.sessionId) {
      return {
        botmuxSessionId: meta.sessionId,
        botmuxSurfaceCwd: meta.cwdBySessionId[meta.sessionId] ?? ''
      }
    }
    return {}
  }
  return {
    ...(sessionId ? { botmuxSessionId: sessionId } : {}),
    ...(cwd ? { botmuxSurfaceCwd: cwd } : {})
  }
}
