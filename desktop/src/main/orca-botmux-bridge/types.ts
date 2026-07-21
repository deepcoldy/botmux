/** Transport for reaching one orca_botmux dashboard control plane. */
export type OrcaBotmuxBridgeTransport =
  | { kind: 'local' }
  | {
      kind: 'ssh'
      /**
       * SSH destination as accepted by system OpenSSH, e.g. `user@host` or Host alias.
       * Optional when `sshTargetId` is set (resolved from Desktop SSH store).
       */
      target?: string
      /** OrcaBotmux/Desktop SSH target id from Settings → SSH (preferred). */
      sshTargetId?: string
      /** Extra OpenSSH argv (e.g. -i, -p) when not using configHost. */
      sshExtraArgs?: string[]
      /** Display label for status UI. */
      label?: string
      /** Remote orca_botmux home (default ~/.orca_botmux on the remote). */
      remoteBotmuxHome?: string
      /** Preferred remote dashboard port if .dashboard-port is missing. */
      remoteDashboardPort?: number
    }
  | {
      /** Central platform reverse-proxy to this machine's dashboard (no SSH). */
      kind: 'platform'
      /** Override base URL; default from ~/.orca_botmux/platform.json machine subdomain. */
      baseUrl?: string
      /** Dashboard token; default from ~/.orca_botmux/.dashboard-token on this machine. */
      token?: string
      label?: string
    }

/** Stable id for a connected control-plane endpoint (local or one SSH host). */
export function botmuxEndpointId(transport: OrcaBotmuxBridgeTransport): string {
  if (transport.kind === 'local') return 'local'
  if (transport.kind === 'platform') {
    return `platform:${transport.baseUrl ?? 'default'}`
  }
  if (transport.sshTargetId) return `ssh:${transport.sshTargetId}`
  const dest = (transport.target ?? '').trim() || 'unknown'
  return `ssh:manual:${dest}`
}

export function botmuxEndpointLabel(transport: OrcaBotmuxBridgeTransport): string {
  if (transport.kind === 'local') return 'Local'
  if (transport.kind === 'platform') return transport.label || 'Platform tunnel'
  return (
    transport.label ||
    transport.target ||
    transport.sshTargetId ||
    'SSH remote'
  )
}

export type OrcaBotmuxBridgeSession = {
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

export type OrcaBotmuxBridgeEndpointStatus = {
  id: string
  transport: OrcaBotmuxBridgeTransport
  ok: boolean
  baseUrl?: string
  sessionCount?: number
  message?: string
  reason?: string
}

/** Aggregate status across all connected endpoints. */
export type OrcaBotmuxBridgeMultiStatus = {
  endpoints: OrcaBotmuxBridgeEndpointStatus[]
  totalSessions: number
  /** @deprecated prefer endpoints[]; kept for older UI that expects single status */
  ok: boolean
  message?: string
  sessionCount: number
}

export type OrcaBotmuxBridgeStatus =
  | {
      ok: true
      transport: OrcaBotmuxBridgeTransport
      baseUrl: string
      sessionCount: number
      message?: string
    }
  | {
      ok: false
      transport: OrcaBotmuxBridgeTransport
      reason: string
      message: string
    }

export type OrcaBotmuxBridgeListResult =
  | {
      ok: true
      sessions: OrcaBotmuxBridgeSession[]
      /** Per-endpoint base URLs for debugging */
      endpoints: Array<{ id: string; label: string; baseUrl: string; ok: boolean }>
    }
  | { ok: false; reason: string; message: string; sessions: OrcaBotmuxBridgeSession[] }

export type OrcaBotmuxBridgeWriteLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: string; message: string }
