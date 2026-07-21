/**
 * OrcaBotmux session status → OrcaBotmux sidebar status-dot (StatusIndicator geometry:
 * 12px box / 8px dot / shared-clock working ring), with orca_botmux daemon status
 * vocabulary instead of WorktreeStatus.
 */
import React from 'react'
import { cn } from '@/lib/utils'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { translate } from '@/i18n/i18n'
import {
  isOrcaBotmuxSessionClosed,
  resolveOrcaBotmuxSessionStatusTone,
  type OrcaBotmuxSessionStatusTone
} from '@/lib/orca-botmux-session-status'

// Why: keep the historical import surface (`./OrcaBotmuxSessionStatusDot`) stable
// for tests and sibling components after the pure mapping moved to lib.
export { isOrcaBotmuxSessionClosed, resolveOrcaBotmuxSessionStatusTone, type OrcaBotmuxSessionStatusTone }

const STATUS_LABELS: Record<string, { key: string; fallback: string }> = {
  working: { key: 'statusWorking', fallback: 'Working' },
  starting: { key: 'statusStarting', fallback: 'Starting' },
  analyzing: { key: 'statusAnalyzing', fallback: 'Analyzing' },
  idle: { key: 'statusIdle', fallback: 'Idle' },
  limited: { key: 'statusLimited', fallback: 'Limited' },
  dormant: { key: 'statusDormant', fallback: 'Dormant' },
  closed: { key: 'statusClosed', fallback: 'Closed' }
}

export function orcaBotmuxSessionStatusLabel(status: string | undefined): string {
  const raw = (status ?? '').trim()
  const entry = STATUS_LABELS[raw.toLowerCase()]
  if (entry) return translate(`settings.orcaBotmuxBridge.${entry.key}`, entry.fallback)
  // Unknown daemon status: surface it raw so future vocabulary stays visible.
  if (raw) return raw
  return translate('settings.orcaBotmuxBridge.statusUnknown', 'Unknown')
}

export function OrcaBotmuxSessionStatusDot({
  status
}: {
  status?: string
}): React.JSX.Element {
  const tone = resolveOrcaBotmuxSessionStatusTone(status)
  const label = orcaBotmuxSessionStatusLabel(status)
  return (
    <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" title={label}>
      {tone === 'working' ? (
        <AgentWorkingSpinner className="size-2" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'block size-2 rounded-full',
            tone === 'active' && 'bg-emerald-500',
            tone === 'warning' && 'bg-amber-500',
            tone === 'inactive' && 'bg-neutral-500/40'
          )}
        />
      )}
      <span className="sr-only">{label}</span>
    </span>
  )
}
