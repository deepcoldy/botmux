import { describe, expect, it } from 'vitest'
import {
  orcaBotmuxSessionMatchesQuery,
  buildOrcaBotmuxAgentGroups,
  buildOrcaBotmuxAgentOptions,
  buildOrcaBotmuxHostSections,
  capOrcaBotmuxHostSessions,
  sortOrcaBotmuxSessionsByActivity,
  type BotmuxEndpointLike,
  type OrcaBotmuxSessionLeaf
} from './orca-botmux-session-tree'

function leaf(partial: Partial<OrcaBotmuxSessionLeaf> & { sessionId: string }): OrcaBotmuxSessionLeaf {
  return { hostId: 'local', hostLabel: 'Local', ...partial }
}

function endpoint(partial: Partial<BotmuxEndpointLike> & { id: string }): BotmuxEndpointLike {
  return { ok: true, transport: { kind: 'ssh', label: partial.id }, ...partial }
}

describe('sortOrcaBotmuxSessionsByActivity', () => {
  it('ranks working first, closed last', () => {
    const sorted = sortOrcaBotmuxSessionsByActivity([
      leaf({ sessionId: 'c', status: 'closed', title: 'c' }),
      leaf({ sessionId: 'd', status: 'dormant', title: 'd' }),
      leaf({ sessionId: 'w', status: 'working', title: 'w' }),
      leaf({ sessionId: 'i', status: 'idle', title: 'i' }),
      leaf({ sessionId: 'l', status: 'limited', title: 'l' })
    ])
    expect(sorted.map((s) => s.sessionId)).toEqual(['w', 'i', 'l', 'd', 'c'])
  })

  it('breaks rank ties by updatedAt desc, then title', () => {
    const sorted = sortOrcaBotmuxSessionsByActivity([
      leaf({ sessionId: 'old', status: 'idle', title: 'b', updatedAt: 100 }),
      leaf({ sessionId: 'new', status: 'idle', title: 'a', updatedAt: 200 }),
      leaf({ sessionId: 'no-time', status: 'idle', title: 'a' })
    ])
    expect(sorted.map((s) => s.sessionId)).toEqual(['new', 'old', 'no-time'])
  })

  it('parses ISO updatedAt strings', () => {
    const sorted = sortOrcaBotmuxSessionsByActivity([
      leaf({ sessionId: 'a', status: 'idle', updatedAt: '2026-07-01T00:00:00Z' }),
      leaf({ sessionId: 'b', status: 'idle', updatedAt: '2026-07-20T00:00:00Z' })
    ])
    expect(sorted[0].sessionId).toBe('b')
  })

  it('is fully deterministic for same-title sessions (sessionId tiebreak)', () => {
    const sorted = sortOrcaBotmuxSessionsByActivity([
      leaf({ sessionId: 'sess-b', status: 'idle', title: 'same' }),
      leaf({ sessionId: 'sess-a', status: 'idle', title: 'same' })
    ])
    expect(sorted.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b'])
  })

  it('does not mutate the input array', () => {
    const input = [
      leaf({ sessionId: 'z', status: 'dormant' }),
      leaf({ sessionId: 'a', status: 'working' })
    ]
    sortOrcaBotmuxSessionsByActivity(input)
    expect(input.map((s) => s.sessionId)).toEqual(['z', 'a'])
  })
})

describe('orcaBotmuxSessionMatchesQuery', () => {
  const session = leaf({
    sessionId: 'sess-1',
    title: '@coco-oncall(d2) 你的底层模型',
    botName: 'coco-oncall(d2)',
    cliType: 'coco',
    cwd: '/root/workspace',
    status: 'dormant',
    hostId: 'ssh:d2',
    hostLabel: 'd2'
  })

  it('matches empty query', () => {
    expect(orcaBotmuxSessionMatchesQuery(session, '  ')).toBe(true)
  })

  it('matches title/bot/cli/cwd/status case-insensitively', () => {
    expect(orcaBotmuxSessionMatchesQuery(session, 'COCO')).toBe(true)
    expect(orcaBotmuxSessionMatchesQuery(session, 'workspace')).toBe(true)
    expect(orcaBotmuxSessionMatchesQuery(session, '休眠')).toBe(false) // status matched raw, not translated
    expect(orcaBotmuxSessionMatchesQuery(session, 'dormant')).toBe(true)
  })

  it('matches host label so a host name acts as a host filter', () => {
    expect(orcaBotmuxSessionMatchesQuery(session, 'd2')).toBe(true)
  })

  it('requires every token (AND semantics)', () => {
    expect(orcaBotmuxSessionMatchesQuery(session, 'coco workspace')).toBe(true)
    expect(orcaBotmuxSessionMatchesQuery(session, 'coco missing')).toBe(false)
  })
})

describe('capOrcaBotmuxHostSessions', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => leaf({ sessionId: `s${i}` }))

  it('returns everything when under the cap', () => {
    const { visible, hiddenCount } = capOrcaBotmuxHostSessions(sessions.slice(0, 3), 8)
    expect(visible).toHaveLength(3)
    expect(hiddenCount).toBe(0)
  })

  it('caps and reports the hidden tail', () => {
    const { visible, hiddenCount } = capOrcaBotmuxHostSessions(sessions, 8)
    expect(visible.map((s) => s.sessionId)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
    expect(hiddenCount).toBe(2)
  })

  it('Infinity disables the cap (search results show all)', () => {
    const { visible, hiddenCount } = capOrcaBotmuxHostSessions(sessions, Number.POSITIVE_INFINITY)
    expect(visible).toHaveLength(10)
    expect(hiddenCount).toBe(0)
  })
})

