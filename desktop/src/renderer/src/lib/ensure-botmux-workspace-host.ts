/**
 * Resolve where Botmux session tabs should live.
 *
 *  1. Match session `cwd` + host to a real Botmux worktree when present.
 *  2. Else fabricate a **stable** per-session host `botmux:session:<sessionId>`
 *     from session metadata (path=cwd, SSH target from hostId) — main area,
 *     not Projects, not floating.
 *
 * Floating terminal is never used.
 */
import { useAppStore } from '@/store'
import {
  BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
} from '../../../shared/constants'
import {
  ensureBotmuxAgentWorktree,
  getBotmuxHostSshTargetId,
  getCachedBotmuxControlPlaneWorktree,
  isBotmuxControlPlaneHostId,
  isBotmuxMainTerminalHostId,
  sshTargetIdFromBotmuxHostId,
  worktreeIdForBotmuxAgent
} from '../../../shared/botmux-main-terminal-host'
import { botmuxAgentLabel } from '@/lib/botmux-session-tree'
import { parseWorkspaceKey, folderWorkspaceKey } from '../../../shared/workspace-scope'
import { isBotmuxTabHostPath } from '@/lib/botmux-session-tree'
import {
  botmuxHostIdForRepoConnection,
  pickDeepestWorktreeMatch,
  type WorktreeMatchTarget
} from '@/lib/match-botmux-sessions-to-worktree'

export type BotmuxTabHost =
  | {
      ok: true
      worktreeId: string
      surface: 'worktree'
      remotePty: boolean
      reason: 'session-cwd' | 'botmux-session' | 'botmux-main'
    }
  | { ok: false; message: string }

type Store = ReturnType<typeof useAppStore.getState>

export type BotmuxHostSessionHint = {
  sessionId?: string
  hostId: string
  hostLabel?: string
  title?: string
  cwd?: string | null
  botName?: string
  cliType?: string
  /** Optional precomputed agent key/label; otherwise derived from botName/cliType. */
  agentKey?: string
  agentLabel?: string
}

/** Collect every Botmux worktree/folder that can match a botmux session cwd. */
export function listBotmuxMatchTargets(store: Store): WorktreeMatchTarget[] {
  const targets: WorktreeMatchTarget[] = []
  const seen = new Set<string>()

  const push = (worktreeId: string, path: string, botmuxHostId: string): void => {
    if (!worktreeId || !path || isBotmuxTabHostPath(path)) return
    if (isBotmuxControlPlaneHostId(worktreeId)) return
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) return
    if (seen.has(worktreeId)) return
    seen.add(worktreeId)
    targets.push({ worktreeId, path, botmuxHostId })
  }

  const all =
    typeof store.allWorktrees === 'function'
      ? store.allWorktrees()
      : Object.values(store.worktreesByRepo ?? {}).flat()

  for (const wt of all ?? []) {
    if (!wt?.id || !wt.path) continue
    const repo = store.repos?.find((r) => r.id === wt.repoId)
    push(wt.id, wt.path, botmuxHostIdForRepoConnection(repo?.connectionId))
  }

  for (const fw of store.folderWorkspaces ?? []) {
    if (!fw?.id || !fw.folderPath) continue
    push(
      folderWorkspaceKey(fw.id),
      fw.folderPath,
      botmuxHostIdForRepoConnection(fw.connectionId)
    )
  }

  return targets
}

function worktreeIsRemotePty(store: Store, worktreeId: string): boolean {
  if (isBotmuxMainTerminalHostId(worktreeId)) return false
  if (isBotmuxControlPlaneHostId(worktreeId)) {
    return Boolean(getBotmuxHostSshTargetId(worktreeId))
  }

  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const fw = store.folderWorkspaces?.find((w) => w.id === scope.folderWorkspaceId)
    return Boolean(fw?.connectionId?.trim())
  }
  const bare =
    scope?.type === 'worktree'
      ? scope.worktreeId
      : worktreeId.startsWith('worktree:')
        ? worktreeId.slice('worktree:'.length)
        : worktreeId
  const wt =
    store.getKnownWorktreeById?.(bare) ??
    store.getKnownWorktreeById?.(worktreeId) ??
    Object.values(store.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry?.id === bare || entry?.id === worktreeId)
  if (!wt) return false
  const repo = store.repos?.find((r) => r.id === wt.repoId)
  return Boolean(repo?.connectionId?.trim())
}

function normalizeHostId(worktreeId: string): string {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'worktree') return scope.worktreeId
  return worktreeId
}

/**
 * Activate main Terminal workbench for a host id.
 */
export function activateBotmuxTabHost(worktreeId: string): void {
  const store = useAppStore.getState()
  if (isBotmuxControlPlaneHostId(worktreeId)) {
    store.setActiveWorktree(worktreeId)
  } else {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      store.setActiveFolderWorkspace(scope.folderWorkspaceId)
    } else {
      store.setActiveWorktree(normalizeHostId(worktreeId))
    }
  }
  store.setActiveView('terminal')
  store.setActiveTabType('terminal')
}

