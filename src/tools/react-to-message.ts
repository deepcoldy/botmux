import { z } from 'zod';
import { addReaction, removeReaction } from '../im/lark/client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  message_id: z.string().describe('Message ID to react to'),
  emoji_type: z.string().default('OnIt').describe('Emoji type, e.g. OnIt, THUMBSUP, DONE,�ять'),
  action: z.enum(['add', 'remove']).default('add').describe('Add or remove a reaction'),
  reaction_id: z.string().optional().describe('Reaction ID (required for remove)'),
});

export const description = 'Add or remove an emoji reaction on a message. Use "add" with OnIt when starting to process, then "remove" after responding.';

export async function execute(args: z.infer<typeof schema>) {
  try {
    if (args.action === 'add') {
      const reactionId = await addReaction(config.lark.appId, args.message_id, args.emoji_type);
      return { success: true, reactionId, messageId: args.message_id, emoji: args.emoji_type };
    } else {
      if (!args.reaction_id) {
        return { error: 'reaction_id is required for remove action' };
      }
      await removeReaction(config.lark.appId, args.message_id, args.reaction_id);
      return { success: true, messageId: args.message_id, removed: args.reaction_id };
    }
  } catch (err: any) {
    logger.error(`Failed to ${args.action} reaction: ${err.message}`);
    return { error: `Failed to ${args.action} reaction: ${err.message}` };
  }
}
