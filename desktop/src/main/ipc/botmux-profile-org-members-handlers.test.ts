import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  listBotmuxProfileOrgMembersMock,
  inviteBotmuxProfileOrgMemberMock,
  revokeBotmuxProfileOrgInviteMock,
  changeBotmuxProfileOrgMemberRoleMock,
  removeBotmuxProfileOrgMemberMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listBotmuxProfileOrgMembersMock: vi.fn(),
  inviteBotmuxProfileOrgMemberMock: vi.fn(),
  revokeBotmuxProfileOrgInviteMock: vi.fn(),
  changeBotmuxProfileOrgMemberRoleMock: vi.fn(),
  removeBotmuxProfileOrgMemberMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../botmux-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/botmux-user-data'
}))

vi.mock('../botmux-profiles/profile-cloud-org-members-service', () => ({
  listBotmuxProfileOrgMembers: listBotmuxProfileOrgMembersMock,
  inviteBotmuxProfileOrgMember: inviteBotmuxProfileOrgMemberMock,
  revokeBotmuxProfileOrgInvite: revokeBotmuxProfileOrgInviteMock,
  changeBotmuxProfileOrgMemberRole: changeBotmuxProfileOrgMemberRoleMock,
  removeBotmuxProfileOrgMember: removeBotmuxProfileOrgMemberMock
}))

import { registerBotmuxProfileOrgMemberHandlers } from './botmux-profile-org-members-handlers'

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler for ${channel}`)
  }
  return handler({}, args)
}

describe('registerBotmuxProfileOrgMemberHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listBotmuxProfileOrgMembersMock.mockReset().mockResolvedValue({ status: 'ok', roster: {} })
    inviteBotmuxProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    revokeBotmuxProfileOrgInviteMock.mockReset().mockResolvedValue({ status: 'ok' })
    changeBotmuxProfileOrgMemberRoleMock.mockReset().mockResolvedValue({ status: 'ok' })
    removeBotmuxProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    registerBotmuxProfileOrgMemberHandlers()
  })

  it('registers all five org-member channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'botmuxProfiles:orgInviteRevoke',
        'botmuxProfiles:orgMemberChangeRole',
        'botmuxProfiles:orgMemberInvite',
        'botmuxProfiles:orgMemberRemove',
        'botmuxProfiles:orgMembersList'
      ].sort()
    )
  })

  it('forwards a valid invite to the service with a trimmed email', async () => {
    await invoke('botmuxProfiles:orgMemberInvite', {
      orgId: 'org-1',
      email: '  new@example.com  ',
      role: 'admin'
    })
    expect(inviteBotmuxProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/botmux-user-data', {
      orgId: 'org-1',
      email: 'new@example.com',
      role: 'admin'
    })
  })

  it('rejects an invite with a missing org id', async () => {
    await expect(
      invoke('botmuxProfiles:orgMemberInvite', { email: 'a@b.com', role: 'member' })
    ).rejects.toThrow('invalid_botmux_profile_org_selection')
    expect(inviteBotmuxProfileOrgMemberMock).not.toHaveBeenCalled()
  })

  it('rejects an invite with an unknown role', async () => {
    await expect(
      invoke('botmuxProfiles:orgMemberInvite', { orgId: 'org-1', email: 'a@b.com', role: 'root' })
    ).rejects.toThrow('invalid_botmux_org_role')
  })

  it('rejects a role change with a blank user id', async () => {
    await expect(
      invoke('botmuxProfiles:orgMemberChangeRole', { orgId: 'org-1', userId: '  ', role: 'admin' })
    ).rejects.toThrow('invalid_botmux_org_member_user')
  })

  it('forwards remove and revoke with validated args', async () => {
    await invoke('botmuxProfiles:orgMemberRemove', { orgId: 'org-1', userId: 'user-2' })
    expect(removeBotmuxProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/botmux-user-data', {
      orgId: 'org-1',
      userId: 'user-2'
    })
    await invoke('botmuxProfiles:orgInviteRevoke', { orgId: 'org-1', email: 'gone@b.com' })
    expect(revokeBotmuxProfileOrgInviteMock).toHaveBeenCalledWith('/tmp/botmux-user-data', {
      orgId: 'org-1',
      email: 'gone@b.com'
    })
  })
})
