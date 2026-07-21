/**
 * One orca_botmux session row — reuses the OrcaBotmux WorktreeCard anatomy (surface
 * data attrs + status lane + title/meta rows) so sidebar sections render alike.
 * Title row carries the owning bot's avatar; meta line shows agent name (when
 * the title doesn't already lead with it) + status + repo:branch (or cwd tail).
 * Purely presentational; open behavior lives in OrcaBotmuxSessionsTree.
 */
import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { OrcaBotmuxSessionLeaf } from '@/lib/orca-botmux-session-tree'
import { OrcaBotmuxBotAvatar } from './OrcaBotmuxBotAvatar'
import { OrcaBotmuxSessionStatusDot, orcaBotmuxSessionStatusLabel } from './OrcaBotmuxSessionStatusDot'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

function sessionMetaLine(s: OrcaBotmuxSessionLeaf, displayTitle: string): string {
  const parts: string[] = []
  const bot = s.botName?.trim()
  // Why: titles often already lead with @botName — don't repeat it in meta.
  if (bot && !displayTitle.startsWith(`@${bot}`)) parts.push(bot)
  if (s.status?.trim()) parts.push(orcaBotmuxSessionStatusLabel(s.status))
  if (s.repoName) {
    // repo:branch (GitLab-style) replaces the cwd tail once git info exists.
    parts.push(s.gitBranch ? `${s.repoName}:${s.gitBranch}` : s.repoName)
  } else {
    const tail = s.cwd
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .slice(-2)
      .join('/')
    if (tail) parts.push(tail)
  }
  return parts.join(' · ')
}

export function OrcaBotmuxSessionRow({
  session,
  active,
  busy,
  onOpen
}: {
  session: OrcaBotmuxSessionLeaf
  active: boolean
  /** Global action in flight — spinner only shows on the row being opened. */
  busy: boolean
  onOpen: (session: OrcaBotmuxSessionLeaf, mode: 'attach' | 'web') => void
}): React.JSX.Element {
  const displayTitle = session.title || session.sessionId.slice(0, 12)
  const meta = sessionMetaLine(session, displayTitle)
  return (
    <button
      type="button"
      data-worktree-card-surface="true"
      data-worktree-card-active={active ? 'primary' : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex cursor-pointer flex-col pl-0.5 pr-1.5 ml-1 w-[calc(100%-0.25rem)] rounded-lg text-left',
        'transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'border border-transparent worktree-sidebar-card-hover',
        meta ? 'pt-1.25 pb-1.5' : 'py-2'
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
            <OrcaBotmuxSessionStatusDot status={session.status} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <OrcaBotmuxBotAvatar
                  name={session.botName ?? session.cliType}
                  avatarUrl={session.botAvatarUrl}
                />
                <span className="block min-w-0 truncate text-[13px] font-normal leading-5 text-foreground">
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
            {meta ? (
              <div className="flex min-w-0 items-center gap-1.5" data-worktree-card-meta-row="">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <span className="block min-w-0 truncate text-[11px] leading-none text-muted-foreground">
                    {meta}
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
