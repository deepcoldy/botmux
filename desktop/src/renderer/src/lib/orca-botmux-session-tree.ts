/**
 * Group orca_botmux bridge sessions for the left-sidebar tree:
 *   host (device) → sessions (flat, activity-sorted)
 *
 * Agent identity (bot/cli) intentionally lives on the session row (title +
 * cli badge) instead of a middle tree level — the sidebar is too narrow for
 * host → agent → session nesting.
 */
import { translate } from '@/i18n/i18n'
import {
  orcaBotmuxSessionActivityRank,
  resolveOrcaBotmuxSessionStatusTone
} from '@/lib/orca-botmux-session-status'

export type OrcaBotmuxSessionLeaf = {
  sessionId: string
  hostId: string
  hostLabel: string
  botId?: string
  botName?: string
  title?: string
  status?: string
  cliType?: string
  cwd?: string
  /** Last daemon-side activity (epoch ms or ISO string); drives activity sort. */
  updatedAt?: number | string
  /** Bot avatar URL (daemon enrichment); absent on older daemons. */
  botAvatarUrl?: string
  /** Repo top-level dir name of cwd, when it is a git repo. */
  repoName?: string
  /** Current branch of cwd; absent for detached HEAD / non-repo. */
  gitBranch?: string
}

export type BotmuxEndpointLike = {
  id: string
  ok: boolean
  sessionCount?: number
  /** Connect error for offline endpoints (shown as host-row tooltip). */
  message?: string
  transport: {
    kind: 'local' | 'ssh' | 'platform'
    label?: string
    target?: string
  }
}

export type OrcaBotmuxHostSection = {
  hostId: string
  hostLabel: string
  ok: boolean
  message?: string
  /** Sessions currently doing work — surfaced on the host row. */
  workingCount: number
  /** Flat sessions, activity-sorted (working first, closed last). */
  sessions: OrcaBotmuxSessionLeaf[]
}

/** Rows shown per host before collapsing the tail behind "N more". */
export const ORCA_BOTMUX_HOST_SESSION_ROW_CAP = 8

function hostLabelFromEndpoint(e: BotmuxEndpointLike): string {
  if (e.transport.kind === 'local') return translate('settings.orcaBotmuxBridge.local', 'Local')
  if (e.transport.kind === 'platform') {
    // Same fallback as main's botmuxEndpointLabel so row label == tab title.
    return e.transport.label || translate('settings.orcaBotmuxBridge.platformTunnel', 'Platform tunnel')
  }
  return e.transport.label || e.transport.target || e.id
}

/** Stable agent group key + display label for a orca_botmux session leaf. */
export function orcaBotmuxAgentLabel(session: Pick<OrcaBotmuxSessionLeaf, 'botName' | 'cliType'>): {
  key: string
  label: string
} {
  const name = session.botName?.trim()
  const cli = session.cliType?.trim()
  if (name && cli && name.toLowerCase() !== cli.toLowerCase()) {
    return { key: `${cli}::${name}`, label: `${name} · ${cli}` }
  }
  if (name) return { key: `bot:${name}`, label: name }
  if (cli) return { key: `cli:${cli}`, label: cli }
  return { key: 'unknown', label: translate('settings.orcaBotmuxBridge.agentOther', 'Other') }
}

