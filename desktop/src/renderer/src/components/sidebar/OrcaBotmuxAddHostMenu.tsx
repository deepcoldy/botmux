/**
 * "Add machine" menu for the OrcaBotmux sidebar: connect Local / platform tunnel /
 * any known-but-unconnected SSH target, or jump to creating/managing hosts.
 * Replaces the old always-visible quick-connect chip row (adding a machine is
 * a rare action — endpoints persist and auto-reconnect).
 */
import React from 'react'
import { Check, Laptop, Loader2, Plus, Server, Settings2, SquarePlus, Globe } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import type { OrcaBotmuxSshTargetRow } from '@/lib/load-orca-botmux-ssh-targets'

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(`settings.orcaBotmuxBridge.${key}`, fallback, options)

/** Keep the menu scannable; the Settings pane table handles the long tail. */
const MAX_SSH_MENU_ITEMS = 7

export function BotmuxAddHostMenu({
  localConnected,
  platformConnected,
  sshTargets,
  busy,
  labeled,
  onConnectLocal,
  onConnectPlatform,
  onConnectSsh,
  onNewSshHost,
  onManage
}: {
  localConnected: boolean
  platformConnected: boolean
  /** Unconnected SSH targets (parent pre-filters). */
  sshTargets: OrcaBotmuxSshTargetRow[]
  busy: boolean
  /** Empty-state variant: labeled outline button instead of an icon button. */
  labeled?: boolean
  onConnectLocal: () => void
  onConnectPlatform: () => void
  onConnectSsh: (sshTargetId: string) => void
  onNewSshHost: () => void
  onManage: () => void
}): React.JSX.Element {
  const menuTargets = sshTargets.slice(0, MAX_SSH_MENU_ITEMS)
  const overflowTargets = sshTargets.length - menuTargets.length

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {labeled ? (
              <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" disabled={busy}>
                <Plus className="size-3.5" />
                {t('addMachine', 'Add machine')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={t('addMachine', 'Add machine')}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" strokeWidth={2.25} />}
              </Button>
            )}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('addMachine', 'Add machine')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6} className="w-60">
        <DropdownMenuLabel>{t('addMachine', 'Add machine')}</DropdownMenuLabel>
        <DropdownMenuItem disabled={localConnected} onSelect={() => onConnectLocal()}>
          <Laptop className="size-3.5" />
          {t('local', 'Local')}
          {localConnected ? <Check className="ml-auto size-3.5 text-primary" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={platformConnected} onSelect={() => onConnectPlatform()}>
          <Globe className="size-3.5" />
          {t('platformTunnel', 'Platform tunnel')}
          {platformConnected ? <Check className="ml-auto size-3.5 text-primary" /> : null}
        </DropdownMenuItem>

        {menuTargets.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('sshHostsSection', 'SSH hosts')}</DropdownMenuLabel>
            {menuTargets.map((h) => (
              <DropdownMenuItem key={h.id} onSelect={() => onConnectSsh(h.id)}>
                <Server className="size-3.5" />
                <span className="min-w-0 truncate">{h.label}</span>
                <span className="ml-auto max-w-24 truncate text-[10px] text-muted-foreground">
                  {h.destination}
                </span>
              </DropdownMenuItem>
            ))}
            {overflowTargets > 0 ? (
              <DropdownMenuItem onSelect={() => onManage()}>
                <Server className="size-3.5" />
                {t('moreHosts', 'More hosts…')}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  +{overflowTargets}
                </span>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onNewSshHost()}>
          <SquarePlus className="size-3.5" />
          {t('newSshHost', 'New SSH host…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onManage()}>
          <Settings2 className="size-3.5" />
          {t('manageMachines', 'Manage machines…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
