import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ConnectCurrentBotmuxProfileResult,
  CreateCloudLinkedBotmuxProfileResult,
  RefreshCurrentBotmuxProfileAuthResult,
  SelectBotmuxProfileOrgResult,
  SignOutCurrentBotmuxProfileResult
} from '../../../../shared/botmux-profiles'
import type { AppState } from '../types'

export type BotmuxProfilesAuthActions = {
  createCloudLinkedBotmuxProfile: (args: {
    orgId?: string
    name?: string
  }) => Promise<CreateCloudLinkedBotmuxProfileResult | null>
  connectCurrentBotmuxProfile: () => Promise<ConnectCurrentBotmuxProfileResult | null>
  refreshCurrentBotmuxProfileAuth: () => Promise<RefreshCurrentBotmuxProfileAuthResult | null>
  signOutCurrentBotmuxProfile: () => Promise<SignOutCurrentBotmuxProfileResult | null>
  selectBotmuxProfileOrg: (orgId: string) => Promise<SelectBotmuxProfileOrgResult | null>
}

// Why a separate module: the cloud-auth actions share the profiles slice's
// state keys but form their own cohesive surface (connect/refresh/sign-out/
// org selection), and the combined slice file exceeded the repo line budget.
export const createBotmuxProfilesAuthActions: StateCreator<
  AppState,
  [],
  [],
  BotmuxProfilesAuthActions
> = (set, get) => ({
  createCloudLinkedBotmuxProfile: async (args) => {
    try {
      const result = await window.api.botmuxProfiles.createCloudLinked(args)
      set({
        botmuxProfileAuthStatus: result.auth,
        ...(result.status === 'created'
          ? {
              activeBotmuxProfileId: result.activeProfileId,
              botmuxProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'created') {
        toast.success(
          translate('auto.store.slices.botmux.profiles.319d7cf39b', 'Cloud profile created')
        )
      } else if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.f0c9e11a6d', 'Failed to create cloud profile'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to create Botmux cloud profile:', err)
      toast.error(
        translate('auto.store.slices.botmux.profiles.f0c9e11a6d', 'Failed to create cloud profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  connectCurrentBotmuxProfile: async () => {
    if (get().botmuxProfileConnecting) {
      return null
    }
    set({ botmuxProfileConnecting: true })
    try {
      const result = await window.api.botmuxProfiles.connectCurrent()
      set({
        botmuxProfileConnecting: false,
        botmuxProfileAuthStatus: result.auth,
        ...(result.status === 'connected'
          ? {
              activeBotmuxProfileId: result.activeProfileId,
              botmuxProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'unconfigured') {
        toast.error(
          translate(
            'auto.store.slices.botmux.profiles.8b8fa73174',
            'Botmux Cloud sign-in is not configured'
          ),
          {
            description: result.auth.setupMessage
          }
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.33290e88ed', 'Failed to connect profile'),
          { description: result.error }
        )
      } else if (result.status === 'connected') {
        toast.success(translate('auto.store.slices.botmux.profiles.9fcb07a796', 'Profile connected'))
      }
      return result
    } catch (err) {
      console.error('Failed to connect Botmux profile:', err)
      set({ botmuxProfileConnecting: false })
      toast.error(
        translate('auto.store.slices.botmux.profiles.33290e88ed', 'Failed to connect profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  refreshCurrentBotmuxProfileAuth: async () => {
    try {
      const result = await window.api.botmuxProfiles.refreshAuth()
      set({
        botmuxProfileAuthStatus: result.auth,
        ...(result.status === 'refreshed'
          ? {
              activeBotmuxProfileId: result.activeProfileId,
              botmuxProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.2f6c78a039', 'Failed to refresh profile auth'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to refresh Botmux profile auth:', err)
      toast.error(
        translate('auto.store.slices.botmux.profiles.2f6c78a039', 'Failed to refresh profile auth'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  signOutCurrentBotmuxProfile: async () => {
    try {
      const result = await window.api.botmuxProfiles.signOutCurrent()
      set({
        activeBotmuxProfileId: result.activeProfileId,
        botmuxProfiles: result.profiles,
        botmuxProfileAuthStatus: result.auth
      })
      toast.success(
        translate('auto.store.slices.botmux.profiles.a37b5e6d37', 'Signed out of profile')
      )
      return result
    } catch (err) {
      console.error('Failed to sign out of Botmux profile:', err)
      toast.error(translate('auto.store.slices.botmux.profiles.83600521e7', 'Failed to sign out'), {
        description: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  },

  selectBotmuxProfileOrg: async (orgId) => {
    try {
      const result = await window.api.botmuxProfiles.selectOrg({ orgId })
      set({
        botmuxProfileAuthStatus: result.auth,
        ...(result.status === 'selected'
          ? {
              activeBotmuxProfileId: result.activeProfileId,
              botmuxProfiles: result.profiles
            }
          : {})
      })
      if (result.status === 'reconnect-required') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.d6e764e7db', 'Reconnect this profile')
        )
      } else if (result.status === 'failed') {
        toast.error(
          translate('auto.store.slices.botmux.profiles.76deec8f58', 'Failed to switch organization'),
          { description: result.error }
        )
      }
      return result
    } catch (err) {
      console.error('Failed to switch Botmux profile org:', err)
      toast.error(
        translate('auto.store.slices.botmux.profiles.76deec8f58', 'Failed to switch organization'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
