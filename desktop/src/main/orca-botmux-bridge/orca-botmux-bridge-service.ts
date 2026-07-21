import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getSshConnectionStore
} from '../ipc/ssh'
import {
  answerPendingAsk,
  fetchPendingAsks,
  type BridgePendingAsk
} from './asks-client'
import {
  fetchDashboardSessions,
  fetchSessionWriteLink,
  resolveLocalDashboardEndpoint,
  triggerSessionTurn,
  type DashboardEndpoint
} from './orca-botmux-dashboard-client'
import { resolvePlatformDashboardEndpoint } from './platform-endpoint'
import {
  clearPersistedBridgeEndpoints,
  loadPersistedBridgeEndpoints,
  removePersistedBridgeEndpoint,
  savePersistedBridgeEndpoints,
  transportForPersist,
  upsertPersistedBridgeEndpoint
} from './endpoint-persistence'
import { openRemoteBotmuxTunnel, type SshTunnelHandle } from './ssh-tunnel'
import { buildOpenSshInvocation } from './ssh-target-destination'
import { openOrcaBotmuxTerminalWindow } from './terminal-window'
import { writeLinkHttpToWorkerWsUrl } from './write-link-to-ws'
import {
  botmuxTmuxSessionName,
  buildLocalTmuxAttachShell,
  buildRemoteTmuxAttachShell,
  buildSshTmuxAttachShell
} from './tmux-attach'
import {
  botmuxEndpointId,
  botmuxEndpointLabel,
  type OrcaBotmuxBridgeEndpointStatus,
  type OrcaBotmuxBridgeListResult,
  type OrcaBotmuxBridgeMultiStatus,
  type OrcaBotmuxBridgeSession,
  type OrcaBotmuxBridgeStatus,
  type OrcaBotmuxBridgeTransport,
  type OrcaBotmuxBridgeWriteLinkResult
} from './types'

type LiveEndpoint = {
  id: string
  transport: OrcaBotmuxBridgeTransport
  endpoint: DashboardEndpoint
  tunnel: SshTunnelHandle | null
  label: string
}

/** Multiple concurrent control planes (local + N SSH remotes). */
const live = new Map<string, LiveEndpoint>()

/**
 * Live tunnels plus **desired-but-offline** hosts from disk, so the sidebar
 * still lists remotes after a cold start / failed reconnect without re-adding.
 */
export function listOrcaBotmuxBridgeEndpoints(): OrcaBotmuxBridgeEndpointStatus[] {
  const liveRows: OrcaBotmuxBridgeEndpointStatus[] = [...live.values()].map((e) => ({
    id: e.id,
    transport: e.transport,
    ok: true,
    baseUrl: e.endpoint.baseUrl,
    message: `${e.label} → ${e.endpoint.baseUrl}`
  }))
  const liveIds = new Set(liveRows.map((e) => e.id))
  const offline: OrcaBotmuxBridgeEndpointStatus[] = loadPersistedBridgeEndpoints()
    .filter((row) => !liveIds.has(row.id))
    .map((row) => ({
      id: row.id,
      transport: row.transport,
      ok: false,
      reason: 'offline',
      message: `${botmuxEndpointLabel(row.transport)} · saved (offline)`
    }))
  return [...liveRows, ...offline]
}

/** @deprecated single-transport API — returns first live or a default local stub. */
export function getOrcaBotmuxBridgeTransport(): OrcaBotmuxBridgeTransport {
  const first = live.values().next().value as LiveEndpoint | undefined
  return first?.transport ?? { kind: 'local' }
}

/**
 * Connect (or refresh) one endpoint without disconnecting others.
 * Idempotent for the same endpoint id.
 *
 * Persistence is **user intent** (desired hosts), not "only tunnels that are
 * up right now". A failed connect/reconnect must not erase the host from disk.
 */
