import { describe, expect, it } from 'vitest'
import {
  botmuxActivityRank,
  botmuxAvatarHue,
  botmuxAgentLabel,
  botmuxSessionMatchesQuery,
  botmuxSessionMetaLine,
  botmuxStatusTone,
  buildBotmuxAgentGroups,
  buildBotmuxAgentOptions,
  groupBotmuxSessionsByHost,
  sortBotmuxSessionsByActivity
} from './botmux-session-presentation'
import type { BotmuxBridgeSession } from './botmux-bridge-rpc'

function leaf(partial: Partial<BotmuxBridgeSession> & { sessionId: string }): BotmuxBridgeSession {
  return { hostId: 'local', hostLabel: 'Local', ...partial }
}

describe('botmuxStatusTone / botmuxActivityRank', () => {
  it('maps daemon vocabulary to tones and ranks live work first', () => {
    expect(botmuxStatusTone('working')).toBe('working')
    expect(botmuxStatusTone('idle')).toBe('active')
    expect(botmuxStatusTone('limited')).toBe('warning')
    expect(botmuxStatusTone('dormant')).toBe('inactive')
    expect(botmuxActivityRank('working')).toBeLessThan(botmuxActivityRank('idle'))
    expect(botmuxActivityRank('idle')).toBeLessThan(botmuxActivityRank('dormant'))
    expect(botmuxActivityRank('closed')).toBeGreaterThan(botmuxActivityRank('dormant'))
  })
})

describe('sortBotmuxSessionsByActivity', () => {
  it('ranks working first, closed last, deterministic for ties', () => {
    const sorted = sortBotmuxSessionsByActivity([
      leaf({ sessionId: 'b', status: 'idle', title: 'same' }),
      leaf({ sessionId: 'c', status: 'closed' }),
      leaf({ sessionId: 'a', status: 'idle', title: 'same' }),
      leaf({ sessionId: 'w', status: 'working' })
    ])
    expect(sorted.map((s) => s.sessionId)).toEqual(['w', 'a', 'b', 'c'])
  })
})

describe('groupBotmuxSessionsByHost', () => {
  it('groups by host with working counts and sorted labels', () => {
    const groups = groupBotmuxSessionsByHost([
      leaf({ sessionId: '1', hostId: 'ssh:d2', hostLabel: 'd2', status: 'working' }),
      leaf({ sessionId: '2', hostId: 'ssh:d2', hostLabel: 'd2', status: 'idle' }),
      leaf({ sessionId: '3', hostId: 'local', hostLabel: 'Local', status: 'idle' })
    ])
    expect(groups.map((g) => g.hostLabel)).toEqual(['d2', 'Local'])
    expect(groups[0].workingCount).toBe(1)
    expect(groups[0].sessions).toHaveLength(2)
  })
})

describe('botmuxSessionMatchesQuery', () => {
  it('matches across title/bot/host with AND semantics', () => {
    const s = leaf({
      sessionId: 'x',
      title: '@relay-loopy(d2) 用我的身份',
      botName: 'relay-loopy(d2)',
      hostLabel: 'd2',
      cwd: '/root/workspace/botmux'
    })
    expect(botmuxSessionMatchesQuery(s, 'relay workspace')).toBe(true)
    expect(botmuxSessionMatchesQuery(s, 'relay missing')).toBe(false)
    expect(botmuxSessionMatchesQuery(s, '  ')).toBe(true)
  })
})

describe('botmuxSessionMetaLine', () => {
  it('shows agent + status + repo:branch', () => {
    const meta = botmuxSessionMetaLine(
      leaf({
        sessionId: 'x',
        title: '看看代码',
        botName: 'coco-oncall(d2)',
        status: 'idle',
        repoName: 'botmux',
        gitBranch: 'feat/x'
      })
    )
    expect(meta).toBe('coco-oncall(d2) · Idle · botmux:feat/x')
  })

  it('dedupes agent name already leading the title, falls back to cwd tail', () => {
    const meta = botmuxSessionMetaLine(
      leaf({
        sessionId: 'x',
        title: '@relay-loopy(d2) hey',
        botName: 'relay-loopy(d2)',
        status: 'dormant',
        cwd: '/root/workspace/botmux'
      })
    )
    expect(meta).toBe('Dormant · workspace/botmux')
  })
})

describe('botmuxAgentLabel / buildBotmuxAgentOptions / buildBotmuxAgentGroups', () => {
  it('derives the same agent identity as desktop', () => {
    expect(botmuxAgentLabel({ botName: 'relay-loopy(d2)', cliType: 'claude-code' })).toEqual({
      key: 'claude-code::relay-loopy(d2)',
      label: 'relay-loopy(d2) · claude-code'
    })
    expect(botmuxAgentLabel({ cliType: 'riff' }).key).toBe('cli:riff')
    expect(botmuxAgentLabel({}).key).toBe('unknown')
  })

  it('options aggregate counts and carry the first avatar', () => {
    const options = buildBotmuxAgentOptions([
      leaf({ sessionId: '1', botName: 'alpha', cliType: 'coco' }),
      leaf({ sessionId: '2', botName: 'alpha', cliType: 'coco', botAvatarUrl: 'https://img/a.png' }),
      leaf({ sessionId: '3', cliType: 'riff' })
    ])
    const alpha = options.find((o) => o.label === 'alpha · coco')
    expect(alpha?.count).toBe(2)
    expect(alpha?.avatarUrl).toBe('https://img/a.png')
  })

  it('groups are activity-sorted inside, biggest first', () => {
    const groups = buildBotmuxAgentGroups([
      leaf({ sessionId: 'a1', botName: 'alpha', cliType: 'coco', status: 'dormant' }),
      leaf({ sessionId: 'a2', botName: 'alpha', cliType: 'coco', status: 'working' }),
      leaf({ sessionId: 'b1', cliType: 'riff', status: 'idle' })
    ])
    expect(groups.map((g) => g.agentKey)).toEqual(['coco::alpha', 'cli:riff'])
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['a2', 'a1'])
  })
})

describe('botmuxAvatarHue', () => {
  it('is deterministic and in range', () => {
    expect(botmuxAvatarHue('relay-loopy(d2)')).toBe(botmuxAvatarHue('relay-loopy(d2)'))
    expect(botmuxAvatarHue('relay-loopy(d2)')).not.toBe(botmuxAvatarHue('codex(d2)'))
    expect(botmuxAvatarHue('x')).toBeGreaterThanOrEqual(0)
    expect(botmuxAvatarHue('x')).toBeLessThan(360)
  })
})
