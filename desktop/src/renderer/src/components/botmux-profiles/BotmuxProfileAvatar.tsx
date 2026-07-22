import { cn } from '@/lib/utils'
import type { BotmuxProfileSummary } from '../../../../shared/botmux-profiles'

export function BotmuxProfileAvatar({
  profile,
  className
}: {
  profile: BotmuxProfileSummary
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground',
        className
      )}
      aria-hidden
    >
      {profile.avatar.initials.slice(0, 2).toUpperCase()}
    </span>
  )
}
