import type {
  ConnectCurrentBotmuxProfileResult,
  CreateCloudLinkedBotmuxProfileArgs,
  CreateCloudLinkedBotmuxProfileResult,
  BotmuxProfileAuthStatus,
  SelectBotmuxProfileOrgResult,
  SignOutCurrentBotmuxProfileResult
} from '../../shared/botmux-profiles'
import { ensureActiveBotmuxProfile } from './profile-index-store'
import { getBotmuxCloudAuthConfig, isBotmuxCloudDevAuthEnabled } from './profile-cloud-auth-config'
import {
  clearBotmuxCloudSession,
  readBotmuxCloudSession,
  saveBotmuxCloudSessionExchange
} from './profile-cloud-session-store'
import { cloudSessionIdentity, tombstoneCloudSession } from './profile-cloud-session-mutation'
import {
  createBotmuxCloudProfile,
  exchangeBotmuxCloudAuthCode,
  revokeBotmuxCloudSession
} from './profile-cloud-client'
import { beginBotmuxCloudPkceFlow } from './profile-cloud-pkce'
import {
  createCloudLinkedBotmuxProfileRecord,
  linkBotmuxProfileToCloud,
  unlinkBotmuxProfileFromCloud
} from './profile-cloud-index'
import { runWithFreshBotmuxCloudSession } from './profile-cloud-session-refresh'
import {
  connectDevBotmuxCloudProfile,
  createDevCloudLinkedBotmuxProfile,
  selectDevBotmuxCloudOrg
} from './profile-cloud-dev-service'
import { getBotmuxProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { selectCloudOrgWithMutationFence } from './profile-cloud-org-selection'

export { refreshCurrentBotmuxProfileAuth } from './profile-cloud-capability-refresh'

function isUserCancelledAuthError(message: string): boolean {
  return message === 'botmux_cloud_auth_timeout' || message === 'botmux_cloud_auth_denied'
}

function activeAuth(
  active: ReturnType<typeof ensureActiveBotmuxProfile>,
  userDataPath: string
): BotmuxProfileAuthStatus {
  return getBotmuxProfileAuthStatusFromProfile(active, userDataPath)
}

export function getCurrentBotmuxProfileAuthStatus(userDataPath: string): BotmuxProfileAuthStatus {
  return getBotmuxProfileAuthStatusFromProfile(ensureActiveBotmuxProfile(userDataPath), userDataPath)
}

export async function connectCurrentBotmuxProfile(
  userDataPath: string
): Promise<ConnectCurrentBotmuxProfileResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    const list = connectDevBotmuxCloudProfile(active, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  }

  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: activeAuth(active, userDataPath)
    }
  }

  try {
    const code = await beginBotmuxCloudPkceFlow(configState.config, active.profile.id)
    const exchange = await exchangeBotmuxCloudAuthCode(configState.config, {
      ...code,
      localProfileId: active.profile.id
    })
    saveBotmuxCloudSessionExchange(active.profile.id, userDataPath, exchange)
    const list = linkBotmuxProfileToCloud(active.profile.id, exchange.cloud, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isUserCancelledAuthError(message)) {
      return {
        status: 'cancelled',
        auth: getCurrentBotmuxProfileAuthStatus(userDataPath)
      }
    }
    return {
      status: 'failed',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      error: message
    }
  }
}

export async function signOutCurrentBotmuxProfile(
  userDataPath: string
): Promise<SignOutCurrentBotmuxProfileResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  const configState = getBotmuxCloudAuthConfig()
  const session = readBotmuxCloudSession(active.profile.id, userDataPath)
  if (active.profile.cloud) {
    // Why: persist the destructive fence before logout network I/O so a
    // refresh already in flight cannot save after explicit sign-out.
    tombstoneCloudSession(
      cloudSessionIdentity(active.profile.id, active.profile.cloud),
      userDataPath
    )
  }
  if (!isBotmuxCloudDevAuthEnabled() && configState.configured && session.status === 'found') {
    await revokeBotmuxCloudSession(configState.config, session.session).catch(() => undefined)
  }
  clearBotmuxCloudSession(active.profile.id, userDataPath)
  const list = unlinkBotmuxProfileFromCloud(active.profile.id, userDataPath)
  return {
    status: 'signed-out',
    auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
    activeProfileId: list.activeProfileId,
    profiles: list.profiles
  }
}

export async function createCloudLinkedBotmuxProfile(
  userDataPath: string,
  args: CreateCloudLinkedBotmuxProfileArgs
): Promise<CreateCloudLinkedBotmuxProfileResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    const result = createDevCloudLinkedBotmuxProfile(active, userDataPath, args)
    if (result.status !== 'created') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'created',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles,
      profile: result.list.profile
    }
  }

  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const operation = await runWithFreshBotmuxCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => createBotmuxCloudProfile(configState.config, session, args)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    const created = operation.value
    const list = createCloudLinkedBotmuxProfileRecord(
      created.cloud,
      { name: args.name },
      userDataPath
    )
    saveBotmuxCloudSessionExchange(list.profile.id, userDataPath, created)
    return {
      status: 'created',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles,
      profile: list.profile
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function selectCurrentBotmuxProfileOrg(
  userDataPath: string,
  orgId: string
): Promise<SelectBotmuxProfileOrgResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  if (isBotmuxCloudDevAuthEnabled()) {
    const result = selectDevBotmuxCloudOrg(active, userDataPath, orgId)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }

  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const list = await selectCloudOrgWithMutationFence({
      config: configState.config,
      active,
      userDataPath,
      orgId
    })
    if (!list) {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentBotmuxProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