export async function connectOrcaBotmuxBridgeEndpoint(
  transport: OrcaBotmuxBridgeTransport
): Promise<OrcaBotmuxBridgeEndpointStatus> {
  const normalized = await normalizeTransport(transport)
  const id = botmuxEndpointId(normalized)
  const label = botmuxEndpointLabel(normalized)

  // Remember the host as soon as the user (or auto-reconnect) targets it,
  // even if the tunnel fails this attempt — so restart doesn't force re-add.
  upsertPersistedBridgeEndpoint(normalized)

  // Close previous tunnel for this id if reconnecting.
  const prev = live.get(id)
  if (prev?.tunnel) {
    prev.tunnel.close()
  }

  const resolved = await openEndpoint(normalized)
  if (!resolved.ok) {
    live.delete(id)
    // Why: do NOT rewrite the desired list from `live` here — that was wiping
    // saved SSH hosts whenever cold-start reconnect raced SSH readiness.
    return {
      id,
      transport: normalized,
      ok: false,
      reason: resolved.reason,
      message: resolved.message
    }
  }

  live.set(id, {
    id,
    transport: normalized,
    endpoint: resolved.endpoint,
    tunnel: resolved.tunnel,
    label
  })
  // Why: OS Notification for asks must work even when OrcaBotmux sidebar is closed.
  ensureOrcaBotmuxAskBackgroundPoll()

  const list = await fetchDashboardSessions(resolved.endpoint)
  const sessionCount = list.ok ? list.sessions.length : 0
  return {
    id,
    transport: normalized,
    ok: list.ok,
    baseUrl: resolved.endpoint.baseUrl,
    sessionCount,
    message: list.ok
      ? `${label} → ${resolved.endpoint.baseUrl} (${sessionCount} sessions)`
      : list.message,
    reason: list.ok ? undefined : list.reason
  }
}

export function disconnectOrcaBotmuxBridgeEndpoint(endpointId: string): { ok: true } | { ok: false; message: string } {
  const entry = live.get(endpointId)
  if (entry?.tunnel) entry.tunnel.close()
  live.delete(endpointId)
  // Explicit user disconnect — drop from desired list.
  removePersistedBridgeEndpoint(endpointId)
  if (!entry) {
    // Still ok if only persisted-offline: user is clearing a remembered host.
    return { ok: true }
  }
  return { ok: true }
}

export function disconnectAllOrcaBotmuxBridgeEndpoints(): void {
  for (const entry of live.values()) {
    if (entry.tunnel) entry.tunnel.close()
  }
  live.clear()
  clearPersistedBridgeEndpoints()
}

/**
 * Reconnect endpoints saved from the last session. Call after SSH handlers
 * are registered so OrcaBotmux port-forward / connectRegisteredSshTarget work.
 *
 * Failures stay on disk; caller can retry without the user re-adding hosts.
 */
