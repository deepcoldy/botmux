/**
 * Compact badge: how many orca_botmux sessions have workingDir under this worktree.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Radio } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  getOrcaBotmuxSessionsFeedSnapshot,
  subscribeOrcaBotmuxSessionsFeed
} from '@/lib/orca-botmux-sessions-feed'
import {
  orcaBotmuxHostIdForRepoConnection,
  filterSessionsForWorktree
} from '@/lib/match-orca-botmux-sessions-to-worktree'
import { isOrcaBotmuxTabHostPath } from '@/lib/orca-botmux-session-tree'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type Props = {
  worktreeId: string
  worktreePath: string
  repoId: string
  className?: string
}

export function WorktreeOrcaBotmuxSessionBadge({
  worktreeId,
  worktreePath,
  repoId,
  className
}: Props): React.JSX.Element | null {
  const feed = useSyncExternalStore(
    subscribeOrcaBotmuxSessionsFeed,
    getOrcaBotmuxSessionsFeedSnapshot,
    getOrcaBotmuxSessionsFeedSnapshot
  )
  const repo = useAppStore((s) => s.repos.find((r) => r.id === repoId))

  const count = useMemo(() => {
    if (!worktreePath || isOrcaBotmuxTabHostPath(worktreePath)) return 0
    const target = {
      worktreeId,
      path: worktreePath,
      orcaBotmuxHostId: orcaBotmuxHostIdForRepoConnection(repo?.connectionId)
    }
    return filterSessionsForWorktree(feed.sessions, target).length
  }, [feed.sessions, worktreeId, worktreePath, repo?.connectionId])

  if (count <= 0) return null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-0 text-[9px] font-medium',
        'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        className
      )}
      title={translate(
        'settings.orcaBotmuxBridge.worktreeSessionBadge',
        '{{count}} orca_botmux session(s) in this directory',
        { count }
      )}
    >
      <Radio className="size-2.5" />
      {count}
    </span>
  )
}
