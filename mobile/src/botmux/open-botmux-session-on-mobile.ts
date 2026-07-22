/**
 * Open a Botmux Feishu bridge session **on the phone**: resolve a managed
 * worktree, reuse an existing attach tab when possible, otherwise create a
 * terminal that runs `tmux attach` (or `ssh … tmux attach`), then navigate.
 *
 * Desktop-only `botmuxBridge.openTerminal` is intentionally not used here —
 * that path only focuses the Mac app and leaves the simulator with no UI.
 */
import type { RpcClient } from '../transport/rpc-client'
import {
  botmuxBridgeTmuxAttachSpec,
  type BotmuxBridgeSession,
  type BotmuxTmuxAttachSpec
} from './botmux-bridge-rpc'
import {
  botmuxHostIdFromExecutionHost,
  isBotmuxPathInsideOrEqual,
  normalizeBotmuxMatchPath
} from './botmux-session-worktree-match'

export type MobileWorktreeCandidate = {
  worktreeId: string
  path: string
  displayName?: string
  repo?: string
  hostId?: string | null
  isActive?: boolean
}

export type OpenBotmuxSessionOnMobileResult =
  | {
      ok: true
      worktreeId: string
      displayName: string
      sessionPath: string
      attachKind: 'local' | 'ssh'
      /** True when an existing tab was activated instead of a new attach. */
      reused: boolean
      tabId?: string
      command?: string
    }
  | { ok: false; message: string }

type SessionTabSnapshot = {
  id: string
  type: string
  title?: string
  terminal?: string | null
}

function unwrapOk<T extends { ok?: boolean; error?: { message?: string } }>(
  response: T,
  fallback: string
): asserts response is T & { ok: true } {
  if (!response || (response as { ok?: boolean }).ok === false) {
    const message =
      typeof (response as { error?: { message?: string } })?.error?.message === 'string'
        ? (response as { error: { message: string } }).error.message
        : fallback
    throw new Error(message)
  }
}

/** Stable short id used in tmux session names (`bmx-<8 hex>`). */
export function botmuxMobileTmuxSessionName(sessionId: string): string {
  const id = String(sessionId ?? '').trim()
  if (!id) return 'bmx-unknown'
  return `bmx-${id.slice(0, 8)}`
}

/** Tab titles we stamp (and match) so re-open can reuse the same attach tab. */
export function botmuxMobileAttachTabTitle(
  session: Pick<BotmuxBridgeSession, 'sessionId' | 'title'>,
  tmuxSessionName = botmuxMobileTmuxSessionName(session.sessionId)
): string {
  const label = session.title?.trim()
  if (label) {
    // Keep the marker first so OSC title churn still leaves a searchable prefix.
    return `${tmuxSessionName} · ${label}`.slice(0, 80)
  }
  return tmuxSessionName
}

export function findExistingBotmuxAttachTab(
  tabs: readonly SessionTabSnapshot[],
  session: Pick<BotmuxBridgeSession, 'sessionId' | 'title'>,
  tmuxSessionName = botmuxMobileTmuxSessionName(session.sessionId)
): SessionTabSnapshot | null {
  const needle = tmuxSessionName.toLowerCase()
  const sid = session.sessionId.trim().toLowerCase()
  for (const tab of tabs) {
    if (tab.type !== 'terminal') continue
    const title = (tab.title ?? '').toLowerCase()
    if (!title) continue
    if (title.includes(needle)) return tab
    // Why: older opens may have only shown OSC titles that still mention the
    // short session id (tmux status / host label).
    if (sid.length >= 8 && title.includes(sid.slice(0, 8))) return tab
  }
  return null
}

function isBotmuxAgentWorktreeId(worktreeId: string): boolean {
  return worktreeId.startsWith('botmux:agent:')
}

/** Deepest path+host match, or null when nothing matches (no active/first fallback). */
function matchWorktreesBySessionPath(
  session: Pick<BotmuxBridgeSession, 'cwd' | 'hostId'>,
  worktrees: readonly MobileWorktreeCandidate[]
): MobileWorktreeCandidate | null {
  const cwd = session.cwd?.trim()
  if (!cwd || worktrees.length === 0) return null

  const sessionHost = session.hostId
  const matches: MobileWorktreeCandidate[] = []
  for (const wt of worktrees) {
    const wtHost = botmuxHostIdFromExecutionHost(wt.hostId ?? null, null)
    // Why: session.hostId is the bridge endpoint id (`ssh:…` / `local`); map
    // worktree execution host the same way before comparing.
    if (wtHost !== sessionHost && sessionHost !== 'local') {
      // Still allow path match when host metadata is missing on older payloads.
      if (wt.hostId) continue
    }
    if (isBotmuxPathInsideOrEqual(cwd, wt.path)) {
      matches.push(wt)
    }
  }
  if (matches.length === 0) return null
  matches.sort(
    (a, b) => normalizeBotmuxMatchPath(b.path).length - normalizeBotmuxMatchPath(a.path).length
  )
  return matches[0] ?? null
}

