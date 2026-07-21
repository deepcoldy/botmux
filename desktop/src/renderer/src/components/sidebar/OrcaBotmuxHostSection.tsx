/**
 * One host (machine) section in the OrcaBotmux sidebar tree: host card row with
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
  buildOrcaBotmuxAgentGroups,
  capOrcaBotmuxHostSessions,
  type OrcaBotmuxHostSection as HostSection,
  type OrcaBotmuxSessionLeaf
} from '@/lib/orca-botmux-session-tree'
import { OrcaBotmuxBotAvatar } from './OrcaBotmuxBotAvatar'
import { OrcaBotmuxSessionRow } from './OrcaBotmuxSessionRow'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

/** SectionMetricsBadge pill (WorktreeList) — the one rounded-full badge in the sidebar. */
const COUNT_PILL_CLASS =
  'inline-flex h-4 shrink-0 items-center rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90'
const COUNT_PILL_INNER_CLASS = 'min-w-4 px-1.5 text-center'

export function OrcaBotmuxHostSection({
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
  onOpenSession: (s: OrcaBotmuxSessionLeaf, mode: 'attach' | 'web') => void
  onReconnect: (hostId: string) => void
  onDisconnect: (hostId: string) => void
  onManage: () => void
}): React.JSX.Element {
  const { visible, hiddenCount } = capOrcaBotmuxHostSessions(section.sessions, rowCap)
  const shown = expanded ? section.sessions : visible
  const overflow = expanded ? 0 : hiddenCount
  const agentGroups = groupByAgent ? buildOrcaBotmuxAgentGroups(section.sessions) : []

  const renderSession = (s: OrcaBotmuxSessionLeaf): React.JSX.Element => {
    const key = `${s.hostId}::${s.sessionId}`
    return (
      <OrcaBotmuxSessionRow
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
          'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-all',
          'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          section.ok
            ? 'border-worktree-sidebar-border bg-worktree-sidebar-accent/70'
            : 'border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35 text-muted-foreground'
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
        {/* Why: pill hugs the label like OrcaBotmux's HostSectionHeader —
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
            className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
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
                  className="size-5 shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity focus-visible:opacity-100 group-hover/host-header:opacity-100 data-[state=open]:opacity-100"
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
          <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-56">
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

      {!collapsed ? (
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
                    className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left worktree-sidebar-card-hover"
                    onClick={() => onToggleAgentCollapsed(agentId)}
                  >
                    <ChevronDown
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform',
                        agentCollapsed && '-rotate-90'
                      )}
                    />
                    <OrcaBotmuxBotAvatar
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
                  {!agentCollapsed ? (
                    <div className="ml-3 flex flex-col gap-0.5">
                      {group.sessions.map(renderSession)}
                    </div>
                  ) : null}
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
      ) : null}
    </li>
  )
}
