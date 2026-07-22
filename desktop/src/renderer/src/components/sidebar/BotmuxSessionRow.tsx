/**
 * One botmux session row — reuses the Botmux WorktreeCard anatomy (surface
 * data attrs + status lane + title/meta rows) so sidebar sections render alike.
 * Title row carries the owning bot's avatar; meta line shows agent name (when
 * the title doesn't already lead with it) + status + repo:branch (or cwd tail).
 * Purely presentational; open behavior lives in BotmuxSessionsTree.
 */
import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { BotmuxSessionLeaf } from '@/lib/botmux-session-tree'
import { BotmuxBotAvatar } from './BotmuxBotAvatar'
import { BotmuxSessionStatusDot } from './BotmuxSessionStatusDot'
import { botmuxSessionMetaLine } from '@/lib/botmux-session-tree'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.botmuxBridge.${key}`, fallback, options)

export function BotmuxSessionRow({
  session,
  active,
  busy,
  onOpen
}: {
  session: BotmuxSessionLeaf
  active: boolean
  /** Global action in flight — spinner only shows on the row being opened. */
  busy: boolean
  onOpen: (session: BotmuxSessionLeaf, mode: 'attach' | 'web') => void
}): React.JSX.Element {
  const displayTitle = session.title || session.sessionId.slice(0, 12)
  const sessionMetaLine = botmuxSessionMetaLine(session, displayTitle)
  return (
    <button
      type="button"
      data-worktree-card-surface="true"
      data-worktree-card-active={active ? 'primary' : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'botmux-session-row relative flex cursor-pointer flex-col pl-0.5 pr-1.5 ml-1 w-[calc(100%-0.25rem)] rounded-lg text-left',
        'transition-[background-color,border-color,opacity,box-shadow,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] outline-none select-none',
        // Why: Apple "kill latency" — press feedback on pointer-down (fast
        // ease-out), not on release.
        'active:scale-[0.99] active:transition-transform active:duration-[80ms] active:ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'border border-transparent worktree-sidebar-card-hover',
        sessionMetaLine ? 'pt-1.25 pb-1.5' : 'py-2'
      )}
      title={t('openInWorkspace', 'Open native terminal (tmux attach). Shift+click for Web.')}
      onClick={(e) => onOpen(session, e.shiftKey ? 'web' : 'attach')}
    >
      <div className="group/worktree-card w-full min-w-0" data-worktree-card-hover-trigger="">
        <div
          className="flex w-full min-w-0 items-start gap-0.5 pl-0"
          data-worktree-card-parent-content=""
        >
          <div
            className="flex shrink-0 items-start justify-center pt-[2px]"
            data-worktree-card-status-slot=""
          >
            <BotmuxSessionStatusDot status={session.status} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <BotmuxBotAvatar
                  name={session.botName ?? session.cliType}
                  avatarUrl={session.botAvatarUrl}
                />
                <span className="block min-w-0 truncate text-[13px] font-normal leading-5 tracking-[-0.006em] text-foreground">
                  {displayTitle}
                </span>
                {session.cliType ? (
                  <Badge
                    variant="outline"
                    className="h-[16px] shrink-0 rounded border-foreground/20 bg-foreground/[0.06] px-1.5 text-[10px] font-medium leading-none text-foreground/70"
                  >
                    {session.cliType}
                  </Badge>
                ) : null}
              </div>
              {busy && active ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            {sessionMetaLine ? (
              <div className="flex min-w-0 items-center gap-1.5" data-worktree-card-meta-row="">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <span className="block min-w-0 truncate text-[11px] leading-none tracking-[0.005em] text-muted-foreground">
                    {sessionMetaLine}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  )
}
