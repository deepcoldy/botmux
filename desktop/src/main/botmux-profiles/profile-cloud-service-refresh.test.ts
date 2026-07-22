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
  BotmuxCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginBotmuxCloudPkceFlowMock: vi.fn(),
  createBotmuxCloudProfileMock: vi.fn(),
  exchangeBotmuxCloudAuthCodeMock: vi.fn(),
  refreshBotmuxCloudCapabilitiesMock: vi.fn(),
  refreshBotmuxCloudSessionMock: vi.fn(),
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
  selectBotmuxCloudOrg: vi.fn()
}))

import {
  connectCurrentBotmuxProfile,
  createCloudLinkedBotmuxProfile,
  getCurrentBotmuxProfileAuthStatus,
  refreshCurrentBotmuxProfileAuth
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

function mockSuccessfulConnect(expiresAt = futureExpiresAt()): void {
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
    expiresAt,
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies BotmuxCloudSessionExchangeResponse)
}

describe('Botmux cloud profile service session refresh', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-cloud-service-refresh-'))
    beginBotmuxCloudPkceFlowMock.mockReset()
    createBotmuxCloudProfileMock.mockReset()
    exchangeBotmuxCloudAuthCodeMock.mockReset()
    refreshBotmuxCloudCapabilitiesMock.mockReset()
    refreshBotmuxCloudSessionMock.mockReset()
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

  it('refreshes an expired access token before creating cloud profiles', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudSessionMock.mockResolvedValue({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: cloudSummary,
      organizations,
      capabilities
    } satisfies BotmuxCloudSessionExchangeResponse)
    createBotmuxCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities
    } satisfies BotmuxCloudSessionExchangeResponse)

    const result = await createCloudLinkedBotmuxProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    expect(result.status).toBe('created')
    expect(refreshBotmuxCloudSessionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ refreshToken: 'refresh-token' })
    )
    expect(createBotmuxCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('refreshes capability flags for the connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudCapabilitiesMock.mockResolvedValue({
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 25
      }
    })

    const result = await refreshCurrentBotmuxProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshBotmuxCloudCapabilitiesMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' })
    )
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false, team: true },
      refreshedAt: 25
    })
  })

  it('clears stale active org metadata when capability refresh returns no active org', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    exchangeBotmuxCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
      organizations,
      capabilities
    } satisfies BotmuxCloudSessionExchangeResponse)
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudCapabilitiesMock.mockResolvedValue({
      cloud: cloudSummary,
      organizations: [],
      capabilities: {
        flags: { share: false },
        refreshedAt: 31
      }
    })

    const result = await refreshCurrentBotmuxProfileAuth(userDataPath)
    const status = getCurrentBotmuxProfileAuthStatus(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(status.cloud?.activeOrgId).toBeUndefined()
    expect(status.cloud?.activeOrgName).toBeUndefined()
    expect(status.organizations).toEqual([])
    expect(status.capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 31
    })
  })

  it('requires reconnect when an expired refresh token is rejected', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentBotmuxProfile(userDataPath)
    refreshBotmuxCloudSessionMock.mockRejectedValue(new BotmuxCloudRequestErrorMock(401))

    const result = await refreshCurrentBotmuxProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })
})
