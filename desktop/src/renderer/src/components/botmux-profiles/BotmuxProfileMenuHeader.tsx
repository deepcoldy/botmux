import { CircleUserRound } from 'lucide-react'
import { DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import type { BotmuxProfileSummary } from '../../../../shared/botmux-profiles'
import { BotmuxProfileAvatar } from './BotmuxProfileAvatar'

export function BotmuxProfileMenuHeader({
  profile,
  title,
  subtitle,
  showProfileAvatar
}: {
  profile: BotmuxProfileSummary
  title: string
  subtitle: string
  showProfileAvatar: boolean
}): React.JSX.Element {
  return (
    <DropdownMenuLabel className="px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {showProfileAvatar ? (
          <BotmuxProfileAvatar profile={profile} className="size-7 text-xs" />
        ) : (
          <CircleUserRound className="size-5 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-foreground">{title}</div>
          <div className="truncate text-[11px] font-medium text-muted-foreground">{subtitle}</div>
        </div>
      </div>
    </DropdownMenuLabel>
  )
}
