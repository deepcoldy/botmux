/** Callback control input must not enter persistent/replayable message bodies. */
import { isTraeLoginCompleteCommandText } from '../core/trae-login-command.js';

type Mention = { key?: unknown; name?: unknown };
type Message = {
  content?: unknown;
  body?: { content?: unknown };
  mentions?: Mention[];
  message_type?: string;
  msg_type?: string;
};
type Envelope = { message?: Message };

// Match the parser's complete inline <at> forms, anchored at the command lane's
// current start. An incomplete tag is ordinary text, not a proven mention.
const LEADING_AT_TAG = /^<at\b[^>]*?(?:\/>|>(?:(?!<at\b)[\s\S])*?<\/at>)/i;
const LEADING_USER_PLACEHOLDER = /^@_user_\d+/;

function mentionTokens(mentions: Mention[] | undefined): string[] {
  return (Array.isArray(mentions) ? mentions : []).flatMap(m => [
    typeof m?.key === 'string' && m.key.startsWith('@') ? m.key : undefined,
    typeof m?.name === 'string' && m.name.trim() ? '@' + m.name.trim() : undefined,
  ]).filter((k): k is string => !!k).sort((a, b) => b.length - a.length);
}

function stripProvenLeadingMentions(text: string, mentions: Mention[] | undefined): string {
  let rest = text.trimStart();
  const tokens = mentionTokens(mentions);
  for (;;) {
    const token = tokens.find(k => rest.startsWith(k));
    const placeholder = LEADING_USER_PLACEHOLDER.exec(rest)?.[0];
    const atTag = LEADING_AT_TAG.exec(rest)?.[0];
    const prefix = token ?? placeholder ?? atTag;
    if (!prefix) return rest;
    rest = rest.slice(prefix.length).trimStart();
  }
}

function isCallbackCommandText(text: string, mentions: Mention[] | undefined): boolean {
  const command = stripProvenLeadingMentions(text, mentions);
  if (isTraeLoginCompleteCommandText(command)) return true;
  // A text body without structured mention metadata can still carry an
  // @mention immediately attached to `/dashboard`. Recognize that narrow shape
  // without the parser's generic @\S+ fallback, which would also erase ordinary
  // prose in `@Bot请解释 /dashboard ...` and misclassify the discussion.
  if (!command.startsWith('@')) return false;
  const firstToken = command.split(/\s/, 1)[0] ?? '';
  const commandOffset = firstToken.toLowerCase().indexOf('/dashboard');
  return commandOffset > 0 && isTraeLoginCompleteCommandText(command.slice(commandOffset));
}

function renderPostNode(node: any): any {
  if (node?.tag === 'text') return node.text ?? '';
  if (node?.tag === 'a') {
    const text = node.text ?? '';
    return text && node.href && text !== node.href ? `${text}(${node.href})` : (text || node.href || '');
  }
  if (node?.tag === 'at') return `@${node.user_name ?? 'unknown'}`;
  // These nodes always render a non-command placeholder/fence. Their exact
  // display text is irrelevant once the command head has already matched.
  if (['media', 'img', 'file'].includes(node?.tag)) return '[attachment]';
  if (node?.tag === 'code_block') return '\n```\n';
  // Unknown and malformed nodes have no authored command text. Tolerating null
  // here is deliberate: privacy classification must not fail open when the
  // display parser falls back to raw JSON for the same malformed post.
  return '';
}

function isPostCallback(content: string, mentions: Mention[] | undefined): boolean {
  const parsed = JSON.parse(content);
  let title = '';
  let paragraphs: any = [];
  if (Array.isArray(parsed?.content)) {
    title = parsed.title ?? '';
    paragraphs = parsed.content;
  } else if (parsed && typeof parsed === 'object') {
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (value && typeof value === 'object' && Array.isArray(value.content)) {
        title = value.title ?? '';
        paragraphs = value.content;
        break;
      }
    }
  }
  const body = (paragraphs as any[]).map((paragraph: any) => {
    const nodes: any[] = Array.isArray(paragraph) ? paragraph : [paragraph];
    let firstVisible = 0;
    // Post mentions are inline AST nodes. Strip only that structural prefix;
    // never apply a free-form @\S+ rule to the rendered post body.
    while (firstVisible < nodes.length) {
      const node = nodes[firstVisible];
      if (node?.tag === 'at'
        || node?.tag === 'text' && typeof node.text === 'string' && !node.text.trim()
        || renderPostNode(node) === '') firstVisible++;
      else break;
    }
    return nodes.slice(firstVisible).map(renderPostNode).join('').replace(/\n{3,}/g, '\n\n').trim();
  }).filter(Boolean).join('\n');
  return isCallbackCommandText(title ? `${title}\n${body}` : body, mentions);
}

function isTextCallback(content: string, mentions: Mention[] | undefined): boolean {
  let text = content;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === 'string') text = parsed.text;
  } catch { /* plain text / malformed JSON remains available to the raw fallback */ }
  return isCallbackCommandText(text, mentions);
}

export function isTraeLoginCallbackEvent(data: unknown): boolean {
  const event = data as { message?: Message; event?: Envelope } | undefined;
  const envelope = event?.message ? event : event?.event;
  const message = envelope?.message;
  const content = message?.content ?? message?.body?.content;
  if (!message || typeof content !== 'string') return false;
  try {
    return (message.message_type ?? message.msg_type) === 'post'
      ? isPostCallback(content, message.mentions)
      : isTextCallback(content, message.mentions);
  } catch {
    // A malformed rich-text AST must not turn a recognizable raw control input
    // into an ordinary durable message. The text path is dependency-free and
    // still protects a literal command head without over-reading discussions.
    return isTextCallback(content, message.mentions);
  }
}

export function redactTraeLoginCallbackEvent<T>(data: T): T {
  if (!isTraeLoginCallbackEvent(data)) return data;
  const copy = JSON.parse(JSON.stringify(data));
  for (const message of [copy.message, copy.event?.message]) if (message) {
    message.content = JSON.stringify({ text: '/dashboard trae-login complete [redacted]' });
    if (message.body && typeof message.body === 'object') message.body.content = message.content;
    message.message_type = 'text';
  }
  return copy;
}
