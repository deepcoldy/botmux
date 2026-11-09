import { getMessageDetail } from './client.js';
import {
  extractMentionIdentities, mentionAppId, mentionOpenId, resolvePostBody, type MentionIdentity,
} from './message-parser.js';
import { logger } from '../../utils/logger.js';

const SUPPORTED_TYPES = new Set(['text', 'post']);
const APP_ID = /^cli_[a-z0-9]+$/;
// Not JSON-serializable and not reachable from event content, so senders cannot forge it.
const VERIFIED_APP_IDS = Symbol('substituteVerifiedAppIds');

/** One @ in the event, as seen by this app. `key` is absent for post inline
 *  at-nodes when the event's mentions[] is empty. */
type EventMention = { key?: string; openId: string };
type RestMention = { key: string; openId?: string; appId?: string };

/** Mention identities for substitute matching, plus App IDs that
 *  resolveSubstituteAppMentions verified for this message object. */
export function substituteMentionIdentities(message: any): MentionIdentity[] {
  const mentions = extractMentionIdentities(message);
  const verified: Map<string, string> | undefined = message?.[VERIFIED_APP_IDS];
  if (!verified) return mentions;
  return mentions.map(mention => {
    const appId = !mention.appId && mention.openId ? verified.get(mention.openId) : undefined;
    return appId ? { ...mention, appId } : mention;
  });
}

