import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { replyMessage, uploadImage, uploadFile } from '../im/lark/client.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().optional().describe('Session ID for the active session (auto-detected if omitted)'),
  content: z.string().describe('Message text to send (plain text). Can be empty string when sending only images/files.'),
  images: z.array(z.string()).optional().describe('Optional local file paths of images to attach (e.g. ["/tmp/chart.png"]). Images are embedded inline in the message.'),
  files: z.array(z.string()).optional().describe('Optional local file paths of files to attach (e.g. ["/tmp/report.pdf"]). Each file is sent as a separate message.'),
  mentions: z.array(z.object({
    open_id: z.string().describe('Open ID of the user/bot to @mention'),
    name: z.string().describe('Display name for the @mention'),
  })).optional().describe('Optional list of users/bots to @mention in the message. Get open_ids from list_bots tool.'),
});

export const description = 'Send a message to the Lark thread associated with a session. Supports plain text, images (embedded inline), and file attachments. Just send plain text — formatting is handled automatically. Use `images` to attach local image files (png/jpg/gif etc.) and `files` to attach documents.';

/** Build a post content block from plain text, splitting by newlines into paragraphs.
 *  When mentions are provided, @Name patterns in the text are replaced with inline `at` tags. */
function textToPostContent(text: string, mentions?: Array<{ open_id: string; name: string }>): any[][] {
  // Build a regex that matches any @Name from the mentions list
  let mentionPattern: RegExp | null = null;
  const mentionMap = new Map<string, string>(); // lowercase name -> open_id
  if (mentions && mentions.length > 0) {
    const patterns: string[] = [];
    for (const m of mentions) {
      const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push(escaped);
      mentionMap.set(m.name.toLowerCase(), m.open_id);
    }
    mentionPattern = new RegExp(`@(${patterns.join('|')})\\b`, 'gi');
  }

  return text.split('\n').map(line => {
    if (!mentionPattern) return [{ tag: 'text', text: line }];

    const nodes: any[] = [];
    let lastIndex = 0;
    for (const match of line.matchAll(mentionPattern)) {
      const matchedName = match[1];
      const openId = mentionMap.get(matchedName.toLowerCase());
      if (!openId) continue;

      // Add text before the match
      if (match.index > lastIndex) {
        nodes.push({ tag: 'text', text: line.slice(lastIndex, match.index) });
      }
      nodes.push({ tag: 'at', user_id: openId });
      lastIndex = match.index + match[0].length;
    }
    // Add remaining text
    if (lastIndex < line.length) {
      nodes.push({ tag: 'text', text: line.slice(lastIndex) });
    }
    // If no matches were found in this line, return as plain text
    if (nodes.length === 0) {
      nodes.push({ tag: 'text', text: line });
    }
    return nodes;
  });
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
  if (!args.session_id) {
    return { error: 'session_id is required but was not provided and could not be auto-detected' };
  }
  const session = sessionStore.getSession(args.session_id);
  if (!session) {
    return { error: `Session ${args.session_id} not found` };
  }
  if (session.status === 'closed') {
    return { error: `Session ${args.session_id} is closed` };
  }

  try {
    // Read the session owner's open_id from the persisted session data.
    // The MCP server runs in a separate process (spawned by the CLI) and
    // does NOT inherit env vars from the worker, so we can't rely on __OWNER_OPEN_ID.
    const mentionUser = session.ownerOpenId;

    const replyInThread = true;  // Always reply in thread to create topics in all chat types
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

    // Build post content: text paragraphs + inline images.
    // Pass mentions so @Name in text gets replaced with proper `at` tags inline.
    const postContent = text ? textToPostContent(text, args.mentions) : [];

    for (const key of imageKeys) {
      postContent.push([{ tag: 'img', image_key: key }]);
    }

    // If there are mentions that weren't found in the text (e.g. no @Name in content),
    // append them at the end as fallback
    if (args.mentions && args.mentions.length > 0) {
      const usedOpenIds = new Set<string>();
      for (const para of postContent) {
        for (const node of para) {
          if (node.tag === 'at' && node.user_id) usedOpenIds.add(node.user_id);
        }
      }
      const unusedMentions = args.mentions.filter(m => !usedOpenIds.has(m.open_id));
      if (unusedMentions.length > 0) {
        if (postContent.length === 0) postContent.push([]);
        const lastLine = postContent[postContent.length - 1];
        for (const m of unusedMentions) {
          lastLine.push({ tag: 'at', user_id: m.open_id });
        }
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

    // Build a comprehensive open_id → larkAppId lookup that includes both
    // self-reported IDs (from bots-info.json) and cross-ref IDs (per-app scoped).
    // Lark open_ids are per-app: the open_id that list_bots returns for Bot B
    // (as seen by Bot A) differs from Bot B's self-reported open_id.
    const openIdToAppId = new Map<string, string>();
    for (const entry of botEntries) {
      if (entry.botOpenId) openIdToAppId.set(entry.botOpenId, entry.larkAppId);
    }
    // Read cross-ref files: bot-openids-{appId}.json maps botName → open_id in that app's context
    try {
      const dataDir = config.session.dataDir;
      for (const file of readdirSync(dataDir)) {
        if (!file.startsWith('bot-openids-') || !file.endsWith('.json')) continue;
        try {
          const crossRef: Record<string, string> = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
          for (const [botName, crossOpenId] of Object.entries(crossRef)) {
            // Resolve botName → larkAppId via bots-info
            const entry = botEntries.find(e => e.botName?.toLowerCase() === botName.toLowerCase());
            if (entry) openIdToAppId.set(crossOpenId, entry.larkAppId);
          }
        } catch { /* ignore corrupt file */ }
      }
    } catch { /* ignore */ }

    // Collect target larkAppIds: explicit mentions + auto-detected from text
    const targetAppIds = new Set<string>();

    // 1. Explicit mentions (excluding self)
    if (args.mentions) {
      for (const m of args.mentions) {
        const targetApp = openIdToAppId.get(m.open_id);
        if (targetApp && targetApp !== appId) targetAppIds.add(targetApp);
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
            targetAppIds.add(entry.larkAppId);
            break;
          }
        }
      }
    }

    if (targetAppIds.size > 0) {
      const signalDir = join(config.session.dataDir, 'bot-mentions');
      if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });

      for (const targetApp of targetAppIds) {
        // Use the target bot's self-reported open_id for the signal
        // (daemons match signals by their own botOpenId)
        const targetEntry = botEntries.find(e => e.larkAppId === targetApp);
        const targetOpenId = targetEntry?.botOpenId ?? targetApp;
        const signal = {
          rootMessageId: session.rootMessageId,
          chatId: session.chatId,
          chatType: session.chatType,
          senderAppId: appId,
          targetBotOpenId: targetOpenId,
          content: text,
          messageId,
          timestamp: Date.now(),
        };
        const filename = `${Date.now()}-${targetOpenId.slice(-8)}.json`;
        writeFileSync(join(signalDir, filename), JSON.stringify(signal));
        logger.info(`Wrote bot-mention signal for ${targetApp} in thread ${session.rootMessageId}`);
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
