import { describe, expect, it, vi } from 'vitest'
import {
  ensureSshTargetConnected,
  isTransientSshStatus
} from './ensure-ssh-target-connected'
import type { SshConnectionState } from '../../../shared/ssh-types'

function state(
  status: SshConnectionState['status'],
  targetId = 'ssh-1'
): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

describe('isTransientSshStatus', () => {
  it('treats connecting / deploying-relay / reconnecting as transient', () => {
    expect(isTransientSshStatus('connecting')).toBe(true)
    expect(isTransientSshStatus('deploying-relay')).toBe(true)
    expect(isTransientSshStatus('reconnecting')).toBe(true)
    expect(isTransientSshStatus('connected')).toBe(false)
    expect(isTransientSshStatus('disconnected')).toBe(false)
  })
})

describe('ensureSshTargetConnected', () => {
  it('publishes connected main state without calling connect', async () => {
    const connected = state('connected')
    const getState = vi.fn().mockResolvedValue(connected)
    const connect = vi.fn()
    const publishState = vi.fn()

    const result = await ensureSshTargetConnected('ssh-1', {
      getState,
      connect,
      publishState
    })

    expect(result).toEqual(connected)
    expect(connect).not.toHaveBeenCalled()
    expect(publishState).toHaveBeenCalledWith('ssh-1', connected)
  })

  it('unsticks deploying-relay when main is already connected', async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce(state('deploying-relay'))
      .mockResolvedValueOnce(state('connected'))
    const connect = vi.fn()
    const publishState = vi.fn()
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await ensureSshTargetConnected('ssh-1', {
      getState,
      connect,
      publishState,
      sleep,
      pollIntervalMs: 1,
      settleTimeoutMs: 1000
    })

    expect(result?.status).toBe('connected')
    expect(connect).not.toHaveBeenCalled()
    expect(publishState).toHaveBeenCalledWith('ssh-1', expect.objectContaining({ status: 'connected' }))
  })

  it('calls connect when disconnected and publishes the result', async () => {
    const connected = state('connected')
    const getState = vi.fn().mockResolvedValue(state('disconnected'))
    const connect = vi.fn().mockResolvedValue(connected)
    const publishState = vi.fn()

    const result = await ensureSshTargetConnected('ssh-1', {
      getState,
      connect,
      publishState
    })

    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(result).toEqual(connected)
    expect(publishState).toHaveBeenCalledWith('ssh-1', connected)
  })

  it('publishes main state then rethrows after a failed connect', async () => {
    const failed = state('error')
    failed.error = 'boom'
    const getState = vi
      .fn()
      .mockResolvedValueOnce(state('disconnected'))
      .mockResolvedValueOnce(failed)
    const connect = vi.fn().mockRejectedValue(new Error('boom'))
    const publishState = vi.fn()

    await expect(
      ensureSshTargetConnected('ssh-1', {
        getState,
        connect,
        publishState
      })
    ).rejects.toThrow('boom')

    expect(publishState).toHaveBeenCalledWith('ssh-1', failed)
  })
})
