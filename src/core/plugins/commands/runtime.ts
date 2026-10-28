import { getBot, loadBotConfigsCached } from '../../../bot-registry.js';
import { readGlobalConfig } from '../../../global-config.js';
import { t, type Locale } from '../../../i18n/index.js';
import { resolveEffectivePluginIds } from '../effective.js';
import { createPluginCommandGateway } from './gateway.js';

/**
 * Process-wide gateway for Lark slash commands contributed by plugins. Routing
 * and `/help` share it so both always read the same live registry + Bot
 * enablement; config parsing is cached by file contents, not by message.
 */
export const pluginCommandGateway = createPluginCommandGateway({
  resolvePluginIds: (larkAppId) => resolveEffectivePluginIds(currentBotPluginConfig(larkAppId), readGlobalConfig()),
});

/**
 * `botmux plugin enable/disable` only rewrites bots.json, while the daemon's
 * registered Bot config is a start-time snapshot. Read the file like workers
 * do (`resolvePluginGenerationBot`) so enablement applies without a restart.
 */
function currentBotPluginConfig(larkAppId: string): { plugins?: string[] } {
  try {
    const fresh = loadBotConfigsCached().find(candidate => candidate.larkAppId === larkAppId);
    if (fresh) return fresh;
  } catch {
    // Unreadable bots.json: fall back to the registered snapshot.
  }
  return getBot(larkAppId).config;
}

/** `/help` section for this bot's plugin commands; empty when there are none. */
export function renderPluginCommandHelp(larkAppId: string | undefined, locale?: Locale): string[] {
  if (!larkAppId) return [];
  const commands = pluginCommandGateway.list(larkAppId);
  if (commands.length === 0) return [];
  return [
    '',
    t('help.plugin_commands_header', undefined, locale),
    ...commands.map(command => {
      const description = command.pluginId === null
        ? t('daemon.plugin_command_conflict', { cmd: command.name }, locale)
        : command.description;
      return description ? `${command.name} — ${description}` : command.name;
    }),
  ];
}
