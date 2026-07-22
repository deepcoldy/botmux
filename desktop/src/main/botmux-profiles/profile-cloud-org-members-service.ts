import type {
  BotmuxProfileOrgInviteRevokeArgs,
  BotmuxProfileOrgMemberChangeRoleArgs,
  BotmuxProfileOrgMemberInviteArgs,
  BotmuxProfileOrgMemberMutationResult,
  BotmuxProfileOrgMemberRemoveArgs,
  BotmuxProfileOrgMembersListResult
} from '../../shared/botmux-profiles'
import type { ActiveBotmuxProfileState } from './profile-index-store'
import { ensureActiveBotmuxProfile } from './profile-index-store'
import type { BotmuxCloudAuthConfig } from './profile-cloud-auth-config'
import { getBotmuxCloudAuthConfig, isBotmuxCloudDevAuthEnabled } from './profile-cloud-auth-config'
import type { BotmuxCloudSession } from './profile-cloud-session-store'
import { BotmuxCloudRequestError } from './profile-cloud-client'
import { runWithFreshBotmuxCloudSession } from './profile-cloud-session-refresh'
import {
  changeBotmuxCloudOrgMemberRole,
  inviteBotmuxCloudOrgMember,
  listBotmuxCloudOrgMembers,
  removeBotmuxCloudOrgMember,
  revokeBotmuxCloudOrgInvite
} from './profile-cloud-org-members-client'
import {
  changeDevBotmuxCloudOrgMemberRole,
  inviteDevBotmuxCloudOrgMember,
  listDevBotmuxCloudOrgMembers,
  removeDevBotmuxCloudOrgMember,
  revokeDevBotmuxCloudOrgInvite
} from './profile-cloud-dev-org-members'

type OrgCallResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'request-error'; error: BotmuxCloudRequestError }
  | { status: 'failed'; error: string }

// Why: only a 401 means the token itself is stale and should drive a session
// refresh/reconnect. 403/404/409/400 are business or permission outcomes the UI
// must interpret, so they are surfaced as values rather than thrown — otherwise
// runWithFreshBotmuxCloudSession would treat a 403 as an auth failure and burn a
// pointless token refresh + retry before giving up.
async function runOrgMemberCall<T>(
  config: BotmuxCloudAuthConfig,
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  call: (session: BotmuxCloudSession) => Promise<T>
): Promise<OrgCallResult<T>> {
  try {
    const operation = await runWithFreshBotmuxCloudSession(
      config,
      active,
      userDataPath,
      async (session) => {
        try {
          return { ok: true as const, value: await call(session) }
        } catch (error) {
          if (error instanceof BotmuxCloudRequestError && error.statusCode !== 401) {
            return { ok: false as const, error }
          }
          throw error
        }
      }
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required' }
    }
    const outcome = operation.value
    return outcome.ok
      ? { status: 'ok', value: outcome.value }
      : { status: 'request-error', error: outcome.error }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

function mapMutationRequestError(error: BotmuxCloudRequestError): BotmuxProfileOrgMemberMutationResult {
  switch (error.statusCode) {
    case 403:
      return { status: 'forbidden' }
    case 404:
      return { status: 'not-found' }
    case 409:
      return {
        status: 'conflict',
        reason: error.errorCode === 'already_member' ? 'already_member' : 'already_invited'
      }
    case 400:
      return {
        status: 'invalid',
        reason:
          error.errorCode === 'cannot_remove_self' ? 'cannot_remove_self' : 'cannot_change_own_role'
      }
    default:
      return { status: 'failed', error: error.message }
  }
}

function mapMutationResult(result: OrgCallResult<void>): BotmuxProfileOrgMemberMutationResult {
  switch (result.status) {
    case 'ok':
      return { status: 'ok' }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return mapMutationRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function listBotmuxProfileOrgMembers(
  userDataPath: string,
  orgId: string
): Promise<BotmuxProfileOrgMembersListResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    return { status: 'ok', roster: listDevBotmuxCloudOrgMembers(orgId) }
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    listBotmuxCloudOrgMembers(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', roster: result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return { status: 'failed', error: result.error.message }
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function inviteBotmuxProfileOrgMember(
  userDataPath: string,
  args: BotmuxProfileOrgMemberInviteArgs
): Promise<BotmuxProfileOrgMemberMutationResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    return inviteDevBotmuxCloudOrgMember(args)
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      inviteBotmuxCloudOrgMember(configState.config, session, args)
    )
  )
}

export async function revokeBotmuxProfileOrgInvite(
  userDataPath: string,
  args: BotmuxProfileOrgInviteRevokeArgs
): Promise<BotmuxProfileOrgMemberMutationResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    return revokeDevBotmuxCloudOrgInvite(args)
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      revokeBotmuxCloudOrgInvite(configState.config, session, args)
    )
  )
}

export async function changeBotmuxProfileOrgMemberRole(
  userDataPath: string,
  args: BotmuxProfileOrgMemberChangeRoleArgs
): Promise<BotmuxProfileOrgMemberMutationResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    return changeDevBotmuxCloudOrgMemberRole(args)
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      changeBotmuxCloudOrgMemberRole(configState.config, session, args)
    )
  )
}

export async function removeBotmuxProfileOrgMember(
  userDataPath: string,
  args: BotmuxProfileOrgMemberRemoveArgs
): Promise<BotmuxProfileOrgMemberMutationResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    return removeDevBotmuxCloudOrgMember(args)
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  return mapMutationResult(
    await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
      removeBotmuxCloudOrgMember(configState.config, session, args)
    )
  )
}
