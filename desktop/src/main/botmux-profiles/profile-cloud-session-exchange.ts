import type {
  BotmuxCloudCapabilities,
  BotmuxCloudOrgSummary,
  BotmuxProfileCloudSummary
} from '../../shared/botmux-profiles'

export type BotmuxCloudSessionExchangeResponse = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  cloud: BotmuxProfileCloudSummary
  organizations?: BotmuxCloudOrgSummary[]
  capabilities: BotmuxCloudCapabilities
}
