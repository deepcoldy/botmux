import type { BotConfig } from '../bot-registry.js';

/**
 * An explicit PM2 daemon may never retain a pre-bootstrap config snapshot.
 * Re-read its original raw bots.json slot immediately before registration and
 * reject removal, pending state, or an App ID replacement as a fatal drift.
 */
export function reloadExactDaemonBotConfig(
  index: number,
  originalAppId: string,
  loadAtIndex: (index: number) => BotConfig,
): BotConfig {
  const reloaded = loadAtIndex(index);
  if (reloaded.larkAppId !== originalAppId) {
    throw new Error(`BOTMUX_BOT_INDEX=${index} target drifted during profile bootstrap`);
  }
  return reloaded;
}
