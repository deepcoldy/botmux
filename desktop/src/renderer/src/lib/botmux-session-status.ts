/**
 * Botmux daemon session-status vocabulary → display tone + label.
 *
 * Daemon vocabulary (src/core/dashboard-rows.ts): working | analyzing |
 * limited | idle | starting | dormant | closed. Anything unrecognized reads
 * as inactive so future daemon states degrade gracefully.
 */
import { translate } from '@/i18n/i18n'

export type BotmuxSessionStatusTone = 'working' | 'active' | 'warning' | 'inactive'

export function resolveBotmuxSessionStatusTone(
  status: string | undefined
): BotmuxSessionStatusTone {
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
export function isBotmuxSessionClosed(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'closed'
}

const STATUS_LABELS: Record<string, { key: string; fallback: string }> = {
  working: { key: 'statusWorking', fallback: 'Working' },
  starting: { key: 'statusStarting', fallback: 'Starting' },
  analyzing: { key: 'statusAnalyzing', fallback: 'Analyzing' },
  idle: { key: 'statusIdle', fallback: 'Idle' },
  limited: { key: 'statusLimited', fallback: 'Limited' },
  dormant: { key: 'statusDormant', fallback: 'Dormant' },
  closed: { key: 'statusClosed', fallback: 'Closed' }
}

export function botmuxSessionStatusLabel(status: string | undefined): string {
  const raw = (status ?? '').trim()
  const entry = STATUS_LABELS[raw.toLowerCase()]
  if (entry) return translate(`settings.botmuxBridge.${entry.key}`, entry.fallback)
  // Unknown daemon status: surface it raw so future vocabulary stays visible.
  if (raw) return raw
  return translate('settings.botmuxBridge.statusUnknown', 'Unknown')
}

const TONE_RANK: Record<BotmuxSessionStatusTone, number> = {
  working: 0,
  active: 1,
  warning: 2,
  inactive: 3
}

/**
 * Sort rank for the sidebar tree: live work first, closed (only shown when
 * the user opts in) always sinks below everything else.
 */
export function botmuxSessionActivityRank(status: string | undefined): number {
  if (isBotmuxSessionClosed(status)) return 4
  return TONE_RANK[resolveBotmuxSessionStatusTone(status)]
}
