import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  listOrcaProfileOrgMembersMock,
  inviteOrcaProfileOrgMemberMock,
  revokeOrcaProfileOrgInviteMock,
  changeOrcaProfileOrgMemberRoleMock,
  removeOrcaProfileOrgMemberMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listOrcaProfileOrgMembersMock: vi.fn(),
  inviteOrcaProfileOrgMemberMock: vi.fn(),
  revokeOrcaProfileOrgInviteMock: vi.fn(),
  changeOrcaProfileOrgMemberRoleMock: vi.fn(),
  removeOrcaProfileOrgMemberMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../orca-botmux-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/orca-botmux-user-data'
}))

vi.mock('../orca-botmux-profiles/profile-cloud-org-members-service', () => ({
  listOrcaProfileOrgMembers: listOrcaProfileOrgMembersMock,
  inviteOrcaProfileOrgMember: inviteOrcaProfileOrgMemberMock,
  revokeOrcaProfileOrgInvite: revokeOrcaProfileOrgInviteMock,
  changeOrcaProfileOrgMemberRole: changeOrcaProfileOrgMemberRoleMock,
  removeOrcaProfileOrgMember: removeOrcaProfileOrgMemberMock
}))

import { registerOrcaProfileOrgMemberHandlers } from './orca-botmux-profile-org-members-handlers'

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler for ${channel}`)
  }
  return handler({}, args)
}

describe('registerOrcaProfileOrgMemberHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listOrcaProfileOrgMembersMock.mockReset().mockResolvedValue({ status: 'ok', roster: {} })
    inviteOrcaProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    revokeOrcaProfileOrgInviteMock.mockReset().mockResolvedValue({ status: 'ok' })
    changeOrcaProfileOrgMemberRoleMock.mockReset().mockResolvedValue({ status: 'ok' })
    removeOrcaProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    registerOrcaProfileOrgMemberHandlers()
  })

  it('registers all five org-member channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'orcaBotmuxProfiles:orgInviteRevoke',
        'orcaBotmuxProfiles:orgMemberChangeRole',
        'orcaBotmuxProfiles:orgMemberInvite',
        'orcaBotmuxProfiles:orgMemberRemove',
        'orcaBotmuxProfiles:orgMembersList'
      ].sort()
    )
  })

  it('forwards a valid invite to the service with a trimmed email', async () => {
    await invoke('orcaBotmuxProfiles:orgMemberInvite', {
      orgId: 'org-1',
      email: '  new@example.com  ',
      role: 'admin'
    })
    expect(inviteOrcaProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/orca-botmux-user-data', {
      orgId: 'org-1',
      email: 'new@example.com',
      role: 'admin'
    })
  })

  it('rejects an invite with a missing org id', async () => {
    await expect(
      invoke('orcaBotmuxProfiles:orgMemberInvite', { email: 'a@b.com', role: 'member' })
    ).rejects.toThrow('invalid_orca_profile_org_selection')
    expect(inviteOrcaProfileOrgMemberMock).not.toHaveBeenCalled()
  })

  it('rejects an invite with an unknown role', async () => {
    await expect(
      invoke('orcaBotmuxProfiles:orgMemberInvite', { orgId: 'org-1', email: 'a@b.com', role: 'root' })
    ).rejects.toThrow('invalid_orca_org_role')
  })

  it('rejects a role change with a blank user id', async () => {
    await expect(
      invoke('orcaBotmuxProfiles:orgMemberChangeRole', { orgId: 'org-1', userId: '  ', role: 'admin' })
    ).rejects.toThrow('invalid_orca_org_member_user')
  })

  it('forwards remove and revoke with validated args', async () => {
    await invoke('orcaBotmuxProfiles:orgMemberRemove', { orgId: 'org-1', userId: 'user-2' })
    expect(removeOrcaProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/orca-botmux-user-data', {
      orgId: 'org-1',
      userId: 'user-2'
    })
    await invoke('orcaBotmuxProfiles:orgInviteRevoke', { orgId: 'org-1', email: 'gone@b.com' })
    expect(revokeOrcaProfileOrgInviteMock).toHaveBeenCalledWith('/tmp/orca-botmux-user-data', {
      orgId: 'org-1',
      email: 'gone@b.com'
    })
  })
})
