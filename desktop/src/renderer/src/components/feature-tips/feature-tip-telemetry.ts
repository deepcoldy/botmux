import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type BotmuxCliFeatureTipSource = EventProps<'botmux_cli_feature_tip_shown'>['source']
export type BotmuxCliFeatureTipSetupResult = EventProps<'botmux_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

export function getBotmuxCliFeatureTipTelemetrySource(value: unknown): BotmuxCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackBotmuxCliFeatureTipShown(source: BotmuxCliFeatureTipSource): void {
  track('botmux_cli_feature_tip_shown', { source })
}

export function trackBotmuxCliFeatureTipSetupClicked(source: BotmuxCliFeatureTipSource): void {
  track('botmux_cli_feature_tip_setup_clicked', { source })
}

export function trackBotmuxCliFeatureTipSetupResult(
  source: BotmuxCliFeatureTipSource,
  result: BotmuxCliFeatureTipSetupResult
): void {
  track('botmux_cli_feature_tip_setup_result', { source, result })
}

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}
