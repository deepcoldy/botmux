import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  BotmuxProfileAuthStatus,
  BotmuxProfileSummary,
  SwitchBotmuxProfileResult,
  TransferBotmuxProfileProjectArgs,
  TransferBotmuxProfileProjectResult
} from '../../../../shared/botmux-profiles'
import type { AppState } from '../types'
import {
  createBotmuxProfilesAuthActions,
  type BotmuxProfilesAuthActions
} from './botmux-profiles-auth-actions'

export type BotmuxProfilesSlice = BotmuxProfilesAuthActions & {
  botmuxProfiles: BotmuxProfileSummary[]
  activeBotmuxProfileId: string | null
  botmuxProfileAuthStatus: BotmuxProfileAuthStatus | null
  botmuxProfilesMultiProfileUi: boolean
  botmuxProfilesLoading: boolean
  botmuxProfileSwitching: boolean
  botmuxProfileConnecting: boolean
  fetchBotmuxProfiles: () => Promise<void>
  fetchBotmuxProfileAuthStatus: () => Promise<BotmuxProfileAuthStatus | null>
  createLocalBotmuxProfile: (name?: string) => Promise<BotmuxProfileSummary | null>
  switchBotmuxProfile: (profileId: string) => Promise<SwitchBotmuxProfileResult | null>
  transferBotmuxProfileProject: (
    args: TransferBotmuxProfileProjectArgs
  ) => Promise<TransferBotmuxProfileProjectResult | null>
}

export const createBotmuxProfilesSlice: StateCreator<AppState, [], [], BotmuxProfilesSlice> = (
  set,
  get,
  api
) => ({
  botmuxProfiles: [],
  activeBotmuxProfileId: null,
  botmuxProfileAuthStatus: null,
  botmuxProfilesMultiProfileUi: false,
  botmuxProfilesLoading: false,
  botmuxProfileSwitching: false,
  botmuxProfileConnecting: false,

  fetchBotmuxProfiles: async () => {
    set({ botmuxProfilesLoading: true })
    try {
      const [state, authStatus] = await Promise.all([
        window.api.botmuxProfiles.list(),
        window.api.botmuxProfiles.authStatus()
      ])
      set({
        activeBotmuxProfileId: state.activeProfileId,
        botmuxProfiles: state.profiles,
        botmuxProfilesMultiProfileUi: state.multiProfileUi,
        botmuxProfileAuthStatus: authStatus,
        botmuxProfilesLoading: false
      })
    } catch (err) {
      console.error('Failed to fetch Botmux profiles:', err)
      set({ botmuxProfilesLoading: false })
    }
  },

  fetchBotmuxProfileAuthStatus: async () => {
    try {
      const authStatus = await window.api.botmuxProfiles.authStatus()
      set({ botmuxProfileAuthStatus: authStatus })
      return authStatus
    } catch (err) {
      console.error('Failed to fetch Botmux profile auth status:', err)
      return null
    }
  },

  createLocalBotmuxProfile: async (name) => {
    try {
      const state = await window.api.botmuxProfiles.createLocal({ name })
      set({
        activeBotmuxProfileId: state.activeProfileId,
        botmuxProfiles: state.profiles
      })
      void get().fetchBotmuxProfileAuthStatus()
      return state.profile
    } catch (err) {
      console.error('Failed to create Botmux profile:', err)
      toast.error(
        translate('auto.store.slices.botmux.profiles.612f7f6861', 'Failed to create profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  ...createBotmuxProfilesAuthActions(set, get, api),

  switchBotmuxProfile: async (profileId) => {
    if (!profileId || profileId === get().activeBotmuxProfileId) {
      return { status: 'already-active' }
    }
    set({ botmuxProfileSwitching: true })
    try {
      const result = await window.api.botmuxProfiles.switchProfile({ profileId })
      if (result?.status !== 'relaunching') {
        // Why: only a relaunch may keep the switcher locked; a stale
        // "already-active" answer would otherwise disable it forever.
        set({ botmuxProfileSwitching: false })
      }
      return result
    } catch (err) {
      console.error('Failed to switch Botmux profile:', err)
      set({ botmuxProfileSwitching: false })
      toast.error(
        translate('auto.store.slices.botmux.profiles.7d4bc516ee', 'Failed to switch profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  transferBotmuxProfileProject: async (args) => {
    try {
      const result = await window.api.botmuxProfiles.transferProject(args)
      if (result.status === 'duplicate-target') {
        toast.error(
          translate(
            'auto.store.slices.botmux.profiles.f518e89aa5',
            'Project already exists in that profile'
          )
        )
      }
      if (result.status === 'transferred' && result.willRelaunch) {
        set({ botmuxProfileSwitching: true })
      }
      return result
    } catch (err) {
      console.error('Failed to transfer Botmux profile project:', err)
      toast.error(
        translate('auto.store.slices.botmux.profiles.f03ae7f27b', 'Failed to transfer project'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
