import type { BotConfig } from '../bot-registry.js';
import { validateCodexInstanceRoster } from './codex-instance-pool.js';
import { readBotSessionsStrict } from './session-store.js';

export function assertCodexInstanceConfigWrite(previous: Partial<BotConfig>[], next: Partial<BotConfig>[]): void {
  validateCodexInstanceRoster(next);
  for (const old of previous) {
    if (!old.codexInstancePool || !old.larkAppId) continue;
    const replacement = next.find(bot => bot.larkAppId === old.larkAppId);
    const retained = new Set(replacement?.codexInstancePool?.instances.map(i => i.id) ?? []);
    const removed = new Set(old.codexInstancePool.instances.filter(i => !retained.has(i.id)).map(i => i.id));
    if (!removed.size) continue;
    const references = readBotSessionsStrict(old.larkAppId).filter(s => s.cliInstanceBinding?.instanceId && removed.has(s.cliInstanceBinding.instanceId));
    if (references.length) throw new Error(`Cannot remove Codex instances referenced by ${references.length} recoverable sessions; disable random allocation instead`);
  }
}
