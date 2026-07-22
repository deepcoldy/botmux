import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BotmuxCloudCapabilities,
  BotmuxCloudOrgSummary,
  BotmuxProfileCloudSummary
} from '../../shared/botmux-profiles'
import type { BotmuxCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const {
  beginBotmuxCloudPkceFlowMock,
  createBotmuxCloudProfileMock,
  exchangeBotmuxCloudAuthCodeMock,
  refreshBotmuxCloudCapabilitiesMock,
  refreshBotmuxCloudSessionMock,
  selectBotmuxCloudOrgMock,
  BotmuxCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginBotmuxCloudPkceFlowMock: vi.fn(),
  createBotmuxCloudProfileMock: vi.fn(),
  exchangeBotmuxCloudAuthCodeMock: vi.fn(),
  refreshBotmuxCloudCapabilitiesMock: vi.fn(),
  refreshBotmuxCloudSessionMock: vi.fn(),
  selectBotmuxCloudOrgMock: vi.fn(),
  BotmuxCloudRequestErrorMock: class BotmuxCloudRequestError extends Error {
    constructor(public readonly statusCode: number) {
      super(`botmux_cloud_request_failed_${statusCode}`)
      this.name = 'BotmuxCloudRequestError'
    }
  },
  safeStorageMock: {
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
    isEncryptionAvailable: vi.fn(() => true)
  }
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginBotmuxCloudPkceFlow: beginBotmuxCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  BotmuxCloudRequestError: BotmuxCloudRequestErrorMock,
  createBotmuxCloudProfile: createBotmuxCloudProfileMock,
  exchangeBotmuxCloudAuthCode: exchangeBotmuxCloudAuthCodeMock,
  refreshBotmuxCloudCapabilities: refreshBotmuxCloudCapabilitiesMock,
  refreshBotmuxCloudSession: refreshBotmuxCloudSessionMock,
  revokeBotmuxCloudSession: vi.fn(),
  selectBotmuxCloudOrg: selectBotmuxCloudOrgMock
}))

import {
  connectCurrentBotmuxProfile,
  createCloudLinkedBotmuxProfile,
  getCurrentBotmuxProfileAuthStatus,
  refreshCurrentBotmuxProfileAuth,
  selectCurrentBotmuxProfileOrg
} from './profile-cloud-service'

const cloudSummary: BotmuxProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const capabilities: BotmuxCloudCapabilities = {
  flags: { share: true },
  refreshedAt: 11
}

const organizations: BotmuxCloudOrgSummary[] = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
}

function configureCloudEnv(): void {
  vi.stubEnv('BOTMUX_CLOUD_API_URL', 'https://botmux-cloud.example')
  vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', 'desktop-client')
}

function mockSuccessfulConnect(): void {
  beginBotmuxCloudPkceFlowMock.mockResolvedValue({
    code: 'auth-code',
    codeVerifier: 'code-verifier',
    nonce: 'nonce',
    redirectUri: 'http://127.0.0.1:4100/auth/callback',
    state: 'state'
  })
  exchangeBotmuxCloudAuthCodeMock.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies BotmuxCloudSessionExchangeResponse)
}

function mockSuccessfulSessionRefresh(): void {
  refreshBotmuxCloudSessionMock.mockResolvedValue({
    accessToken: 'rotated-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies BotmuxCloudSessionExchangeResponse)
}

describe('Botmux cloud profile auth-failure retry', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-cloud-service-auth-retry-'))
    beginBotmuxCloudPkceFlowMock.mockReset()
    createBotmuxCloudProfileMock.mockReset()
    exchangeBotmuxCloudAuthCodeMock.mockReset()
    refreshBotmuxCloudCapabilitiesMock.mockReset()
    refreshBotmuxCloudSessionMock.mockReset()
    selectBotmuxCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('BOTMUX_CLOUD_API_URL', '')
    vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('refreshes and retries cloud profile creation after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentBotmuxProfile(userDataPath)
    createBotmuxCloudProfileMock
      .mockRejectedValueOnce(new BotmuxCloudRequestErrorMock(401))
      .mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: futureExpiresAt(),
        cloud: { ...cloudSummary, cloudProfileId: 'cloud-profile-2' },
        organizations,
        capabilities
      } satisfies BotmuxCloudSessionExchangeResponse)

    const result = await createCloudLinkedBotmuxProfile(userDataPath, { name: 'Acme' })

    expect(result.status).toBe('created')
    expect(createBotmuxCloudProfileMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { name: 'Acme' }
    )
  })

  it('refreshes and retries capability refresh after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudCapabilitiesMock
      .mockRejectedValueOnce(new BotmuxCloudRequestErrorMock(403))
      .mockResolvedValue({
        capabilities: { flags: { share: false }, refreshedAt: 26 } satisfies BotmuxCloudCapabilities
      })

    const result = await refreshCurrentBotmuxProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshBotmuxCloudCapabilitiesMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' })
    )
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 26
    })
  })

  it('requires reconnect when a retried capability refresh is still unauthorized', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudCapabilitiesMock
      .mockRejectedValueOnce(new BotmuxCloudRequestErrorMock(401))
      .mockRejectedValueOnce(new BotmuxCloudRequestErrorMock(401))

    const result = await refreshCurrentBotmuxProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })

  it('refreshes and retries organization selection after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentBotmuxProfile(userDataPath)
    selectBotmuxCloudOrgMock
      .mockRejectedValueOnce(new BotmuxCloudRequestErrorMock(401))
      .mockResolvedValue({
        cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
        organizations,
        capabilities
      })

    const result = await selectCurrentBotmuxProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectBotmuxCloudOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      'org-1'
    )
  })
})
