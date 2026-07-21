/**
 * HTTP client for a orca_botmux dashboard control plane (local or tunneled).
 * Self-contained: does not import the root orca_botmux package (separate install).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaBotmuxBridgeSession, OrcaBotmuxBridgeTransport } from './types'

/** Single-endpoint session list (no hostId yet — service stamps hostId). */
export type SingleHostSessionList =
  | { ok: true; baseUrl: string; sessions: Omit<OrcaBotmuxBridgeSession, 'hostId' | 'hostLabel'>[]; transport: OrcaBotmuxBridgeTransport }
  | { ok: false; transport: OrcaBotmuxBridgeTransport; reason: string; message: string }

export type DashboardEndpoint = {
  baseUrl: string
  token: string | null
  transport: OrcaBotmuxBridgeTransport
}

export function defaultLocalBotmuxHome(home = homedir()): string {
  return join(home, '.orca_botmux')
}

/**
 * Stable local folder used as an OrcaBotmux worktree host for OrcaBotmux sessions
 * so Web/PTY tabs open in the main workspace without "Add Project" first.
 */
export function defaultBotmuxDesktopWorkspaceDir(home = homedir()): string {
  return join(defaultLocalBotmuxHome(home), 'desktop-workspace')
}

/** Ensure `~/.orca_botmux/desktop-workspace` exists; return absolute path. */
export function ensureOrcaBotmuxDesktopWorkspaceDir(home = homedir()): {
  path: string
  created: boolean
} {
  const path = defaultBotmuxDesktopWorkspaceDir(home)
  const created = !existsSync(path)
  mkdirSync(path, { recursive: true })
  return { path, created }
}

/** Operator-facing hint when local orca_botmux is not running. */
export function describeLocalBotmuxReadiness(
  botmuxHome = defaultLocalBotmuxHome()
): {
  ready: boolean
  port: number | null
  hasToken: boolean
  message: string
} {
  const portPath = join(botmuxHome, '.dashboard-port')
  const tokenPath = join(botmuxHome, '.dashboard-token')
  const hasToken = existsSync(tokenPath) && Boolean(readFileSync(tokenPath, 'utf8').trim())
  if (!existsSync(portPath)) {
    return {
      ready: false,
      port: null,
      hasToken,
      message:
        'Local orca_botmux dashboard is not running. In a terminal: `orca_botmux start` (or `pnpm daemon:restart` from the orca_botmux checkout), then Connect Local.'
    }
  }
  const port = Number(readFileSync(portPath, 'utf8').trim())
  if (!Number.isFinite(port) || port <= 0) {
    return {
      ready: false,
      port: null,
      hasToken,
      message: `Invalid port in ${portPath}`
    }
  }
  return {
    ready: true,
    port,
    hasToken,
    message: `Local dashboard on port ${port}${hasToken ? '' : ' (no .dashboard-token yet — open dashboard once)'}`
  }
}

export function resolveLocalDashboardEndpoint(
  botmuxHome = defaultLocalBotmuxHome()
): DashboardEndpoint | { ok: false; reason: string; message: string } {
  const portPath = join(botmuxHome, '.dashboard-port')
  const tokenPath = join(botmuxHome, '.dashboard-token')
  if (!existsSync(portPath)) {
    return {
      ok: false,
      reason: 'no_dashboard_port',
      message: `No dashboard port file at ${portPath}. Start orca_botmux daemon/dashboard first.`
    }
  }
  const port = Number(readFileSync(portPath, 'utf8').trim())
  if (!Number.isFinite(port) || port <= 0) {
    return {
      ok: false,
      reason: 'bad_dashboard_port',
      message: `Invalid dashboard port in ${portPath}`
    }
  }
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() || null : null
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    transport: { kind: 'local' }
  }
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {}
  // Cookie is the dashboard browser auth path; ?t= also works on many routes.
  return {
    Cookie: `orca_botmux_dashboard_token=${token}`,
    Authorization: `Bearer ${token}`
  }
}

