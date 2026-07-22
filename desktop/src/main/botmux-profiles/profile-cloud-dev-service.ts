import type {
  CreateCloudLinkedBotmuxProfileArgs,
  BotmuxProfileListState
} from '../../shared/botmux-profiles'
import type { ActiveBotmuxProfileState } from './profile-index-store'
import { createCloudLinkedBotmuxProfileRecord, linkBotmuxProfileToCloud } from './profile-cloud-index'
import { readBotmuxCloudSession, saveBotmuxCloudSessionExchange } from './profile-cloud-session-store'
import { createDevBotmuxCloudSession } from './profile-cloud-dev-auth'

type DevProfileListResult = BotmuxProfileListState

type DevCreateProfileResult =
  | {
      status: 'created'
      list: ReturnType<typeof createCloudLinkedBotmuxProfileRecord>
    }
  | { status: 'reconnect-required' }

type DevMutationResult =
  | {
      status: 'updated'
      list: DevProfileListResult
    }
  | { status: 'reconnect-required' }

export function connectDevBotmuxCloudProfile(
  active: ActiveBotmuxProfileState,
  userDataPath: string
): DevProfileListResult {
  const session = createDevBotmuxCloudSession({ localProfileId: active.profile.id })
  saveBotmuxCloudSessionExchange(active.profile.id, userDataPath, session)
  return linkBotmuxProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export function createDevCloudLinkedBotmuxProfile(
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  args: CreateCloudLinkedBotmuxProfileArgs
): DevCreateProfileResult {
  if (readBotmuxCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevBotmuxCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedBotmuxProfileRecord(session.cloud, { name: args.name }, userDataPath)
  saveBotmuxCloudSessionExchange(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export function refreshDevBotmuxCloudProfile(
  active: ActiveBotmuxProfileState,
  userDataPath: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readBotmuxCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevBotmuxCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  saveBotmuxCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkBotmuxProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}

export function selectDevBotmuxCloudOrg(
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  orgId: string
): DevMutationResult {
  if (
    !active.profile.cloud ||
    readBotmuxCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevBotmuxCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  saveBotmuxCloudSessionExchange(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: linkBotmuxProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
