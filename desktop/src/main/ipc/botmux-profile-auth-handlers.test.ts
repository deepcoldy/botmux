import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  createCloudLinkedBotmuxProfileMock,
  connectCurrentBotmuxProfileMock,
  getCurrentBotmuxProfileAuthStatusMock,
  refreshCurrentBotmuxProfileAuthMock,
  selectCurrentBotmuxProfileOrgMock,
  signOutCurrentBotmuxProfileMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  createCloudLinkedBotmuxProfileMock: vi.fn(),
  connectCurrentBotmuxProfileMock: vi.fn(),
  getCurrentBotmuxProfileAuthStatusMock: vi.fn(),
  refreshCurrentBotmuxProfileAuthMock: vi.fn(),
  selectCurrentBotmuxProfileOrgMock: vi.fn(),
  signOutCurrentBotmuxProfileMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: () => '/tmp/botmux-user-data',
    relaunch: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: vi.fn()
}))

vi.mock('../botmux-profiles/profile-index-store', () => ({
  createLocalBotmuxProfile: vi.fn(),
  getBotmuxProfileListState: vi.fn(),
  seedNewBotmuxProfileTelemetryConsent: vi.fn(),
  setActiveBotmuxProfile: vi.fn()
}))

vi.mock('../botmux-profiles/profile-project-transfer', () => ({
  transferBotmuxProfileProject: vi.fn()
}))

vi.mock('../botmux-profiles/profile-cloud-service', () => ({
  createCloudLinkedBotmuxProfile: createCloudLinkedBotmuxProfileMock,
  connectCurrentBotmuxProfile: connectCurrentBotmuxProfileMock,
  getCurrentBotmuxProfileAuthStatus: getCurrentBotmuxProfileAuthStatusMock,
  refreshCurrentBotmuxProfileAuth: refreshCurrentBotmuxProfileAuthMock,
  selectCurrentBotmuxProfileOrg: selectCurrentBotmuxProfileOrgMock,
  signOutCurrentBotmuxProfile: signOutCurrentBotmuxProfileMock
}))

import { registerBotmuxProfileHandlers } from './botmux-profiles'

describe('registerBotmuxProfileHandlers auth channels', () => {
  beforeEach(() => {
    handlers.clear()
    createCloudLinkedBotmuxProfileMock.mockReset()
    connectCurrentBotmuxProfileMock.mockReset()
    getCurrentBotmuxProfileAuthStatusMock.mockReset()
    refreshCurrentBotmuxProfileAuthMock.mockReset()
    selectCurrentBotmuxProfileOrgMock.mockReset()
    signOutCurrentBotmuxProfileMock.mockReset()
  })

  it('returns auth status for the current profile', async () => {
    const status = {
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    }
    getCurrentBotmuxProfileAuthStatusMock.mockReturnValue(status)
    registerBotmuxProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('botmuxProfiles:authStatus')?.(null))).resolves.toBe(
      status
    )
    expect(getCurrentBotmuxProfileAuthStatusMock).toHaveBeenCalledWith('/tmp/botmux-user-data')
  })

  it('connects and signs out the current profile through the cloud service', async () => {
    const connectResult = { status: 'unconfigured', auth: { activeProfileId: 'local-default' } }
    const signOutResult = { status: 'signed-out', auth: { activeProfileId: 'local-default' } }
    connectCurrentBotmuxProfileMock.mockResolvedValue(connectResult)
    signOutCurrentBotmuxProfileMock.mockResolvedValue(signOutResult)
    registerBotmuxProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('botmuxProfiles:connectCurrent')?.(null))
    ).resolves.toBe(connectResult)
    await expect(
      Promise.resolve(handlers.get('botmuxProfiles:signOutCurrent')?.(null))
    ).resolves.toBe(signOutResult)
    expect(connectCurrentBotmuxProfileMock).toHaveBeenCalledWith('/tmp/botmux-user-data')
    expect(signOutCurrentBotmuxProfileMock).toHaveBeenCalledWith('/tmp/botmux-user-data')
  })

  it('refreshes profile auth through the cloud service', async () => {
    const refreshResult = { status: 'refreshed', auth: { activeProfileId: 'local-default' } }
    refreshCurrentBotmuxProfileAuthMock.mockResolvedValue(refreshResult)
    registerBotmuxProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(Promise.resolve(handlers.get('botmuxProfiles:refreshAuth')?.(null))).resolves.toBe(
      refreshResult
    )
    expect(refreshCurrentBotmuxProfileAuthMock).toHaveBeenCalledWith('/tmp/botmux-user-data')
  })

  it('validates organization selection before calling the cloud service', async () => {
    const selectResult = { status: 'selected', auth: { activeProfileId: 'local-default' } }
    selectCurrentBotmuxProfileOrgMock.mockResolvedValue(selectResult)
    registerBotmuxProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(handlers.get('botmuxProfiles:selectOrg')?.(null, { orgId: ' org-1 ' }))
    ).resolves.toBe(selectResult)
    expect(selectCurrentBotmuxProfileOrgMock).toHaveBeenCalledWith('/tmp/botmux-user-data', 'org-1')

    await expect(
      Promise.resolve(handlers.get('botmuxProfiles:selectOrg')?.(null, { orgId: ' ' }))
    ).rejects.toThrow('invalid_botmux_profile_org_selection')
  })

  it('creates cloud-linked profiles with trimmed optional args', async () => {
    const createResult = {
      status: 'created',
      auth: { activeProfileId: 'local-default' },
      activeProfileId: 'local-default',
      profiles: [],
      profile: { id: 'cloud-1' }
    }
    createCloudLinkedBotmuxProfileMock.mockResolvedValue(createResult)
    registerBotmuxProfileHandlers({
      flush: vi.fn(),
      freezeWrites: vi.fn(),
      getSettings: () => ({})
    } as never)

    await expect(
      Promise.resolve(
        handlers.get('botmuxProfiles:createCloudLinked')?.(null, { orgId: ' org-1 ', name: ' Acme ' })
      )
    ).resolves.toBe(createResult)
    expect(createCloudLinkedBotmuxProfileMock).toHaveBeenCalledWith('/tmp/botmux-user-data', {
      orgId: 'org-1',
      name: 'Acme'
    })
  })
})
