// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { useAppStore } from '@/store'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

const deleteFlowMocks = vi.hoisted(() => ({
  runWorktreeDelete: vi.fn()
}))

const environmentSshMocks = vi.hoisted(() => ({
  connectRuntimeEnvironmentSshTarget: vi.fn(),
  resyncRuntimeEnvironmentSshTargets: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('../sidebar/delete-worktree-flow', () => ({
  runWorktreeDelete: deleteFlowMocks.runWorktreeDelete
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => environmentSshMocks)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

function installSshConnect(
  connect: ReturnType<typeof vi.fn>,
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect,
        getState: vi.fn().mockResolvedValue(null),
        listTargets: vi.fn().mockResolvedValue([]),
        listRemovedTargetLabels: vi.fn().mockResolvedValue({}),
        ...overrides
      }
    }
  })
}

describe('TerminalSshReconnectOverlay', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    toastMocks.error.mockReset()
    deleteFlowMocks.runWorktreeDelete.mockReset()
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockReset()
    environmentSshMocks.resyncRuntimeEnvironmentSshTargets.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('auto-ensures SSH for a disconnected terminal without a manual Connect click', async () => {
    const connect = vi.fn().mockResolvedValue({
      targetId: 'ssh-target-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    } satisfies SshConnectionState)
    installSshConnect(connect)

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    expect(screen.getByText('SSH connection required')).toBeInTheDocument()
    expect(screen.getByText(/This terminal is waiting for devbox/)).toBeInTheDocument()
    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-target-1' })
    })
  })

  it('shows an in-flight state while the SSH target is reconnecting', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    // Why: auto-ensure polls getState; settle to connected without calling connect.
    const getState = vi
      .fn()
      .mockResolvedValueOnce({
        targetId: 'ssh-target-1',
        status: 'reconnecting',
        error: null,
        reconnectAttempt: 1
      } satisfies SshConnectionState)
      .mockResolvedValue({
        targetId: 'ssh-target-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      } satisfies SshConnectionState)
    installSshConnect(connect, { getState })

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="reconnecting"
      />
    )

    expect(screen.getByText(/Connecting to devbox/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connecting.../ })).toBeDisabled()
    await waitFor(() => {
      expect(getState).toHaveBeenCalled()
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('unsticks a missed connected push after deploying-relay via getState reconcile', async () => {
    const connect = vi.fn()
    const getState = vi.fn().mockResolvedValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      supportsFolderDownload: true
    } satisfies SshConnectionState)
    installSshConnect(connect, { getState })

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-1"
        targetLabel="d2"
        status="deploying-relay"
      />
    )

    await waitFor(() => {
      expect(useAppStore.getState().sshConnectionStates.get('ssh-1')?.status).toBe('connected')
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports auto-ensure connect failures and re-enables the Connect action', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('Passphrase rejected'))
    installSshConnect(connect)

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="auth-failed"
      />
    )

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Passphrase rejected'))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('resyncs target metadata after a failed auto-ensure connect so a stale overlay converges', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('SSH target "ssh-dead" not found'))
    const listTargets = vi
      .fn()
      .mockResolvedValue([
        { id: 'ssh-live', label: 'devbox', host: 'devbox', port: 22, username: 'me' }
      ])
    const listRemovedTargetLabels = vi.fn().mockResolvedValue({ 'ssh-dead': 'devbox (removed)' })
    installSshConnect(connect, { listTargets, listRemovedTargetLabels })

    render(
      <TerminalSshReconnectOverlay targetId="ssh-dead" targetLabel="devbox" status="disconnected" />
    )

    // Why: the metadata refresh is what flips TerminalPane's targetRemoved
    // derivation, replacing the failing Connect loop with the ghost-host UI.
    await waitFor(() => {
      expect(useAppStore.getState().sshTargetLabels.get('ssh-live')).toBe('devbox')
      expect(useAppStore.getState().removedSshTargetLabels.get('ssh-dead')).toBe('devbox (removed)')
    })
  })

  it('still applies the target list when the removed-labels refresh fails', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('SSH target "ssh-dead" not found'))
    const listTargets = vi
      .fn()
      .mockResolvedValue([
        { id: 'ssh-live', label: 'devbox', host: 'devbox', port: 22, username: 'me' }
      ])
    const listRemovedTargetLabels = vi.fn().mockRejectedValue(new Error('unavailable'))
    installSshConnect(connect, { listTargets, listRemovedTargetLabels })

    render(
      <TerminalSshReconnectOverlay targetId="ssh-dead" targetLabel="devbox" status="disconnected" />
    )

    // Why: a removed-labels failure must not discard the refreshed target
    // list — it alone is enough evidence for targetRemoved to converge.
    await waitFor(() => {
      expect(useAppStore.getState().sshTargetLabels.get('ssh-live')).toBe('devbox')
      expect(useAppStore.getState().sshTargetsHydrated).toBe(true)
    })
  })

  it('offers to remove the workspace (not Connect) when the SSH target was removed', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-dead"
        targetLabel="ssh-dead"
        status="disconnected"
        targetRemoved
        worktreeId="repo::/work/wt"
      />
    )

    expect(screen.getByText('SSH host removed')).toBeInTheDocument()
    // No Connect button — reconnect is impossible for a removed target.
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    expect(deleteFlowMocks.runWorktreeDelete).toHaveBeenCalledWith('repo::/work/wt')
    expect(connect).not.toHaveBeenCalled()
  })

  it('routes Connect to the owning environment runtime RPC for a remote-owned workspace', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue(null)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-remote-1"
        targetLabel="devbox"
        status="disconnected"
        sshOwnerEnvironmentId="env-1"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(environmentSshMocks.connectRuntimeEnvironmentSshTarget).toHaveBeenCalledWith(
        'env-1',
        'ssh-remote-1'
      )
    )
    // The local ssh API must never see a remote host's target.
    expect(connect).not.toHaveBeenCalled()
  })

  it('resyncs the owning environment (not the local store) after a failed remote connect', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const listTargets = vi.fn().mockResolvedValue([])
    installSshConnect(connect, { listTargets })
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockRejectedValue(
      new Error('SSH target "ssh-remote-dead" not found')
    )
    environmentSshMocks.resyncRuntimeEnvironmentSshTargets.mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-remote-dead"
        targetLabel="devbox"
        status="disconnected"
        sshOwnerEnvironmentId="env-1"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('SSH target "ssh-remote-dead" not found')
    )
    await waitFor(() =>
      expect(environmentSshMocks.resyncRuntimeEnvironmentSshTargets).toHaveBeenCalledWith('env-1')
    )
    // The failed-connect resync must not rewrite local target metadata.
    expect(listTargets).not.toHaveBeenCalled()
    expect(useAppStore.getState().sshTargetsHydrated).toBe(false)
  })

  it('publishes the returned SSH state so deferred terminal reattach can resume', async () => {
    const connectedState: SshConnectionState = {
      targetId: 'ssh-target-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      remotePlatform: 'linux'
    }
    const connect = vi.fn().mockResolvedValue(connectedState)
    installSshConnect(connect)

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    await waitFor(() =>
      expect(useAppStore.getState().sshConnectionStates.get('ssh-target-1')).toEqual(connectedState)
    )
  })
})
