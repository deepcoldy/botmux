/**
 * Load SSH hosts for Botmux Sessions from the **same catalog** as Settings → SSH.
 *
 * Order:
 *  1. Best-effort `ssh.importConfig()` so ~/.ssh/config hosts appear (same as SshPane open).
 *  2. `ssh.listTargets()` — authoritative Desktop SSH store.
 *  3. Overlay botmux-connected + botmux status from `botmuxBridge.listSshTargets` when present.
 */
import { buildOpenSshInvocation } from './build-open-ssh-invocation-client'
import type { SshTarget } from '../../../shared/ssh-types'

export type BotmuxSshTargetRow = {
  id: string
  label: string
  destination: string
  host?: string
  configHost?: string
  username?: string
  port?: number
  /** Already linked as a botmux bridge endpoint. */
  botmuxConnected: boolean
  /** Botmux SSH connection status if known. */
  botmuxSshStatus: string | null
  source?: string | null
}

type BridgeListResult = {
  localConnected?: boolean
  platformConnected?: boolean
  sshStoreReady?: boolean
  targets?: Array<{
    id: string
    label: string
    destination: string
    host?: string
    configHost?: string
    username?: string
    port?: number
    connected?: boolean
    botmuxSshStatus?: string | null
    source?: string | null
  }>
}

type WindowSshApi = {
  listTargets?: () => Promise<SshTarget[]>
  importConfig?: () => Promise<unknown>
}

type WindowBridgeApi = {
  listSshTargets?: () => Promise<BridgeListResult>
}

function sshApi(): WindowSshApi | undefined {
  return (window as unknown as { api?: { ssh?: WindowSshApi } }).api?.ssh
}

function bridgeApi(): WindowBridgeApi | undefined {
  return (window as unknown as { api?: { botmuxBridge?: WindowBridgeApi } }).api?.botmuxBridge
}

export async function loadBotmuxSshTargets(opts?: {
  /** When true (default), sync ~/.ssh/config first like Settings → SSH. */
  importConfig?: boolean
}): Promise<{
  targets: BotmuxSshTargetRow[]
  localConnected: boolean
  platformConnected: boolean
}> {
  const ssh = sshApi()
  const bridge = bridgeApi()

  if (opts?.importConfig !== false && ssh?.importConfig) {
    try {
      await ssh.importConfig()
    } catch {
      // Best-effort — listing known targets must still work.
    }
  }

  let fromSsh: SshTarget[] = []
  if (ssh?.listTargets) {
    try {
      fromSsh = (await ssh.listTargets()) ?? []
    } catch {
      fromSsh = []
    }
  }

  let bridgeResult: BridgeListResult = {}
  if (bridge?.listSshTargets) {
    try {
      bridgeResult = (await bridge.listSshTargets()) ?? {}
    } catch {
      bridgeResult = {}
    }
  }

  const bridgeById = new Map((bridgeResult.targets ?? []).map((t) => [t.id, t]))

  const targets: BotmuxSshTargetRow[] = []
  const seen = new Set<string>()

  // Prefer Settings → SSH catalog (same as SshPane).
  for (const t of fromSsh) {
    if (t.owner?.type === 'on-demand-runtime') continue
    const inv = buildOpenSshInvocation(t)
    const bridgeRow = bridgeById.get(t.id)
    seen.add(t.id)
    targets.push({
      id: t.id,
      label: t.label || inv.label,
      destination: inv.destination,
      host: t.host,
      configHost: t.configHost,
      username: t.username,
      port: t.port,
      botmuxConnected: bridgeRow?.connected === true,
      botmuxSshStatus: bridgeRow?.botmuxSshStatus ?? null,
      source: t.source ?? bridgeRow?.source ?? null
    })
  }

  // Fall back / merge bridge-only rows if ssh API empty or incomplete.
  for (const b of bridgeResult.targets ?? []) {
    if (seen.has(b.id)) continue
    seen.add(b.id)
    targets.push({
      id: b.id,
      label: b.label,
      destination: b.destination,
      host: b.host,
      configHost: b.configHost,
      username: b.username,
      port: b.port,
      botmuxConnected: b.connected === true,
      botmuxSshStatus: b.botmuxSshStatus ?? null,
      source: b.source ?? null
    })
  }

  return {
    targets,
    localConnected: bridgeResult.localConnected === true,
    platformConnected: bridgeResult.platformConnected === true
  }
}