/** Prefer deepest path match so sessions under a nested worktree land correctly. */
export function pickWorktreeForBotmuxSession(
  session: Pick<BotmuxBridgeSession, 'cwd' | 'hostId'>,
  worktrees: readonly MobileWorktreeCandidate[],
  preferredWorktreeId?: string | null
): MobileWorktreeCandidate | null {
  if (preferredWorktreeId) {
    const preferred = worktrees.find((w) => w.worktreeId === preferredWorktreeId)
    if (preferred) return preferred
  }

  // Why: prefer botmux agent workspaces over ordinary repo worktrees (e.g. master)
  // when path/host match. Landing a Feishu attach on a shared worktree shows its
  // existing bare tabs next to the attach tab and races desktop auto-create.
  const agentTrees = worktrees.filter((w) => isBotmuxAgentWorktreeId(w.worktreeId))
  const agentMatch = matchWorktreesBySessionPath(session, agentTrees)
  if (agentMatch) return agentMatch

  const pathMatch = matchWorktreesBySessionPath(session, worktrees)
  if (pathMatch) return pathMatch

  if (worktrees.length === 0) return null
  return worktrees.find((w) => w.isActive) ?? worktrees[0] ?? null
}

/**
 * Choose the attach shell for the worktree PTY environment.
 * Remote Botmux worktrees already run on the SSH host → bare `tmux attach`.
 * Local worktrees need the full `ssh -tt … tmux attach` line for remote bots.
 */
export function resolveBotmuxAttachCommandForWorktree(
  attach: Extract<BotmuxTmuxAttachSpec, { ok: true }>,
  worktree: MobileWorktreeCandidate
): string {
  const host = (worktree.hostId ?? '').trim()
  const worktreeIsRemote = host.startsWith('ssh:')
  if (attach.attachKind === 'ssh' && worktreeIsRemote && attach.remoteShellCommand?.trim()) {
    return attach.remoteShellCommand.trim()
  }
  return (attach.shellCommand || attach.remoteShellCommand || '').trim()
}

function buildSessionPath(
  mobileHostId: string,
  worktreeId: string,
  displayName: string,
  tabId?: string
): string {
  const params = new URLSearchParams()
  params.set('name', displayName)
  // Why: session screen uses this to skip empty-session bare auto-create for
  // this visit only — scoped to Botmux open, any worktree id.
  params.set('botmuxOpen', '1')
  if (tabId) params.set('tabId', tabId)
  return `/h/${mobileHostId}/session/${encodeURIComponent(worktreeId)}?${params.toString()}`
}

