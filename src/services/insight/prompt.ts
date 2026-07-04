import { safeScrubAndTruncate } from './scrub.js';
import type { TurnPromptPreview, TurnPromptSource } from './types.js';

const MAX_PROMPT_PREVIEW = 400;

function extractBotmuxUserText(value: string): string {
  const match = value.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/);
  let text = match?.[1] ?? value;
  text = text
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/g, '')
    .replace(/<mentions>[\s\S]*?<\/mentions>/g, '')
    .replace(/<sender\b[\s\S]*?<\/sender>/g, '')
    .replace(/<sender\b[\s\S]*?\/>/g, '')
    .replace(/<session_id>[\s\S]*?<\/session_id>/g, '')
    .replace(/<\/?user_message>/g, '')
    .replace(/^\s*\[用户引用了消息[^\n]*\]\s*$/gm, '')
    .replace(/^\s*\[来自[^\n]*@mention[^\n]*\]\s*$/gm, '')
    .trim();
  return text;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrsFromTag(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:-]*)=(["'])(.*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out[m[1]!] = decodeAttr(m[3] ?? '');
  }
  return out;
}

function compactName(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.slice(0, 60);
}

function uniqueNames(values: Array<string | undefined>, cap = 8): string[] | undefined {
  const names = [...new Set(values.map(compactName).filter((v): v is string => Boolean(v)))].slice(0, cap);
  return names.length ? names : undefined;
}

function looksLikeHumanBotMention(text: string): boolean {
  return /^@\S+/.test(text.trim());
}

function extractBotmuxPromptSource(raw: string, extractedText: string): TurnPromptSource | undefined {
  const senderAttrs = raw.match(/<sender\b([^>]*)\/?>/)?.[1];
  const sender = senderAttrs ? attrsFromTag(senderAttrs) : {};
  const senderType = sender.type === 'user' || sender.type === 'bot' || sender.type === 'system' ? sender.type : undefined;
  const senderName = compactName(sender.name);
  const isTaskNotification = /<task-notification\b[\s\S]*?<\/task-notification>/i.test(raw)
    || /<task-notification\b/i.test(extractedText);

  const mentionNames: string[] = [];
  const mentionsBlock = raw.match(/<mentions>([\s\S]*?)<\/mentions>/)?.[1] ?? '';
  const mentionRe = /<mention\b([^>]*)\/?>/g;
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = mentionRe.exec(mentionsBlock))) {
    mentionNames.push(attrsFromTag(mentionMatch[1] ?? '').name);
  }

  const quotedBotName = compactName(raw.match(/^\s*\[来自\s+([^\]\n]+?)\s+的 @mention\]\s*$/m)?.[1]);
  if (quotedBotName) mentionNames.push(quotedBotName);

  const mentionedNames = uniqueNames(mentionNames);
  const isBotSender = senderType === 'bot';
  const isA2A = isBotSender || Boolean(quotedBotName);
  const inferredUser = !senderType && looksLikeHumanBotMention(extractedText);
  if (!senderType && !senderName && !mentionedNames && !isA2A && !isTaskNotification && !inferredUser) return undefined;
  const kind = isTaskNotification ? 'system' : isA2A ? 'a2a_agent' : 'user';
  const agentName = isA2A ? (senderName ?? quotedBotName) : undefined;
  return {
    kind,
    ...(agentName ? { agentName } : {}),
    ...(senderType ? { senderType } : { senderType: isTaskNotification ? 'system' as const : inferredUser ? 'user' as const : 'unknown' as const }),
    ...(senderName ? { senderName } : {}),
    ...(isBotSender ? { isBotSender } : {}),
    ...(isA2A ? { isA2A } : {}),
    ...(mentionedNames ? { mentionedNames } : {}),
  };
}

export function safePromptPreview(value: string | undefined, max = MAX_PROMPT_PREVIEW): TurnPromptPreview | undefined {
  const raw = (value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return undefined;
  const extractedText = extractBotmuxUserText(raw);
  let text = extractedText;
  if (!text) return undefined;
  const source = extractBotmuxPromptSource(raw, extractedText);
  const { text: scrubbed, truncated } = safeScrubAndTruncate(text, max);
  return {
    text: scrubbed,
    truncated,
    ...(source ? { source } : {}),
  };
}
