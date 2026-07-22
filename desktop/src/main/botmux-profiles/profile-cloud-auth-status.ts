import type { BotmuxProfileAuthStatus } from '../../shared/botmux-profiles'
import type { ActiveBotmuxProfileState } from './profile-index-store'
import { getBotmuxCloudAuthConfig, isBotmuxCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { readBotmuxCloudSession } from './profile-cloud-session-store'

export function getBotmuxProfileAuthStatusFromProfile(
  active: ActiveBotmuxProfileState,
  userDataPath: string
): BotmuxProfileAuthStatus {
  const configState = getBotmuxCloudAuthConfig()
  const devAuthEnabled = isBotmuxCloudDevAuthEnabled()
  const configured = configState.configured || devAuthEnabled
  const cloud = active.profile.cloud
  if (!cloud) {
    return {
      activeProfileId: active.profile.id,
      configured,
      state: configured ? 'local' : 'unconfigured',
      persistence: 'none',
      setupMessage: configured ? undefined : configState.setupMessage
    }
  }

  const session = readBotmuxCloudSession(active.profile.id, userDataPath)
  if (!configured) {
    return {
      activeProfileId: active.profile.id,
      configured: false,
      state: 'unconfigured',
      persistence: session.status === 'found' ? session.persistence : 'none',
      cloud,
      credentialError: session.status === 'decrypt-failed' ? session.error : undefined,
      setupMessage: configState.setupMessage
    }
  }
  if (session.status === 'found') {
    return {
      activeProfileId: active.profile.id,
      configured,
      state: 'connected',
      persistence: session.persistence,
      cloud,
      organizations: session.session.organizations,
      capabilities: session.session.capabilities
    }
  }

  return {
    activeProfileId: active.profile.id,
    configured,
    state: 'reconnect-required',
    persistence: 'none',
    cloud,
    credentialError: session.status === 'decrypt-failed' ? session.error : undefined
  }
}
