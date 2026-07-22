import React from 'react'
import { cn } from '@/lib/utils'
import { agentSpinnerRef } from '@/lib/agent-spinner-clock'

// Why: the working-state ring must not carry its own infinite CSS animation —
// that keeps the compositor awake per element for the whole agent run. The
// shared agent-spinner clock rotates every mounted ring in phase and stops
// cleanly when nothing can be seen. Callers size it via className (size-2 etc.).
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      ref={agentSpinnerRef}
      data-agent-spinner=""
      className={cn(
        // Why: the shared clock steps the ring 30° every ~83ms; without a
        // transition that reads as stop-motion (perceived frame drops). A
        // linear transform transition ≈ the tick interval makes the browser
        // interpolate between steps — continuous rotation while the main
        // thread still only wakes 12×/s for N spinners.
        'transition-transform duration-[83ms] ease-linear motion-reduce:transition-none',
        // Why: under reduced motion the clock never ticks, so fill the top
        // border too — a frozen transparent-top ring reads as a broken
        // spinner; a complete ring reads as an intentional static marker (#9515).
        'block rounded-full border-2 border-yellow-500 border-t-transparent motion-reduce:border-t-yellow-500',
        className
      )}
    />
  )
}
