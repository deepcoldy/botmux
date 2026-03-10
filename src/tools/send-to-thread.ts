import { z } from 'zod';
import { replyMessage } from '../services/lark-client.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().describe('Session ID for the active session'),
  content: z.string().describe('Message content to send'),
  msg_type: z.enum(['text', 'post']).default('text').describe('Message type: text or post (rich text)'),
});

export const description = 'Send a message to the Lark thread associated with a session.';

/** Build a post content block from plain text, splitting by newlines into paragraphs */
function textToPostContent(text: string): any[][] {
  return text.split('\n').map(line => [{ tag: 'text', text: line }]);
}

/** Append an @mention node to the last paragraph of post content blocks */
function appendMention(blocks: any[][], openId: string): any[][] {
  if (blocks.length === 0) blocks.push([]);
  blocks[blocks.length - 1].push({ tag: 'at', user_id: openId });
  return blocks;
}

export async function execute(args: z.infer<typeof schema>) {
  const session = sessionStore.getSession(args.session_id);
  if (!session) {
    return { error: `Session ${args.session_id} not found` };
  }
  if (session.status === 'closed') {
    return { error: `Session ${args.session_id} is closed` };
  }

  try {
    const mentionUser = config.daemon.allowedUsers[0];

    // Always send as post format to support @mentions
    let postContent: any[][];

    if (args.msg_type === 'post') {
      // Already post format — parse and extract content blocks
      try {
        const parsed = JSON.parse(args.content);
        // Handle wrapped {"zh_cn": {title, content}} or unwrapped {title, content}
        const inner = parsed.zh_cn ?? parsed.en_us ?? parsed;
        postContent = Array.isArray(inner.content) ? inner.content : textToPostContent(args.content);
      } catch {
        postContent = textToPostContent(args.content);
      }
    } else {
      postContent = textToPostContent(args.content);
    }

    // Append @mention if we have a user to mention
    if (mentionUser) {
      appendMention(postContent, mentionUser);
    }

    const content = JSON.stringify({
      zh_cn: { title: '', content: postContent },
    });

    const messageId = await replyMessage(session.rootMessageId, content, 'post');

    return {
      success: true,
      messageId,
      sessionId: args.session_id,
    };
  } catch (err: any) {
    logger.error(`Failed to send to thread: ${err.message}`);
    return { error: `Failed to send message: ${err.message}` };
  }
}