export async function openBotmuxSessionOnMobile(args: {
  client: Pick<RpcClient, 'sendRequest'>
  /** Mobile paired host id (route `/h/[hostId]/…`). */
  mobileHostId: string
  session: BotmuxBridgeSession
  preferredWorktreeId?: string | null
  /** Optional pre-fetched list; when omitted, loads via `worktree.ps`. */
  worktrees?: readonly MobileWorktreeCandidate[]
}): Promise<OpenBotmuxSessionOnMobileResult> {
  const { client, mobileHostId, session } = args
  try {
    const attach = await botmuxBridgeTmuxAttachSpec(client as RpcClient, {
      sessionId: session.sessionId,
      hostId: session.hostId
    })
    if (!attach.ok) {
      return {
        ok: false,
        message: attach.message || 'Could not build tmux attach command'
      }
    }

    const tmuxSessionName =
      attach.tmuxSessionName?.trim() || botmuxMobileTmuxSessionName(session.sessionId)

    let worktrees = args.worktrees
    if (!worktrees) {
      const listRes = await client.sendRequest('worktree.ps', { limit: 10000 })
      unwrapOk(listRes, 'Failed to list worktrees')
      const result = listRes.result as { worktrees?: MobileWorktreeCandidate[] }
      worktrees = result.worktrees ?? []
    }

    const worktree = pickWorktreeForBotmuxSession(
      session,
      worktrees,
      args.preferredWorktreeId
    )
    if (!worktree) {
      return {
        ok: false,
        message:
          'No managed worktree available on this desktop. Open or create a worktree first, then try again.'
      }
    }

    const displayName =
      session.title?.trim() ||
      worktree.displayName ||
      worktree.repo ||
      session.sessionId.slice(0, 8)

    // Why: notifyClients:false keeps the desktop renderer from focusing this
    // worktree. A full activate on an empty workspace runs the desktop
    // "auto-create first terminal" path and leaves a bare shell beside (or
    // instead of) the tmux attach tab we create next.
    await client.sendRequest('worktree.activate', {
      worktree: `id:${worktree.worktreeId}`,
      notifyClients: false
    })

    // Prefer reuse: listing existing tabs avoids a second `tmux attach` (which
    // can fight the first attach and leave a corrupted phone-fit TUI).
    const listed = await client.sendRequest('session.tabs.list', {
      worktree: `id:${worktree.worktreeId}`
    })
    if (listed.ok) {
      const tabs = ((listed.result as { tabs?: SessionTabSnapshot[] })?.tabs ??
        []) as SessionTabSnapshot[]
      const existing = findExistingBotmuxAttachTab(tabs, session, tmuxSessionName)
      if (existing) {
        await client.sendRequest('session.tabs.activate', {
          worktree: `id:${worktree.worktreeId}`,
          tabId: existing.id,
          notifyClients: false
        })
        return {
          ok: true,
          worktreeId: worktree.worktreeId,
          displayName,
          sessionPath: buildSessionPath(
            mobileHostId,
            worktree.worktreeId,
            displayName,
            existing.id
          ),
          attachKind: attach.attachKind,
          reused: true,
          tabId: existing.id
        }
      }
    }

    const command = resolveBotmuxAttachCommandForWorktree(attach, worktree)
    if (!command) {
      return { ok: false, message: 'Empty attach command from desktop bridge' }
    }

    // Why: mutation id must be unique per open attempt. A stable per-session
    // key (e.g. only sessionId) is kept for ~60s on the host and returns the
    // settled create after the user closes that tab — so re-open would skip a
    // fresh `tmux attach` and navigate to a dead tab.
    const clientMutationId = `botmux-mobile-open:${session.sessionId.slice(0, 8)}:${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    // Why: activate:false — create with activate:true focuses the desktop
    // worktree while the tab graph is still empty/racing, and Terminal.tsx's
    // empty-session auto-create then spawns a bare shell next to our attach.
    const created = await client.sendRequest('session.tabs.createTerminal', {
      worktree: `id:${worktree.worktreeId}`,
      command,
      activate: false,
      clientMutationId
    })
    if (!created.ok) {
      return {
        ok: false,
        message:
          (typeof created.error?.message === 'string' && created.error.message) ||
          'Failed to create terminal'
      }
    }

    const createdTab = (created.result as { tab?: SessionTabSnapshot })?.tab
    const terminalHandle =
      createdTab && typeof createdTab.terminal === 'string' ? createdTab.terminal : null
    const tabId = createdTab?.id

    // Why: stamp a stable title so the next open can find this tab even after
    // Claude/tmux OSC titles replace the default "Terminal N" label.
    if (terminalHandle) {
      try {
        await client.sendRequest('terminal.rename', {
          terminal: terminalHandle,
          title: botmuxMobileAttachTabTitle(session, tmuxSessionName)
        })
      } catch {
        // Rename is best-effort; reuse can still match by short session id.
      }
    }

    // Why: select the attach tab for the phone without telling the desktop
    // renderer to navigate (same notifyClients:false policy as activate above).
    if (tabId) {
      try {
        await client.sendRequest('session.tabs.activate', {
          worktree: `id:${worktree.worktreeId}`,
          tabId,
          notifyClients: false
        })
      } catch {
        // Phone still navigates with tabId; activation is best-effort.
      }
    }

    return {
      ok: true,
      worktreeId: worktree.worktreeId,
      displayName,
      sessionPath: buildSessionPath(mobileHostId, worktree.worktreeId, displayName, tabId),
      attachKind: attach.attachKind,
      reused: false,
      tabId,
      command
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e)
    }
  }
}
