import type { RefreshCurrentBotmuxProfileAuthResult } from '../../shared/botmux-profiles'
import { getBotmuxCloudAuthConfig, isBotmuxCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getBotmuxProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshBotmuxCloudCapabilities } from './profile-cloud-client'
import { linkBotmuxProfileToCloud } from './profile-cloud-index'
import { ensureActiveBotmuxProfile, getBotmuxProfileListState } from './profile-index-store'
import { refreshDevBotmuxCloudProfile } from './profile-cloud-dev-service'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import { runWithFreshBotmuxCloudSession } from './profile-cloud-session-refresh'
import { readBotmuxCloudSession, saveBotmuxCloudSessionIfCurrent } from './profile-cloud-session-store'

export async function refreshCurrentBotmuxProfileAuth(
  userDataPath: string
): Promise<RefreshCurrentBotmuxProfileAuthResult> {
  const active = ensureActiveBotmuxProfile(userDataPath)
  const auth = () => getBotmuxProfileAuthStatusFromProfile(active, userDataPath)
  if (!active.profile.cloud) {
    return { status: 'local', auth: auth() }
  }
  if (isBotmuxCloudDevAuthEnabled()) {
    const result = refreshDevBotmuxCloudProfile(active, userDataPath)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: auth() }
    }
    return {
      status: 'refreshed',
      auth: auth(),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }
  const configState = getBotmuxCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: auth() }
  }
  try {
    const identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    let mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
    const operation = await runWithFreshBotmuxCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => refreshBotmuxCloudCapabilities(configState.config, session)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (refresh.cloud) {
      const refreshedIdentity = cloudSessionIdentity(active.profile.id, refresh.cloud)
      if (
        refreshedIdentity.cloudUserId !== identity.cloudUserId ||
        refreshedIdentity.cloudProfileId !== identity.cloudProfileId
      ) {
        throw new Error('botmux_cloud_identity_changed_during_capability_refresh')
      }
      if (refreshedIdentity.organizationId !== identity.organizationId) {
        const advanced = recordCloudSessionIdentityMutationIfCurrent(
          refreshedIdentity,
          userDataPath,
          mutationSnapshot
        )
        if (!advanced) {
          return { status: 'reconnect-required', auth: auth() }
        }
        mutationSnapshot = advanced
      }
    }
    const session = readBotmuxCloudSession(active.profile.id, userDataPath)
    if (session.status !== 'found') {
      return { status: 'reconnect-required', auth: auth() }
    }
    if (
      saveBotmuxCloudSessionIfCurrent(
        active.profile.id,
        userDataPath,
        {
          ...session.session,
          organizations: refresh.organizations ?? session.session.organizations,
          capabilities: refresh.capabilities
        },
        mutationSnapshot
      ) === null
    ) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const list = refresh.cloud
      ? linkBotmuxProfileToCloud(active.profile.id, refresh.cloud, userDataPath)
      : getBotmuxProfileListState(userDataPath)
    return {
      status: 'refreshed',
      auth: getBotmuxProfileAuthStatusFromProfile(
        ensureActiveBotmuxProfile(userDataPath),
        userDataPath
      ),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: auth(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