/**
 * Resolve tab host for a botmux session.
 * Never returns floating.
 */
/**
 * Host for botmux **attach** open.
 *
 * Always prefer a **local** PTY host + `ssh -tt … tmux attach` for SSH sessions.
 * Matching a real Botmux SSH worktree with remotePty looks attractive, but
 * `sshConnectionStates.status === 'connected'` does **not** mean SshPtyProvider
 * is registered — CDP repro: remotePty=true, tab lives 500ms with ptyId=null,
 * main logs "No PTY provider" / black flash.
 *
 * Local worktree match is OK (local PTY + local tmux). SSH sessions always use
 * `botmux:session:<id>` local host.
 */
export function resolveBotmuxSessionTabHost(session: BotmuxHostSessionHint): BotmuxTabHost {
  const store = useAppStore.getState()
  const targets = listBotmuxMatchTargets(store)
  const matched = pickDeepestWorktreeMatch(
    { hostId: session.hostId, cwd: session.cwd ?? undefined },
    targets
  )
  console.info('[botmux-open]', 'resolve:match', {
    hostId: session.hostId,
    cwd: session.cwd ?? null,
    targetCount: targets.length,
    matched: matched
      ? { worktreeId: matched.worktreeId, path: matched.path, botmuxHostId: matched.botmuxHostId }
      : null
  })

  // Local-only match: open on that worktree (no SSH provider).
  if (matched && !worktreeIsRemotePty(store, matched.worktreeId)) {
    console.info('[botmux-open]', 'resolve:session-cwd-local', {
      worktreeId: matched.worktreeId
    })
    return {
      ok: true,
      worktreeId: matched.worktreeId,
      surface: 'worktree',
      remotePty: false,
      reason: 'session-cwd'
    }
  }

  if (matched && worktreeIsRemotePty(store, matched.worktreeId)) {
    console.warn(
      '[botmux-open]',
      'resolve:skip-remote-worktree → botmux-session local PTY',
      {
        matchedWorktreeId: matched.worktreeId,
        note: 'SSH worktree match ignored for attach; avoids No PTY provider race'
      }
    )
  }

  const sessionId = String(session.sessionId ?? '').trim()
  if (sessionId) {
    // Filesystem: plant session cwd + SSH connectionId for FileExplorer.
    // PTY: still local (remotePty false); spawn path forced to '.' for control-plane.
    const filesystemConnectionId = sshTargetIdFromBotmuxHostId(session.hostId)
    const agent =
      session.agentKey && session.agentLabel
        ? { key: session.agentKey, label: session.agentLabel }
        : botmuxAgentLabel({ botName: session.botName, cliType: session.cliType })
    const agentKey = String(session.agentKey ?? agent.key).trim() || 'unknown'
    const agentLabel = String(session.agentLabel ?? agent.label).trim() || agentKey

    ensureBotmuxAgentWorktree({
      sessionId,
      hostId: session.hostId,
      hostLabel: session.hostLabel,
      title: session.title,
      cwd: session.cwd,
      agentKey,
      agentLabel,
      // FS routing only — getBotmuxHostSshTargetId intentionally ignores this for PTY.
      sshTargetId: filesystemConnectionId
    })
    const worktreeId = worktreeIdForBotmuxAgent(session.hostId, agentKey)
    // Project branch/head from a matching Botmux worktree when cwd lands under it
    // (right panel git chrome). Does not switch terminal host to remote PTY.
    if (matched && worktreeIsRemotePty(store, matched.worktreeId)) {
      const source =
        store.getKnownWorktreeById?.(matched.worktreeId) ??
        store.allWorktrees?.().find((w: { id: string }) => w.id === matched.worktreeId)
      const synthetic = getCachedBotmuxControlPlaneWorktree(worktreeId)
      if (source && synthetic) {
        if (source.branch) synthetic.branch = source.branch
        if (source.head) synthetic.head = source.head
      }
    }
    console.info('[botmux-open]', 'resolve:botmux-agent', {
      worktreeId,
      agentKey,
      agentLabel,
      cwd: session.cwd ?? null,
      filesystemConnectionId,
      matchedPath: matched?.path ?? null,
      remotePty: false,
      note: 'agent host: local PTY + ssh attach; path=cwd for FileExplorer'
    })
    return {
      ok: true,
      worktreeId,
      surface: 'worktree',
      remotePty: false,
      // Keep reason name for log filters; identity is agent-scoped now.
      reason: 'botmux-session'
    }
  }

  console.info('[botmux-open]', 'resolve:botmux-main')
  return {
    ok: true,
    worktreeId: BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
    surface: 'worktree',
    remotePty: false,
    reason: 'botmux-main'
  }
}

/**
 * Host without session id (web/relay helpers). Uses shared main Botmux surface.
 */
export async function ensureBotmuxWorkspaceHost(): Promise<BotmuxTabHost> {
  return {
    ok: true,
    worktreeId: BOTMUX_MAIN_TERMINAL_WORKTREE_ID,
    surface: 'worktree',
    remotePty: false,
    reason: 'botmux-main'
  }
}