export async function fetchDashboardSessions(
  endpoint: DashboardEndpoint
): Promise<SingleHostSessionList> {
  const url = new URL('/api/sessions', endpoint.baseUrl)
  if (endpoint.token) url.searchParams.set('t', endpoint.token)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(endpoint.token)
      }
    })
  } catch (error) {
    return {
      ok: false,
      transport: endpoint.transport,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : 'Dashboard unreachable'
    }
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      transport: endpoint.transport,
      reason: 'unauthorized',
      message: 'Dashboard rejected auth. Rotate token with `orca_botmux dashboard` or check .dashboard-token.'
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      transport: endpoint.transport,
      reason: 'http_error',
      message: `GET /api/sessions → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    }
  }

  const data = (await res.json().catch(() => null)) as unknown
  const sessions = normalizeSessions(data, endpoint)
  return {
    ok: true,
    transport: endpoint.transport,
    baseUrl: endpoint.baseUrl,
    sessions
  }
}

export async function triggerSessionTurn(
  endpoint: DashboardEndpoint,
  args: { sessionId: string; botId?: string; text: string }
): Promise<
  | { ok: true; triggerId?: string; message?: string }
  | { ok: false; reason: string; message: string }
> {
  const text = args.text.trim()
  if (!text) {
    return { ok: false, reason: 'empty', message: 'Message text is empty' }
  }
  const url = new URL('/api/trigger', endpoint.baseUrl)
  if (endpoint.token) url.searchParams.set('t', endpoint.token)

  const body = {
    source: { type: 'ui', requestId: `desktop_${Date.now()}` },
    target: {
      kind: 'turn',
      sessionId: args.sessionId,
      ...(args.botId ? { botId: args.botId } : {})
    },
    envelope: {
      format: 'text',
      sourceName: 'orca-botmux-desktop',
      trusted: false,
      rawText: text
    },
    instruction: text
  }

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...authHeaders(endpoint.token)
      },
      body: JSON.stringify(body)
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : 'Dashboard unreachable'
    }
  }

  const raw = await res.text().catch(() => '')
  let parsed: { ok?: boolean; triggerId?: string; message?: string; error?: string } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* non-json */
  }
  if (!res.ok || parsed.ok === false) {
    return {
      ok: false,
      reason: 'trigger_failed',
      message: parsed.error || parsed.message || `trigger HTTP ${res.status}: ${raw.slice(0, 200)}`
    }
  }
  return {
    ok: true,
    triggerId: parsed.triggerId,
    message: parsed.message
  }
}

export async function fetchSessionWriteLink(
  endpoint: DashboardEndpoint,
  sessionId: string
): Promise<{ ok: true; url: string } | { ok: false; reason: string; message: string }> {
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/write-link`, endpoint.baseUrl)
  if (endpoint.token) url.searchParams.set('t', endpoint.token)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(endpoint.token)
      }
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : 'Dashboard unreachable'
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      reason: 'http_error',
      message: `write-link HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    }
  }
  const body = (await res.json().catch(() => ({}))) as {
    url?: string
    writeUrl?: string
    token?: string
  }
  let link = body.url ?? body.writeUrl
  if (!link) {
    return { ok: false, reason: 'malformed', message: 'write-link response missing url' }
  }
  // Why: browser tabs in the worktree webview may not share the dashboard
  // cookie partition. Ensure the write-link carries an explicit token when we
  // know the dashboard bearer so Terminal open never lands unauthenticated.
  link = ensureUrlAuthToken(link, endpoint.token ?? body.token ?? null)
  return { ok: true, url: link }
}

/** Append ?t= / &t= or ?token= if the write-link has no credential query yet. */
export function ensureUrlAuthToken(url: string, token: string | null): string {
  if (!token) return url
  try {
    const u = new URL(url)
    if (
      u.searchParams.has('t') ||
      u.searchParams.has('token') ||
      u.searchParams.has('writeToken') ||
      u.searchParams.has('viewToken')
    ) {
      return url
    }
    u.searchParams.set('t', token)
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}t=${encodeURIComponent(token)}`
  }
}

function normalizeSessions(
  data: unknown,
  endpoint: DashboardEndpoint
): Omit<OrcaBotmuxBridgeSession, 'hostId' | 'hostLabel'>[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { sessions?: unknown }).sessions)
      ? ((data as { sessions: unknown[] }).sessions)
      : []

  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const sessionId = String(r.sessionId ?? r.id ?? '')
      if (!sessionId) return null
      const webPort = typeof r.webPort === 'number' ? r.webPort : undefined
      const proxyPort = typeof r.proxyPort === 'number' ? r.proxyPort : undefined
      let terminalUrl: string | null = null
      if (typeof r.webUrl === 'string') terminalUrl = r.webUrl
      else if (proxyPort || webPort) {
        const port = proxyPort ?? webPort
        terminalUrl = `http://127.0.0.1:${port}/s/${encodeURIComponent(sessionId)}`
        if (endpoint.token) terminalUrl += `?t=${encodeURIComponent(endpoint.token)}`
      }
      // Dashboard composeRowFromActive uses `workingDir` + `cliId` (not cwd/cliType).
      const cwdRaw =
        typeof r.workingDir === 'string'
          ? r.workingDir
          : typeof r.cwd === 'string'
            ? r.cwd
            : typeof r.workDir === 'string'
              ? r.workDir
              : undefined
      const cliRaw =
        typeof r.cliId === 'string'
          ? r.cliId
          : typeof r.cliType === 'string'
            ? r.cliType
            : typeof r.cli === 'string'
              ? r.cli
              : undefined
      return {
        sessionId,
        botId: typeof r.botId === 'string' ? r.botId : typeof r.appId === 'string' ? r.appId : undefined,
        botName: typeof r.botName === 'string' ? r.botName : undefined,
        title: typeof r.title === 'string' ? r.title : typeof r.name === 'string' ? r.name : undefined,
        status: typeof r.status === 'string' ? r.status : undefined,
        cwd: cwdRaw && cwdRaw.trim() ? cwdRaw.trim() : undefined,
        cliType: cliRaw && cliRaw !== 'unknown' ? cliRaw : undefined,
        botAvatarUrl: typeof r.botAvatarUrl === 'string' && r.botAvatarUrl.trim() ? r.botAvatarUrl.trim() : undefined,
        repoName: typeof r.repoName === 'string' && r.repoName.trim() ? r.repoName.trim() : undefined,
        gitBranch: typeof r.gitBranch === 'string' && r.gitBranch.trim() ? r.gitBranch.trim() : undefined,
        updatedAt: (r.updatedAt ?? r.lastActiveAt ?? r.createdAt ?? r.lastMessageAt) as
          | number
          | string
          | undefined,
        webPort,
        proxyPort,
        terminalUrl
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
}
