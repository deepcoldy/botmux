/**
 * Mobile / runtime RPC surface for the Botmux Feishu Botmux bridge.
 * Thin wrappers around the main-process bridge service (same as desktop IPC).
 */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  getBotmuxBridgeNativeTerminalSpec,
  getBotmuxBridgeStatus,
  getBotmuxBridgeTmuxAttachSpec,
  listBotmuxBridgeEndpoints,
  listBotmuxBridgeSessions,
  openBotmuxBridgeTerminal
} from '../../../botmux-bridge/botmux-bridge-service'
import { applyBotmuxSessionWorktreeScope } from '../../../../shared/botmux-session-worktree-match'

const OptionalString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === 'string' ? v : undefined))
  .optional()

const ListSessionsParams = z
  .object({
    /** When set with botmuxHostId, only sessions under this path are returned. */
    worktreePath: OptionalString,
    /** Bridge host id (`local` | `ssh:…`) for worktree scope matching. */
    botmuxHostId: OptionalString
  })
  .optional()
  .default({})

const SessionHostParams = z.object({
  sessionId: z.string().min(1),
  hostId: OptionalString
})

const OpenTerminalParams = z.object({
  sessionId: z.string().min(1),
  hostId: OptionalString,
  external: z.boolean().optional(),
  title: OptionalString
})

/**
 * Pure post-process for listSessions RPC (unit-tested without live tunnels).
 */
export function shapeBotmuxBridgeListSessionsResult(
  list: Awaited<ReturnType<typeof listBotmuxBridgeSessions>>,
  scope?: { worktreePath?: string; botmuxHostId?: string }
): Awaited<ReturnType<typeof listBotmuxBridgeSessions>> {
  if (!list.ok) return list
  const sessions = applyBotmuxSessionWorktreeScope(list.sessions, scope ?? null)
  return {
    ...list,
    sessions
  }
}

export const BOTMUX_BRIDGE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'botmuxBridge.getStatus',
    params: null,
    handler: async () => {
      return await getBotmuxBridgeStatus()
    }
  }),
  defineMethod({
    name: 'botmuxBridge.listEndpoints',
    params: null,
    handler: () => {
      return listBotmuxBridgeEndpoints()
    }
  }),
  defineMethod({
    name: 'botmuxBridge.listSessions',
    params: ListSessionsParams,
    handler: async (params) => {
      const list = await listBotmuxBridgeSessions()
      return shapeBotmuxBridgeListSessionsResult(list, {
        worktreePath: params?.worktreePath,
        botmuxHostId: params?.botmuxHostId
      })
    }
  }),
  defineMethod({
    name: 'botmuxBridge.nativeTerminalSpec',
    params: SessionHostParams,
    handler: async (params) => {
      return await getBotmuxBridgeNativeTerminalSpec({
        sessionId: params.sessionId,
        hostId: params.hostId
      })
    }
  }),
  defineMethod({
    name: 'botmuxBridge.tmuxAttachSpec',
    params: SessionHostParams,
    handler: (params) => {
      return getBotmuxBridgeTmuxAttachSpec({
        sessionId: params.sessionId,
        hostId: params.hostId
      })
    }
  }),
  defineMethod({
    name: 'botmuxBridge.openTerminal',
    params: OpenTerminalParams,
    handler: async (params) => {
      // Why: opens on the paired desktop (Electron window/tab). Mobile uses this
      // so the phone can trigger attach on the desk machine while also showing
      // nativeTerminalSpec for local display when needed.
      return await openBotmuxBridgeTerminal(params.sessionId, {
        external: params.external === true,
        title: params.title,
        hostId: params.hostId
      })
    }
  })
]