/** Recover stable bot App IDs from this exact message, without names or a bot roster. */
export async function resolveSubstituteAppMentions(larkAppId: string, message: any): Promise<any> {
  const type = message?.message_type ?? message?.msg_type;
  const messageId = message?.message_id;
  if (!SUPPORTED_TYPES.has(type) || typeof messageId !== 'string' || !message?.chat_id) return message;
  const unverified = (reason: string) => {
    logger.debug(`[substitute:${larkAppId}] App ID mention not verified msg=${messageId.substring(0, 12)}: ${reason}`);
    return message;
  };
  try {
    const occurrences = eventMentions(message, type);
    if (!occurrences) return unverified('event mentions malformed');
    if (!occurrences.length) return message;
    // GET /open-apis/im/v1/messages/:message_id returns bot mentions as
    // { id: 'cli_…', id_type: 'app_id' } when user_id_type=open_id is explicit,
    // and as this app's observer-scoped open_id when it is omitted. Both views
    // keep @_user_N placeholders in the body, so the key joins them.
    const options = { userCardContent: false, timeoutMs: 2_000 };
    const [detail, observed] = await Promise.all([
      getMessageDetail(larkAppId, messageId, { ...options, userIdType: 'open_id' }),
      getMessageDetail(larkAppId, messageId, options),
    ]);
    const item = detail?.items?.find((entry: any) => entry.message_id === messageId);
    const baseline = observed?.items?.find((entry: any) => entry.message_id === messageId);
    if (!item || !baseline) return unverified('message missing from REST');
    if (item.chat_id !== message.chat_id || baseline.chat_id !== message.chat_id
        || restType(item) !== type || restType(baseline) !== type) return unverified('chat or type mismatch');
    // The body may keep the same @_user_N after an edit changes its recipient.
    // Both REST views must describe the same version, and so must the event
    // whenever it carries a version (WS often omits update_time).
    if (baseline.body?.content !== item.body?.content
        || baseline.create_time !== item.create_time
        || baseline.update_time !== item.update_time) return unverified('REST views differ');
    if ((message.create_time && item.create_time && message.create_time !== item.create_time)
        || (message.update_time && message.update_time !== item.update_time)) return unverified('version mismatch');
    const body = bodyShape(type, message.content);
    if (body === undefined || body !== bodyShape(type, item.body?.content)) return unverified('body mismatch');
    const rest = restMentions(type, item, baseline);
    if (!rest) return unverified('REST mentions malformed');
    const verified = pairMentions(occurrences, rest);
    if (!verified) return unverified('event mentions do not match REST');
    return verified.size ? { ...message, [VERIFIED_APP_IDS]: verified } : message;
  } catch (err) {
    // API failure is never permission to guess a bot identity from its display name.
    return unverified(`lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function restType(item: any): string | undefined {
  return item.msg_type ?? item.message_type;
}

function parseContent(content: unknown): any {
  return JSON.parse(typeof content === 'string' ? content : '{}') ?? {};
}

function textBody(content: unknown): string | undefined {
  const text = parseContent(content).text;
  return typeof text === 'string' ? text : undefined;
}

function postAtIds(content: unknown): unknown[] {
  const ids: unknown[] = [];
  for (const paragraph of resolvePostBody(parseContent(content)).content) {
    if (!Array.isArray(paragraph)) continue;
    for (const node of paragraph) if (node?.tag === 'at') ids.push(node.user_id);
  }
  return ids;
}

/** `@_user_1` must not match inside `@_user_10`. */
function hasPlaceholder(text: string, key: string): boolean {
  for (let i = text.indexOf(key); i >= 0; i = text.indexOf(key, i + 1)) {
    if (!/\w/.test(text[i + key.length] ?? '')) return true;
  }
  return false;
}

/** WS and REST serialize the same body differently (locale wrapper, key order,
 *  style arrays, open_id vs @_user_N in at-nodes), so compare the visible
 *  shape: title, paragraph structure, node tags and text. At-nodes are slots;
 *  their identities are checked by pairMentions. */
function bodyShape(type: string, content: unknown): string | undefined {
  if (type === 'text') {
    const text = textBody(content);
    return text === undefined ? undefined : JSON.stringify(text);
  }
  const post = resolvePostBody(parseContent(content));
  return JSON.stringify([post.title, post.content.map((paragraph: any) =>
    (Array.isArray(paragraph) ? paragraph : []).map((node: any) =>
      node?.tag === 'at' ? ['at'] : [node?.tag, typeof node?.text === 'string' ? node.text : null]))]);
}

/** Event @s that still need an App ID; undefined means nothing may be
 *  verified. Every occurrence must sit in the body. */
function eventMentions(message: any, type: string): EventMention[] | undefined {
  const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];
  const out: EventMention[] = [];
  if (mentions.length) {
    const text = type === 'text' ? textBody(message.content) : undefined;
    const atIds = type === 'post' ? postAtIds(message.content) : [];
    for (const mention of mentions) {
      const openId = mentionOpenId(mention);
      if (!openId || openId === 'all' || mentionAppId(mention)) continue;
      const key = mention.key;
      if (typeof key !== 'string' || !key) return undefined;
      const inBody = text !== undefined
        ? hasPlaceholder(text, key)
        : atIds.some(id => id === key || id === openId);
      if (inBody) out.push({ key, openId });
    }
    return out;
  }
  // Post events often leave mentions[] empty and carry the observer open_id
  // directly in each at-node.
  if (type !== 'post') return out;
  for (const id of postAtIds(message.content)) {
    if (id === 'all' || (typeof id === 'string' && id.startsWith('cli_'))) continue;
    if (typeof id !== 'string' || !id.startsWith('ou_')) return undefined;
    out.push({ openId: id });
  }
  return out;
}

/** REST mentions joined across both views by key. Both views must list the
 *  same unique keys in the same order; a key missing from the body is unused. */
function restMentions(type: string, item: any, baseline: any): RestMention[] | undefined {
  const app: any[] = Array.isArray(item.mentions) ? item.mentions : [];
  const base: any[] = Array.isArray(baseline.mentions) ? baseline.mentions : [];
  if (app.length !== base.length) return undefined;
  const text = type === 'text' ? textBody(item.body?.content) ?? '' : undefined;
  const atIds = type === 'post' ? postAtIds(item.body?.content) : [];
  const keys = new Set<string>();
  const out: RestMention[] = [];
  for (let i = 0; i < app.length; i++) {
    const key = app[i]?.key;
    if (typeof key !== 'string' || !key || base[i]?.key !== key || keys.has(key)) return undefined;
    keys.add(key);
    if (text !== undefined ? !hasPlaceholder(text, key) : !atIds.includes(key)) continue;
    out.push({ key, openId: mentionOpenId(base[i]), appId: mentionAppId(app[i]) });
  }
  return out;
}

/** Every event @ consumes its own REST mention with the same observer open_id
 *  (and the same key when the event has one), so a repeated @ needs a repeated
 *  REST mention. Any unpaired event @ fails the whole message. */
function pairMentions(occurrences: EventMention[], rest: RestMention[]): Map<string, string> | undefined {
  const consumed = new Set<RestMention>();
  const verified = new Map<string, string>();
  for (const occurrence of occurrences) {
    const match = rest.find(entry => !consumed.has(entry)
      && entry.openId === occurrence.openId
      && (occurrence.key === undefined || entry.key === occurrence.key));
    if (!match) return undefined;
    consumed.add(match);
    if (!match.appId || !APP_ID.test(match.appId)) continue;
    const previous = verified.get(occurrence.openId);
    if (previous && previous !== match.appId) return undefined;
    verified.set(occurrence.openId, match.appId);
  }
  return verified;
}
