import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BotmuxOrgMembersRoster } from '../../shared/botmux-profiles'
import { BotmuxCloudRequestError } from './profile-cloud-client'

const {
  runWithFreshBotmuxCloudSessionMock,
  listBotmuxCloudOrgMembersMock,
  inviteBotmuxCloudOrgMemberMock,
  revokeBotmuxCloudOrgInviteMock,
  changeBotmuxCloudOrgMemberRoleMock,
  removeBotmuxCloudOrgMemberMock
} = vi.hoisted(() => ({
  runWithFreshBotmuxCloudSessionMock: vi.fn(),
  listBotmuxCloudOrgMembersMock: vi.fn(),
  inviteBotmuxCloudOrgMemberMock: vi.fn(),
  revokeBotmuxCloudOrgInviteMock: vi.fn(),
  changeBotmuxCloudOrgMemberRoleMock: vi.fn(),
  removeBotmuxCloudOrgMemberMock: vi.fn()
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

vi.mock('./profile-cloud-session-refresh', () => ({
  runWithFreshBotmuxCloudSessionMock,
  runWithFreshBotmuxCloudSession: runWithFreshBotmuxCloudSessionMock
}))

vi.mock('./profile-cloud-org-members-client', () => ({
  listBotmuxCloudOrgMembers: listBotmuxCloudOrgMembersMock,
  inviteBotmuxCloudOrgMember: inviteBotmuxCloudOrgMemberMock,
  revokeBotmuxCloudOrgInvite: revokeBotmuxCloudOrgInviteMock,
  changeBotmuxCloudOrgMemberRole: changeBotmuxCloudOrgMemberRoleMock,
  removeBotmuxCloudOrgMember: removeBotmuxCloudOrgMemberMock
}))

import {
  changeBotmuxProfileOrgMemberRole,
  inviteBotmuxProfileOrgMember,
  listBotmuxProfileOrgMembers,
  removeBotmuxProfileOrgMember,
  revokeBotmuxProfileOrgInvite
} from './profile-cloud-org-members-service'

const fakeSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  capabilities: { flags: {}, refreshedAt: 1 }
}

// Why: mirror the real contract — invoke the operation with a live session and
// surface its resolved value; business 4xx are returned by the operation as
// values, never thrown, so the session layer never sees them.
function runOperationDirectly(): void {
  runWithFreshBotmuxCloudSessionMock.mockImplementation(
    async (
      _config: unknown,
      _active: unknown,
      _path: unknown,
      op: (session: unknown) => unknown
    ) => ({
      status: 'ok',
      value: await op(fakeSession)
    })
  )
}

function configureCloudEnv(): void {
  vi.stubEnv('BOTMUX_CLOUD_API_URL', 'https://botmux-cloud.example')
  vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', 'desktop-client')
}

const roster: BotmuxOrgMembersRoster = {
  members: [{ userId: 'user-1', email: 'nina@example.com', role: 'owner' }],
  pendingInvites: [],
  viewerRole: 'owner',
  canManageMembers: true
}

describe('Botmux cloud org members service (configured)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-org-members-'))
    runWithFreshBotmuxCloudSessionMock.mockReset()
    listBotmuxCloudOrgMembersMock.mockReset()
    inviteBotmuxCloudOrgMemberMock.mockReset()
    revokeBotmuxCloudOrgInviteMock.mockReset()
    changeBotmuxCloudOrgMemberRoleMock.mockReset()
    removeBotmuxCloudOrgMemberMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('BOTMUX_CLOUD_DEV_AUTH', '')
    vi.stubEnv('BOTMUX_CLOUD_API_URL', '')
    vi.stubEnv('BOTMUX_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports unconfigured when cloud sign-in is not set up', async () => {
    await expect(listBotmuxProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'unconfigured'
    })
    expect(runWithFreshBotmuxCloudSessionMock).not.toHaveBeenCalled()
  })

  it('returns the roster from the client', async () => {
    configureCloudEnv()
    runOperationDirectly()
    listBotmuxCloudOrgMembersMock.mockResolvedValue(roster)

    await expect(listBotmuxProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'ok',
      roster
    })
    expect(listBotmuxCloudOrgMembersMock).toHaveBeenCalledWith(
      expect.any(Object),
      fakeSession,
      'org-1'
    )
  })

  it('maps a 409 already_member invite conflict', async () => {
    configureCloudEnv()
    runOperationDirectly()
    inviteBotmuxCloudOrgMemberMock.mockRejectedValue(new BotmuxCloudRequestError(409, 'already_member'))

    await expect(
      inviteBotmuxProfileOrgMember(userDataPath, { orgId: 'org-1', email: 'a@b.com', role: 'member' })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_member' })
  })

  it('maps a 403 role change to forbidden', async () => {
    configureCloudEnv()
    runOperationDirectly()
    changeBotmuxCloudOrgMemberRoleMock.mockRejectedValue(new BotmuxCloudRequestError(403))

    await expect(
      changeBotmuxProfileOrgMemberRole(userDataPath, {
        orgId: 'org-1',
        userId: 'user-2',
        role: 'admin'
      })
    ).resolves.toEqual({ status: 'forbidden' })
  })

  it('maps a 400 cannot_remove_self to an invalid result', async () => {
    configureCloudEnv()
    runOperationDirectly()
    removeBotmuxCloudOrgMemberMock.mockRejectedValue(
      new BotmuxCloudRequestError(400, 'cannot_remove_self')
    )

    await expect(
      removeBotmuxProfileOrgMember(userDataPath, { orgId: 'org-1', userId: 'user-1' })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_remove_self' })
  })

  it('maps a 404 revoke to not-found', async () => {
    configureCloudEnv()
    runOperationDirectly()
    revokeBotmuxCloudOrgInviteMock.mockRejectedValue(new BotmuxCloudRequestError(404))

    await expect(
      revokeBotmuxProfileOrgInvite(userDataPath, { orgId: 'org-1', email: 'gone@b.com' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('reports reconnect-required when the session layer cannot refresh', async () => {
    configureCloudEnv()
    runWithFreshBotmuxCloudSessionMock.mockResolvedValue({ status: 'reconnect-required' })

    await expect(listBotmuxProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'reconnect-required'
    })
  })
})

describe('Botmux cloud org members service (dev auth)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'botmux-org-members-dev-'))
    runWithFreshBotmuxCloudSessionMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('BOTMUX_CLOUD_DEV_AUTH', '1')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('serves an in-memory roster the caller can manage', async () => {
    const result = await listBotmuxProfileOrgMembers(userDataPath, 'dev-list-org')
    if (result.status !== 'ok') {
      throw new Error(`Expected ok, got ${result.status}`)
    }
    expect(result.roster.canManageMembers).toBe(true)
    expect(result.roster.viewerRole).toBe('owner')
    expect(result.roster.members[0]).toMatchObject({ role: 'owner' })
    expect(result.roster.members.some((member) => member.userId === null)).toBe(true)
    expect(result.roster.pendingInvites.length).toBeGreaterThan(0)
    expect(runWithFreshBotmuxCloudSessionMock).not.toHaveBeenCalled()
  })

  it('mutates the dev roster across invite and revoke', async () => {
    const orgId = 'dev-mutate-org'
    await expect(
      inviteBotmuxProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@botmux.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'ok' })

    const afterInvite = await listBotmuxProfileOrgMembers(userDataPath, orgId)
    if (afterInvite.status !== 'ok') {
      throw new Error('expected ok')
    }
    expect(afterInvite.roster.pendingInvites.some((i) => i.email === 'fresh@botmux.local')).toBe(true)

    await expect(
      inviteBotmuxProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@botmux.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_invited' })

    await expect(
      revokeBotmuxProfileOrgInvite(userDataPath, { orgId, email: 'fresh@botmux.local' })
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      revokeBotmuxProfileOrgInvite(userDataPath, { orgId, email: 'fresh@botmux.local' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('blocks changing the dev owner (self) role', async () => {
    const orgId = 'dev-self-org'
    const list = await listBotmuxProfileOrgMembers(userDataPath, orgId)
    if (list.status !== 'ok') {
      throw new Error('expected ok')
    }
    const self = list.roster.members.find((member) => member.role === 'owner')
    await expect(
      changeBotmuxProfileOrgMemberRole(userDataPath, {
        orgId,
        userId: self?.userId ?? 'dev-user',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_change_own_role' })
  })
})
