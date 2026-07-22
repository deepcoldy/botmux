/**
 * After app restart, Botmux control-plane tabs must not reattach bare local
 * daemon shells. They spawn local PTYs that run `ssh -tt … tmux attach` once
 * at first open; that startup line is not persisted, so reattach leaves the
 * user in `.cdp-debug-userdata` / `~` with no remote session.
 *
 * Re-queue attach via tmuxAttachSpec before panes mount so fresh spawn runs
 * the shell line again.
 */
import {
  BOTMUX_AGENT_ID_SEPARATOR,
  BOTMUX_AGENT_WORKTREE_PREFIX,
  findBotmuxSessionIdForTab,
  isBotmuxAgentHostId,
  isBotmuxControlPlaneHostId,
  isBotmuxSessionHostId,
  sessionIdFromBotmuxWorktreeId
} from '../../../shared/botmux-main-terminal-host'
import type { TerminalTab } from '../../../shared/types'

export type BotmuxAttachRecoveryTab = Pick<
  TerminalTab,
  'id' | 'botmuxSessionId' | 'quickCommandLabel' | 'title' | 'ptyId'
>

export type TmuxAttachSpecResult =
  | {
      ok: true
      shellCommand: string
      cliShellCommand?: string
      title?: string
      tmuxSessionName?: string
    }
  | { ok: false; reason?: string; message?: string }

export type RecoverBotmuxAttachDeps = {
  queueTabStartupCommand: (tabId: string, startup: { command: string }) => void
  tmuxAttachSpec: (args: {
    sessionId: string
    hostId?: string
  }) => Promise<TmuxAttachSpecResult>
  /**
   * Ensure botmux bridge endpoint is live before tmuxAttachSpec.
   * Startup races often run recovery before reconnectPersisted finishes.
   */
  ensureBridgeEndpoint?: (hostId: string | null) => Promise<void>
  /** Optional: clear layout leaf pty maps so connect does not reattach. */
  clearTabPtyBindings?: (tabId: string) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Parse `ssh:<targetId>` / `local` from `botmux:agent:<encodedHost>~~…`.
 */
export function hostIdFromBotmuxAgentWorktreeId(
  worktreeId: string | null | undefined
): string | null {
  if (!isBotmuxAgentHostId(worktreeId)) return null
  const rest = worktreeId!.slice(BOTMUX_AGENT_WORKTREE_PREFIX.length)
  const sep = rest.indexOf(BOTMUX_AGENT_ID_SEPARATOR)
  const encoded = sep >= 0 ? rest.slice(0, sep) : rest
  if (!encoded) return null
  try {
    const hostId = decodeURIComponent(encoded).trim()
    return hostId || null
  } catch {
    return null
  }
}

/**
 * Resolve bridge hostId for a control-plane worktree.
 */
export function hostIdFromBotmuxControlPlaneWorktreeId(
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) return null
  if (isBotmuxAgentHostId(worktreeId)) {
    return hostIdFromBotmuxAgentWorktreeId(worktreeId)
  }
  if (isBotmuxSessionHostId(worktreeId)) {
    // Session hosts do not embed hostId; caller must supply via meta/API.
    return null
  }
  return null
}

/**
 * From `d2 · bmx-f6a95eed` extract a session-id fragment that maps to the
 * same tmux name (`bmx-${sessionId.slice(0, 8)}`).
 */
export function sessionIdHintFromBotmuxTabLabel(
  label: string | null | undefined
): string | null {
  const t = String(label ?? '').trim()
  if (!t) return null
  const m = t.match(/\bbmx-([0-9a-fA-F]{6,12})\b/)
  if (!m) return null
  return m[1]
}

/**
 * Best-effort session id for attach recovery.
 */
export function resolveBotmuxSessionIdForAttachRecovery(args: {
  worktreeId: string
  tab: BotmuxAttachRecoveryTab
}): string | null {
  const stamped = String(args.tab.botmuxSessionId ?? '').trim()
  if (stamped) return stamped
  const fromMeta = findBotmuxSessionIdForTab(args.worktreeId, args.tab.id)
  if (fromMeta) return fromMeta
  const fromSessionHost = sessionIdFromBotmuxWorktreeId(args.worktreeId)
  if (fromSessionHost) return fromSessionHost
  return (
    sessionIdHintFromBotmuxTabLabel(args.tab.quickCommandLabel) ??
    sessionIdHintFromBotmuxTabLabel(args.tab.title)
  )
}

