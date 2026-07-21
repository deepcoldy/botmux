/**
 * OrcaBotmux daemon session-status vocabulary → display tone (pure, no i18n).
 *
 * Daemon vocabulary (src/core/dashboard-rows.ts): working | analyzing |
 * limited | idle | starting | dormant | closed. Anything unrecognized reads
 * as inactive so future daemon states degrade gracefully.
 */
export type OrcaBotmuxSessionStatusTone = 'working' | 'active' | 'warning' | 'inactive'

export function resolveOrcaBotmuxSessionStatusTone(
  status: string | undefined
): OrcaBotmuxSessionStatusTone {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'working':
    case 'starting':
      return 'working'
    case 'analyzing':
    case 'idle':
      return 'active'
    case 'limited':
      return 'warning'
    default:
      return 'inactive'
  }
}

/** Closed sessions are hidden by default in the sidebar (toggle to show). */
export function isOrcaBotmuxSessionClosed(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'closed'
}

const TONE_RANK: Record<OrcaBotmuxSessionStatusTone, number> = {
  working: 0,
  active: 1,
  warning: 2,
  inactive: 3
}

/**
 * Sort rank for the sidebar tree: live work first, closed (only shown when
 * the user opts in) always sinks below everything else.
 */
export function orcaBotmuxSessionActivityRank(status: string | undefined): number {
  if (isOrcaBotmuxSessionClosed(status)) return 4
  return TONE_RANK[resolveOrcaBotmuxSessionStatusTone(status)]
}
