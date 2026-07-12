import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { normalizePluginIdList } from './ids.js';

export function resolveEffectivePluginIds(bot: Pick<BotConfig, 'plugins'>, global: Pick<GlobalConfig, 'plugins'> = {}): string[] {
  const globalPlugins = normalizePluginIdList(global.plugins) ?? [];
  const botPlugins = normalizePluginIdList(bot.plugins) ?? [];
  const effective = new Set(globalPlugins);
  for (const pluginId of botPlugins) effective.add(pluginId);
  return [...effective];
}

export function updateBotPluginOverride(
  botPlugins: string[] | undefined,
  pluginId: string,
  enabled: boolean,
): string[] {
  const current = normalizePluginIdList(botPlugins) ?? [];
  if (enabled) return current.includes(pluginId) ? current : [...current, pluginId];
  return current.filter(id => id !== pluginId);
}
