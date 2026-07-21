import { describe, expect, it, vi, beforeEach } from 'vitest'

const createTab = vi.fn()
const queueTabStartupCommand = vi.fn()
const setActiveTab = vi.fn()
const setActiveTabType = vi.fn()
const setTabBarOrder = vi.fn()
const updateTabTitle = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      createTab,
      queueTabStartupCommand,
      setActiveTab,
      setActiveTabType,
      setTabBarOrder,
      updateTabTitle,
      tabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {}
    })
  }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: () => []
}))

import {
  buildNativeRelayShellCommand,
  openOrcaBotmuxTmuxAttachTab
} from './open-orca-botmux-native-terminal-tab'

describe('openOrcaBotmuxTmuxAttachTab', () => {
  beforeEach(() => {
    createTab.mockReset()
    queueTabStartupCommand.mockReset()
    setActiveTab.mockReset()
    setActiveTabType.mockReset()
    setTabBarOrder.mockReset()
    updateTabTitle.mockReset()
    createTab.mockReturnValue({ id: 'tab-1', ptyId: null })
  })

  it('queues attach shell before activating the tab (no trailing newline)', () => {
    const shell =
      "ssh -tt -o ConnectTimeout=20 -o BatchMode=yes root@10.0.0.1 'tmux attach-session -t bmx-abcd1234' || printf '%s\\n' 'fail'"
    openOrcaBotmuxTmuxAttachTab({
      worktreeId: 'orca_botmux:session:sess-1',
      shellCommand: shell + '\n\n',
      title: 'd2 · bmx-abcd1234'
    })

    expect(queueTabStartupCommand).toHaveBeenCalledTimes(1)
    const prequeuedId = queueTabStartupCommand.mock.calls[0]?.[0] as string
    expect(prequeuedId).toBeTruthy()
    const queued = queueTabStartupCommand.mock.calls[0]?.[1]?.command as string
    expect(queued).toContain('ssh -tt')
    expect(queued).toContain('tmux attach-session')
    expect(queued).not.toMatch(/[\r\n]$/)

    // Why: createTab must use the same pre-queued id so the mounted pane
    // sees pending startup on first paint.
    expect(createTab).toHaveBeenCalledWith(
      'orca_botmux:session:sess-1',
      undefined,
      undefined,
      expect.objectContaining({
        id: prequeuedId,
        activate: true,
        quickCommandLabel: 'd2 · bmx-abcd1234'
      })
    )
    const queueOrder = queueTabStartupCommand.mock.invocationCallOrder[0] ?? 0
    const createOrder = createTab.mock.invocationCallOrder[0] ?? 0
    expect(queueOrder).toBeLessThan(createOrder)
    expect(createTab.mock.calls[0]?.[0]).not.toBe('global-floating-terminal')
  })
})

describe('buildNativeRelayShellCommand', () => {
  it('does not append a trailing newline', () => {
    const line = buildNativeRelayShellCommand({
      command: '/usr/bin/node',
      args: ['relay.mjs'],
      title: 'relay',
      electronRunAsNode: false
    })
    expect(line).not.toMatch(/[\r\n]$/)
  })
})
