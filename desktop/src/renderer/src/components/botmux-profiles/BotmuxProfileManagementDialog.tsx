import { useMemo, useState } from 'react'
import { ArrowRightLeft, Copy, FolderGit2, Loader2, MoveRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  BotmuxProfileSummary,
  TransferBotmuxProfileProjectMode
} from '../../../../shared/botmux-profiles'
import type { Repo } from '../../../../shared/types'
import { BotmuxProfileAvatar } from './BotmuxProfileAvatar'
import {
  BotmuxProfileProjectTransferConfirmDialog,
  type PendingProjectTransfer
} from './BotmuxProfileProjectTransferConfirmDialog'
import { getBotmuxProfileProjectLiveWorkSummary } from './botmux-profile-switch-liveness'

type PendingTransfer = {
  repoId: string
  targetProfileId: string
  mode: TransferBotmuxProfileProjectMode
}

function pendingKey(value: PendingTransfer): string {
  return `${value.mode}:${value.repoId}:${value.targetProfileId}`
}

function getRepoPath(repo: Repo): string {
  return repo.path || repo.displayName
}

function ProjectTransferMenu({
  repo,
  sourceProfileId,
  targetProfiles,
  pending,
  onTransfer
}: {
  repo: Repo
  sourceProfileId: string
  targetProfiles: BotmuxProfileSummary[]
  pending: PendingTransfer | null
  onTransfer: (
    repo: Repo,
    targetProfile: BotmuxProfileSummary,
    mode: TransferBotmuxProfileProjectMode
  ) => void
}): React.JSX.Element {
  const disabled = targetProfiles.length === 0 || Boolean(pending)
  const repoPending = pending?.repoId === repo.id
  const renderTargetItems = (mode: TransferBotmuxProfileProjectMode): React.JSX.Element[] =>
    targetProfiles.map((profile) => {
      const targetPending =
        pending &&
        pendingKey(pending) === pendingKey({ repoId: repo.id, targetProfileId: profile.id, mode })
      return (
        <DropdownMenuItem
          key={`${mode}:${profile.id}`}
          disabled={Boolean(pending) || profile.id === sourceProfileId}
          onSelect={() => onTransfer(repo, profile, mode)}
        >
          {mode === 'move' ? <MoveRight /> : <Copy />}
          <BotmuxProfileAvatar profile={profile} />
          <span className="min-w-0 truncate">{profile.name}</span>
          {targetPending ? <Loader2 className="ml-auto size-3.5 animate-spin" /> : null}
        </DropdownMenuItem>
      )
    })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" disabled={disabled}>
          {repoPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRightLeft />}
          {translate('auto.components.botmux.profiles.management.04e7bd2a23', 'Transfer')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          {translate('auto.components.botmux.profiles.management.128c7dfe64', 'Copy to')}
        </DropdownMenuLabel>
        {renderTargetItems('copy')}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.botmux.profiles.management.df8b7d876b', 'Move to')}
        </DropdownMenuLabel>
        {renderTargetItems('move')}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BotmuxProfileManagementDialog({
  open,
  onOpenChange,
  activeProfile,
  profiles
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeProfile: BotmuxProfileSummary
  profiles: BotmuxProfileSummary[]
}): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const transferProject = useAppStore((s) => s.transferBotmuxProfileProject)
  const [pending, setPending] = useState<PendingTransfer | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingProjectTransfer | null>(
    null
  )
  const targetProfiles = useMemo(
    () => profiles.filter((profile) => profile.id !== activeProfile.id),
    [activeProfile.id, profiles]
  )

  const runTransfer = async (
    repo: Repo,
    targetProfile: BotmuxProfileSummary,
    mode: TransferBotmuxProfileProjectMode
  ): Promise<void> => {
    if (pending) {
      return
    }
    const nextPending = { repoId: repo.id, targetProfileId: targetProfile.id, mode }
    setPending(nextPending)
    const result = await transferProject({
      sourceProfileId: activeProfile.id,
      targetProfileId: targetProfile.id,
      repoId: repo.id,
      mode
    })
    setPending(null)
    if (result?.status === 'transferred') {
      toast.success(
        mode === 'move'
          ? translate('auto.components.botmux.profiles.management.9aa26347b3', 'Project moved')
          : translate('auto.components.botmux.profiles.management.816ce624b6', 'Project copied'),
        {
          description: targetProfile.name
        }
      )
    }
  }

  const handleTransfer = (
    repo: Repo,
    targetProfile: BotmuxProfileSummary,
    mode: TransferBotmuxProfileProjectMode
  ): void => {
    if (pending) {
      return
    }
    const liveWorkSummary = getBotmuxProfileProjectLiveWorkSummary(useAppStore.getState(), repo.id)
    if (mode === 'move' || liveWorkSummary.hasLiveWork) {
      setPendingConfirmation({ repo, targetProfile, mode, liveWorkSummary })
      return
    }
    void runTransfer(repo, targetProfile, mode)
  }

  const confirmTransfer = async (): Promise<void> => {
    if (!pendingConfirmation) {
      return
    }
    const next = pendingConfirmation
    await runTransfer(next.repo, next.targetProfile, next.mode)
    setPendingConfirmation(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.botmux.profiles.management.2c45bda8d3', 'Manage profiles')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.botmux.profiles.management.2db945e4a0',
              'Copy or move projects from the active profile to another local profile.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <BotmuxProfileAvatar profile={activeProfile} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{activeProfile.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {translate(
                  repos.length === 1
                    ? 'auto.components.botmux.profiles.management.projectCountSingular'
                    : 'auto.components.botmux.profiles.management.projectCountPlural',
                  repos.length === 1 ? '{{count}} project' : '{{count}} projects',
                  { count: repos.length }
                )}
              </div>
            </div>
          </div>
          <ScrollArea className="max-h-[360px]">
            {repos.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {translate(
                  'auto.components.botmux.profiles.management.8668cb2946',
                  'No projects in this profile.'
                )}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {repos.map((repo) => (
                  <div key={repo.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{repo.displayName}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {getRepoPath(repo)}
                      </div>
                    </div>
                    <ProjectTransferMenu
                      repo={repo}
                      sourceProfileId={activeProfile.id}
                      targetProfiles={targetProfiles}
                      pending={pending}
                      onTransfer={(selectedRepo, targetProfile, mode) => {
                        handleTransfer(selectedRepo, targetProfile, mode)
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {targetProfiles.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.botmux.profiles.management.93034915ab',
              'Create another profile before copying projects.'
            )}
          </div>
        ) : null}
        <BotmuxProfileProjectTransferConfirmDialog
          activeProfileName={activeProfile.name}
          pendingTransfer={pendingConfirmation}
          pending={Boolean(pending)}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={() => {
            void confirmTransfer()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
