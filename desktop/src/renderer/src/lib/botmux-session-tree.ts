/**
 * Group botmux bridge sessions for the left-sidebar tree:
 *   host (device) → sessions (flat, activity-sorted)
 *
 * Agent identity (bot/cli) intentionally lives on the session row (title +
 * cli badge) instead of a middle tree level — the sidebar is too narrow for
 * host → agent → session nesting.
 */
import { translate } from '@/i18n/i18n'
import {
  botmuxSessionActivityRank,
  botmuxSessionStatusLabel,
  resolveBotmuxSessionStatusTone
} from '@/lib/botmux-session-status'

export type BotmuxSessionLeaf = {
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

export type BotmuxHostSection = {
  hostId: string
  hostLabel: string
  ok: boolean
  message?: string
  /** Sessions currently doing work — surfaced on the host row. */
  workingCount: number
  /** Flat sessions, activity-sorted (working first, closed last). */
  sessions: BotmuxSessionLeaf[]
}

/** Rows shown per host before collapsing the tail behind "N more". */
export const BOTMUX_HOST_SESSION_ROW_CAP = 8

function hostLabelFromEndpoint(e: BotmuxEndpointLike): string {
  if (e.transport.kind === 'local') return translate('settings.botmuxBridge.local', 'Local')
  if (e.transport.kind === 'platform') {
    // Same fallback as main's botmuxEndpointLabel so row label == tab title.
    return e.transport.label || translate('settings.botmuxBridge.platformTunnel', 'Platform tunnel')
  }
  return e.transport.label || e.transport.target || e.id
}

/** Stable agent group key + display label for a botmux session leaf. */
export function botmuxAgentLabel(session: Pick<BotmuxSessionLeaf, 'botName' | 'cliType'>): {
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
  return { key: 'unknown', label: translate('settings.botmuxBridge.agentOther', 'Other') }
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
export function sortBotmuxSessionsByActivity(
  sessions: readonly BotmuxSessionLeaf[]
): BotmuxSessionLeaf[] {
  return [...sessions].sort((a, b) => {
    const rankDelta = botmuxSessionActivityRank(a.status) - botmuxSessionActivityRank(b.status)
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
export function botmuxSessionMatchesQuery(session: BotmuxSessionLeaf, query: string): boolean {
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
export function capBotmuxHostSessions(
  sessions: readonly BotmuxSessionLeaf[],
  cap: number
): { visible: BotmuxSessionLeaf[]; hiddenCount: number } {
  if (sessions.length <= cap) return { visible: [...sessions], hiddenCount: 0 }
  return { visible: sessions.slice(0, cap), hiddenCount: sessions.length - cap }
}

/**
 * Shared session meta line (sidebar tree + right panel): agent name (only
 * when the title doesn't already lead with it) · status · repo:branch,
 * falling back to the cwd tail without git info.
 */
export function botmuxSessionMetaLine(
  s: BotmuxSessionLeaf,
  displayTitle: string
): string {
  const parts: string[] = []
  const bot = s.botName?.trim()
  // Why: titles often already lead with @botName — don't repeat it in meta.
  if (bot && !displayTitle.startsWith(`@${bot}`)) parts.push(bot)
  if (s.status?.trim()) parts.push(botmuxSessionStatusLabel(s.status))
  if (s.repoName) {
    // repo:branch (GitLab-style) replaces the cwd tail once git info exists.
    parts.push(s.gitBranch ? `${s.repoName}:${s.gitBranch}` : s.repoName)
  } else {
    const tail = s.cwd
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .slice(-2)
      .join('/')
    if (tail) parts.push(tail)
  }
  return parts.join(' · ')
}

/** Agent filter key for a session (same identity as botmuxAgentLabel). */
export function botmuxSessionAgentKey(
  session: Pick<BotmuxSessionLeaf, 'botName' | 'cliType'>
): string {
  return botmuxAgentLabel(session).key
}

export type BotmuxAgentOption = {
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
export function buildBotmuxAgentOptions(
  sessions: readonly BotmuxSessionLeaf[]
): BotmuxAgentOption[] {
  const byKey = new Map<string, BotmuxAgentOption>()
  for (const s of sessions) {
    const { key, label } = botmuxAgentLabel(s)
    const option = byKey.get(key) ?? { key, label, count: 0 }
    option.count += 1
    if (!option.avatarUrl && s.botAvatarUrl) option.avatarUrl = s.botAvatarUrl
    byKey.set(key, option)
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
  )
}

export type BotmuxAgentGroup = {
  agentKey: string
  label: string
  /** First session's bot avatar in this group, when known. */
  avatarUrl?: string
  /** Activity-sorted within the group. */
  sessions: BotmuxSessionLeaf[]
}

/**
 * Optional middle tree level (host → agent → sessions) for the sidebar's
 * group-by-agent view. Same agentKey identity as the agent-scoped worktrees
 * that sessions open into (worktreeIdForBotmuxAgent).
 */
export function buildBotmuxAgentGroups(
  sessions: readonly BotmuxSessionLeaf[]
): BotmuxAgentGroup[] {
  const byKey = new Map<string, BotmuxAgentGroup>()
  for (const s of sessions) {
    const { key, label } = botmuxAgentLabel(s)
    let group = byKey.get(key)
    if (!group) {
      group = { agentKey: key, label, sessions: [] }
      byKey.set(key, group)
    }
    if (!group.avatarUrl && s.botAvatarUrl) group.avatarUrl = s.botAvatarUrl
    group.sessions.push(s)
  }
  return [...byKey.values()]
    .map((g) => ({ ...g, sessions: sortBotmuxSessionsByActivity(g.sessions) }))
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
export function buildBotmuxHostSections(
  endpoints: BotmuxEndpointLike[],
  sessions: BotmuxSessionLeaf[]
): BotmuxHostSection[] {
  const byHost = new Map<string, BotmuxSessionLeaf[]>()
  for (const s of sessions) {
    const list = byHost.get(s.hostId) ?? []
    list.push(s)
    byHost.set(s.hostId, list)
  }

  const endpointById = new Map(endpoints.map((e) => [e.id, e]))
  const hostIds = new Set<string>([...endpoints.map((e) => e.id), ...byHost.keys()])

  const hosts: BotmuxHostSection[] = []
  for (const hostId of hostIds) {
    const ep = endpointById.get(hostId)
    const hostSessions = sortBotmuxSessionsByActivity(byHost.get(hostId) ?? [])
    hosts.push({
      hostId,
      hostLabel: ep ? hostLabelFromEndpoint(ep) : hostSessions[0]?.hostLabel || hostId,
      ok: ep?.ok ?? true,
      message: ep?.message,
      workingCount: hostSessions.filter(
        (s) => resolveBotmuxSessionStatusTone(s.status) === 'working'
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
export function isBotmuxTabHostPath(path: string | undefined | null): boolean {
  if (!path) return false
  const n = path.replace(/\\/g, '/')
  return n.endsWith('/.botmux/desktop-workspace') || n.endsWith('.botmux/desktop-workspace')
}

export const BOTMUX_TAB_HOST_DISPLAY_NAME = 'Botmux Sessions'
