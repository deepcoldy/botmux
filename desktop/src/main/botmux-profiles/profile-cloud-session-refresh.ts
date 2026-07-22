import type { BotmuxCloudAuthConfig } from './profile-cloud-auth-config'
import type { ActiveBotmuxProfileState } from './profile-index-store'
import {
  clearBotmuxCloudSession,
  type BotmuxCloudSession,
  readBotmuxCloudSession,
  saveBotmuxCloudSessionIfCurrent
} from './profile-cloud-session-store'
import { BotmuxCloudRequestError, refreshBotmuxCloudSession } from './profile-cloud-client'
import { linkBotmuxProfileToCloud } from './profile-cloud-index'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  tombstoneCloudSession
} from './profile-cloud-session-mutation'

const CLOUD_SESSION_REFRESH_SKEW_MS = 60_000

export type FreshCloudSessionResult =
  | { status: 'found'; session: BotmuxCloudSession }
  | { status: 'reconnect-required' }

export type CloudSessionOperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }

function shouldRefreshCloudSession(session: BotmuxCloudSession, now = Date.now()): boolean {
  return session.expiresAt <= now + CLOUD_SESSION_REFRESH_SKEW_MS
}

export function isBotmuxCloudAuthFailure(error: unknown): boolean {
  return (
    error instanceof BotmuxCloudRequestError && (error.statusCode === 401 || error.statusCode === 403)
  )
}

const inflightCloudSessionRefreshes = new Map<string, Promise<BotmuxCloudSession>>()

class StaleCloudSessionMutationError extends Error {
  constructor() {
    super('stale_cloud_session_mutation')
  }
}

function cloudSessionRefreshKey(profileId: string, userDataPath: string): string {
  return `${userDataPath}\0${profileId}`
}

// Why: with refresh-token rotation, only the session that actually failed may
// clear the store; otherwise a loser of a concurrent refresh race would wipe
// the winner's freshly rotated session.
function clearCloudSessionIfUnchanged(
  profileId: string,
  userDataPath: string,
  failed: BotmuxCloudSession,
  active: ActiveBotmuxProfileState
): void {
  const current = readBotmuxCloudSession(profileId, userDataPath)
  if (current.status === 'found' && current.session.refreshToken !== failed.refreshToken) {
    return
  }
  if (active.profile.cloud) {
    tombstoneCloudSession(
      cloudSessionIdentity(active.profile.id, active.profile.cloud),
      userDataPath
    )
  }
  clearBotmuxCloudSession(profileId, userDataPath)
}

async function refreshStoredCloudSession(
  config: BotmuxCloudAuthConfig,
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  session: BotmuxCloudSession
): Promise<BotmuxCloudSession> {
  // Why: refresh tokens rotate, so concurrent refreshes must single-flight;
  // a second POST with the same refresh token can trip server reuse detection
  // and revoke the whole token family.
  const key = cloudSessionRefreshKey(active.profile.id, userDataPath)
  const inflight = inflightCloudSessionRefreshes.get(key)
  if (inflight) {
    return inflight
  }
  const task = (async () => {
    const current = readBotmuxCloudSession(active.profile.id, userDataPath)
    if (current.status === 'found' && current.session.refreshToken !== session.refreshToken) {
      // Another caller already rotated this session; reuse its result.
      return current.session
    }
    if (!active.profile.cloud) {
      throw new StaleCloudSessionMutationError()
    }
    const expectedIdentity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    const snapshot = captureCloudSessionMutation(expectedIdentity, userDataPath)
    const refreshed = await refreshBotmuxCloudSession(config, session)
    const refreshedIdentity = cloudSessionIdentity(active.profile.id, refreshed.cloud)
    if (
      refreshedIdentity.cloudUserId !== expectedIdentity.cloudUserId ||
      refreshedIdentity.cloudProfileId !== expectedIdentity.cloudProfileId ||
      refreshedIdentity.organizationId !== expectedIdentity.organizationId
    ) {
      throw new StaleCloudSessionMutationError()
    }
    const nextSession = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      organizations: refreshed.organizations,
      capabilities: refreshed.capabilities
    }
    if (
      saveBotmuxCloudSessionIfCurrent(active.profile.id, userDataPath, nextSession, snapshot) === null
    ) {
      throw new StaleCloudSessionMutationError()
    }
    linkBotmuxProfileToCloud(active.profile.id, refreshed.cloud, userDataPath)
    return nextSession
  })()
  inflightCloudSessionRefreshes.set(key, task)
  try {
    return await task
  } finally {
    inflightCloudSessionRefreshes.delete(key)
  }
}

export async function readFreshBotmuxCloudSession(
  config: BotmuxCloudAuthConfig,
  active: ActiveBotmuxProfileState,
  userDataPath: string
): Promise<FreshCloudSessionResult> {
  const session = readBotmuxCloudSession(active.profile.id, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  if (!shouldRefreshCloudSession(session.session)) {
    return { status: 'found', session: session.session }
  }
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session.session)
    }
  } catch (error) {
    if (isBotmuxCloudAuthFailure(error)) {
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session.session, active)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function forceRefreshBotmuxCloudSession(
  config: BotmuxCloudAuthConfig,
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  session: BotmuxCloudSession
): Promise<FreshCloudSessionResult> {
  try {
    return {
      status: 'found',
      session: await refreshStoredCloudSession(config, active, userDataPath, session)
    }
  } catch (error) {
    if (isBotmuxCloudAuthFailure(error)) {
      clearCloudSessionIfUnchanged(active.profile.id, userDataPath, session, active)
      return { status: 'reconnect-required' }
    }
    throw error
  }
}

export async function runWithFreshBotmuxCloudSession<T>(
  config: BotmuxCloudAuthConfig,
  active: ActiveBotmuxProfileState,
  userDataPath: string,
  operation: (session: BotmuxCloudSession) => Promise<T>
): Promise<CloudSessionOperationResult<T>> {
  const session = await readFreshBotmuxCloudSession(config, active, userDataPath)
  if (session.status !== 'found') {
    return { status: 'reconnect-required' }
  }
  try {
    return { status: 'ok', value: await operation(session.session) }
  } catch (error) {
    if (!isBotmuxCloudAuthFailure(error)) {
      throw error
    }
    const refreshed = await forceRefreshBotmuxCloudSession(
      config,
      active,
      userDataPath,
      session.session
    )
    if (refreshed.status !== 'found') {
      return { status: 'reconnect-required' }
    }
    try {
      return { status: 'ok', value: await operation(refreshed.session) }
    } catch (retryError) {
      // Why: a 401 after a successful refresh means the session itself is
      // rejected. A 403 is an authorization (permission) failure — signing
      // the user out for it would destroy a valid session, so let it surface
      // as a failed operation instead.
      if (retryError instanceof BotmuxCloudRequestError && retryError.statusCode === 401) {
        clearCloudSessionIfUnchanged(active.profile.id, userDataPath, refreshed.session, active)
        return { status: 'reconnect-required' }
      }
      throw retryError
    }
  }
}