export async function reconnectPersistedBotmuxEndpoints(): Promise<{
  attempted: number
  connected: number
  failures: Array<{ id: string; message: string }>
}> {
  const persisted = loadPersistedBridgeEndpoints()
  const failures: Array<{ id: string; message: string }> = []
  let connected = 0
  for (const row of persisted) {
    try {
      const status = await connectOrcaBotmuxBridgeEndpoint(row.transport)
      if (status.ok) connected += 1
      else failures.push({ id: row.id, message: status.message ?? status.reason ?? 'failed' })
    } catch (error) {
      failures.push({
        id: row.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  // Re-assert the full desired list after reconnect (connect upserts each row;
  // this keeps ordering stable and heals any partial pre-fix files).
  if (persisted.length > 0) {
    savePersistedBridgeEndpoints(
      persisted.map((row) => ({
        id: row.id,
        transport: transportForPersist(row.transport)
      }))
    )
  }
  if (connected > 0) ensureOrcaBotmuxAskBackgroundPoll()
  return { attempted: persisted.length, connected, failures }
}

/**
 * Legacy single-set API: disconnect all, then connect one.
 * Keeps older UI working.
 */
export async function setOrcaBotmuxBridgeTransport(
  transport: OrcaBotmuxBridgeTransport
): Promise<OrcaBotmuxBridgeStatus> {
  disconnectAllOrcaBotmuxBridgeEndpoints()
  const status = await connectOrcaBotmuxBridgeEndpoint(transport)
  if (!status.ok) {
    return {
      ok: false,
      transport: status.transport,
      reason: status.reason ?? 'connect_failed',
      message: status.message ?? 'Connect failed'
    }
  }
  return {
    ok: true,
    transport: status.transport,
    baseUrl: status.baseUrl!,
    sessionCount: status.sessionCount ?? 0,
    message: status.message
  }
}

async function normalizeTransport(
  transport: OrcaBotmuxBridgeTransport
): Promise<OrcaBotmuxBridgeTransport> {
  if (transport.kind === 'local' || transport.kind === 'platform') return transport
  if (transport.kind !== 'ssh') return transport

  if (transport.sshTargetId) {
    const store = getSshConnectionStore()
    const target =
      store?.getTarget(transport.sshTargetId) ??
      store?.listTargets().find((t) => t.id === transport.sshTargetId)
    if (!target) {
      return {
        ...transport,
        target: transport.target ?? '',
        label: transport.label ?? transport.sshTargetId
      }
    }
    const inv = buildOpenSshInvocation(target)
    return {
      kind: 'ssh',
      sshTargetId: target.id,
      target: inv.destination,
      sshExtraArgs: inv.extraArgs,
      label: inv.label,
      remoteBotmuxHome: transport.remoteBotmuxHome,
      remoteDashboardPort: transport.remoteDashboardPort
    }
  }

  return {
    ...transport,
    target: (transport.target ?? '').trim(),
    label: transport.label ?? transport.target
  }
}

async function openEndpoint(
  transport: OrcaBotmuxBridgeTransport
): Promise<
  | { ok: true; endpoint: DashboardEndpoint; tunnel: SshTunnelHandle | null }
  | { ok: false; reason: string; message: string }
> {
  if (transport.kind === 'local') {
    const local = resolveLocalDashboardEndpoint()
    if ('ok' in local && local.ok === false) return local
    return { ok: true, endpoint: local as DashboardEndpoint, tunnel: null }
  }

  if (transport.kind === 'platform') {
    const plat = resolvePlatformDashboardEndpoint(transport)
    if ('ok' in plat && plat.ok === false) return plat
    return { ok: true, endpoint: plat as DashboardEndpoint, tunnel: null }
  }

  // One-click: ensure OrcaBotmux SSH host is connected before preferring port-forward.
  if (transport.sshTargetId) {
    const state = getRegisteredSshState(transport.sshTargetId)
    if (state?.status !== 'connected') {
      try {
        const next = await connectRegisteredSshTarget(transport.sshTargetId)
        if (next.status !== 'connected') {
          console.warn(
            `[orca-botmux-bridge] SSH ${transport.sshTargetId} ended as ${next.status}; falling back to system ssh -L`
          )
        }
      } catch (error) {
        // Still allow system ssh -L (BatchMode) when interactive SSH connect fails.
        console.warn(
          `[orca-botmux-bridge] auto SSH connect failed for ${transport.sshTargetId}:`,
          error instanceof Error ? error.message : error
        )
      }
    }
  }

  const destination = transport.target?.trim()
  if (!destination) {
    return {
      ok: false,
      reason: 'bad_target',
      message:
        'SSH target is empty. Pick a host from Settings → SSH or enter user@host / config Host.'
    }
  }

  const tunneled = await openRemoteBotmuxTunnel({
    target: destination,
    remoteBotmuxHome: transport.remoteBotmuxHome,
    remoteDashboardPort: transport.remoteDashboardPort,
    extraArgs: transport.sshExtraArgs,
    preferOrcaSshTargetId: transport.sshTargetId
  })
  if (!tunneled.ok) return tunneled
  return {
    ok: true,
    endpoint: {
      baseUrl: tunneled.endpoint.baseUrl,
      token: tunneled.endpoint.token,
      transport
    },
    tunnel: tunneled.tunnel
  }
}

function requireEndpoint(
  hostId?: string
): LiveEndpoint | { ok: false; reason: string; message: string } {
  if (hostId) {
    const entry = live.get(hostId)
    if (!entry) {
      return {
        ok: false,
        reason: 'host_not_connected',
        message: `Endpoint not connected: ${hostId}. Connect it in the OrcaBotmux panel first.`
      }
    }
    return entry
  }
  if (live.size === 1) {
    return live.values().next().value as LiveEndpoint
  }
  if (live.size === 0) {
    return {
      ok: false,
      reason: 'no_endpoints',
      message: 'No orca_botmux endpoints connected. Connect Local and/or SSH hosts first.'
    }
  }
  return {
    ok: false,
    reason: 'host_required',
    message: 'Multiple hosts connected — pass hostId for this session action.'
  }
}

export async function getOrcaBotmuxBridgeStatus(): Promise<OrcaBotmuxBridgeMultiStatus> {
  const endpoints: OrcaBotmuxBridgeEndpointStatus[] = []
  let totalSessions = 0
  const liveIds = new Set<string>()

  for (const entry of live.values()) {
    liveIds.add(entry.id)
    const list = await fetchDashboardSessions(entry.endpoint)
    if (list.ok) {
      totalSessions += list.sessions.length
      endpoints.push({
        id: entry.id,
        transport: entry.transport,
        ok: true,
        baseUrl: entry.endpoint.baseUrl,
        sessionCount: list.sessions.length,
        message: `${entry.label} → ${entry.endpoint.baseUrl}`
      })
    } else {
      endpoints.push({
        id: entry.id,
        transport: entry.transport,
        ok: false,
        baseUrl: entry.endpoint.baseUrl,
        reason: list.reason,
        message: `${entry.label}: ${list.message}`
      })
    }
  }

  // Desired hosts that are not live yet (failed reconnect / still connecting).
  for (const row of loadPersistedBridgeEndpoints()) {
    if (liveIds.has(row.id)) continue
    endpoints.push({
      id: row.id,
      transport: row.transport,
      ok: false,
      reason: 'offline',
      message: `${botmuxEndpointLabel(row.transport)} · saved (offline — will retry)`
    })
  }

  if (endpoints.length === 0) {
    return {
      endpoints: [],
      totalSessions: 0,
      ok: false,
      message: 'No endpoints connected',
      sessionCount: 0
    }
  }

  const anyOk = endpoints.some((e) => e.ok)
  return {
    endpoints,
    totalSessions,
    ok: anyOk,
    sessionCount: totalSessions,
    message: endpoints.map((e) => e.message).filter(Boolean).join(' · ')
  }
}

/** @deprecated single-host status shape for older callers */
export async function getOrcaBotmuxBridgeStatusLegacy(): Promise<OrcaBotmuxBridgeStatus> {
  const multi = await getOrcaBotmuxBridgeStatus()
  const first = multi.endpoints[0]
  if (!first) {
    return {
      ok: false,
      transport: { kind: 'local' },
      reason: 'no_endpoints',
      message: multi.message ?? 'No endpoints'
    }
  }
  if (!first.ok) {
    return {
      ok: false,
      transport: first.transport,
      reason: first.reason ?? 'error',
      message: first.message ?? 'Failed'
    }
  }
  return {
    ok: true,
    transport: first.transport,
    baseUrl: first.baseUrl!,
    sessionCount: first.sessionCount ?? 0,
    message: multi.message
  }
}

export async function listOrcaBotmuxBridgeSessions(): Promise<OrcaBotmuxBridgeListResult> {
  if (live.size === 0) {
    return {
      ok: false,
      reason: 'no_endpoints',
      message: 'No orca_botmux endpoints connected',
      sessions: []
    }
  }

  const sessions: OrcaBotmuxBridgeSession[] = []
  const endpointSummaries: Array<{ id: string; label: string; baseUrl: string; ok: boolean }> = []
  let anyOk = false

  for (const entry of live.values()) {
    const list = await fetchDashboardSessions(entry.endpoint)
    if (!list.ok) {
      endpointSummaries.push({
        id: entry.id,
        label: entry.label,
        baseUrl: entry.endpoint.baseUrl,
        ok: false
      })
      continue
    }
    anyOk = true
    endpointSummaries.push({
      id: entry.id,
      label: entry.label,
      baseUrl: list.baseUrl,
      ok: true
    })
    for (const s of list.sessions) {
      sessions.push({
        ...s,
        hostId: entry.id,
        hostLabel: entry.label
      })
    }
  }

  if (!anyOk) {
    return {
      ok: false,
      reason: 'all_failed',
      message: 'All connected endpoints failed to list sessions',
      sessions: []
    }
  }

  return { ok: true, sessions, endpoints: endpointSummaries }
}

export async function getOrcaBotmuxBridgeWriteLink(
  sessionId: string,
  hostId?: string
): Promise<OrcaBotmuxBridgeWriteLinkResult> {
  const entry = requireEndpoint(hostId)
  if ('ok' in entry && entry.ok === false) {
    return { ok: false, reason: entry.reason, message: entry.message }
  }
  return await fetchSessionWriteLink((entry as LiveEndpoint).endpoint, sessionId)
}

export async function openOrcaBotmuxBridgeTerminal(
  sessionId: string,
  opts?: { external?: boolean; title?: string; hostId?: string }
): Promise<
  | { ok: true; url: string; mode: 'in-app' | 'external' }
  | { ok: false; reason: string; message: string }
> {
  const entry = requireEndpoint(opts?.hostId)
  if ('ok' in entry && entry.ok === false) {
    return { ok: false, reason: entry.reason, message: entry.message }
  }
  const liveEntry = entry as LiveEndpoint
  const link = await fetchSessionWriteLink(liveEntry.endpoint, sessionId)
  if (!link.ok) return link

  if (opts?.external) {
    const { shell } = await import('electron')
    await shell.openExternal(link.url)
    return { ok: true, url: link.url, mode: 'external' }
  }

  const opened = await openOrcaBotmuxTerminalWindow({
    url: link.url,
    title: opts?.title ?? `OrcaBotmux · ${liveEntry.label} · ${sessionId}`,
    token: liveEntry.endpoint.token
  })
  if (!opened.ok) {
    const { shell } = await import('electron')
    await shell.openExternal(link.url)
    return { ok: true, url: link.url, mode: 'external' }
  }
  return { ok: true, url: link.url, mode: 'in-app' }
}

export async function sendOrcaBotmuxBridgeMessage(args: {
  sessionId: string
  botId?: string
  text: string
  hostId?: string
}): Promise<
  | { ok: true; triggerId?: string; message?: string }
  | { ok: false; reason: string; message: string }
> {
  const entry = requireEndpoint(args.hostId)
  if ('ok' in entry && entry.ok === false) {
    return { ok: false, reason: entry.reason, message: entry.message }
  }
  return await triggerSessionTurn((entry as LiveEndpoint).endpoint, args)
}

// ─── Ask-hooks ──────────────────────────────────────────────────────

const seenAskIds = new Set<string>()

export async function listOrcaBotmuxBridgePendingAsks(): Promise<{
  ok: boolean
  asks: BridgePendingAsk[]
  message?: string
}> {
  if (live.size === 0) {
    return { ok: false, asks: [], message: 'No endpoints connected' }
  }
  const asks: BridgePendingAsk[] = []
  for (const entry of live.values()) {
    const r = await fetchPendingAsks(entry.endpoint, {
      hostId: entry.id,
      hostLabel: entry.label
    })
    if (r.ok) asks.push(...r.asks)
  }
  // System notifications for newly seen asks
  for (const ask of asks) {
    if (seenAskIds.has(ask.askId)) continue
    seenAskIds.add(ask.askId)
    try {
      const { Notification } = await import('electron')
      if (Notification.isSupported()) {
        const prompt = ask.questions[0]?.prompt ?? 'Agent needs your input'
        const n = new Notification({
          title: `OrcaBotmux ask · ${ask.hostLabel}`,
          body: prompt.slice(0, 180),
          silent: false
        })
        n.show()
      }
    } catch {
      /* notifications optional */
    }
  }
  // Prune seen set to current ids
  const liveIds = new Set(asks.map((a) => a.askId))
  for (const id of [...seenAskIds]) {
    if (!liveIds.has(id)) seenAskIds.delete(id)
  }
  return { ok: true, asks }
}

export async function answerOrcaBotmuxBridgeAsk(args: {
  askId: string
  selections: string[][]
  hostId?: string
  larkAppId?: string
}): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const entry = requireEndpoint(args.hostId)
  if ('ok' in entry && entry.ok === false) {
    return { ok: false, reason: entry.reason, message: entry.message }
  }
  return await answerPendingAsk((entry as LiveEndpoint).endpoint, {
    askId: args.askId,
    selections: args.selections,
    larkAppId: args.larkAppId
  })
}

/**
 * Build a command line for OrcaBotmux native PTY that relays worker web-terminal WS.
 * Renderer should createTerminal with this command when preferring native xterm.
 * Always use Electron as Node (`ELECTRON_RUN_AS_NODE=1` in the shell wrapper).
 */
export function buildNativeTerminalRelayCommand(wsUrl: string): {
  command: string
  args: string[]
  electronRunAsNode: boolean
  cwd?: string
} {
  // Lazy require keeps this module loadable in unit contexts without Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronApp = require('electron').app as import('electron').App
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // Packaged vs dev: scripts live next to project root in dev.
  const packaged = path.join(process.resourcesPath, 'orca-botmux-term-relay.mjs')
  const dev = path.join(electronApp.getAppPath(), 'scripts', 'orca-botmux-term-relay.mjs')
  const script =
    electronApp.isPackaged && fs.existsSync(packaged)
      ? packaged
      : fs.existsSync(dev)
        ? dev
        : packaged
  return {
    // Why: packaged Electron app has no system node guarantee; RUN_AS_NODE uses
    // the same binary the app already shipped.
    command: process.execPath,
    args: [script, wsUrl],
    electronRunAsNode: true
  }
}

export async function getOrcaBotmuxBridgeNativeTerminalSpec(args: {
  sessionId: string
  hostId?: string
}): Promise<
  | {
      ok: true
      command: string
      args: string[]
      title: string
      writeLinkUrl: string
      electronRunAsNode: boolean
    }
  | { ok: false; reason: string; message: string }
> {
  const link = await getOrcaBotmuxBridgeWriteLink(args.sessionId, args.hostId)
  if (!link.ok) return link
  const converted = writeLinkHttpToWorkerWsUrl(link.url)
  if (!converted.ok) {
    return { ok: false, reason: converted.reason, message: converted.message }
  }
  const spec = buildNativeTerminalRelayCommand(converted.wsUrl)
  return {
    ok: true,
    command: spec.command,
    args: spec.args,
    electronRunAsNode: spec.electronRunAsNode,
    title: `OrcaBotmux · ${args.sessionId.slice(0, 8)}`,
    writeLinkUrl: link.url
  }
}

/**
 * Preferred native open: OrcaBotmux terminal tab runs local/ssh shell that
 * `tmux attach`s the orca_botmux worker session (same as OrcaBotmux remote terminal).
 *
 * Shell lines intentionally avoid bare `exec` so attach failures (no session,
 * Permission denied) leave the PTY alive with an error instead of flash/black.
 *
 * For SSH:
 *  - `remoteShellCommand` — run inside an OrcaBotmux SSH PTY (connectionId worktree)
 *  - `shellCommand` / `cliShellCommand` — local `ssh -tt … tmux attach` fallback
 *    with full IdentityFile/port/jump from Settings → SSH
 */
export function getOrcaBotmuxBridgeTmuxAttachSpec(args: {
  sessionId: string
  hostId?: string
}):
  | {
      ok: true
      attachKind: 'local' | 'ssh'
      tmuxSessionName: string
      /** Primary shell line for the tab (local tmux, or system ssh -tt for SSH). */
      shellCommand: string
      /**
       * When set, renderer should prefer opening an OrcaBotmux SSH-backed worktree
       * tab and run this command on the remote shell (no nested system ssh).
       */
      remoteShellCommand: string
      title: string
      sshTargetId?: string
      destination?: string
      cliShellCommand?: string
    }
  | { ok: false; reason: string; message: string } {
  const sessionId = String(args.sessionId ?? '').trim()
  if (!sessionId) {
    return { ok: false, reason: 'bad_session', message: 'sessionId is required' }
  }
  const entry = requireEndpoint(args.hostId)
  if ('ok' in entry && entry.ok === false) {
    return { ok: false, reason: entry.reason, message: entry.message }
  }
  const liveEntry = entry as LiveEndpoint
  const tmuxSessionName = botmuxTmuxSessionName(sessionId)
  const title = `${liveEntry.label} · ${tmuxSessionName}`
  const transport = liveEntry.transport

  if (transport.kind === 'local') {
    const line = buildLocalTmuxAttachShell(tmuxSessionName)
    return {
      ok: true,
      attachKind: 'local',
      tmuxSessionName,
      shellCommand: line,
      remoteShellCommand: line,
      title
    }
  }

  if (transport.kind === 'ssh') {
    // Re-resolve from SSH store so IdentityFile/user/port are current.
    let destination = (transport.target ?? '').trim()
    let extraArgs = transport.sshExtraArgs ?? []
    if (transport.sshTargetId) {
      const store = getSshConnectionStore()
      const target =
        store?.getTarget(transport.sshTargetId) ??
        store?.listTargets().find((t) => t.id === transport.sshTargetId)
      if (target) {
        const inv = buildOpenSshInvocation(target)
        destination = inv.destination
        extraArgs = inv.extraArgs
      }
    }
    if (!destination) {
      return {
        ok: false,
        reason: 'bad_target',
        message: 'SSH endpoint has no destination for tmux attach'
      }
    }
    const cliShellCommand = buildSshTmuxAttachShell(destination, extraArgs, tmuxSessionName)
    const remoteShellCommand = buildRemoteTmuxAttachShell(tmuxSessionName)
    return {
      ok: true,
      attachKind: 'ssh',
      tmuxSessionName,
      // Default CLI path until renderer upgrades to prefer OrcaBotmux remote PTY.
      shellCommand: cliShellCommand,
      remoteShellCommand,
      cliShellCommand,
      title,
      sshTargetId: transport.sshTargetId,
      destination
    }
  }

  // platform tunnel: no shell SSH path — caller should use write-link Web.
  return {
    ok: false,
    reason: 'use_web',
    message: 'Platform hosts have no SSH attach path; open Web terminal instead.'
  }
}

// ─── Background ask poll (OS notifications even when panel closed) ─

let askPollTimer: ReturnType<typeof setInterval> | null = null

/** Start (or keep) a main-process poller that surfaces OS notifications for new asks. */
export function ensureOrcaBotmuxAskBackgroundPoll(intervalMs = 15_000): void {
  if (askPollTimer) return
  askPollTimer = setInterval(() => {
    if (live.size === 0) return
    void listOrcaBotmuxBridgePendingAsks().catch(() => {
      /* swallow — panel refresh will surface errors */
    })
  }, intervalMs)
  // Unref so this timer does not keep the process alive alone (if supported).
  if (typeof askPollTimer === 'object' && askPollTimer && 'unref' in askPollTimer) {
    try {
      ;(askPollTimer as NodeJS.Timeout).unref()
    } catch {
      /* ignore */
    }
  }
}

export function stopOrcaBotmuxAskBackgroundPoll(): void {
  if (askPollTimer) {
    clearInterval(askPollTimer)
    askPollTimer = null
  }
}
