import { ipcMain } from 'electron'
import {
  answerBotmuxBridgeAsk,
  connectBotmuxBridgeEndpoint,
  disconnectAllBotmuxBridgeEndpoints,
  disconnectBotmuxBridgeEndpoint,
  getBotmuxBridgeNativeTerminalSpec,
  getBotmuxBridgeTmuxAttachSpec,
  getBotmuxBridgeStatus,
  getBotmuxBridgeTransport,
  getBotmuxBridgeWriteLink,
  listBotmuxBridgeEndpoints,
  listBotmuxBridgePendingAsks,
  listBotmuxBridgeSessions,
  openBotmuxBridgeTerminal,
  reconnectPersistedBotmuxEndpoints,
  sendBotmuxBridgeMessage,
  setBotmuxBridgeTransport
} from './botmux-bridge-service'
import type { BotmuxBridgeTransport } from './types'
import { getRegisteredSshState, getSshConnectionStore } from '../ipc/ssh'
import { buildOpenSshInvocation } from './ssh-target-destination'
import {
  describeLocalBotmuxReadiness,
  ensureBotmuxDesktopWorkspaceDir
} from './botmux-dashboard-client'

export function registerBotmuxBridgeIpc(): void {
  // ── Multi-endpoint ───────────────────────────────────────────────
  ipcMain.handle('botmuxBridge:listEndpoints', () => listBotmuxBridgeEndpoints())

  ipcMain.handle(
    'botmuxBridge:connectEndpoint',
    async (_e, transport: BotmuxBridgeTransport) => {
      return await connectBotmuxBridgeEndpoint(transport)
    }
  )

  ipcMain.handle('botmuxBridge:disconnectEndpoint', (_e, endpointId: string) => {
    return disconnectBotmuxBridgeEndpoint(String(endpointId ?? ''))
  })

  ipcMain.handle('botmuxBridge:disconnectAll', () => {
    disconnectAllBotmuxBridgeEndpoints()
    return { ok: true as const }
  })

  // ── Legacy single-transport (still used by older UI bits) ────────
  ipcMain.handle('botmuxBridge:getTransport', () => getBotmuxBridgeTransport())

  ipcMain.handle('botmuxBridge:setTransport', async (_e, transport: BotmuxBridgeTransport) => {
    // Prefer multi-connect semantics: add/refresh without wiping others.
    // Callers that need exclusive mode can disconnectAll first.
    return await connectBotmuxBridgeEndpoint(transport)
  })

  ipcMain.handle('botmuxBridge:getStatus', async () => {
    return await getBotmuxBridgeStatus()
  })

  ipcMain.handle('botmuxBridge:listSessions', async () => {
    return await listBotmuxBridgeSessions()
  })

  ipcMain.handle(
    'botmuxBridge:getWriteLink',
    async (_e, args: string | { sessionId: string; hostId?: string }) => {
      if (typeof args === 'string') {
        return await getBotmuxBridgeWriteLink(args)
      }
      return await getBotmuxBridgeWriteLink(String(args?.sessionId ?? ''), args?.hostId)
    }
  )

  ipcMain.handle(
    'botmuxBridge:openTerminal',
    async (
      _e,
      args: { sessionId: string; hostId?: string; external?: boolean; title?: string } | string
    ) => {
      if (typeof args === 'string') {
        return await openBotmuxBridgeTerminal(args)
      }
      return await openBotmuxBridgeTerminal(String(args?.sessionId ?? ''), {
        external: args?.external === true,
        title: args?.title,
        hostId: args?.hostId
      })
    }
  )

  ipcMain.handle(
    'botmuxBridge:sendMessage',
    async (_e, args: { sessionId: string; botId?: string; text: string; hostId?: string }) => {
      return await sendBotmuxBridgeMessage({
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
  ipcMain.handle('botmuxBridge:listSshTargets', () => {
    const store = getSshConnectionStore()
    // Same source as Settings → SSH; never invent a second host catalog.
    const targets = store?.listTargets() ?? []
    const connectedIds = new Set(
      listBotmuxBridgeEndpoints()
        .filter((e) => e.transport.kind === 'ssh' && e.transport.sshTargetId)
        .map((e) => (e.transport.kind === 'ssh' ? e.transport.sshTargetId! : ''))
    )
    const localConnected = listBotmuxBridgeEndpoints().some((e) => e.id === 'local')
    const platformConnected = listBotmuxBridgeEndpoints().some((e) =>
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
          const botmuxState = getRegisteredSshState(t.id)
          return {
            id: t.id,
            label: t.label || inv.label,
            destination: inv.destination,
            host: t.host,
            configHost: t.configHost,
            username: t.username,
            port: t.port,
            /** Botmux control-plane already connected for this SSH target. */
            connected: connectedIds.has(t.id),
            /** Botmux SSH session state (Settings → SSH), if any. */
            botmuxSshStatus: botmuxState?.status ?? null,
            source: t.source ?? null
          }
        })
    }
  })

  // Keep exclusive setTransport for tests if needed via this alias
  ipcMain.handle(
    'botmuxBridge:replaceAllWithTransport',
    async (_e, transport: BotmuxBridgeTransport) => {
      return await setBotmuxBridgeTransport(transport)
    }
  )

  ipcMain.handle('botmuxBridge:reconnectPersisted', async () => {
    return await reconnectPersistedBotmuxEndpoints()
  })

  ipcMain.handle('botmuxBridge:listPendingAsks', async () => {
    return await listBotmuxBridgePendingAsks()
  })

  ipcMain.handle(
    'botmuxBridge:answerAsk',
    async (
      _e,
      args: { askId: string; selections: string[][]; hostId?: string; larkAppId?: string }
    ) => {
      return await answerBotmuxBridgeAsk({
        askId: String(args?.askId ?? ''),
        selections: Array.isArray(args?.selections) ? args.selections : [],
        hostId: args?.hostId,
        larkAppId: args?.larkAppId
      })
    }
  )

  ipcMain.handle(
    'botmuxBridge:nativeTerminalSpec',
    async (_e, args: { sessionId: string; hostId?: string }) => {
      return await getBotmuxBridgeNativeTerminalSpec({
        sessionId: String(args?.sessionId ?? ''),
        hostId: args?.hostId
      })
    }
  )

  /** Preferred: local/ssh shell → tmux attach (Botmux-class native terminal). */
  ipcMain.handle(
    'botmuxBridge:tmuxAttachSpec',
    (_e, args: { sessionId: string; hostId?: string }) => {
      return getBotmuxBridgeTmuxAttachSpec({
        sessionId: String(args?.sessionId ?? ''),
        hostId: args?.hostId
      })
    }
  )

  ipcMain.handle('botmuxBridge:localReadiness', () => describeLocalBotmuxReadiness())

  /** Stable folder path for hosting Botmux session tabs in the main worktree UI. */
  ipcMain.handle('botmuxBridge:ensureWorkspaceDir', () => ensureBotmuxDesktopWorkspaceDir())
}
