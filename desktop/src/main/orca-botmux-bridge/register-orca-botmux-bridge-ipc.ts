import { ipcMain } from 'electron'
import {
  answerOrcaBotmuxBridgeAsk,
  connectOrcaBotmuxBridgeEndpoint,
  disconnectAllOrcaBotmuxBridgeEndpoints,
  disconnectOrcaBotmuxBridgeEndpoint,
  getOrcaBotmuxBridgeNativeTerminalSpec,
  getOrcaBotmuxBridgeTmuxAttachSpec,
  getOrcaBotmuxBridgeStatus,
  getOrcaBotmuxBridgeTransport,
  getOrcaBotmuxBridgeWriteLink,
  listOrcaBotmuxBridgeEndpoints,
  listOrcaBotmuxBridgePendingAsks,
  listOrcaBotmuxBridgeSessions,
  openOrcaBotmuxBridgeTerminal,
  reconnectPersistedBotmuxEndpoints,
  sendOrcaBotmuxBridgeMessage,
  setOrcaBotmuxBridgeTransport
} from './orca-botmux-bridge-service'
import type { OrcaBotmuxBridgeTransport } from './types'
import { getRegisteredSshState, getSshConnectionStore } from '../ipc/ssh'
import { buildOpenSshInvocation } from './ssh-target-destination'
import {
  describeLocalBotmuxReadiness,
  ensureOrcaBotmuxDesktopWorkspaceDir
} from './orca-botmux-dashboard-client'

