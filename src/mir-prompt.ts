/**
 * Pure prompt-normalization for the Mir CLI runner.
 *
 * Mir drives mircli in non-interactive Print Mode and can't consume botmux's
 * XML envelope directly, so `normalizeMircliPrompt` unwraps `<user_message>`
 * and flattens the surrounding context blocks (routing / role / sender /
 * mentions / available_bots / attachments) into plain prose.
 *
 * This module is intentionally side-effect-free (no argv parsing, no process
 * wiring) — split out of `mir-runner.ts`, whose entrypoint runs `main()` on
 * import — so the transformation can be unit-tested. See mir-runner.ts for the
 * runtime that consumes it.
 */

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTaggedBlock(content: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(content);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const close = content.toLowerCase().indexOf(`</${tag}>`, start);
  if (close < 0) return undefined;
  return content.slice(start, close).trim();
}

function extractOpeningTagAttributes(content: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(content);
  return open ? open[1] : undefined;
}

function extractXmlAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}="([^"]*)"`, 'i');
  const match = pattern.exec(attrs);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function summarizeAttachments(content: string): string[] {
  const block = extractTaggedBlock(content, 'attachments');
  if (!block) return [];

  const out: string[] = [];
  const itemPattern = /<(image|file)\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(itemPattern)) {
    const type = match[1].toLowerCase();
    const attrs = match[2];
    const n = extractXmlAttribute(attrs, 'n');
    const path = extractXmlAttribute(attrs, 'path');
    const name = extractXmlAttribute(attrs, 'name');
    if (!path) continue;
    const label = type === 'image' ? 'image' : 'file';
    const index = n ? ` ${n}` : '';
    const suffix = name ? ` (${name})` : '';
    out.push(`${label}${index}: ${path}${suffix}`);
  }
  return out;
}

function summarizeRole(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'role');
  if (!block) return undefined;
  const role = decodeXmlEntities(block).trim();
  if (!role) return undefined;
  return ['Role context from BotMux:', role].join('\n');
}

function summarizeBotmuxRouting(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'botmux_routing');
  if (!block) return undefined;
  const routing = decodeXmlEntities(block).trim();
  if (!routing) return undefined;
  return ['BotMux routing instructions:', routing].join('\n');
}

export function summarizeAvailableBots(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'available_bots');
  if (!block) return undefined;

  const lines: string[] = [];
  const attrs = extractOpeningTagAttributes(content, 'available_bots') || '';
  const hint = extractXmlAttribute(attrs, 'hint');
  if (hint) lines.push(hint);

  const botPattern = /<bot\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(botPattern)) {
    const name = extractXmlAttribute(match[1], 'name');
    const openId = extractXmlAttribute(match[1], 'open_id');
    if (!name && !openId) continue;
    lines.push(`- ${name || '(unnamed bot)'}: ${openId || '(missing open_id)'}`);
  }

  // Collapsed variant (peer count above the inline threshold): the roster is a
  // plain-text body line ("N bots: names"), not <bot/> children. Surface it so
  // Mira still sees the names — not just the hint. For the inline variant the
  // body is only <bot/> tags, so after stripping them this is empty (a no-op).
  const body = decodeXmlEntities(block.replace(/<bot\b[^>]*\/?>/gi, '')).trim();
  if (body) lines.push(body);

  if (lines.length === 0) return undefined;
  return [
    'BotMux bots you can communicate or collaborate with:',
    ...lines,
    'To reach one of these bots, use local bash to run: botmux send --mention <open_id> "message".',
  ].join('\n');
}

function summarizeMentions(content: string): string | undefined {
  const block = extractTaggedBlock(content, 'mentions');
  if (!block) return undefined;

  const mentions: string[] = [];
  const mentionPattern = /<mention\b([^>]*)\/?>/gi;
  for (const match of block.matchAll(mentionPattern)) {
    const name = extractXmlAttribute(match[1], 'name');
    const openId = extractXmlAttribute(match[1], 'open_id');
    if (!name && !openId) continue;
    mentions.push(`- ${name || '(unnamed mention)'}${openId ? `: ${openId}` : ''}`);
  }

  if (mentions.length === 0) return undefined;
  return ['Mentions in this BotMux turn:', ...mentions].join('\n');
}

function summarizeSender(content: string): string | undefined {
  const attrs = extractOpeningTagAttributes(content, 'sender');
  if (attrs === undefined) return undefined;
  const type = extractXmlAttribute(attrs, 'type');
  const name = extractXmlAttribute(attrs, 'name');
  const openId = extractXmlAttribute(attrs, 'open_id');
  if (!name && !openId && !type) return undefined;
  const who = `${name || '(unknown)'}${openId ? ` (${openId})` : ''}${type ? ` [${type}]` : ''}`;
  const lines = [`Message sender: ${who}`];
  if (type === 'bot') {
    lines.push('The sender is another bot — your reply is delivered back to it automatically; do not worry about @-mentioning to wake it.');
  }
  return lines.join('\n');
}

export function normalizeMircliPrompt(content: string): string {
  const userMessage = extractTaggedBlock(content, 'user_message');
  if (!userMessage) return content;

  const context = [
    summarizeBotmuxRouting(content),
    summarizeRole(content),
    summarizeSender(content),
    summarizeMentions(content),
    summarizeAvailableBots(content),
  ].filter((section): section is string => Boolean(section));

  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(['BotMux context:', ...context].join('\n\n'));
  }
  sections.push(['User request:', decodeXmlEntities(userMessage)].join('\n'));

  const attachments = summarizeAttachments(content);
  if (attachments.length > 0) {
    sections.push([
      'Attachments available on the local filesystem:',
      ...attachments.map(item => `- ${item}`),
    ].join('\n'));
  }
  return sections.join('\n\n');
}
