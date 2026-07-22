/**
 * One host (machine) section in the Botmux sidebar tree: host card row with
 * collapse + working summary + actions menu, then its flat session list with
 * a row cap ("N more" affordance à la ImportedWorktreesVisibilityLine).
 */
import React from 'react'
import {
  ChevronDown,
  Ellipsis,
  RefreshCw,
  Server,
  ServerOff,
  Settings2,
  Unplug
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { translate } from '@/i18n/i18n'
import {
  buildBotmuxAgentGroups,
  capBotmuxHostSessions,
  type BotmuxHostSection as HostSection,
  type BotmuxSessionLeaf
} from '@/lib/botmux-session-tree'
import { BotmuxBotAvatar } from './BotmuxBotAvatar'
import { BotmuxSessionRow } from './BotmuxSessionRow'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.botmuxBridge.${key}`, fallback, options)

/** Apple-style count: plain tabular secondary text, no pill chrome. */
const COUNT_PILL_CLASS =
  'inline-flex h-4 shrink-0 items-center text-[10px] font-normal tabular-nums leading-none text-muted-foreground/70'
const COUNT_PILL_INNER_CLASS = 'min-w-4 px-1 text-center'

export function BotmuxHostSection({
  section,
  collapsed,
  onToggleCollapsed,
  rowCap,
  expanded,
  onToggleExpanded,
  groupByAgent,
  collapsedAgents,
  onToggleAgentCollapsed,
  activeKey,
  busy,
  onOpenSession,
  onReconnect,
  onDisconnect,
  onManage
}: {
  section: HostSection
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Infinity while a text filter is active (search shows all matches). */
  rowCap: number
  expanded: boolean
  onToggleExpanded: () => void
  /** Group sessions under per-agent sub-headers instead of a flat list. */
  groupByAgent: boolean
  collapsedAgents: Record<string, boolean>
  onToggleAgentCollapsed: (agentId: string) => void
  activeKey: string | null
  busy: boolean
  onOpenSession: (s: BotmuxSessionLeaf, mode: 'attach' | 'web') => void
  onReconnect: (hostId: string) => void
  onDisconnect: (hostId: string) => void
  onManage: () => void
}): React.JSX.Element {
  const { visible, hiddenCount } = capBotmuxHostSessions(section.sessions, rowCap)
  const shown = expanded ? section.sessions : visible
  const overflow = expanded ? 0 : hiddenCount
  const agentGroups = groupByAgent ? buildBotmuxAgentGroups(section.sessions) : []

  const renderSession = (s: BotmuxSessionLeaf): React.JSX.Element => {
    const key = `${s.hostId}::${s.sessionId}`
    return (
      <BotmuxSessionRow
        key={key}
        session={s}
        active={activeKey === key}
        busy={busy}
        onOpen={onOpenSession}
      />
    )
  }

  return (
    <li className="flex flex-col">
      {/* Row is div[role=button]: a real <button> cannot nest the menu trigger. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        className={cn(
          'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border px-2 text-left transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
          // Why: Apple "kill latency" — press feedback on pointer-down.
          'active:scale-[0.99] active:transition-transform active:duration-[80ms] active:ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          // Why: Apple grouped-list material — whisper-light fill + hairline
          // border instead of the heavier accent card; hover deepens a notch.
          section.ok
            ? 'border-black/[0.05] bg-black/[0.025] hover:bg-black/[0.045] dark:border-white/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]'
            : 'border-black/[0.04] bg-black/[0.015] text-muted-foreground dark:border-white/[0.05] dark:bg-white/[0.03]'
        )}
        title={!section.ok && section.message ? section.message : undefined}
        onClick={onToggleCollapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleCollapsed()
          }
        }}
      >
        {section.ok ? (
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ServerOff className="size-3.5 shrink-0 text-muted-foreground/80" />
        )}
        {/* Why: pill hugs the label like Botmux's HostSectionHeader —
            right-anchoring floats it beside the hover-only controls. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[12px] font-semibold leading-none">
            {section.hostLabel}
          </span>
          {section.ok ? (
            <span
              className={COUNT_PILL_CLASS}
              title={t('sessionCountTitle', '{{count}} sessions', {
                count: section.sessions.length
              })}
            >
              <span className={COUNT_PILL_INNER_CLASS}>{section.sessions.length}</span>
            </span>
          ) : (
            <span
              className="inline-flex h-4 shrink-0 items-center rounded-full border border-destructive/30 bg-destructive/10 text-[9px] font-medium leading-none text-destructive"
            >
              <span className={COUNT_PILL_INNER_CLASS}>{t('offline', 'Offline')}</span>
            </span>
          )}
          {section.workingCount > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium leading-none text-muted-foreground"
              title={t('hostWorkingSummary', '{{working}} working · {{total}} sessions', {
                working: section.workingCount,
                total: section.sessions.length
              })}
            >
              <AgentWorkingSpinner className="size-2" />
              {section.workingCount}
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            'flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 transition-opacity',
            'can-hover:opacity-0 group-hover/host-header:opacity-100 group-focus-within/host-header:opacity-100'
          )}
        >
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
              collapsed && '-rotate-90'
            )}
          />
        </div>
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  className="size-5 shrink-0 text-muted-foreground transition-all can-hover:opacity-0 focus-visible:opacity-100 group-hover/host-header:opacity-100 data-[state=open]:opacity-100 active:scale-[0.92] active:duration-[80ms] active:ease-[cubic-bezier(0.25,0.46,0.45,0.94)]"
                  aria-label={t('hostActions', 'Host actions for {{host}}', {
                    host: section.hostLabel
                  })}
                  // Why: the host row itself toggles collapse on click;
                  // opening the menu must not also fold the section.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('hostActionsTitle', 'Host actions')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="start" sideOffset={8} className="botmux-menu-content w-56">
            <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
              {section.hostLabel}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onReconnect(section.hostId)}>
              <RefreshCw className="size-3.5" />
              {t('reconnect', 'Reconnect')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onManage()}>
              <Settings2 className="size-3.5" />
              {t('manageMachines', 'Manage machines…')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onDisconnect(section.hostId)}
            >
              <Unplug className="size-3.5" />
              {t('disconnect', 'Disconnect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="botmux-collapsible" data-open={!collapsed}>
        <div className="botmux-collapsible-inner">
          <div className="ml-2 flex flex-col gap-0.5 pt-0.5">
          {section.sessions.length === 0 ? (
            <p className={cn('px-2 py-1 text-[10px]', section.ok ? 'text-muted-foreground' : 'text-destructive/80')}>
              {section.ok
                ? t('hostEmptySessions', 'No sessions')
                : (section.message ?? t('offline', 'Offline'))}
            </p>
          ) : groupByAgent ? (
            // Group-by-agent view: per-agent collapsible sub-headers, no row cap
            // (the user explicitly opted into the detailed grouping).
            agentGroups.map((group) => {
              const agentId = `${section.hostId}::${group.agentKey}`
              const agentCollapsed = collapsedAgents[agentId] === true
              return (
                <div key={agentId} className="flex flex-col">
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left transition-transform worktree-sidebar-card-hover active:scale-[0.98] active:duration-[80ms] active:ease-[cubic-bezier(0.25,0.46,0.45,0.94)]"
                    onClick={() => onToggleAgentCollapsed(agentId)}
                  >
                    <ChevronDown
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                        agentCollapsed && '-rotate-90'
                      )}
                    />
                    <BotmuxBotAvatar
                      name={group.label}
                      avatarUrl={group.avatarUrl}
                      className="size-3.5 text-[8px]"
                    />
                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">
                        {group.label}
                      </span>
                      <span
                        className={COUNT_PILL_CLASS}
                        title={t('sessionCountTitle', '{{count}} sessions', {
                          count: group.sessions.length
                        })}
                      >
                        <span className={COUNT_PILL_INNER_CLASS}>{group.sessions.length}</span>
                      </span>
                    </div>
                  </button>
                  <div className="botmux-collapsible" data-open={!agentCollapsed}>
                    <div className="botmux-collapsible-inner">
                      <div className="ml-3 flex flex-col gap-0.5">
                        {group.sessions.map(renderSession)}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          ) : (
            shown.map(renderSession)
          )}
          {!groupByAgent && overflow > 0 ? (
            <button
              type="button"
              className="mx-1 my-0.5 flex min-h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground"
              onClick={onToggleExpanded}
            >
              <ChevronDown className="size-3 transition-transform -rotate-90" />
              {t('moreSessions', '{{count}} more…', { count: overflow })}
            </button>
          ) : null}
          {!groupByAgent && expanded && section.sessions.length > rowCap ? (
            <button
              type="button"
              className="mx-1 my-0.5 flex min-h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground"
              onClick={onToggleExpanded}
            >
              <ChevronDown className="size-3 transition-transform" />
              {t('showLessSessions', 'Show less')}
            </button>
          ) : null}
          </div>
        </div>
      </div>
    </li>
  )
}
