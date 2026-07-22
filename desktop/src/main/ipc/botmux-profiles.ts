import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { relaunchApp, type AppRelaunchReason } from '../app-relaunch'
import type {
  CreateLocalBotmuxProfileArgs,
  CreateLocalBotmuxProfileResult,
  CreateCloudLinkedBotmuxProfileArgs,
  CreateCloudLinkedBotmuxProfileResult,
  FindBotmuxProfileProjectsByPathArgs,
  FindBotmuxProfileProjectsByPathResult,
  BotmuxProfileListResult,
  RefreshCurrentBotmuxProfileAuthResult,
  SwitchBotmuxProfileArgs,
  SwitchBotmuxProfileResult,
  TransferBotmuxProfileProjectArgs,
  TransferBotmuxProfileProjectResult,
  ConnectCurrentBotmuxProfileResult,
  BotmuxProfileAuthStatus,
  SelectBotmuxProfileOrgArgs,
  SelectBotmuxProfileOrgResult,
  SignOutCurrentBotmuxProfileResult
} from '../../shared/botmux-profiles'
import {
  createLocalBotmuxProfile,
  getBotmuxProfileListState,
  seedNewBotmuxProfileTelemetryConsent,
  setActiveBotmuxProfile
} from '../botmux-profiles/profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation
} from '../botmux-profiles/profile-cloud-session-mutation'
import { getProfileUserDataPath } from '../botmux-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../botmux-profiles/profile-ui-scope'
import { transferBotmuxProfileProject } from '../botmux-profiles/profile-project-transfer'
import { findBotmuxProfileProjectsByPath } from '../botmux-profiles/profile-project-presence'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import {
  createCloudLinkedBotmuxProfile,
  connectCurrentBotmuxProfile,
  getCurrentBotmuxProfileAuthStatus,
  refreshCurrentBotmuxProfileAuth,
  selectCurrentBotmuxProfileOrg,
  signOutCurrentBotmuxProfile
} from '../botmux-profiles/profile-cloud-service'
import { registerBotmuxProfileOrgMemberHandlers } from './botmux-profile-org-members-handlers'

type RegisterBotmuxProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onAuthMutation?: () => void
  onBeforeSignOut?: () => void
}

function profileIdFromArgs(args: unknown): string {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as SwitchBotmuxProfileArgs).profileId !== 'string'
  ) {
    throw new Error('invalid_botmux_profile_id')
  }
  const profileId = (args as SwitchBotmuxProfileArgs).profileId.trim()
  if (!profileId) {
    throw new Error('invalid_botmux_profile_id')
  }
  return profileId
}

function transferProjectArgsFromUnknown(args: unknown): TransferBotmuxProfileProjectArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_botmux_profile_project_transfer')
  }
  const candidate = args as TransferBotmuxProfileProjectArgs
  const sourceProfileId = candidate.sourceProfileId?.trim()
  const targetProfileId = candidate.targetProfileId?.trim()
  const repoId = candidate.repoId?.trim()
  const mode = candidate.mode
  if (!sourceProfileId || !targetProfileId || !repoId || (mode !== 'move' && mode !== 'copy')) {
    throw new Error('invalid_botmux_profile_project_transfer')
  }
  return {
    sourceProfileId,
    targetProfileId,
    repoId,
    mode
  }
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindBotmuxProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_botmux_profile_project_path')
  }
  const candidate = args as FindBotmuxProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_botmux_profile_project_path')
  }
  let executionHostId: FindBotmuxProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_botmux_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_botmux_profile_project_path')
    }
  }
  return {
    path,
    connectionId:
      typeof candidate.connectionId === 'string' ? candidate.connectionId.trim() || null : null,
    executionHostId,
    excludeProfileId:
      typeof candidate.excludeProfileId === 'string'
        ? candidate.excludeProfileId.trim() || null
        : null
  }
}

function orgIdFromUnknown(args: unknown): string {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_botmux_profile_org_selection')
  }
  const orgId = (args as SelectBotmuxProfileOrgArgs).orgId?.trim()
  if (!orgId) {
    throw new Error('invalid_botmux_profile_org_selection')
  }
  return orgId
}

function createCloudLinkedProfileArgsFromUnknown(args: unknown): CreateCloudLinkedBotmuxProfileArgs {
  if (!args || typeof args !== 'object') {
    return {}
  }
  const candidate = args as CreateCloudLinkedBotmuxProfileArgs
  const orgId = typeof candidate.orgId === 'string' ? candidate.orgId.trim() : undefined
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : undefined
  return {
    ...(orgId ? { orgId } : {}),
    ...(name ? { name } : {})
  }
}

