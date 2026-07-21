import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime project groups', () => {
  it('keeps runtime copies of a grouped canonical project in the same project group', async () => {
    const gitRemoteIdentity = {
      canonicalKey: 'github.com/stablyai/orca_botmux',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/stablyai/orca_botmux.git'
    }
    const localOrca: Repo = {
      id: 'local-orca_botmux',
      path: '/Users/alice/stably/orca_botmux',
      displayName: 'orca_botmux',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local',
      gitRemoteIdentity,
      projectGroupId: 'group-orca_botmux'
    }
    const runtimeOrca: Repo = {
      id: 'runtime-orca_botmux',
      path: '/vercel/sandbox/orca_botmux',
      displayName: 'orca_botmux',
      badgeColor: '#111',
      addedAt: 2,
      gitRemoteIdentity
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-runtime-orca_botmux',
      ok: true,
      result: { repos: [runtimeOrca] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localOrca]
    })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([
      localOrca,
      {
        ...runtimeOrca,
        executionHostId: 'runtime:env-1',
        projectGroupId: 'group-orca_botmux'
      }
    ])
  })
})
