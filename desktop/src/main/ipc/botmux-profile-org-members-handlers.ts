import { ipcMain } from 'electron'
import type {
  BotmuxOrgRole,
  BotmuxProfileOrgInviteRevokeArgs,
  BotmuxProfileOrgMemberChangeRoleArgs,
  BotmuxProfileOrgMemberInviteArgs,
  BotmuxProfileOrgMemberMutationResult,
  BotmuxProfileOrgMemberRemoveArgs,
  BotmuxProfileOrgMembersListArgs,
  BotmuxProfileOrgMembersListResult
} from '../../shared/botmux-profiles'
import { getProfileUserDataPath } from '../botmux-profiles/profile-storage-paths'
import {
  changeBotmuxProfileOrgMemberRole,
  inviteBotmuxProfileOrgMember,
  listBotmuxProfileOrgMembers,
  removeBotmuxProfileOrgMember,
  revokeBotmuxProfileOrgInvite
} from '../botmux-profiles/profile-cloud-org-members-service'

function orgMembersScopedArgs(args: unknown): { orgId: string; record: Record<string, unknown> } {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_botmux_profile_org_selection')
  }
  const record = args as Record<string, unknown>
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_botmux_profile_org_selection')
  }
  return { orgId, record }
}

function orgRoleFromUnknown(value: unknown): BotmuxOrgRole {
  if (value === 'owner' || value === 'admin' || value === 'member') {
    return value
  }
  throw new Error('invalid_botmux_org_role')
}

function orgEmailFromUnknown(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (!email) {
    throw new Error('invalid_botmux_org_member_email')
  }
  return email
}

function orgUserIdFromUnknown(value: unknown): string {
  const userId = typeof value === 'string' ? value.trim() : ''
  if (!userId) {
    throw new Error('invalid_botmux_org_member_user')
  }
  return userId
}

function orgMemberInviteArgsFromUnknown(args: unknown): BotmuxProfileOrgMemberInviteArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email), role: orgRoleFromUnknown(record.role) }
}

function orgInviteRevokeArgsFromUnknown(args: unknown): BotmuxProfileOrgInviteRevokeArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email) }
}

function orgMemberChangeRoleArgsFromUnknown(args: unknown): BotmuxProfileOrgMemberChangeRoleArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return {
    orgId,
    userId: orgUserIdFromUnknown(record.userId),
    role: orgRoleFromUnknown(record.role)
  }
}

function orgMemberRemoveArgsFromUnknown(args: unknown): BotmuxProfileOrgMemberRemoveArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, userId: orgUserIdFromUnknown(record.userId) }
}

export function registerBotmuxProfileOrgMemberHandlers(): void {
  ipcMain.handle(
    'botmuxProfiles:orgMembersList',
    async (
      _event,
      rawArgs: BotmuxProfileOrgMembersListArgs
    ): Promise<BotmuxProfileOrgMembersListResult> =>
      listBotmuxProfileOrgMembers(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  ipcMain.handle(
    'botmuxProfiles:orgMemberInvite',
    async (
      _event,
      rawArgs: BotmuxProfileOrgMemberInviteArgs
    ): Promise<BotmuxProfileOrgMemberMutationResult> =>
      inviteBotmuxProfileOrgMember(getProfileUserDataPath(), orgMemberInviteArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'botmuxProfiles:orgInviteRevoke',
    async (
      _event,
      rawArgs: BotmuxProfileOrgInviteRevokeArgs
    ): Promise<BotmuxProfileOrgMemberMutationResult> =>
      revokeBotmuxProfileOrgInvite(getProfileUserDataPath(), orgInviteRevokeArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'botmuxProfiles:orgMemberChangeRole',
    async (
      _event,
      rawArgs: BotmuxProfileOrgMemberChangeRoleArgs
    ): Promise<BotmuxProfileOrgMemberMutationResult> =>
      changeBotmuxProfileOrgMemberRole(
        getProfileUserDataPath(),
        orgMemberChangeRoleArgsFromUnknown(rawArgs)
      )
  )

  ipcMain.handle(
    'botmuxProfiles:orgMemberRemove',
    async (
      _event,
      rawArgs: BotmuxProfileOrgMemberRemoveArgs
    ): Promise<BotmuxProfileOrgMemberMutationResult> =>
      removeBotmuxProfileOrgMember(getProfileUserDataPath(), orgMemberRemoveArgsFromUnknown(rawArgs))
  )
}