async function runBeforeProfileRelaunch(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    console.warn(
      '[botmux-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

function scheduleProfileRelaunch(reason: Extract<AppRelaunchReason, `profile-${string}`>): void {
  setTimeout(() => {
    relaunchApp(reason)
    // Why: app.quit() (not app.exit) so before-quit/will-quit still run —
    // renderer scrollback capture, PTY kill, stats flush, and daemon final
    // checkpoints must not be skipped on a profile switch.
    app.quit()
  }, 150)
}

export function registerBotmuxProfileHandlers(
  store: Store,
  options: RegisterBotmuxProfileHandlersOptions = {}
): void {
  ipcMain.handle(
    'botmuxProfiles:list',
    (): BotmuxProfileListResult => ({
      ...getBotmuxProfileListState(),
      multiProfileUi: isMultiProfileUiEnabled()
    })
  )

  ipcMain.handle(
    'botmuxProfiles:authStatus',
    (): BotmuxProfileAuthStatus => getCurrentBotmuxProfileAuthStatus(getProfileUserDataPath())
  )

  ipcMain.handle(
    'botmuxProfiles:createLocal',
    (_event, args?: CreateLocalBotmuxProfileArgs): CreateLocalBotmuxProfileResult => {
      const result = createLocalBotmuxProfile(args)
      seedNewBotmuxProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  ipcMain.handle(
    'botmuxProfiles:switch',
    async (_event, args: SwitchBotmuxProfileArgs): Promise<SwitchBotmuxProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getBotmuxProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      const activeProfile = current.profiles.find(
        (profile) => profile.id === current.activeProfileId
      )
      if (activeProfile?.cloud) {
        // Why: profile selection changes the expected identity synchronously;
        // stale refresh saves must fail even before relaunch teardown finishes.
        recordCloudSessionIdentityMutation(
          cloudSessionIdentity(activeProfile.id, activeProfile.cloud),
          getProfileUserDataPath()
        )
      }
      // Why: the current profile must be persisted before the global index
      // points startup at the target profile.
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)
      store.flush()
      setActiveBotmuxProfile(profileId)

      scheduleProfileRelaunch('profile-switch')

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'botmuxProfiles:transferProject',
    async (
      _event,
      rawArgs: TransferBotmuxProfileProjectArgs
    ): Promise<TransferBotmuxProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getBotmuxProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_botmux_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Why: transfer before any relaunch side effect so a duplicate-target
        // or validation failure cannot strand the app in a quitting state.
        // flush→transfer→freeze runs synchronously with no interleaving, and
        // the freeze keeps late sync saves from resurrecting the moved
        // project from stale memory before the relaunch.
        store.flush()
        const result = transferBotmuxProfileProject(args, getProfileUserDataPath())
        if (result.status === 'transferred') {
          store.freezeWrites()
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          setActiveBotmuxProfile(args.targetProfileId)
          scheduleProfileRelaunch('profile-transfer')
          return { ...result, willRelaunch: true }
        }
        return result
      }
      store.flush()
      return transferBotmuxProfileProject(args, getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'botmuxProfiles:findProjectProfiles',
    (_event, rawArgs: FindBotmuxProfileProjectsByPathArgs): FindBotmuxProfileProjectsByPathResult =>
      findBotmuxProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )

  ipcMain.handle(
    'botmuxProfiles:connectCurrent',
    async (): Promise<ConnectCurrentBotmuxProfileResult> => {
      const result = await connectCurrentBotmuxProfile(getProfileUserDataPath())
      if (result.status === 'connected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'botmuxProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedBotmuxProfileArgs
    ): Promise<CreateCloudLinkedBotmuxProfileResult> => {
      const result = await createCloudLinkedBotmuxProfile(
        getProfileUserDataPath(),
        createCloudLinkedProfileArgsFromUnknown(rawArgs)
      )
      if (result.status === 'created') {
        seedNewBotmuxProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'botmuxProfiles:refreshAuth',
    async (): Promise<RefreshCurrentBotmuxProfileAuthResult> => {
      const result = await refreshCurrentBotmuxProfileAuth(getProfileUserDataPath())
      if (result.status === 'refreshed') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'botmuxProfiles:signOutCurrent',
    async (): Promise<SignOutCurrentBotmuxProfileResult> => {
      options.onBeforeSignOut?.()
      return signOutCurrentBotmuxProfile(getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'botmuxProfiles:selectOrg',
    async (_event, rawArgs: SelectBotmuxProfileOrgArgs): Promise<SelectBotmuxProfileOrgResult> => {
      const result = await selectCurrentBotmuxProfileOrg(
        getProfileUserDataPath(),
        orgIdFromUnknown(rawArgs)
      )
      if (result.status === 'selected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  registerBotmuxProfileOrgMemberHandlers()
}