function updatedAtMillis(updatedAt: number | string | undefined): number {
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt
  if (typeof updatedAt === 'string') {
    const asNumber = Number(updatedAt)
    if (Number.isFinite(asNumber) && updatedAt.trim() !== '') return asNumber
    const parsed = Date.parse(updatedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Activity sort: live work floats up (working → active → warning → inactive →
 * closed), then most-recently-updated, then title for stability.
 */
export function sortOrcaBotmuxSessionsByActivity(
  sessions: readonly OrcaBotmuxSessionLeaf[]
): OrcaBotmuxSessionLeaf[] {
  return [...sessions].sort((a, b) => {
    const rankDelta = orcaBotmuxSessionActivityRank(a.status) - orcaBotmuxSessionActivityRank(b.status)
    if (rankDelta !== 0) return rankDelta
    const timeDelta = updatedAtMillis(b.updatedAt) - updatedAtMillis(a.updatedAt)
    if (timeDelta !== 0) return timeDelta
    // Why: full tiebreak down to sessionId — daemon list order can shift
    // between polls, and same-title rows must not swap visually.
    return (
      (a.title || a.sessionId).localeCompare(b.title || b.sessionId) ||
      a.sessionId.localeCompare(b.sessionId)
    )
  })
}

/**
 * Text filter for the tree: every whitespace-separated token must hit
 * somewhere in the session's searchable text (AND semantics, VS Code style).
 * hostLabel is included so typing a host name "filters by host".
 */
export function orcaBotmuxSessionMatchesQuery(session: OrcaBotmuxSessionLeaf, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = [
    session.title,
    session.sessionId,
    session.botName,
    session.cliType,
    session.cwd,
    session.hostLabel,
    session.status
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** Cap a host's visible sessions; searching bypasses the cap (caller passes Infinity). */
export function capOrcaBotmuxHostSessions(
  sessions: readonly OrcaBotmuxSessionLeaf[],
  cap: number
): { visible: OrcaBotmuxSessionLeaf[]; hiddenCount: number } {
  if (sessions.length <= cap) return { visible: [...sessions], hiddenCount: 0 }
  return { visible: sessions.slice(0, cap), hiddenCount: sessions.length - cap }
}

/** Agent filter key for a session (same identity as orcaBotmuxAgentLabel). */
export function orcaBotmuxSessionAgentKey(
  session: Pick<OrcaBotmuxSessionLeaf, 'botName' | 'cliType'>
): string {
  return orcaBotmuxAgentLabel(session).key
}

export type OrcaBotmuxAgentOption = {
  key: string
  label: string
  count: number
  /** First session's bot avatar in this agent set, when known. */
  avatarUrl?: string
}

/**
 * Agent filter options for the sidebar filter menu: one entry per agent
 * present in the given (visible) session set, most sessions first.
 */
export function buildOrcaBotmuxAgentOptions(
  sessions: readonly OrcaBotmuxSessionLeaf[]
): OrcaBotmuxAgentOption[] {
  const byKey = new Map<string, OrcaBotmuxAgentOption>()
  for (const s of sessions) {
    const { key, label } = orcaBotmuxAgentLabel(s)
    const option = byKey.get(key) ?? { key, label, count: 0 }
    option.count += 1
    if (!option.avatarUrl && s.botAvatarUrl) option.avatarUrl = s.botAvatarUrl
    byKey.set(key, option)
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
  )
}

export type OrcaBotmuxAgentGroup = {
  agentKey: string
  label: string
  /** First session's bot avatar in this group, when known. */
  avatarUrl?: string
  /** Activity-sorted within the group. */
  sessions: OrcaBotmuxSessionLeaf[]
}

/**
 * Optional middle tree level (host → agent → sessions) for the sidebar's
 * group-by-agent view. Same agentKey identity as the agent-scoped worktrees
 * that sessions open into (worktreeIdForOrcaBotmuxAgent).
 */
export function buildOrcaBotmuxAgentGroups(
  sessions: readonly OrcaBotmuxSessionLeaf[]
): OrcaBotmuxAgentGroup[] {
  const byKey = new Map<string, OrcaBotmuxAgentGroup>()
  for (const s of sessions) {
    const { key, label } = orcaBotmuxAgentLabel(s)
    let group = byKey.get(key)
    if (!group) {
      group = { agentKey: key, label, sessions: [] }
      byKey.set(key, group)
    }
    if (!group.avatarUrl && s.botAvatarUrl) group.avatarUrl = s.botAvatarUrl
    group.sessions.push(s)
  }
  return [...byKey.values()]
    .map((g) => ({ ...g, sessions: sortOrcaBotmuxSessionsByActivity(g.sessions) }))
    .sort(
      (a, b) =>
        b.sessions.length - a.sessions.length ||
        a.label.localeCompare(b.label) ||
        a.agentKey.localeCompare(b.agentKey)
    )
}

/**
 * Build the sidebar host sections: one per connected endpoint (plus any host
 * that only exists via sessions), sessions flattened + activity-sorted.
 * Connected hosts first, then alphabetical — stable across polls.
 */
export function buildOrcaBotmuxHostSections(
  endpoints: BotmuxEndpointLike[],
  sessions: OrcaBotmuxSessionLeaf[]
): OrcaBotmuxHostSection[] {
  const byHost = new Map<string, OrcaBotmuxSessionLeaf[]>()
  for (const s of sessions) {
    const list = byHost.get(s.hostId) ?? []
    list.push(s)
    byHost.set(s.hostId, list)
  }

  const endpointById = new Map(endpoints.map((e) => [e.id, e]))
  const hostIds = new Set<string>([...endpoints.map((e) => e.id), ...byHost.keys()])

  const hosts: OrcaBotmuxHostSection[] = []
  for (const hostId of hostIds) {
    const ep = endpointById.get(hostId)
    const hostSessions = sortOrcaBotmuxSessionsByActivity(byHost.get(hostId) ?? [])
    hosts.push({
      hostId,
      hostLabel: ep ? hostLabelFromEndpoint(ep) : hostSessions[0]?.hostLabel || hostId,
      ok: ep?.ok ?? true,
      message: ep?.message,
      workingCount: hostSessions.filter(
        (s) => resolveOrcaBotmuxSessionStatusTone(s.status) === 'working'
      ).length,
      sessions: hostSessions
    })
  }

  return hosts.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return a.hostLabel.localeCompare(b.hostLabel)
  })
}

/** Path marker for the silent tab-host folder (not shown as a real project). */
export function isOrcaBotmuxTabHostPath(path: string | undefined | null): boolean {
  if (!path) return false
  const n = path.replace(/\\/g, '/')
  return n.endsWith('/.orca_botmux/desktop-workspace') || n.endsWith('.orca_botmux/desktop-workspace')
}

export const ORCA_BOTMUX_TAB_HOST_DISPLAY_NAME = 'OrcaBotmux Sessions'
