import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { normalizePluginIdList } from './ids.js';

export function resolveEffectivePluginIds(bot: Pick<BotConfig, 'plugins'>, global: Pick<GlobalConfig, 'plugins'> = {}): string[] {
  // Presence is significant: an explicit [] disables every default plugin for
  // this bot, while an absent field inherits the machine defaults.
  return normalizePluginIdList(bot.plugins === undefined ? global.plugins : bot.plugins) ?? [];
}

export function updateBotPluginOverride(
  botPlugins: string[] | undefined,
  machineDefaults: string[] | undefined,
  pluginId: string,
  enabled: boolean,
): string[] {
  const current = normalizePluginIdList(botPlugins === undefined ? machineDefaults : botPlugins) ?? [];
  if (enabled) return current.includes(pluginId) ? current : [...current, pluginId];
  return current.filter(id => id !== pluginId);
}
