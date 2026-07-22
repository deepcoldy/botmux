/** Transport for reaching one botmux dashboard control plane. */
export type BotmuxBridgeTransport =
  | { kind: 'local' }
  | {
      kind: 'ssh'
      /**
       * SSH destination as accepted by system OpenSSH, e.g. `user@host` or Host alias.
       * Optional when `sshTargetId` is set (resolved from Desktop SSH store).
       */
      target?: string
      /** Botmux/Desktop SSH target id from Settings → SSH (preferred). */
      sshTargetId?: string
      /** Extra OpenSSH argv (e.g. -i, -p) when not using configHost. */
      sshExtraArgs?: string[]
      /** Display label for status UI. */
      label?: string
      /** Remote botmux home (default ~/.botmux on the remote). */
      remoteBotmuxHome?: string
      /** Preferred remote dashboard port if .dashboard-port is missing. */
      remoteDashboardPort?: number
    }
  | {
      /** Central platform reverse-proxy to this machine's dashboard (no SSH). */
      kind: 'platform'
      /** Override base URL; default from ~/.botmux/platform.json machine subdomain. */
      baseUrl?: string
      /** Dashboard token; default from ~/.botmux/.dashboard-token on this machine. */
      token?: string
      label?: string
    }

/** Stable id for a connected control-plane endpoint (local or one SSH host). */
export function botmuxEndpointId(transport: BotmuxBridgeTransport): string {
  if (transport.kind === 'local') return 'local'
  if (transport.kind === 'platform') {
    return `platform:${transport.baseUrl ?? 'default'}`
  }
  if (transport.sshTargetId) return `ssh:${transport.sshTargetId}`
  const dest = (transport.target ?? '').trim() || 'unknown'
  return `ssh:manual:${dest}`
}

export function botmuxEndpointLabel(transport: BotmuxBridgeTransport): string {
  if (transport.kind === 'local') return 'Local'
  if (transport.kind === 'platform') return transport.label || 'Platform tunnel'
  return (
    transport.label ||
    transport.target ||
    transport.sshTargetId ||
    'SSH remote'
  )
}

export type BotmuxBridgeSession = {
  sessionId: string
  /** Which connected endpoint this session came from. */
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
  webPort?: number
  proxyPort?: number
  /** Best-effort terminal open URL (may require auth cookie / token). */
  terminalUrl?: string | null
}

export type BotmuxBridgeEndpointStatus = {
  id: string
  transport: BotmuxBridgeTransport
  ok: boolean
  baseUrl?: string
  sessionCount?: number
  message?: string
  reason?: string
}

/** Aggregate status across all connected endpoints. */
export type BotmuxBridgeMultiStatus = {
  endpoints: BotmuxBridgeEndpointStatus[]
  totalSessions: number
  /** @deprecated prefer endpoints[]; kept for older UI that expects single status */
  ok: boolean
  message?: string
  sessionCount: number
}

export type BotmuxBridgeStatus =
  | {
      ok: true
      transport: BotmuxBridgeTransport
      baseUrl: string
      sessionCount: number
      message?: string
    }
  | {
      ok: false
      transport: BotmuxBridgeTransport
      reason: string
      message: string
    }

export type BotmuxBridgeListResult =
  | {
      ok: true
      sessions: BotmuxBridgeSession[]
      /** Per-endpoint base URLs for debugging */
      endpoints: Array<{ id: string; label: string; baseUrl: string; ok: boolean }>
    }
  | { ok: false; reason: string; message: string; sessions: BotmuxBridgeSession[] }

export type BotmuxBridgeWriteLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: string; message: string }
