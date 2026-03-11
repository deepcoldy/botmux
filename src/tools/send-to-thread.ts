import { z } from 'zod';
import { replyMessage } from '../services/lark-client.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().describe('Session ID for the active session'),
  content: z.string().describe('Message content to send (plain text)'),
});

export const description = 'Send a plain text message to the Lark thread associated with a session. Just send plain text — formatting is handled automatically.';

/** Build a post content block from plain text, splitting by newlines into paragraphs */
function textToPostContent(text: string): any[][] {
  return text.split('\n').map(line => [{ tag: 'text', text: line }]);
}

/** Try to extract plain text from post JSON that Claude sometimes generates */
function extractTextFromPostJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed.zh_cn ?? parsed.en_us ?? parsed;
    if (!Array.isArray(inner.content)) return null;
    // Flatten post blocks back to plain text
    const lines: string[] = [];
    for (const paragraph of inner.content) {
      if (!Array.isArray(paragraph)) continue;
      const parts: string[] = [];
      for (const node of paragraph) {
        if (node.tag === 'text' && typeof node.text === 'string') {
          parts.push(node.text);
        }
      }
      lines.push(parts.join(''));
    }
    return lines.join('\n').trim();
  } catch {
    return null;
  }
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
    // Prefer the session owner's open_id (set by worker from init message),
    // fall back to first configured allowed user if it looks like an open_id.
    const mentionUser = process.env.__OWNER_OPEN_ID
      || (config.daemon.allowedUsers[0]?.startsWith('ou_') ? config.daemon.allowedUsers[0] : undefined);

    // If Claude sent post JSON as content, extract the plain text from it
    let text = args.content;
    const extracted = extractTextFromPostJson(text);
    if (extracted) {
      text = extracted;
    }

    const postContent = textToPostContent(text);

    // Append @mention if we have a user to mention
    if (mentionUser) {
      if (postContent.length === 0) postContent.push([]);
      postContent[postContent.length - 1].push({ tag: 'at', user_id: mentionUser });
    }

    const content = JSON.stringify({
      zh_cn: { title: '', content: postContent },
    });

    const replyInThread = session.chatType === 'p2p';
    const messageId = await replyMessage(session.rootMessageId, content, 'post', replyInThread);

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
