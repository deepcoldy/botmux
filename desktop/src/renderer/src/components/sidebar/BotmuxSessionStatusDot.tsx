/**
 * Botmux session status → Botmux sidebar status-dot (StatusIndicator geometry:
 * 12px box / 8px dot / shared-clock working ring), with botmux daemon status
 * vocabulary instead of WorktreeStatus.
 */
import React from 'react'
import { cn } from '@/lib/utils'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  isBotmuxSessionClosed,
  botmuxSessionStatusLabel,
  resolveBotmuxSessionStatusTone,
  type BotmuxSessionStatusTone
} from '@/lib/botmux-session-status'

// Why: keep the historical import surface (`./BotmuxSessionStatusDot`) stable
// for tests and sibling components after the mapping/labels moved to lib.
export {
  isBotmuxSessionClosed,
  botmuxSessionStatusLabel,
  resolveBotmuxSessionStatusTone,
  type BotmuxSessionStatusTone
}

export function BotmuxSessionStatusDot({
  status
}: {
  status?: string
}): React.JSX.Element {
  const tone = resolveBotmuxSessionStatusTone(status)
  const label = botmuxSessionStatusLabel(status)
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
