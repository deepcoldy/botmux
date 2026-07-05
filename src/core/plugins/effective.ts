import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';

export function resolveEffectivePluginIds(bot: Pick<BotConfig, 'plugins'>, global: Pick<GlobalConfig, 'plugins'> = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(global.plugins ?? []), ...(bot.plugins ?? [])]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
