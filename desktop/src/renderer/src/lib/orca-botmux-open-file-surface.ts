/**
 * Restore orca_botmux explorer/session surface when an editor tab is activated.
 * Pure helpers so unit tests cover the decision without Electron.
 */
import {
  getOrcaBotmuxSessionHostMeta,
  isOrcaBotmuxControlPlaneHostId,
  type OrcaBotmuxSessionHostMeta
} from '../../../shared/orca-botmux-main-terminal-host'
import { isPathInsideOrEqual, normalizeMatchPath } from './match-orca-botmux-sessions-to-worktree'

export type OrcaBotmuxOpenFileSurfaceStamp = {
  orcaBotmuxSessionId?: string | null
  orcaBotmuxSurfaceCwd?: string | null
  filePath?: string | null
  worktreeId?: string | null
}

export type ResolvedBotmuxFileSurface = {
  sessionId: string
  cwd: string
}

/**
 * Decide which orca_botmux session surface an open file should restore on activate.
 */
export function resolveOrcaBotmuxSurfaceForOpenFile(args: {
  file: OrcaBotmuxOpenFileSurfaceStamp
  hostMeta?: OrcaBotmuxSessionHostMeta | null
}): ResolvedBotmuxFileSurface | null {
  const worktreeId = String(args.file.worktreeId ?? '').trim()
  if (!worktreeId || !isOrcaBotmuxControlPlaneHostId(worktreeId)) {
    return null
  }
  const meta = args.hostMeta ?? getOrcaBotmuxSessionHostMeta(worktreeId)
  const stampedSession = String(args.file.orcaBotmuxSessionId ?? '').trim()
  if (stampedSession) {
    const cwd = (
      args.file.orcaBotmuxSurfaceCwd ??
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

/** Stamp taken from the live host surface when opening a file under a orca_botmux host. */
export function stampFromOrcaBotmuxHostSurface(args: {
  worktreeId: string
  surface?: { sessionId?: string; cwd?: string } | null
}): Pick<OrcaBotmuxOpenFileSurfaceStamp, 'orcaBotmuxSessionId' | 'orcaBotmuxSurfaceCwd'> {
  if (!isOrcaBotmuxControlPlaneHostId(args.worktreeId)) {
    return {}
  }
  const sessionId = String(args.surface?.sessionId ?? '').trim()
  const cwd = String(args.surface?.cwd ?? '').trim()
  if (!sessionId && !cwd) {
    const meta = getOrcaBotmuxSessionHostMeta(args.worktreeId)
    if (meta?.sessionId) {
      return {
        orcaBotmuxSessionId: meta.sessionId,
        orcaBotmuxSurfaceCwd: meta.cwdBySessionId[meta.sessionId] ?? ''
      }
    }
    return {}
  }
  return {
    ...(sessionId ? { orcaBotmuxSessionId: sessionId } : {}),
    ...(cwd ? { orcaBotmuxSurfaceCwd: cwd } : {})
  }
}
