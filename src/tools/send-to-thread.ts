import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { replyMessage, uploadImage, uploadFile } from '../im/lark/client.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().describe('Session ID for the active session'),
  content: z.string().describe('Message text to send (plain text). Can be empty string when sending only images/files.'),
  images: z.array(z.string()).optional().describe('Optional local file paths of images to attach (e.g. ["/tmp/chart.png"]). Images are embedded inline in the message.'),
  files: z.array(z.string()).optional().describe('Optional local file paths of files to attach (e.g. ["/tmp/report.pdf"]). Each file is sent as a separate message.'),
  mentions: z.array(z.object({
    open_id: z.string().describe('Open ID of the user/bot to @mention'),
    name: z.string().describe('Display name for the @mention'),
  })).optional().describe('Optional list of users/bots to @mention in the message. Get open_ids from list_bots tool.'),
});

export const description = 'Send a message to the Lark thread associated with a session. Supports plain text, images (embedded inline), and file attachments. Just send plain text — formatting is handled automatically. Use `images` to attach local image files (png/jpg/gif etc.) and `files` to attach documents.';

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

    const replyInThread = session.chatType === 'p2p';
    const appId = session.larkAppId || config.lark.appId;

    // Validate that image/file paths exist before doing anything
    for (const p of [...(args.images ?? []), ...(args.files ?? [])]) {
      if (!existsSync(p)) {
        return { error: `File not found: ${p}` };
      }
    }

    // Upload images in parallel
    const imageKeys: string[] = [];
    if (args.images && args.images.length > 0) {
      const results = await Promise.all(
        args.images.map(p => uploadImage(appId, p)),
      );
      imageKeys.push(...results);
    }

    // If Claude sent post JSON as content, extract the plain text from it
    let text = args.content;
    const extracted = extractTextFromPostJson(text);
    if (extracted) {
      text = extracted;
    }

    // Build post content: text paragraphs + inline images
    const postContent = text ? textToPostContent(text) : [];

    for (const key of imageKeys) {
      postContent.push([{ tag: 'img', image_key: key }]);
    }

    // Append explicit mentions (e.g. @mention other bots)
    if (args.mentions && args.mentions.length > 0) {
      if (postContent.length === 0) postContent.push([]);
      const lastLine = postContent[postContent.length - 1];
      for (const m of args.mentions) {
        lastLine.push({ tag: 'at', user_id: m.open_id });
      }
    }

    // Append @mention to session owner (human user)
    if (mentionUser) {
      if (postContent.length === 0) postContent.push([]);
      postContent[postContent.length - 1].push({ tag: 'at', user_id: mentionUser });
    }

    const content = JSON.stringify({
      zh_cn: { title: '', content: postContent },
    });

    const messageId = await replyMessage(appId, session.rootMessageId, content, 'post', replyInThread);

    // Send file attachments as separate messages (Lark post doesn't support inline files)
    const fileMessageIds: string[] = [];
    if (args.files && args.files.length > 0) {
      for (const filePath of args.files) {
        const fileKey = await uploadFile(appId, filePath);
        const fileContent = JSON.stringify({ file_key: fileKey });
        const fid = await replyMessage(appId, session.rootMessageId, fileContent, 'file', replyInThread);
        fileMessageIds.push(fid);
      }
    }

    // Write signal files for bot-to-bot mentions.
    // Lark WSClient does not deliver im.message.receive_v1 events for bot-sent messages,
    // so the daemon uses these signal files to route messages to target bots internally.
    //
    // Resolve targets from two sources:
    // 1. Explicit args.mentions (CLI passed open_ids directly)
    // 2. Auto-detect @BotName in text content (CLIs often forget the mentions param)
    const botInfoPath = join(config.session.dataDir, 'bots-info.json');
    type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
    let botEntries: BotInfoEntry[] = [];
    try {
      if (existsSync(botInfoPath)) {
        botEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8'));
      }
    } catch { /* ignore */ }

    // Collect target open_ids: explicit mentions + auto-detected from text
    const targetOpenIds = new Set<string>();
    const botOpenIds = new Set(botEntries.filter(e => e.botOpenId).map(e => e.botOpenId!));
    // Find self open_id to exclude from targets (don't signal yourself)
    const selfOpenId = botEntries.find(e => e.larkAppId === appId)?.botOpenId;

    // 1. Explicit mentions (excluding self)
    if (args.mentions) {
      for (const m of args.mentions) {
        if (m.open_id !== selfOpenId && botOpenIds.has(m.open_id)) targetOpenIds.add(m.open_id);
      }
    }

    // 2. Auto-detect @BotName / @cliId in text (case-insensitive)
    if (text && botEntries.length > 0) {
      for (const entry of botEntries) {
        if (!entry.botOpenId || entry.larkAppId === appId) continue; // skip self
        const names = [entry.botName, entry.cliId].filter(Boolean) as string[];
        for (const name of names) {
          // Match @Name with word boundary (handles "@Aiden", "@Claude Code", "@claude-code")
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`@${escaped}\\b`, 'i').test(text)) {
            targetOpenIds.add(entry.botOpenId);
            break;
          }
        }
      }
    }

    if (targetOpenIds.size > 0) {
      const signalDir = join(config.session.dataDir, 'bot-mentions');
      if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });

      for (const openId of targetOpenIds) {
        const signal = {
          rootMessageId: session.rootMessageId,
          chatId: session.chatId,
          chatType: session.chatType,
          senderAppId: appId,
          targetBotOpenId: openId,
          content: text,
          messageId,
          timestamp: Date.now(),
        };
        const filename = `${Date.now()}-${openId.slice(-8)}.json`;
        writeFileSync(join(signalDir, filename), JSON.stringify(signal));
        logger.info(`Wrote bot-mention signal for ${openId} in thread ${session.rootMessageId}`);
      }
    }

    return {
      success: true,
      messageId,
      ...(fileMessageIds.length > 0 && { fileMessageIds }),
      sessionId: args.session_id,
    };
  } catch (err: any) {
    logger.error(`Failed to send to thread: ${err.message}`);
    return { error: `Failed to send message: ${err.message}` };
  }
}
