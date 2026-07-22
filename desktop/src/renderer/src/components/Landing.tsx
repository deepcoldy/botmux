import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus, X } from 'lucide-react'
import { useAppStore } from '../store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/types'
import {
  dismissPreflightIssue,
  githubProjectKeys,
  isPreflightIssueDismissed
} from './landing-preflight-dismissal'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import logo from '../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'
import {
  getLandingPreflightIssues,
  hasGitHubBackedProject,
  type PreflightIssue
} from './landing-preflight-issues'

type ShortcutItem = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

function PreflightBanner({
  issues,
  repos
}: {
  issues: PreflightIssue[]
  repos: Repo[]
}): React.JSX.Element | null {
  // Why: keying the seed on the current GitHub project set means adding a new
  // GitHub project (which changes the key) re-evaluates dismissals, so a lapsed
  // dismissal re-surfaces the nudge without a manual reset.
  const githubKey = githubProjectKeys(repos).join('|')
  const [dismissed, setDismissed] = useState<Set<string>>(
    () =>
      new Set(
        issues
          .filter((issue) => issue.dismissible && isPreflightIssueDismissed(issue.id, repos))
          .map((issue) => issue.id)
      )
  )

  useEffect(() => {
    setDismissed(
      new Set(
        issues
          .filter((issue) => issue.dismissible && isPreflightIssueDismissed(issue.id, repos))
          .map((issue) => issue.id)
      )
    )
    // Why: re-seed only when the GitHub project set changes; issues identity is
    // stable per render and would otherwise reset transient dismiss state.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [githubKey])

  const visibleIssues = issues.filter((issue) => !dismissed.has(issue.id))
  if (visibleIssues.length === 0) {
    return null
  }

  const dismiss = (issue: PreflightIssue): void => {
    dismissPreflightIssue(issue.id, repos)
    setDismissed((prev) => new Set(prev).add(issue.id))
  }

  return (
    // Why: cap width below the max-w-lg column so the card reads as part of the
    // centered content stack instead of stretching edge-to-edge. The styleguide
    // reserves color for true error state — these are soft setup nudges, so use
    // the quiet muted/border surface, not an amber frame.
    <div className="w-full max-w-sm space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
      {visibleIssues.map((issue) => (
        <div
          key={issue.id}
          className="flex items-start gap-3 rounded-md px-1 py-1.5 first:pt-0 last:pb-0"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500/70" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] font-medium leading-snug text-foreground">{issue.title}</p>
            <p className="text-xs leading-snug text-muted-foreground">{issue.description}</p>
            <button
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline cursor-pointer"
              onClick={() => window.api.shell.openUrl(issue.fixUrl)}
            >
              {issue.fixLabel}
              <ExternalLink className="size-3" />
            </button>
          </div>
          {issue.dismissible && (
            <button
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
              onClick={() => dismiss(issue)}
              aria-label={translate('auto.components.Landing.preflightDismiss', 'Dismiss')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default function Landing(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const openModal = useAppStore((s) => s.openModal)

  const createTargetLabel =
    repos.length > 0 && repos.every((repo) => isGitRepoKind(repo)) ? 'Worktree' : 'Workspace'
  const canCreateWorktree = repos.length > 0
  const hasGitHubProject = useMemo(() => hasGitHubBackedProject(repos), [repos])

  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[]>([])

  useEffect(() => {
    let cancelled = false
    const refreshPreflight = (force = false): void => {
      void window.api.preflight.check(force ? { force: true } : undefined).then((status) => {
        if (cancelled) {
          return
        }
        setPreflightIssues(
          getLandingPreflightIssues(status, { hasGitHubBackedProject: hasGitHubProject })
        )
      })
    }

    // oxlint-disable-next-line react-doctor/no-initialize-state -- Why: preflight status is read from an external IPC probe on mount and focus.
    refreshPreflight()

    // Why: users often install/authenticate gh outside Botmux. Re-check when the
    // window becomes active again so the landing warning clears without relaunch.
    const handleWindowActive = (): void => {
      if (document.visibilityState === 'visible') {
        refreshPreflight(true)
      }
    }

    document.addEventListener('visibilitychange', handleWindowActive)
    window.addEventListener('focus', handleWindowActive)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleWindowActive)
      window.removeEventListener('focus', handleWindowActive)
    }
  }, [hasGitHubProject])

  useEffect(() => {
    if (preflightIssues.length === 0) {
      return
    }

    let cancelled = false
    // Why: some users complete `gh auth login` without ever leaving the Botmux
    // window. Poll only while a warning is visible so the banner self-clears.
    const intervalId = window.setInterval(() => {
      void window.api.preflight.check({ force: true }).then((status) => {
        if (cancelled) {
          return
        }
        setPreflightIssues(
          getLandingPreflightIssues(status, { hasGitHubBackedProject: hasGitHubProject })
        )
      })
    }, 30000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [hasGitHubProject, preflightIssues.length])

  const createWorktreeShortcut = useShortcutKeyDetails('workspace.create')
  const previousWorktreeShortcut = useShortcutKeyDetails('worktree.navigateUp')
  const nextWorktreeShortcut = useShortcutKeyDetails('worktree.navigateDown')
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      {
        id: 'create',
        shortcut: createWorktreeShortcut,
        action: `Create ${createTargetLabel.toLowerCase()}`
      },
      { id: 'up', shortcut: previousWorktreeShortcut, action: 'Move up workspace' },
      { id: 'down', shortcut: nextWorktreeShortcut, action: 'Move down workspace' }
    ]
  }, [createTargetLabel, createWorktreeShortcut, nextWorktreeShortcut, previousWorktreeShortcut])

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img
              src={logo}
              alt={translate('auto.components.Landing.520304a067', 'Botmux logo')}
              className="size-12"
            />
          </div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight">
            {translate('auto.components.Landing.6ca6ff404e', 'botmux')}
          </h1>

          {preflightIssues.length > 0 && <PreflightBanner issues={preflightIssues} repos={repos} />}

          <p className="text-sm text-muted-foreground text-center">
            {canCreateWorktree
              ? translate(
                  'auto.components.Landing.9c00bd4adf',
                  'Select a workspace from the sidebar to begin.'
                )
              : translate('auto.components.Landing.cd21242762', 'Add a project to get started.')}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" />
              {translate('auto.components.Landing.f9eaa9e12d', 'Add Project')}
            </button>

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-accent"
              disabled={!canCreateWorktree}
              title={
                !canCreateWorktree
                  ? translate('auto.components.Landing.f05d237049', 'Add a project first')
                  : undefined
              }
              onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
            >
              <GitBranchPlus className="size-3.5" />
              {translate('auto.components.Landing.76a95f7f47', 'Create')}{' '}
              {createTargetLabel.toLowerCase()}
            </button>
          </div>

          <div className="mt-6 w-full max-w-xs space-y-2">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                <span className="text-sm text-muted-foreground">{shortcut.action}</span>
                <ShortcutKeyCombo
                  keys={shortcut.shortcut.keys}
                  doubleTap={shortcut.shortcut.doubleTap}
                  separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
