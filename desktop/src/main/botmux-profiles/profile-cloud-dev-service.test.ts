import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  beginBotmuxCloudPkceFlowMock,
  exchangeBotmuxCloudAuthCodeMock,
  revokeBotmuxCloudSessionMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginBotmuxCloudPkceFlowMock: vi.fn(),
  exchangeBotmuxCloudAuthCodeMock: vi.fn(),
  revokeBotmuxCloudSessionMock: vi.fn(),
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
  createBotmuxCloudProfile: vi.fn(),
  exchangeBotmuxCloudAuthCode: exchangeBotmuxCloudAuthCodeMock,
  refreshBotmuxCloudCapabilities: vi.fn(),
  refreshBotmuxCloudSession: vi.fn(),
  revokeBotmuxCloudSession: revokeBotmuxCloudSessionMock,
  selectBotmuxCloudOrg: vi.fn()
}))

import {
  connectCurrentBotmuxProfile,
  createCloudLinkedBotmuxProfile,
  getCurrentBotmuxProfileAuthStatus,
  selectCurrentBotmuxProfileOrg,
  signOutCurrentBotmuxProfile
} from './profile-cloud-service'

describe('Botmux cloud dev auth service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-cloud-dev-auth-'))
    beginBotmuxCloudPkceFlowMock.mockReset()
    exchangeBotmuxCloudAuthCodeMock.mockReset()
    revokeBotmuxCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('BOTMUX_CLOUD_DEV_AUTH', '1')
    vi.stubEnv('BOTMUX_CLOUD_API_URL', '')
    vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('connects the active profile without PKCE or cloud endpoints', async () => {
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local'
    })

    const result = await connectCurrentBotmuxProfile(userDataPath)

    expect(result.status).toBe('connected')
    expect(beginBotmuxCloudPkceFlowMock).not.toHaveBeenCalled()
    expect(exchangeBotmuxCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: {
        cloudProfileId: 'dev-cloud-local-default',
        email: 'dev@botmux.local'
      },
      capabilities: {
        flags: expect.objectContaining({ 'share.create': true })
      }
    })
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).organizations).toHaveLength(2)
  })

  it('selects dev organizations and creates org-scoped cloud profiles locally', async () => {
    await connectCurrentBotmuxProfile(userDataPath)

    const selected = await selectCurrentBotmuxProfileOrg(userDataPath, 'dev-acme')
    const created = await createCloudLinkedBotmuxProfile(userDataPath, {
      orgId: 'dev-acme',
      name: 'Acme Dev'
    })

    expect(selected.status).toBe('selected')
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'dev-acme',
      activeOrgName: 'Acme Dev'
    })
    expect(created.status).toBe('created')
    if (created.status === 'created') {
      expect(created.profile).toMatchObject({
        name: 'Acme Dev',
        kind: 'cloud-linked',
        cloud: expect.objectContaining({
          activeOrgId: 'dev-acme',
          activeOrgName: 'Acme Dev'
        })
      })
    }
  })

  it('signs out locally without calling the cloud logout endpoint', async () => {
    await connectCurrentBotmuxProfile(userDataPath)

    const result = await signOutCurrentBotmuxProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(revokeBotmuxCloudSessionMock).not.toHaveBeenCalled()
    expect(getCurrentBotmuxProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local',
      persistence: 'none'
    })
  })
})
