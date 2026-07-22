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
  revokeBotmuxCloudSessionMock,
  selectBotmuxCloudOrgMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginBotmuxCloudPkceFlowMock: vi.fn(),
  createBotmuxCloudProfileMock: vi.fn(),
  exchangeBotmuxCloudAuthCodeMock: vi.fn(),
  revokeBotmuxCloudSessionMock: vi.fn(),
  selectBotmuxCloudOrgMock: vi.fn(),
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
  createBotmuxCloudProfile: createBotmuxCloudProfileMock,
  exchangeBotmuxCloudAuthCode: exchangeBotmuxCloudAuthCodeMock,
  revokeBotmuxCloudSession: revokeBotmuxCloudSessionMock,
  selectBotmuxCloudOrg: selectBotmuxCloudOrgMock
}))

import {
  connectCurrentBotmuxProfile,
  createCloudLinkedBotmuxProfile,
  getCurrentBotmuxProfileAuthStatus,
  selectCurrentBotmuxProfileOrg,
  signOutCurrentBotmuxProfile
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

function configureCloudEnv(): void {
  vi.stubEnv('BOTMUX_CLOUD_API_URL', 'https://botmux-cloud.example')
  vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', 'desktop-client')
}

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
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

describe('Botmux cloud profile service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-cloud-service-'))
    beginBotmuxCloudPkceFlowMock.mockReset()
    createBotmuxCloudProfileMock.mockReset()
    exchangeBotmuxCloudAuthCodeMock.mockReset()
    revokeBotmuxCloudSessionMock.mockReset()
    selectBotmuxCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    revokeBotmuxCloudSessionMock.mockResolvedValue(undefined)
    vi.unstubAllEnvs()
    vi.stubEnv('BOTMUX_CLOUD_API_URL', '')
    vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports local unconfigured auth without cloud setup', () => {
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    })
  })

  it('connects the active local profile without replacing its local profile ID', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()

    const result = await connectCurrentBotmuxProfile(userDataPath)

    if (result.status !== 'connected') {
      throw new Error(`Expected connected result, got ${result.status}`)
    }
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({
      id: 'local-default',
      kind: 'cloud-linked',
      cloud: cloudSummary
    })
    expect(exchangeBotmuxCloudAuthCodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ localProfileId: 'local-default', nonce: 'nonce' })
    )
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      persistence: 'encrypted',
      cloud: cloudSummary,
      organizations,
      capabilities
    })
  })

  it('treats provider-denied sign-in as a cancelled connect attempt', async () => {
    configureCloudEnv()
    beginBotmuxCloudPkceFlowMock.mockRejectedValue(new Error('botmux_cloud_auth_denied'))

    const result = await connectCurrentBotmuxProfile(userDataPath)

    expect(result.status).toBe('cancelled')
    expect(exchangeBotmuxCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
  })

  it('does not report a saved cloud session as connected when cloud config is unavailable', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentBotmuxProfile(userDataPath)
    vi.stubEnv('BOTMUX_CLOUD_API_URL', '')
    vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', '')

    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      configured: false,
      state: 'unconfigured',
      persistence: 'encrypted',
      cloud: cloudSummary,
      setupMessage: 'Botmux Cloud sign-in is not configured for this build.'
    })
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).organizations).toBeUndefined()
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).capabilities).toBeUndefined()
  })

  it('signs out by removing cloud metadata while keeping the local profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentBotmuxProfile(userDataPath)

    const result = await signOutCurrentBotmuxProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({ id: 'local-default', kind: 'local' })
    expect(result.profiles[0]?.cloud).toBeUndefined()
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
    expect(revokeBotmuxCloudSessionMock).toHaveBeenCalledOnce()
  })

  it('creates a new empty cloud-linked profile with its own cloud session', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentBotmuxProfile(userDataPath)
    createBotmuxCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: 1000,
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities: { flags: { share: true, team: true }, refreshedAt: 13 }
    } satisfies BotmuxCloudSessionExchangeResponse)

    const result = await createCloudLinkedBotmuxProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    if (result.status !== 'created') {
      throw new Error(`Expected created result, got ${result.status}`)
    }
    expect(result.profile).toMatchObject({
      id: expect.stringMatching(/^cloud-/),
      name: 'Acme',
      kind: 'cloud-linked',
      cloud: expect.objectContaining({ cloudProfileId: 'cloud-profile-2' })
    })
    expect(createBotmuxCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('selects an organization for a connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentBotmuxProfile(userDataPath)
    const orgCloudSummary = {
      ...cloudSummary,
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    }
    selectBotmuxCloudOrgMock.mockResolvedValue({
      cloud: orgCloudSummary,
      organizations,
      capabilities: { flags: { share: true, sso: true }, refreshedAt: 12 }
    })

    const result = await selectCurrentBotmuxProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectBotmuxCloudOrgMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      'org-1'
    )
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    })
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).organizations).toEqual(organizations)
  })
})