export function registerOrcaBotmuxBridgeIpc(): void {
  // ── Multi-endpoint ───────────────────────────────────────────────
  ipcMain.handle('orcaBotmuxBridge:listEndpoints', () => listOrcaBotmuxBridgeEndpoints())

  ipcMain.handle(
    'orcaBotmuxBridge:connectEndpoint',
    async (_e, transport: OrcaBotmuxBridgeTransport) => {
      return await connectOrcaBotmuxBridgeEndpoint(transport)
    }
  )

  ipcMain.handle('orcaBotmuxBridge:disconnectEndpoint', (_e, endpointId: string) => {
    return disconnectOrcaBotmuxBridgeEndpoint(String(endpointId ?? ''))
  })

  ipcMain.handle('orcaBotmuxBridge:disconnectAll', () => {
    disconnectAllOrcaBotmuxBridgeEndpoints()
    return { ok: true as const }
  })

  // ── Legacy single-transport (still used by older UI bits) ────────
  ipcMain.handle('orcaBotmuxBridge:getTransport', () => getOrcaBotmuxBridgeTransport())

  ipcMain.handle('orcaBotmuxBridge:setTransport', async (_e, transport: OrcaBotmuxBridgeTransport) => {
    // Prefer multi-connect semantics: add/refresh without wiping others.
    // Callers that need exclusive mode can disconnectAll first.
    return await connectOrcaBotmuxBridgeEndpoint(transport)
  })

  ipcMain.handle('orcaBotmuxBridge:getStatus', async () => {
    return await getOrcaBotmuxBridgeStatus()
  })

  ipcMain.handle('orcaBotmuxBridge:listSessions', async () => {
    return await listOrcaBotmuxBridgeSessions()
  })

  ipcMain.handle(
    'orcaBotmuxBridge:getWriteLink',
    async (_e, args: string | { sessionId: string; hostId?: string }) => {
      if (typeof args === 'string') {
        return await getOrcaBotmuxBridgeWriteLink(args)
      }
      return await getOrcaBotmuxBridgeWriteLink(String(args?.sessionId ?? ''), args?.hostId)
    }
  )

  ipcMain.handle(
    'orcaBotmuxBridge:openTerminal',
    async (
      _e,
      args: { sessionId: string; hostId?: string; external?: boolean; title?: string } | string
    ) => {
      if (typeof args === 'string') {
        return await openOrcaBotmuxBridgeTerminal(args)
      }
      return await openOrcaBotmuxBridgeTerminal(String(args?.sessionId ?? ''), {
        external: args?.external === true,
        title: args?.title,
        hostId: args?.hostId
      })
    }
  )

  ipcMain.handle(
    'orcaBotmuxBridge:sendMessage',
    async (_e, args: { sessionId: string; botId?: string; text: string; hostId?: string }) => {
      return await sendOrcaBotmuxBridgeMessage({
        sessionId: String(args?.sessionId ?? ''),
        botId: args?.botId,
        text: String(args?.text ?? ''),
        hostId: args?.hostId
      })
    }
  )

  /**
   * List Desktop SSH targets already configured in Settings → SSH
   * (same store as `ssh:listTargets` / ~/.ssh/config import).
   */
  ipcMain.handle('orcaBotmuxBridge:listSshTargets', () => {
    const store = getSshConnectionStore()
    // Same source as Settings → SSH; never invent a second host catalog.
    const targets = store?.listTargets() ?? []
    const connectedIds = new Set(
      listOrcaBotmuxBridgeEndpoints()
        .filter((e) => e.transport.kind === 'ssh' && e.transport.sshTargetId)
        .map((e) => (e.transport.kind === 'ssh' ? e.transport.sshTargetId! : ''))
    )
    const localConnected = listOrcaBotmuxBridgeEndpoints().some((e) => e.id === 'local')
    const platformConnected = listOrcaBotmuxBridgeEndpoints().some((e) =>
      e.id.startsWith('platform:')
    )

    return {
      localConnected,
      platformConnected,
      // Why: 0 means SSH store not ready yet or no hosts — UI can fall back to
      // window.api.ssh.listTargets after importConfig.
      sshStoreReady: store != null,
      targets: targets
        .filter((t) => t.owner?.type !== 'on-demand-runtime')
        .map((t) => {
          const inv = buildOpenSshInvocation(t)
          const orcaState = getRegisteredSshState(t.id)
          return {
            id: t.id,
            label: t.label || inv.label,
            destination: inv.destination,
            host: t.host,
            configHost: t.configHost,
            username: t.username,
            port: t.port,
            /** OrcaBotmux control-plane already connected for this SSH target. */
            connected: connectedIds.has(t.id),
            /** OrcaBotmux SSH session state (Settings → SSH), if any. */
            orcaSshStatus: orcaState?.status ?? null,
            source: t.source ?? null
          }
        })
    }
  })

  // Keep exclusive setTransport for tests if needed via this alias
  ipcMain.handle(
    'orcaBotmuxBridge:replaceAllWithTransport',
    async (_e, transport: OrcaBotmuxBridgeTransport) => {
      return await setOrcaBotmuxBridgeTransport(transport)
    }
  )

  ipcMain.handle('orcaBotmuxBridge:reconnectPersisted', async () => {
    return await reconnectPersistedBotmuxEndpoints()
  })

  ipcMain.handle('orcaBotmuxBridge:listPendingAsks', async () => {
    return await listOrcaBotmuxBridgePendingAsks()
  })

  ipcMain.handle(
    'orcaBotmuxBridge:answerAsk',
    async (
      _e,
      args: { askId: string; selections: string[][]; hostId?: string; larkAppId?: string }
    ) => {
      return await answerOrcaBotmuxBridgeAsk({
        askId: String(args?.askId ?? ''),
        selections: Array.isArray(args?.selections) ? args.selections : [],
        hostId: args?.hostId,
        larkAppId: args?.larkAppId
      })
    }
  )

  ipcMain.handle(
    'orcaBotmuxBridge:nativeTerminalSpec',
    async (_e, args: { sessionId: string; hostId?: string }) => {
      return await getOrcaBotmuxBridgeNativeTerminalSpec({
        sessionId: String(args?.sessionId ?? ''),
        hostId: args?.hostId
      })
    }
  )

  /** Preferred: local/ssh shell → tmux attach (OrcaBotmux-class native terminal). */
  ipcMain.handle(
    'orcaBotmuxBridge:tmuxAttachSpec',
    (_e, args: { sessionId: string; hostId?: string }) => {
      return getOrcaBotmuxBridgeTmuxAttachSpec({
        sessionId: String(args?.sessionId ?? ''),
        hostId: args?.hostId
      })
    }
  )

  ipcMain.handle('orcaBotmuxBridge:localReadiness', () => describeLocalBotmuxReadiness())

  /** Stable folder path for hosting OrcaBotmux session tabs in the main worktree UI. */
  ipcMain.handle('orcaBotmuxBridge:ensureWorkspaceDir', () => ensureOrcaBotmuxDesktopWorkspaceDir())
}
