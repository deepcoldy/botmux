/**
 * Presentation helpers for the mobile Botmux sessions screen: status tone,
 * activity sort, host grouping, meta line, query match. Pure + RN-free so the
 * logic stays unit-testable; mirrors the desktop sidebar's rules.
 */
import type { BotmuxBridgeSession } from './botmux-bridge-rpc'

export type BotmuxStatusTone = 'working' | 'active' | 'warning' | 'inactive'

/** Daemon vocabulary: working | analyzing | limited | idle | starting | dormant | closed. */
export function botmuxStatusTone(status: string | undefined): BotmuxStatusTone {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'working':
    case 'starting':
      return 'working'
    case 'analyzing':
    case 'idle':
      return 'active'
    case 'limited':
      return 'warning'
    default:
      return 'inactive'
  }
}

export function isBotmuxSessionClosed(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'closed'
}

const STATUS_LABELS: Record<string, string> = {
  working: 'Working',
  starting: 'Starting',
  analyzing: 'Analyzing',
  idle: 'Idle',
  limited: 'Limited',
  dormant: 'Dormant',
  closed: 'Closed'
}

export function botmuxStatusLabel(status: string | undefined): string {
  const raw = (status ?? '').trim()
  return STATUS_LABELS[raw.toLowerCase()] ?? (raw || 'Unknown')
}

const TONE_RANK: Record<BotmuxStatusTone, number> = {
  working: 0,
  active: 1,
  warning: 2,
  inactive: 3
}

/** Sort rank: live work first; closed sinks below everything. */
export function botmuxActivityRank(status: string | undefined): number {
  if (isBotmuxSessionClosed(status)) return 4
  return TONE_RANK[botmuxStatusTone(status)]
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

/** Activity sort: rank → updatedAt desc → title → sessionId (fully deterministic). */
export function sortBotmuxSessionsByActivity(
  sessions: readonly BotmuxBridgeSession[]
): BotmuxBridgeSession[] {
  return [...sessions].sort((a, b) => {
    const rankDelta = botmuxActivityRank(a.status) - botmuxActivityRank(b.status)
    if (rankDelta !== 0) return rankDelta
    const timeDelta = updatedAtMillis(b.updatedAt) - updatedAtMillis(a.updatedAt)
    if (timeDelta !== 0) return timeDelta
    return (
      (a.title || a.sessionId).localeCompare(b.title || b.sessionId) ||
      a.sessionId.localeCompare(b.sessionId)
    )
  })
}

export type BotmuxHostGroup = {
  hostId: string
  hostLabel: string
  workingCount: number
  sessions: BotmuxBridgeSession[]
}

/** Stable agent identity for a session (same key space as desktop). */
export function botmuxAgentLabel(session: Pick<BotmuxBridgeSession, 'botName' | 'cliType'>): {
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
  return { key: 'unknown', label: 'Other' }
}

export function botmuxSessionAgentKey(
  session: Pick<BotmuxBridgeSession, 'botName' | 'cliType'>
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

/** Agent filter options: one per agent in the visible set, most sessions first. */
export function buildBotmuxAgentOptions(
  sessions: readonly BotmuxBridgeSession[]
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
  avatarUrl?: string
  sessions: BotmuxBridgeSession[]
}

/** Agent-grouped view (desktop's group-by-agent): biggest group first, activity-sorted inside. */
export function buildBotmuxAgentGroups(
  sessions: readonly BotmuxBridgeSession[]
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

/** Group by hostLabel, activity-sorted inside, hosts A→Z (stable across polls). */
export function groupBotmuxSessionsByHost(
  sessions: readonly BotmuxBridgeSession[]
): BotmuxHostGroup[] {
  const byHost = new Map<string, BotmuxBridgeSession[]>()
  for (const s of sessions) {
    const list = byHost.get(s.hostId) ?? []
    list.push(s)
    byHost.set(s.hostId, list)
  }
  return [...byHost.entries()]
    .map(([hostId, list]) => ({
      hostId,
      hostLabel: list[0]?.hostLabel || hostId,
      workingCount: list.filter((s) => botmuxStatusTone(s.status) === 'working').length,
      sessions: sortBotmuxSessionsByActivity(list)
    }))
    .sort((a, b) => a.hostLabel.localeCompare(b.hostLabel))
}

/** Text filter: every token must hit somewhere in the searchable text. */
export function botmuxSessionMatchesQuery(
  session: BotmuxBridgeSession,
  query: string
): boolean {
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

/**
 * Row meta line: agent name (only when the title doesn't already lead with
 * it) · status · repo:branch, falling back to the cwd tail without git info.
 */
export function botmuxSessionMetaLine(session: BotmuxBridgeSession): string {
  const parts: string[] = []
  const title = session.title || session.sessionId.slice(0, 12)
  const bot = session.botName?.trim()
  if (bot && !title.startsWith(`@${bot}`)) parts.push(bot)
  if (session.status?.trim()) parts.push(botmuxStatusLabel(session.status))
  const repoName = session.repoName?.trim()
  if (repoName) {
    parts.push(session.gitBranch ? `${repoName}:${session.gitBranch}` : repoName)
  } else {
    const tail = session.cwd
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .slice(-2)
      .join('/')
    if (tail) parts.push(tail)
  }
  return parts.join(' · ')
}

/** djb2 → hue so a bot name always lands on the same avatar tile color. */
export function botmuxAvatarHue(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}
