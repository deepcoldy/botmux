/**
 * View-filter menu for the OrcaBotmux sidebar tree (SidebarFilter idiom: a
 * ListFilter icon button with an active-count badge, options inside a
 * DropdownMenu). Holds the text query + agent multi-select + show-closed
 * toggle, replacing the old chip rows.
 */
import React, { useRef } from 'react'
import { Check, Eye, ListFilter, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { OrcaBotmuxAgentOption } from '@/lib/orca-botmux-session-tree'
import { OrcaBotmuxBotAvatar } from './OrcaBotmuxBotAvatar'
import type { OrcaBotmuxSidebarGroupBy } from '@/lib/orca-botmux-sidebar-view-state'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

export function BotmuxFilterMenu({
  query,
  onQueryChange,
  showClosed,
  onShowClosedChange,
  closedCount,
  agents,
  selectedAgentKeys,
  onToggleAgent,
  onResetFilters,
  groupBy,
  onGroupByChange
}: {
  query: string
  onQueryChange: (query: string) => void
  showClosed: boolean
  onShowClosedChange: (next: boolean) => void
  closedCount: number
  /** Agents present in the visible session set (count-sorted). */
  agents: OrcaBotmuxAgentOption[]
  selectedAgentKeys: string[]
  onToggleAgent: (agentKey: string) => void
  onResetFilters: () => void
  groupBy: OrcaBotmuxSidebarGroupBy
  onGroupByChange: (groupBy: OrcaBotmuxSidebarGroupBy) => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const activeCount =
    (query.trim() ? 1 : 0) + (showClosed ? 1 : 0) + selectedAgentKeys.length

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="relative"
              aria-label={t('filterMenuTitle', 'Filter sessions')}
            >
              <ListFilter className="size-3.5" strokeWidth={2.25} />
              {activeCount > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium text-primary-foreground">
                  {activeCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('filterMenuTitle', 'Filter sessions')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6} className="w-64">
        <DropdownMenuLabel>{t('filterMenuTitle', 'Filter sessions')}</DropdownMenuLabel>
        <div className="relative mx-1 mb-1">
          <Input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder={t('filterSessionsPlaceholder', 'Filter sessions…')}
            className="h-8 rounded-[7px] pl-7 pr-7 text-xs"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              // Esc with an empty query must bubble so Radix closes the menu.
              if (e.key === 'Escape' && !query) return
              // Keep typing/escape inside the menu (Radix roving focus).
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                onQueryChange('')
              }
            }}
          />
          <ListFilter className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          {query ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label={t('clearFilter', 'Clear filter')}
              onClick={() => {
                onQueryChange('')
                inputRef.current?.focus()
              }}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        {agents.length >= 2 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('agentsSection', 'Agents')}</DropdownMenuLabel>
            <div className="max-h-40 overflow-y-auto">
              {agents.map((agent) => {
                const selected = selectedAgentKeys.includes(agent.key)
                return (
                  <button
                    key={agent.key}
                    type="button"
                    onClick={() => onToggleAgent(agent.key)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12px] leading-5 font-medium',
                      'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      selected && 'text-foreground'
                    )}
                  >
                    <OrcaBotmuxBotAvatar
                      name={agent.label}
                      avatarUrl={agent.avatarUrl}
                      className="size-3.5 text-[8px]"
                    />
                    <span className="min-w-0 flex-1 truncate">{agent.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {agent.count}
                    </span>
                    {selected ? (
                      <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />
                    ) : null}
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        <button
          type="button"
          role="switch"
          aria-checked={showClosed}
          onClick={() => onShowClosedChange(!showClosed)}
          className="flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="inline-flex items-center gap-2 text-foreground">
            <span className="text-muted-foreground">
              <Eye className="size-3.5" />
            </span>
            {t('filterShowClosed', 'Show closed')}
            {closedCount > 0 ? (
              <span className="text-[10px] text-muted-foreground">{closedCount}</span>
            ) : null}
          </span>
          <span
            aria-hidden
            className={cn(
              'relative h-3.5 w-6 shrink-0 rounded-full transition-colors',
              showClosed ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 left-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform',
                showClosed && 'translate-x-2.5'
              )}
            />
          </span>
        </button>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('groupByLabel', 'Group by')}</DropdownMenuLabel>
        <div className="px-1 pb-1">
          <ToggleGroup
            type="single"
            value={groupBy}
            onValueChange={(value) => {
              if (value === 'host' || value === 'agent') onGroupByChange(value)
            }}
            variant="outline"
            size="sm"
            className="h-6 w-full justify-stretch"
          >
            <ToggleGroupItem
              value="host"
              // Why: inside the dropdown menu, Radix can focus a toggle item
              // without committing ToggleGroup's value change; capture the
              // pointer intent before roving-focus turns it into a no-op.
              onPointerDownCapture={() => onGroupByChange('host')}
              className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
            >
              {t('groupByHost', 'Hosts')}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="agent"
              onPointerDownCapture={() => onGroupByChange('agent')}
              className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
            >
              {t('agentsSection', 'Agents')}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {activeCount > 0 ? (
          <div className="flex items-center px-1 pt-1">
            <button
              type="button"
              onClick={onResetFilters}
              className="rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('resetFilters', 'Reset filters')}
            </button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
