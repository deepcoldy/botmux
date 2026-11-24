import { z } from 'zod';
import { isLocalBotId } from '../setup/local-bot.js';

export const groupSessionSupervisorConfig = z.object({
  botAppId: z.string().refine(id => /^cli_[a-zA-Z0-9]+$/.test(id) || isLocalBotId(id)),
  model: z.string().trim().min(1).max(200),
}).strict();

export type GroupSessionSupervisorConfig = z.infer<typeof groupSessionSupervisorConfig>;
