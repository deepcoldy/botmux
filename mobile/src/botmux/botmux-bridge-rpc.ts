/**
 * Typed wrappers for desktop Botmux bridge RPCs (mobile-allowlisted).
 */
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

export type BotmuxBridgeSession = {
  sessionId: string
  hostId: string
  hostLabel: string
  botId?: string
  botName?: string
  title?: string
  status?: string
  cwd?: string
  cliType?: string
  updatedAt?: number | string
  /** Bot avatar URL (daemon enrichment); absent on older daemons. */
  botAvatarUrl?: string
  /** Repo top-level dir name of cwd, when it is a git repo. */
  repoName?: string
  /** Current branch of cwd; absent for detached HEAD / non-repo. */
  gitBranch?: string
}

export type BotmuxBridgeListSessionsResult =
  | {
      ok: true
      sessions: BotmuxBridgeSession[]
      endpoints: Array<{ id: string; label: string; baseUrl: string; ok: boolean }>
    }
  | {
      ok: false
      reason?: string
      message: string
      sessions: BotmuxBridgeSession[]
    }

export type BotmuxBridgeStatus = {
  ok: boolean
  endpoints: Array<{
    id: string
    ok: boolean
    message?: string
    sessionCount?: number
  }>
  totalSessions?: number
  sessionCount?: number
  message?: string
}

export type BotmuxNativeTerminalSpec =
  | {
      ok: true
      command: string
      args: string[]
      title: string
      writeLinkUrl: string
      electronRunAsNode?: boolean
    }
  | { ok: false; reason?: string; message: string }

export type BotmuxTmuxAttachSpec =
  | {
      ok: true
      attachKind: 'local' | 'ssh'
      tmuxSessionName: string
      shellCommand: string
      remoteShellCommand?: string
      title: string
      sshTargetId?: string
    }
  | { ok: false; reason?: string; message: string }

function unwrapResult<T>(response: RpcResponse): T {
  if (!response.ok) {
    const message =
      typeof response.error?.message === 'string'
        ? response.error.message
        : 'Botmux bridge request failed'
    throw new Error(message)
  }
  return response.result as T
}

export async function botmuxBridgeGetStatus(client: RpcClient): Promise<BotmuxBridgeStatus> {
  const response = await client.sendRequest('botmuxBridge.getStatus')
  return unwrapResult<BotmuxBridgeStatus>(response)
}

export async function botmuxBridgeListSessions(
  client: RpcClient,
  scope?: { worktreePath?: string; botmuxHostId?: string }
): Promise<BotmuxBridgeListSessionsResult> {
  const response = await client.sendRequest('botmuxBridge.listSessions', scope ?? {})
  return unwrapResult<BotmuxBridgeListSessionsResult>(response)
}

export async function botmuxBridgeNativeTerminalSpec(
  client: RpcClient,
  args: { sessionId: string; hostId?: string }
): Promise<BotmuxNativeTerminalSpec> {
  const response = await client.sendRequest('botmuxBridge.nativeTerminalSpec', args)
  return unwrapResult<BotmuxNativeTerminalSpec>(response)
}

export async function botmuxBridgeTmuxAttachSpec(
  client: RpcClient,
  args: { sessionId: string; hostId?: string }
): Promise<BotmuxTmuxAttachSpec> {
  const response = await client.sendRequest('botmuxBridge.tmuxAttachSpec', args)
  return unwrapResult<BotmuxTmuxAttachSpec>(response)
}

export async function botmuxBridgeOpenTerminal(
  client: RpcClient,
  args: { sessionId: string; hostId?: string; title?: string }
): Promise<{ ok: boolean; message?: string; mode?: string }> {
  const response = await client.sendRequest('botmuxBridge.openTerminal', args)
  return unwrapResult(response)
}
