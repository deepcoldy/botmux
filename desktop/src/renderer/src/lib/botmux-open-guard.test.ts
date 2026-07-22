import { describe, expect, it, beforeEach } from 'vitest'
import {
  botmuxOpenGuardKey,
  clearBotmuxAttachInFlightForTest,
  decideBotmuxAttachTabAction,
  decideBotmuxSessionOpenAction,
  getBotmuxAttachInFlightKeysForTest,
  isBareLocalShellTabTitle,
  isReusableBotmuxAttachTab,
  runBotmuxAttachOpenExclusive
} from './botmux-open-guard'

describe('botmuxOpenGuardKey', () => {
  it('combines mode and session id', () => {
    expect(botmuxOpenGuardKey(' sess-1 ', 'attach')).toBe('attach:sess-1')
  })
})

describe('isBareLocalShellTabTitle / isReusableBotmuxAttachTab', () => {
  it('treats ~ / empty as bare local shell (failed attach leftover)', () => {
    expect(isBareLocalShellTabTitle('~')).toBe(true)
    expect(isBareLocalShellTabTitle('')).toBe(true)
    expect(isBareLocalShellTabTitle('  ')).toBe(true)
    expect(isBareLocalShellTabTitle('$')).toBe(true)
  })

  it('treats post-restart local userData / shell titles as bare', () => {
    expect(isBareLocalShellTabTitle('..ebug-userdata')).toBe(true)
    expect(isBareLocalShellTabTitle('.cdp-debug-userdata')).toBe(true)
    expect(isBareLocalShellTabTitle('shell')).toBe(true)
  })

  it('does not treat product attach titles as bare', () => {
    expect(isBareLocalShellTabTitle('d2 · bmx-e2e9b0d1')).toBe(false)
    expect(isBareLocalShellTabTitle('root@10.37.200.253')).toBe(false)
  })

  it('refuses reuse without ptyId or with bare local title', () => {
    expect(
      isReusableBotmuxAttachTab({
        ptyId: null,
        title: 'd2 · bmx-e2e9b0d1',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(false)
    expect(
      isReusableBotmuxAttachTab({
        ptyId: 'botmux:session:x@@abc',
        title: '~',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(false)
  })

  it('reuses live tabs that still look attached', () => {
    expect(
      isReusableBotmuxAttachTab({
        ptyId: 'botmux:session:x@@abc',
        title: 'd2 · bmx-e2e9b0d1',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(true)
    expect(
      isReusableBotmuxAttachTab({
        ptyId: 'botmux:session:x@@abc',
        title: 'root@10.37.200.253',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(true)
  })

  it('refuses reuse when OSC title is bare local userdata after restart', () => {
    expect(
      isReusableBotmuxAttachTab({
        ptyId: 'botmux:agent:ssh%3Assh-1~~agent@@abc',
        title: '..ebug-userdata',
        tmuxSessionName: 'bmx-f6a95eed'
      })
    ).toBe(false)
  })
})

describe('decideBotmuxSessionOpenAction bare-local force re-attach', () => {
  it('closes bound bare local shell instead of reusing', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'f6a95eed-full',
        boundTabId: 'tab-1',
        tmuxSessionName: 'bmx-f6a95eed',
        hostTabs: [
          {
            id: 'tab-1',
            ptyId: 'stale-local',
            title: '..ebug-userdata',
            quickCommandLabel: 'd2 · bmx-f6a95eed',
            botmuxSessionId: 'f6a95eed-full'
          }
        ]
      })
    ).toEqual({ kind: 'close-stale-then-create', tabId: 'tab-1', reason: 'bound-dead' })
  })
})

describe('decideBotmuxAttachTabAction', () => {
  it('skips when the same open is already in flight', () => {
    expect(
      decideBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(['attach:s1']),
        existingTabIds: []
      })
    ).toEqual({ kind: 'skip-inflight' })
  })

  it('reuses the first existing live tab on the host', () => {
    expect(
      decideBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(),
        existingTabIds: ['tab-a', 'tab-b']
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a' })
  })

  it('creates when nothing is open or in flight', () => {
    expect(
      decideBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(['attach:other']),
        existingTabIds: []
      })
    ).toEqual({ kind: 'create' })
  })

  it('creates when only dead (empty) tab ids are supplied', () => {
    // Callers filter to reusable live tabs; empty list means create.
    expect(
      decideBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(),
        existingTabIds: []
      })
    ).toEqual({ kind: 'create' })
  })
})

describe('decideBotmuxSessionOpenAction', () => {
  it('reuses a bound live tab that still looks attached', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: 'tab-a',
        hostTabs: [
          {
            id: 'tab-a',
            ptyId: 'pty-1',
            title: 'd2 · bmx-aaaa',
            botmuxSessionId: 'sess-a'
          }
        ],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a', reason: 'bound-live' })
  })

  it('re-attaches when bound tab has pty but bare local title (restart leftover)', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: 'tab-a',
        hostTabs: [{ id: 'tab-a', ptyId: 'pty-1', title: '~', botmuxSessionId: 'sess-a' }],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'close-stale-then-create', tabId: 'tab-a', reason: 'bound-dead' })
  })

  it('creates when no binding and host is empty', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: null,
        hostTabs: [],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'create', reason: 'no-binding' })
  })

  it('creates a sibling when another session already owns the only tab', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-b',
        boundTabId: null,
        hostTabs: [
          {
            id: 'tab-a',
            ptyId: 'pty-1',
            title: 'root@host',
            botmuxSessionId: 'sess-a'
          }
        ],
        tmuxSessionName: 'bmx-bbbb'
      })
    ).toEqual({ kind: 'create', reason: 'no-binding' })
  })

  it('closes bound dead tab (no ptyId) then create', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: 'tab-a',
        hostTabs: [{ id: 'tab-a', ptyId: null, title: 'd2 · bmx-aaaa', botmuxSessionId: 'sess-a' }],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'close-stale-then-create', tabId: 'tab-a', reason: 'bound-dead' })
  })

  it('resolves binding from tab.botmuxSessionId when meta boundTabId is null', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: null,
        hostTabs: [
          { id: 'tab-a', ptyId: 'pty-1', title: 'root@10.0.0.1', botmuxSessionId: 'sess-a' }
        ]
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a', reason: 'bound-live' })
  })

  it('legacy reuses single unbound healthy tab', () => {
    expect(
      decideBotmuxSessionOpenAction({
        sessionId: 'sess-new',
        boundTabId: null,
        hostTabs: [{ id: 'tab-only', ptyId: 'pty-1', title: 'root@host' }],
        tmuxSessionName: 'bmx-new'
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-only', reason: 'legacy-single' })
  })
})

describe('runBotmuxAttachOpenExclusive', () => {
  beforeEach(() => {
    clearBotmuxAttachInFlightForTest()
  })

  it('coalesces concurrent opens into a single create path', async () => {
    let createCount = 0
    const open = async (): Promise<{ tabId: string }> => {
      createCount += 1
      await new Promise((r) => setTimeout(r, 30))
      return { tabId: `tab-${createCount}` }
    }

    const [a, b] = await Promise.all([
      runBotmuxAttachOpenExclusive('attach:sess-x', open),
      runBotmuxAttachOpenExclusive('attach:sess-x', open)
    ])

    expect(createCount).toBe(1)
    expect(a).toEqual({ tabId: 'tab-1' })
    expect(b).toEqual({ tabId: 'tab-1' })
    expect(getBotmuxAttachInFlightKeysForTest().size).toBe(0)
  })

  it('allows a second open after the first settles', async () => {
    let createCount = 0
    const open = async (): Promise<number> => {
      createCount += 1
      return createCount
    }
    await runBotmuxAttachOpenExclusive('attach:sess-y', open)
    await runBotmuxAttachOpenExclusive('attach:sess-y', open)
    expect(createCount).toBe(2)
  })
})
