import { z } from 'zod';
import { isLocalBotId } from '../setup/local-bot.js';

const model = z.string().trim().min(1).max(200);
export const groupSessionSupervisorConfig = z.union([
  z.object({
    botAppId: z.string().refine(id => /^cli_[a-zA-Z0-9]+$/.test(id) || isLocalBotId(id)),
    model,
  }).strict(),
  z.object({ provider: z.literal('magpie'), model }).strict(),
]);

export type GroupSessionSupervisorConfig = z.infer<typeof groupSessionSupervisorConfig>;

export function sameGroupSessionSupervisor(
  current: GroupSessionSupervisorConfig | undefined, expected: GroupSessionSupervisorConfig,
): boolean {
  if (!current || current.model !== expected.model) return false;
  if ('botAppId' in expected) return 'botAppId' in current && current.botAppId === expected.botAppId;
  return 'provider' in current && current.provider === expected.provider;
}