describe('buildOrcaBotmuxAgentOptions', () => {
  it('aggregates sessions per agent with counts', () => {
    const options = buildOrcaBotmuxAgentOptions([
      leaf({ sessionId: '1', botName: 'relay-loopy(d2)', cliType: 'claude-code' }),
      leaf({ sessionId: '2', botName: 'relay-loopy(d2)', cliType: 'claude-code' }),
      leaf({ sessionId: '3', botName: 'coco-oncall(d2)', cliType: 'coco' })
    ])
    expect(options).toHaveLength(2)
    const relay = options.find((o) => o.key === 'claude-code::relay-loopy(d2)')
    expect(relay?.count).toBe(2)
    expect(relay?.label).toBe('relay-loopy(d2) · claude-code')
  })

  it('sorts by count desc, then label; falls back to cli then Other', () => {
    const options = buildOrcaBotmuxAgentOptions([
      leaf({ sessionId: '1', cliType: 'riff' }),
      leaf({ sessionId: '2', botName: 'zeta', cliType: 'coco' }),
      leaf({ sessionId: '3', botName: 'alpha', cliType: 'coco' }),
      leaf({ sessionId: '4' })
    ])
    // Test env has no locale catalog, so translate() yields the 'Other' fallback.
    expect(options.map((o) => o.label)).toEqual(['alpha · coco', 'Other', 'riff', 'zeta · coco'])
  })

  it('carries the first session avatar per agent', () => {
    const options = buildOrcaBotmuxAgentOptions([
      leaf({ sessionId: '1', botName: 'alpha', cliType: 'coco' }),
      leaf({ sessionId: '2', botName: 'alpha', cliType: 'coco', botAvatarUrl: 'https://img/a.png' }),
      leaf({ sessionId: '3', botName: 'beta', cliType: 'coco', botAvatarUrl: 'https://img/b.png' })
    ])
    expect(options.find((o) => o.label === 'alpha · coco')?.avatarUrl).toBe('https://img/a.png')
    expect(options.find((o) => o.label === 'beta · coco')?.avatarUrl).toBe('https://img/b.png')
  })
})

describe('buildOrcaBotmuxAgentGroups', () => {
  it('groups sessions by agent, activity-sorted inside, biggest group first', () => {
    const groups = buildOrcaBotmuxAgentGroups([
      leaf({ sessionId: 'a1', botName: 'alpha', cliType: 'coco', status: 'dormant' }),
      leaf({ sessionId: 'a2', botName: 'alpha', cliType: 'coco', status: 'working' }),
      leaf({ sessionId: 'b1', cliType: 'riff', status: 'idle' })
    ])
    expect(groups.map((g) => g.agentKey)).toEqual(['coco::alpha', 'cli:riff'])
    // working floats above dormant inside the group
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['a2', 'a1'])
    expect(groups[0].label).toBe('alpha · coco')
    expect(groups[1].label).toBe('riff')
  })

  it('uses the same key space as orcaBotmuxAgentLabel (worktree aggregation identity)', () => {
    const groups = buildOrcaBotmuxAgentGroups([
      leaf({ sessionId: 'x', botName: 'relay-loopy(d2)', cliType: 'claude-code' })
    ])
    expect(groups[0].agentKey).toBe('claude-code::relay-loopy(d2)')
  })

  it('exposes the group avatar from the first session that has one', () => {
    const groups = buildOrcaBotmuxAgentGroups([
      leaf({ sessionId: 'x', botName: 'alpha', cliType: 'coco' }),
      leaf({ sessionId: 'y', botName: 'alpha', cliType: 'coco', botAvatarUrl: 'https://img/a.png' })
    ])
    expect(groups[0].avatarUrl).toBe('https://img/a.png')
  })
})

describe('buildOrcaBotmuxHostSections', () => {
  it('groups sessions by host, flattens and activity-sorts them', () => {
    const sections = buildOrcaBotmuxHostSections(
      [endpoint({ id: 'local', transport: { kind: 'local' } })],
      [
        leaf({ sessionId: 'a', status: 'dormant' }),
        leaf({ sessionId: 'b', status: 'working' }),
        leaf({ sessionId: 'c', status: 'closed' })
      ]
    )
    expect(sections).toHaveLength(1)
    expect(sections[0].hostLabel).toBe('Local')
    expect(sections[0].sessions.map((s) => s.sessionId)).toEqual(['b', 'a', 'c'])
    expect(sections[0].workingCount).toBe(1)
  })

  it('keeps endpoint with zero sessions and offline endpoints with message', () => {
    const sections = buildOrcaBotmuxHostSections(
      [
        endpoint({ id: 'ssh:d2', transport: { kind: 'ssh', label: 'd2' } }),
        endpoint({
          id: 'ssh:dead',
          ok: false,
          message: 'SSH connect failed',
          transport: { kind: 'ssh', label: 'dead' }
        })
      ],
      []
    )
    expect(sections.map((s) => s.hostId)).toEqual(['ssh:d2', 'ssh:dead'])
    expect(sections[1].ok).toBe(false)
    expect(sections[1].message).toBe('SSH connect failed')
    expect(sections[1].sessions).toEqual([])
  })

  it('surfaces session-only hosts (endpoint gone) as connected, sorted by label', () => {
    const sections = buildOrcaBotmuxHostSections(
      [endpoint({ id: 'local', transport: { kind: 'local' } })],
      [leaf({ sessionId: 'x', hostId: 'ssh:gone', hostLabel: 'gone' })]
    )
    // No endpoint row → treated as ok, so plain label order applies ('gone' < 'Local').
    expect(sections.map((s) => s.hostId)).toEqual(['ssh:gone', 'local'])
    expect(sections[0].hostLabel).toBe('gone')
  })
})
