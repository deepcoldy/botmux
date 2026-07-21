import { describe, expect, it, beforeEach } from 'vitest'
import {
  orcaBotmuxOpenGuardKey,
  clearOrcaBotmuxAttachInFlightForTest,
  decideOrcaBotmuxAttachTabAction,
  decideOrcaBotmuxSessionOpenAction,
  getOrcaBotmuxAttachInFlightKeysForTest,
  isBareLocalShellTabTitle,
  isReusableOrcaBotmuxAttachTab,
  runOrcaBotmuxAttachOpenExclusive
} from './orca-botmux-open-guard'

describe('orcaBotmuxOpenGuardKey', () => {
  it('combines mode and session id', () => {
    expect(orcaBotmuxOpenGuardKey(' sess-1 ', 'attach')).toBe('attach:sess-1')
  })
})

describe('isBareLocalShellTabTitle / isReusableOrcaBotmuxAttachTab', () => {
  it('treats ~ / empty as bare local shell (failed attach leftover)', () => {
    expect(isBareLocalShellTabTitle('~')).toBe(true)
    expect(isBareLocalShellTabTitle('')).toBe(true)
    expect(isBareLocalShellTabTitle('  ')).toBe(true)
    expect(isBareLocalShellTabTitle('$')).toBe(true)
  })

  it('does not treat product attach titles as bare', () => {
    expect(isBareLocalShellTabTitle('d2 · bmx-e2e9b0d1')).toBe(false)
    expect(isBareLocalShellTabTitle('root@10.37.200.253')).toBe(false)
  })

  it('refuses reuse without ptyId or with bare local title', () => {
    expect(
      isReusableOrcaBotmuxAttachTab({
        ptyId: null,
        title: 'd2 · bmx-e2e9b0d1',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(false)
    expect(
      isReusableOrcaBotmuxAttachTab({
        ptyId: 'orca_botmux:session:x@@abc',
        title: '~',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(false)
  })

  it('reuses live tabs that still look attached', () => {
    expect(
      isReusableOrcaBotmuxAttachTab({
        ptyId: 'orca_botmux:session:x@@abc',
        title: 'd2 · bmx-e2e9b0d1',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(true)
    expect(
      isReusableOrcaBotmuxAttachTab({
        ptyId: 'orca_botmux:session:x@@abc',
        title: 'root@10.37.200.253',
        tmuxSessionName: 'bmx-e2e9b0d1'
      })
    ).toBe(true)
  })
})

describe('decideOrcaBotmuxAttachTabAction', () => {
  it('skips when the same open is already in flight', () => {
    expect(
      decideOrcaBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(['attach:s1']),
        existingTabIds: []
      })
    ).toEqual({ kind: 'skip-inflight' })
  })

  it('reuses the first existing live tab on the host', () => {
    expect(
      decideOrcaBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(),
        existingTabIds: ['tab-a', 'tab-b']
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a' })
  })

  it('creates when nothing is open or in flight', () => {
    expect(
      decideOrcaBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(['attach:other']),
        existingTabIds: []
      })
    ).toEqual({ kind: 'create' })
  })

  it('creates when only dead (empty) tab ids are supplied', () => {
    // Callers filter to reusable live tabs; empty list means create.
    expect(
      decideOrcaBotmuxAttachTabAction({
        openKey: 'attach:s1',
        inFlightKeys: new Set(),
        existingTabIds: []
      })
    ).toEqual({ kind: 'create' })
  })
})

describe('decideOrcaBotmuxSessionOpenAction', () => {
  it('reuses a bound live tab for the same sessionId (even bare title)', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: 'tab-a',
        hostTabs: [{ id: 'tab-a', ptyId: 'pty-1', title: '~', orcaBotmuxSessionId: 'sess-a' }],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a', reason: 'bound-live' })
  })

  it('creates when no binding and host is empty', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: null,
        hostTabs: [],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'create', reason: 'no-binding' })
  })

  it('creates a sibling when another session already owns the only tab', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-b',
        boundTabId: null,
        hostTabs: [
          {
            id: 'tab-a',
            ptyId: 'pty-1',
            title: 'root@host',
            orcaBotmuxSessionId: 'sess-a'
          }
        ],
        tmuxSessionName: 'bmx-bbbb'
      })
    ).toEqual({ kind: 'create', reason: 'no-binding' })
  })

  it('closes bound dead tab (no ptyId) then create', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: 'tab-a',
        hostTabs: [{ id: 'tab-a', ptyId: null, title: 'd2 · bmx-aaaa', orcaBotmuxSessionId: 'sess-a' }],
        tmuxSessionName: 'bmx-aaaa'
      })
    ).toEqual({ kind: 'close-stale-then-create', tabId: 'tab-a', reason: 'bound-dead' })
  })

  it('resolves binding from tab.orcaBotmuxSessionId when meta boundTabId is null', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-a',
        boundTabId: null,
        hostTabs: [
          { id: 'tab-a', ptyId: 'pty-1', title: 'root@10.0.0.1', orcaBotmuxSessionId: 'sess-a' }
        ]
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-a', reason: 'bound-live' })
  })

  it('legacy reuses single unbound healthy tab', () => {
    expect(
      decideOrcaBotmuxSessionOpenAction({
        sessionId: 'sess-new',
        boundTabId: null,
        hostTabs: [{ id: 'tab-only', ptyId: 'pty-1', title: 'root@host' }],
        tmuxSessionName: 'bmx-new'
      })
    ).toEqual({ kind: 'reuse', tabId: 'tab-only', reason: 'legacy-single' })
  })
})

describe('runOrcaBotmuxAttachOpenExclusive', () => {
  beforeEach(() => {
    clearOrcaBotmuxAttachInFlightForTest()
  })

  it('coalesces concurrent opens into a single create path', async () => {
    let createCount = 0
    const open = async (): Promise<{ tabId: string }> => {
      createCount += 1
      await new Promise((r) => setTimeout(r, 30))
      return { tabId: `tab-${createCount}` }
    }

    const [a, b] = await Promise.all([
      runOrcaBotmuxAttachOpenExclusive('attach:sess-x', open),
      runOrcaBotmuxAttachOpenExclusive('attach:sess-x', open)
    ])

    expect(createCount).toBe(1)
    expect(a).toEqual({ tabId: 'tab-1' })
    expect(b).toEqual({ tabId: 'tab-1' })
    expect(getOrcaBotmuxAttachInFlightKeysForTest().size).toBe(0)
  })

  it('allows a second open after the first settles', async () => {
    let createCount = 0
    const open = async (): Promise<number> => {
      createCount += 1
      return createCount
    }
    await runOrcaBotmuxAttachOpenExclusive('attach:sess-y', open)
    await runOrcaBotmuxAttachOpenExclusive('attach:sess-y', open)
    expect(createCount).toBe(2)
  })
})