/**
 * Queue attach startup for control-plane tabs and drop stale local pty ids.
 * Returns tab ids that received a startup command.
 */
export async function recoverBotmuxAttachOnReconnect(args: {
  worktreeId: string
  tabs: readonly BotmuxAttachRecoveryTab[]
  deps: RecoverBotmuxAttachDeps
}): Promise<string[]> {
  if (!isBotmuxControlPlaneHostId(args.worktreeId)) {
    return []
  }
  const hostId = hostIdFromBotmuxControlPlaneWorktreeId(args.worktreeId)
  const recovered: string[] = []
  const sleep = args.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  // Why: startup often calls recovery while botmux-bridge.reconnectPersisted is
  // still in flight. Ensure the SSH endpoint is registered before attach-spec.
  if (args.deps.ensureBridgeEndpoint) {
    try {
      await args.deps.ensureBridgeEndpoint(hostId)
    } catch (err) {
      console.warn(
        '[botmux-recover] ensureBridgeEndpoint failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  for (const tab of args.tabs) {
    const sessionId = resolveBotmuxSessionIdForAttachRecovery({
      worktreeId: args.worktreeId,
      tab
    })
    if (!sessionId) {
      continue
    }
    try {
      let attach = await args.deps.tmuxAttachSpec({
        sessionId,
        ...(hostId ? { hostId } : {})
      })
      // One retry after brief wait — bridge may finish connecting a tick later.
      if (
        !attach.ok &&
        /not connected|Endpoint not connected/i.test(String(attach.message ?? attach.reason ?? ''))
      ) {
        if (args.deps.ensureBridgeEndpoint) {
          try {
            await args.deps.ensureBridgeEndpoint(hostId)
          } catch {
            /* best-effort */
          }
        }
        await sleep(800)
        attach = await args.deps.tmuxAttachSpec({
          sessionId,
          ...(hostId ? { hostId } : {})
        })
      }
      if (!attach.ok) {
        console.warn(
          `[botmux-recover] tmuxAttachSpec failed tab=${tab.id} session=${sessionId}:`,
          attach.message ?? attach.reason
        )
        continue
      }
      const shell = (attach.cliShellCommand ?? attach.shellCommand ?? '').replace(
        /[\r\n]+$/g,
        ''
      )
      if (!shell) {
        continue
      }
      // Why: drop restored daemon session ids so connectPanePty takes FRESH
      // SPAWN with the re-queued startup line instead of REATTACH bare shell.
      args.deps.clearTabPtyBindings?.(tab.id)
      args.deps.queueTabStartupCommand(tab.id, { command: shell })
      recovered.push(tab.id)
      console.info('[botmux-recover] queued attach', {
        tabId: tab.id,
        worktreeId: args.worktreeId,
        sessionId,
        hostId,
        commandLen: shell.length
      })
    } catch (err) {
      console.warn(
        `[botmux-recover] attach recovery failed tab=${tab.id}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return recovered
}

/** Shared bridge ensure used by reconnect + pty-connection recovery. */
export async function ensureBotmuxBridgeEndpointConnected(
  hostId: string | null | undefined
): Promise<void> {
  const bridge = (
    window as unknown as {
      api?: {
        botmuxBridge?: {
          reconnectPersisted?: () => Promise<unknown>
          connectEndpoint?: (transport: {
            kind: 'local' | 'ssh'
            target?: string
            sshTargetId?: string
          }) => Promise<unknown>
          getStatus?: () => Promise<unknown>
        }
      }
    }
  ).api?.botmuxBridge
  if (!bridge) return

  // Prefer full persisted reconnect (matches app startup).
  if (typeof bridge.reconnectPersisted === 'function') {
    await bridge.reconnectPersisted()
  }

  const h = String(hostId ?? '').trim()
  if (!h || h === 'local') return
  if (h.startsWith('ssh:') && typeof bridge.connectEndpoint === 'function') {
    const sshTargetId = h.slice(4).trim()
    if (sshTargetId) {
      await bridge.connectEndpoint({ kind: 'ssh', sshTargetId })
    }
  }
}
