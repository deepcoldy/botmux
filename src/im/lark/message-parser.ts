import type { LarkMessage, LarkMention } from '../../types.js';
import { getMessageDetail } from './client.js';
import { logger } from '../../utils/logger.js';
import {
  REPLY_CARD_FOOTER_ELEMENT_ID,
  REPLY_CARD_HEADING_ELEMENT_ID_RE,
} from './reply-card-footer-signature.js';
import { hasBotmuxCallbackMarker } from './callback-button-marker.js';

// Event data structure from WSClient im.message.receive_v1
// sender is at data top-level, NOT inside data.message
interface RawEventData {
  sender: {
    sender_id: {
      open_id?: string;
      app_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    thread_id?: string;
    parent_id?: string;
    message_type: string; // NOT msg_type
    content: string;
    chat_id: string;
    chat_type: string;
    create_time: string;
    mentions?: Array<{
      key: string;       // e.g. "@_user_1"
      name: string;      // display name
      // Two shapes exist in the wild. The WS event (im.message.receive_v1)
      // delivers an OBJECT: { open_id, union_id, user_id }. The REST API
      // (im.message.get / list) delivers a bare STRING ("ou_xxx") plus a
      // sibling `id_type`. Always read the open_id via mentionOpenId() so both
      // forms are handled — see its doc-comment for why this matters.
      id?: { open_id?: string; user_id?: string; union_id?: string; app_id?: string } | string;
      id_type?: string;  // present only in the REST string form, e.g. "open_id" / "app_id"
      tenant_key?: string;
    }>;
  };
}

/**
 * Extract a mention's open_id, tolerating BOTH Lark shapes for `mention.id`:
 *
 *   - WebSocket event (im.message.receive_v1): `id` is an OBJECT
 *       { open_id, union_id, user_id }            ← what botmux has always seen
 *   - Message REST API (im.message.get / list):  `id` is a bare STRING "ou_xxx"
 *       with a sibling `id_type` ("open_id" | "union_id" | "user_id")
 *
 * The two diverged in production: the API already ships the flat-string form
 * while the event still ships the object form. If Lark ever converges the event
 * onto the string form, every `m.id.open_id` read across botmux would silently
 * become `undefined` and @-detection (isBotMentioned) would fail closed with no
 * log. Reading through this helper keeps every caller robust regardless of
 * which shape arrives.
 *
 * For the string form we return the value only when it actually IS an open_id
 * (id_type === 'open_id', or absent — mentions are open_id-keyed by default). A
 * string carrying a non-open_id id_type (union_id / user_id, which Lark may
 * return when the app lacks the open_id scope) yields `undefined` rather than
 * being mis-compared against a botOpenId.
 */
export function mentionOpenId(m: { id?: { open_id?: string; app_id?: string } | string | null; id_type?: string } | null | undefined): string | undefined {
  const id = m?.id;
  if (id == null) return undefined;
  if (typeof id === 'object') return id.open_id || undefined;
  if (typeof id === 'string') {
    if (m?.id_type && m.id_type !== 'open_id') return undefined;
    return id || undefined;
  }
  return undefined;
}

export interface MentionIdentity {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  appId?: string;
  idType?: string;
}

/** Extract all stable ids Lark provides for @mentions, across WS and REST shapes. */
export function mentionIdentity(m: {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string; app_id?: string } | string | null;
  id_type?: string;
} | null | undefined): MentionIdentity {
  const id = m?.id;
  const out: MentionIdentity = {
    key: m?.key,
    name: m?.name,
    idType: m?.id_type,
  };
  if (id && typeof id === 'object') {
    out.openId = id.open_id || undefined;
    out.userId = id.user_id || undefined;
    out.unionId = id.union_id || undefined;
    out.appId = id.app_id || undefined;
    return out;
  }
  if (typeof id === 'string' && id) {
    if (!m?.id_type || m.id_type === 'open_id') out.openId = id;
    else if (m.id_type === 'user_id') out.userId = id;
    else if (m.id_type === 'union_id') out.unionId = id;
    else if (m.id_type === 'app_id') out.appId = id;
  }
  return out;
}

/** id_type across both shapes Lark uses (snake_case REST, camelCase legacy). */
export function mentionIdType(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.id_type === 'string') return m.id_type;
  if (typeof m.idType === 'string') return m.idType;
  return undefined;
}

/**
 * Extract a bot mention's app_id across ALL shapes Lark has been observed to
 * use. app_id-form bot mentions must never flow through mentionOpenId() (which
 * is persisted/used as an open_id), so they are matched separately:
 *   1. top-level camelCase `m.appId`
 *   2. top-level snake_case `m.app_id`
 *   3. string `m.id` with id_type === 'app_id' (REST bare-string OR legacy)
 *   4. object `m.id.app_id`
 * Keep this exhaustive: the realtime @-gate (isBotMentioned) depends on it, so
 * dropping a shape silently un-@'s a bot in that shape.
 */
export function mentionAppId(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.appId === 'string') return m.appId;
  if (typeof m.app_id === 'string') return m.app_id;
  const idType = mentionIdType(m);
  if (idType === 'app_id' && typeof m.id === 'string') return m.id;
  if (m.id && typeof m.id === 'object' && typeof m.id.app_id === 'string') return m.id.app_id;
  return undefined;
}

/**
 * Extract @-mentions carried by a post (rich-text) message's inline `at` nodes,
 * as routing-only `LarkMention`s for the --mention-back participant window.
 *
 * WHY separate from parseEventMessage().mentions: a post's `message.mentions[]`
 * is frequently empty — the real @s live as inline `{ tag: 'at', user_id,
 * user_name }` nodes in the content (the realtime @-gate isBotMentioned already
 * scans these). Folding them into the general `parsed.mentions` would ripple
 * into prompt rendering / stripLeadingMentions / mention hints, so this stays a
 * dedicated lane consumed ONLY by buildTurnParticipants.
 *
 * A post `at`'s `user_id` is an `ou_` open_id (in-group) or a `cli_` app_id
 * (out-of-group bot). We classify into openId vs appId; `all` and any other
 * shape are surfaced WITHOUT an executable id so the participant core marks the
 * window incomplete rather than inventing a candidate. Deliberately NO position
 * filtering (unlike mention-targets' command parsing) — every counterpart in the
 * turn counts, including a leading @ of the answering bot (excluded later by
 * self open_id/app_id). Returns [] on non-post shapes / parse errors.
 */
export function extractPostAtParticipants(message: { content?: string } | null | undefined): LarkMention[] {
  const out: LarkMention[] = [];
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { return out; }
  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (!Array.isArray(inner?.content)) return out;
  let seq = 0;
  for (const para of inner.content) {
    if (!Array.isArray(para)) continue;
    for (const node of para) {
      if (node?.tag === 'at') {
        const uid: string | undefined = typeof node.user_id === 'string' ? node.user_id : undefined;
        const name: string | undefined = typeof node.user_name === 'string' ? node.user_name : undefined;
        const isOpenId = !!uid && uid.startsWith('ou_');
        const isAppId = !!uid && uid.startsWith('cli_');
        out.push({
          key: `@_post_at_${seq}`,
          name: name ?? uid ?? '',
          ...(isOpenId ? { openId: uid } : {}),
          ...(isAppId ? { appId: uid } : {}),
          idType: isAppId ? 'app_id' : 'open_id',
        });
      }
      seq++;
    }
  }
  return out;
}

/**
 * truth for the @-gate across every consumer (realtime routing's isBotMentioned,
 * the 30s poll backfill, and the dashboard preview/run-preview collector) so the
 * "explicit @ hands off to normal routing, not the listener" rule can never
 * diverge between legs. Matches by open_id OR by app_id (via mentionAppId, which
 * covers every observed app_id shape), and also scans post-content inline `at`
 * tags (post messages may not populate `mentions`).
 */
export function messageMentionsBot(
  message: { mentions?: any[]; content?: string; body?: { content?: string } } | null | undefined,
  larkAppId: string | undefined,
  botOpenId: string | undefined,
): boolean {
  if (!botOpenId && !larkAppId) return false;
  const mentions: any[] = message?.mentions ?? [];
  for (const m of mentions) {
    if (botOpenId && mentionOpenId(m) === botOpenId) return true;
    if (larkAppId && mentionAppId(m) === larkAppId) return true;
  }
  // Post-content inline `at` tags (bot-sent post messages may omit `mentions`).
  // Realtime events carry the body in `content`; the REST message-list API
  // (poll + dashboard preview/run-preview) carries it in `body.content` — read
  // both so the @-gate is identical across all three legs.
  if (botOpenId) {
    const rawContent = message?.content ?? message?.body?.content;
    try {
      const content = JSON.parse(rawContent ?? '{}');
      const inner = content.zh_cn ?? content.en_us ?? content;
      if (Array.isArray(inner?.content)) {
        for (const paragraph of inner.content) {
          if (!Array.isArray(paragraph)) continue;
          for (const node of paragraph) {
            if (node?.tag === 'at' && node.user_id === botOpenId) return true;
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }
  return false;
}

export function extractMentionIdentities(message: {
  mentions?: Array<{
    key?: string;
    name?: string;
    id?: { open_id?: string; user_id?: string; union_id?: string; app_id?: string } | string | null;
    id_type?: string;
  }>;
  content?: string;
} | null | undefined): MentionIdentity[] {
  const out = (message?.mentions ?? []).map(mentionIdentity);
  try {
    const content = JSON.parse(message?.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node?.tag !== 'at') continue;
          // In post/rich-text content Lark carries the mentionee's OPEN_ID in the
          // at-node's `user_id` field (cf. isBotMentioned, which compares
          // node.user_id against botOpenId), NOT a tenant user_id. Map it to
          // openId only — mislabeling it as userId would both miss a userId-only
          // target and pollute the userId leg with an open_id value.
          out.push({
            name: node.user_name,
            openId: node.user_id,
          });
        }
      }
    }
  } catch { /* ignore non-JSON content */ }
  return out;
}

export function mentionUnionId(m: { id?: { union_id?: string } | string | null; id_type?: string } | null | undefined): string | undefined {
  const id = m?.id;
  if (id == null) return undefined;
  if (typeof id === 'object') return id.union_id || undefined;
  if (typeof id === 'string') {
    if (m?.id_type !== 'union_id') return undefined;
    return id || undefined;
  }
  return undefined;
}

/**
 * When the WebSocket event delivers message_type "nonsupport", call the REST API
 * to fetch the real message content and patch the event data in-place.
 *
 * Also handles `interactive`: the WebSocket event only carries a simplified
 * fallback view of cards (often literally "请升级至最新版本客户端，以查看内容"),
 * so we fetch the real card JSON (including v2 `body.elements`) via REST.
 */
export async function resolveNonsupportMessage(data: RawEventData, larkAppId: string): Promise<void> {
  const type = data.message.message_type;
  if (type !== 'nonsupport' && type !== 'interactive') return;

  // Interactive cards: resolve to the COMPLETE merged text (union of both
  // im.message.get representations) so forwarded cards reach the model fully
  // parsed — same resolver `botmux history` uses. resolveEventCard falls back
  // to local user_dsl unwrap if REST is unavailable (e.g. cross-tenant).
  if (type === 'interactive') {
    await resolveEventCard(data, larkAppId);
    return;
  }

  try {
    const detail = await getMessageDetail(larkAppId, data.message.message_id);
    const msg = detail?.items?.[0];
    if (!msg) return;

    const realType = msg.msg_type;
    const realContent = msg.body?.content;
    if (realType && realContent) {
      logger.info(`[parser] Resolved ${type} → ${realType} for ${data.message.message_id}`);
      data.message.message_type = realType;
      data.message.content = realContent;
    }
  } catch (err) {
    logger.debug(`[parser] Failed to resolve ${type} message ${data.message.message_id}: ${err}`);
  }
}

/**
 * Lark bundles the real v2 card JSON inside a `user_dsl` string on the
 * simplified interactive payload. When present, return the unwrapped v2
 * body so downstream extractors see schema/body.elements directly.
 */
export function unwrapUserDslContent(rawContent: string): string | null {
  try {
    const outer = JSON.parse(rawContent);
    if (typeof outer?.user_dsl !== 'string') return null;
    const inner = JSON.parse(outer.user_dsl);
    if (!inner || typeof inner !== 'object') return null;
    if (!inner.body && !inner.elements && !inner.header) return null;
    return JSON.stringify(inner);
  } catch {
    return null;
  }
}

function unwrapUserDsl(data: RawEventData): boolean {
  const unwrapped = unwrapUserDslContent(data.message.content);
  if (unwrapped === null) return false;
  data.message.content = unwrapped;
  logger.info(`[parser] Unwrapped user_dsl for ${data.message.message_id}`);
  return true;
}

/**
 * Lark's simplified "upgrade your client" card fallback marker. When this text
 * shows up in a card's resolved content, the real body was stripped and must be
 * recovered via `im.message.get` (with `card_msg_content_type=user_card_content`).
 */
export const CARD_UPGRADE_FALLBACK = '请升级至最新版本客户端';

/**
 * Broad check — content carries the upgrade notice *somewhere*. Used to decide
 * whether a card needs REST re-resolution. Deliberately a substring match: a
 * false positive only costs one extra `im.message.get`, and this is the only
 * way to catch **embedded** fallbacks — complex cards (e.g. Argos alarm cards
 * with nested sub-cards) render fine at the top level but bury one or more
 * `请升级…` placeholders mid-body where an anchored check would miss them.
 */
export function cardContentHasUpgradeFallback(content: string): boolean {
  return content.includes(CARD_UPGRADE_FALLBACK);
}

/**
 * Narrow check — content *is* essentially just Lark's upgrade notice, not a
 * body that merely mentions it. Anchored at the start after stripping leading
 * `[图片]` / `[文件 N]` placeholders (the bare fallback renders as
 * `[图片]请升级至最新版本客户端，以查看内容`). Used as the replace gate when
 * re-resolving via REST: it keeps a card that legitimately quotes the phrase
 * mid-text — e.g. a message discussing this very fallback — from being
 * discarded, while still rejecting a REST view that came back as a bare
 * fallback. Makes no structural assumptions, so it's safe for the
 * simplified-but-real Format A shape (no schema/body/header) message.list
 * returns.
 */
export function isPureCardUpgradeFallback(content: string): boolean {
  const stripped = content.replace(/^(?:\s*\[(?:图片|文件)[^\]]*\])+/, '').trimStart();
  return stripped.startsWith(CARD_UPGRADE_FALLBACK);
}

export interface MessageResource {
  type: 'image' | 'file';
  key: string;
  name: string;
  /** When set, download uses this message_id instead of the parent (e.g. merge_forward sub-messages). */
  messageId?: string;
}

/**
 * Stateful numbering that keeps `[图片 N]` / `[文件 N]` placeholders in the
 * rendered text aligned with the attachment footer. The same key always gets
 * the same number, so duplicates across merge_forward sub-messages collapse
 * correctly.
 *
 * Image and file counters are INDEPENDENT — `formatAttachmentsHint` emits
 * `<image n=...>` and `<file n=...>` separately numbered, so a message with
 * one image and one file should render as `[图片 1]` + `[文件 1]`, not
 * `[图片 1]` + `[文件 2]`. Keys are typed via the `image:` / `file:` prefix.
 */
export interface ImgNumberer {
  assign(key: string): { num: number; isNew: boolean };
}

export function createImgNumberer(): ImgNumberer {
  const map = new Map<string, number>();
  let imgCounter = 0;
  let fileCounter = 0;
  return {
    assign(key: string) {
      const existing = map.get(key);
      if (existing !== undefined) return { num: existing, isNew: false };
      // Key prefix selects the counter so image/file numbering stays
      // independent (mirrors formatAttachmentsHint's per-type imgN/fileN).
      // Unknown prefixes share the image counter as a safe default.
      const num = key.startsWith('file:') ? ++fileCounter : ++imgCounter;
      map.set(key, num);
      return { num, isNew: true };
    },
  };
}

export function extractResources(msgType: string, rawContent: string, numberer?: ImgNumberer): MessageResource[] {
  const content = normalizeApiMessageContent(msgType, rawContent);
  const nb = numberer ?? createImgNumberer();
  const pushIfNew = (resources: MessageResource[], r: MessageResource) => {
    if (nb.assign(`${r.type}:${r.key}`).isNew) resources.push(r);
  };
  try {
    const parsed = JSON.parse(content);

    if (msgType === 'image') {
      const resources: MessageResource[] = [];
      const imageKey = parsed.image_key;
      if (imageKey) pushIfNew(resources, { type: 'image', key: imageKey, name: `${imageKey}.jpg` });
      return resources;
    }

    if (msgType === 'file') {
      const resources: MessageResource[] = [];
      const fileKey = parsed.file_key;
      if (fileKey) pushIfNew(resources, { type: 'file', key: fileKey, name: parsed.file_name ?? fileKey });
      return resources;
    }

    if (msgType === 'post') {
      const resources: MessageResource[] = [];
      const { content: contentBlocks } = resolvePostBody(parsed);
      for (const block of contentBlocks) {
        const nodes = Array.isArray(block) ? block : [block];
        for (const node of nodes) {
          if ((node.tag === 'img' || node.tag === 'media') && node.image_key) {
            pushIfNew(resources, { type: 'image', key: node.image_key, name: `${node.image_key}.jpg` });
          }
          if (node.tag === 'file' && node.file_key) {
            pushIfNew(resources, { type: 'file', key: node.file_key, name: node.file_name ?? node.file_key });
          }
        }
      }
      return resources;
    }

    if (msgType === 'interactive') {
      const resources: MessageResource[] = [];
      // v2 cards nest elements under `body`; fall back to legacy top-level.
      const rootElements = Array.isArray(parsed.body?.elements)
        ? parsed.body.elements
        : Array.isArray(parsed.elements) ? parsed.elements : null;
      if (rootElements) {
        const isApiFormat = rootElements.length > 0 && Array.isArray(rootElements[0]);
        if (isApiFormat) {
          // Format A: [[{tag:"img",image_key:"..."}, ...], ...]
          for (const block of rootElements) {
            if (!Array.isArray(block)) continue;
            for (const node of block) {
              const key = node.image_key ?? node.img_key;
              if ((node.tag === 'img' || node.tag === 'image') && key) {
                pushIfNew(resources, { type: 'image', key, name: `${key}.jpg` });
              }
            }
          }
        } else {
          for (const el of rootElements) {
            extractElementImages(el, resources, pushIfNew);
          }
        }
      }
      return resources;
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

export function parseEventMessage(
  data: RawEventData,
  numberer: ImgNumberer = createImgNumberer(),
): { parsed: LarkMessage; resources: MessageResource[] } {
  const { sender, message } = data;

  // Trace non-text messages at debug only (DEBUG=1 gated). The raw card/post
  // content can be many KB and may include attachment metadata that's
  // noisy or sensitive — truncate to ~500 chars so DEBUG logs stay scannable.
  if (message.message_type !== 'text' && logger.isDebug()) {
    const raw = message.content ?? '';
    const trimmed = raw.length > 500 ? raw.slice(0, 500) + `…(+${raw.length - 500}b)` : raw;
    logger.debug(`[parser] type=${message.message_type} content=${trimmed} keys=${Object.keys(message).join(',')}`);
  }

  // Share numberer so in-body [图片 N] placeholders use the same numbers as
  // the attachment list. Resources first → numbers assigned; text second →
  // reuses them.
  const resources = extractResources(message.message_type, message.content, numberer);

  // Extract structured mentions
  const mentions: LarkMention[] | undefined =
    message.mentions && message.mentions.length > 0
      ? message.mentions.map(m => ({
          key: m.key,
          name: m.name,
          openId: mentionOpenId(m),
          userId: mentionIdentity(m).userId,
          unionId: mentionUnionId(m),
          appId: mentionIdentity(m).appId,
          idType: m.id_type,
        }))
      : undefined;

  const parsed: LarkMessage = {
    messageId: message.message_id,
    rootId: message.root_id ?? '',
    threadId: message.thread_id || undefined,
    parentId: message.parent_id || undefined,
    senderId: sender.sender_id?.open_id ?? '',
    senderUnionId: sender.sender_id?.union_id,
    senderType: sender.sender_type,
    msgType: message.message_type,
    content: extractTextContent(message.message_type, message.content, message.mentions, numberer),
    createTime: message.create_time,
    mentions,
  };
  return { parsed, resources };
}

export function parseApiMessage(msg: any, numberer?: ImgNumberer): LarkMessage {
  const msgType = msg.msg_type ?? 'text';
  const rawContent = msg.body?.content ?? '';
  // sender_name is only present when the fetch opted in via with_sender_name=true
  // (all client.ts message read paths do). Covers bot senders too — the one case
  // local rosters can't resolve for third-party bots.
  const senderName = typeof msg.sender?.sender_name === 'string' && msg.sender.sender_name.trim()
    ? msg.sender.sender_name.trim()
    : undefined;
  return {
    messageId: msg.message_id ?? '',
    rootId: msg.root_id ?? msg.thread_id ?? '',
    senderId: msg.sender?.id ?? '',
    senderType: msg.sender?.sender_type ?? 'unknown',
    ...(senderName ? { senderName } : {}),
    msgType,
    content: extractTextContent(msgType, normalizeApiMessageContent(msgType, rawContent), undefined, numberer),
    createTime: msg.create_time ?? '',
  };
}

function normalizeApiMessageContent(msgType: string, rawContent: string): string {
  if (msgType !== 'interactive') return rawContent;
  return unwrapUserDslContent(rawContent) ?? rawContent;
}

/** Resolve post body from either wrapped {"zh_cn":{title,content}} or unwrapped {title,content} format */
function resolvePostBody(parsed: any): { title: string; content: any[] } {
  // Unwrapped: has content array directly
  if (Array.isArray(parsed.content)) {
    return { title: parsed.title ?? '', content: parsed.content };
  }
  // Wrapped in language key: {"zh_cn": {title, content}}
  for (const key of Object.keys(parsed)) {
    const val = parsed[key];
    if (val && typeof val === 'object' && Array.isArray(val.content)) {
      return { title: val.title ?? '', content: val.content };
    }
  }
  return { title: '', content: [] };
}

/**
 * Strip leading `@<name>` mentions from a resolved-content string so callers
 * can detect daemon `/commands` even when the user @-mentioned the bot first.
 *
 * Uses the structured mentions list when available (handles names with spaces);
 * falls back to a `@\S+` regex for cases where Lark didn't populate mentions
 * (e.g. some post messages where the at-tag becomes a plain `@<user_name>`
 * string in the rendered text).
 */
export function stripLeadingMentions(content: string, mentions?: { name: string }[]): string {
  let s = content.trimStart();
  if (mentions && mentions.length > 0) {
    // Sort by name length desc so "@Claude分身" wins over "@Claude" when both
    // could startsWith — otherwise the short name eats "@Claude" and leaves
    // "分身 @CoCo /close" stranded, breaking slash-command detection in
    // multi-bot @ chains like "@Claude @Claude分身 @CoCo /close".
    const sortedMentions = [...mentions].sort((a, b) => b.name.length - a.name.length);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of sortedMentions) {
        const tag = `@${m.name}`;
        if (s.startsWith(tag)) {
          s = s.slice(tag.length).trimStart();
          changed = true;
          break;
        }
      }
    }
    return s;
  }
  // No mentions list (e.g. some post messages) — best-effort strip leading
  // single-word @<word> patterns. Multi-word names without a mentions list
  // can't be reliably detected and will be left in place.
  let changed = true;
  while (changed) {
    changed = false;
    const m = s.match(/^@\S+/);
    if (m) {
      s = s.slice(m[0].length).trimStart();
      changed = true;
    }
  }
  return s;
}

function resolveMentions(text: string, mentions?: RawEventData['message']['mentions']): string {
  if (!mentions || mentions.length === 0) {
    // No mention info available — strip placeholders
    return text.replace(/@_user_\d+/g, '').replace(/[^\S\r\n]{2,}/g, ' ').trim();
  }
  let result = text;
  for (const m of mentions) {
    result = result.replace(m.key, `@${m.name}`);
  }
  return result.trim();
}

function normalizeFenceLanguage(lang: unknown): string {
  return typeof lang === 'string' ? lang.trim().replace(/\s+/g, '_') : '';
}

function renderPostCodeBlock(node: any): string {
  const raw = typeof node.text === 'string'
    ? node.text
    : typeof node.content === 'string'
      ? node.content
      : typeof node.code === 'string'
        ? node.code
        : '';
  const code = raw.replace(/\n+$/, '');
  const lang = normalizeFenceLanguage(node.language ?? node.lang);
  const longestFence = Math.max(2, ...[...code.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(longestFence + 1);
  return `\n${fence}${lang}\n${code}\n${fence}\n`;
}

function renderPostNode(node: any, numberer?: ImgNumberer): string {
  if (node.tag === 'text') return node.text ?? '';
  if (node.tag === 'a') return node.text ?? node.href ?? '';
  if (node.tag === 'at') return `@${node.user_name ?? 'unknown'}`;
  if (node.tag === 'code_block') return renderPostCodeBlock(node);
  if (node.tag === 'img' || node.tag === 'media') {
    const key = node.image_key ?? node.file_key;
    if (key && numberer) return `[图片 ${numberer.assign(`image:${key}`).num}]`;
    return '[图片]';
  }
  if (node.tag === 'file') {
    const key = node.file_key;
    const name = node.file_name ?? '';
    if (key && numberer) {
      const n = numberer.assign(`file:${key}`).num;
      return name ? `[文件 ${n}: ${name}]` : `[文件 ${n}]`;
    }
    return name ? `[文件: ${name}]` : '[文件]';
  }
  return '';
}

function joinPostNodeText(parts: string[]): string {
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Placeholder for inbound voice messages. The daemon's audio-transcribe hook
 *  replaces it with the ASR transcript (prefixed) before the turn is
 *  dispatched; paths the hook doesn't cover still get this safe placeholder
 *  instead of the raw {"file_key":...} JSON. */
export const AUDIO_PLACEHOLDER = '[语音]';

function extractTextContent(msgType: string, rawContent: string, mentions?: RawEventData['message']['mentions'], numberer?: ImgNumberer): string {
  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(rawContent);
      return resolveMentions(parsed.text ?? rawContent, mentions);
    }
    if (msgType === 'post') {
      const parsed = JSON.parse(rawContent);
      const { title, content } = resolvePostBody(parsed);
      const body = content
        .map((paragraph: any[]) => {
          const nodes = Array.isArray(paragraph) ? paragraph : [paragraph];
          return joinPostNodeText(nodes.map((node: any) => renderPostNode(node, numberer)));
        })
        .filter(Boolean)
        .join('\n');
      return title ? `${title}\n${body}` : body;
    }
    if (msgType === 'image') {
      try {
        const p = JSON.parse(rawContent);
        if (p.image_key && numberer) return `[图片 ${numberer.assign(`image:${p.image_key}`).num}]`;
      } catch { /* fall through */ }
      return '[图片]';
    }
    if (msgType === 'file') {
      try {
        const p = JSON.parse(rawContent);
        if (p.file_key && numberer) {
          const n = numberer.assign(`file:${p.file_key}`).num;
          return p.file_name ? `[文件 ${n}: ${p.file_name}]` : `[文件 ${n}]`;
        }
        return `[文件: ${p.file_name ?? 'unknown'}]`;
      } catch {
        return '[文件]';
      }
    }
    if (msgType === 'audio') {
      // 语音消息的转写在 daemon 的 audio-transcribe hook 里完成（下载 opus →
      // ASR → 带前缀文本）；这里只给占位符，避免原始 JSON 注入 CLI。
      return AUDIO_PLACEHOLDER;
    }
    if (msgType === 'interactive') {
      return extractCardContent(rawContent, numberer);
    }
    if (msgType === 'merge_forward') {
      return '[合并转发消息]';
    }
    return rawContent;
  } catch {
    return rawContent;
  }
}

/**
 * Extract the download key from an inbound audio message's raw content
 * (`{"file_key":"...","duration":<ms>}`). Returns null when the content isn't
 * valid JSON or carries no usable file_key — callers should treat that as a
 * permanent failure (reply, don't retry). `duration` is optional and surfaced
 * as durationMs for callers that want to log/skip overlong clips.
 */
export function extractAudioMeta(rawContent: string): { fileKey: string; durationMs?: number } | null {
  try {
    const parsed = JSON.parse(rawContent);
    if (!parsed || typeof parsed.file_key !== 'string' || !parsed.file_key) return null;
    return {
      fileKey: parsed.file_key,
      ...(typeof parsed.duration === 'number' ? { durationMs: parsed.duration } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * botmux-generated reply-card footer signature. New cards carry both a visible
 * versioned link marker and an exact element id. The canonical repository URL
 * is NOT a signature: it is valid body content. For pre-signature cards we
 * recognize only the exact old default-brand + recipient chrome shape; a
 * default-brand-only old card is intentionally preserved because it is
 * indistinguishable from an ordinary repository link.
 */
const LEGACY_DEFAULT_FOOTER_URL = 'https://github.com/deepcoldy/botmux';
const FOOTER_MARKER_HASHES = new Set(['#reply-card-footer', '#reply-card-footer-v1']);

function isBotmuxFooterMarkerUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && decodeURIComponent(url.pathname) === '/deepcoldy/botmux'
      && FOOTER_MARKER_HASHES.has(url.hash);
  } catch {
    return false;
  }
}

function isBotmuxFooterMarkerText(value: unknown): boolean {
  return value === '·' || value === '\u200B';
}

function isBotmuxFooterMarkerAnchor(href: unknown, text: unknown): boolean {
  return isBotmuxFooterMarkerText(text) && isBotmuxFooterMarkerUrl(href);
}

function greyFontInner(line: string): string | null {
  const font = /^\s*<font\b([^>]*)>([\s\S]*?)<\/font>\s*$/i.exec(line);
  if (!font || !/\bcolor\s*=\s*(?:"grey"|'grey'|grey)(?:\s|$)/i.test(font[1])) return null;
  return font[2];
}

function hasExactMarkerMarkdown(value: string): boolean {
  // Match only the protocol's reserved anchor texts. A generic Markdown-link
  // regex can start at an unmatched `[` inside a custom brand and swallow the
  // later marker before it gets a chance to match.
  for (const match of value.matchAll(/\[(·|\u200B)\]\(([^)\s]+)\)/gu)) {
    if (isBotmuxFooterMarkerAnchor(match[2], match[1])) return true;
  }
  return false;
}

function isSignedFormatBFooterLine(line: string): boolean {
  const inner = greyFontInner(line);
  return inner !== null && hasExactMarkerMarkdown(inner);
}

/** Strict compatibility recognizer for Format A cards emitted before the
 * versioned marker existed. Recipient chrome is required; without it, the old
 * default-brand-only footer is indistinguishable from a real repository link. */
function isMeaningfulFormatANode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const value = node as any;
  if (value.tag === 'text') return typeof value.text === 'string' && value.text.trim().length > 0;
  return true;
}

function isLegacyFormatAFooterParagraph(paragraph: unknown[]): boolean {
  const nodes = paragraph.filter(isMeaningfulFormatANode) as any[];
  const first = nodes[0];
  if (
    first?.tag !== 'a'
    || first.href !== LEGACY_DEFAULT_FOOTER_URL
    || typeof first.text !== 'string'
    || first.text.trim().toLowerCase() !== 'botmux'
  ) {
    return false;
  }

  let label = '';
  let sawAt = false;
  for (const node of nodes.slice(1)) {
    if (node.tag === 'at') {
      sawAt = true;
      continue;
    }
    if (node.tag !== 'text' || typeof node.text !== 'string') return false;
    if (sawAt && node.text.trim() !== '') return false;
    label += node.text;
  }
  return sawAt && /^\s*·\s*(?:发送给：|Sent to:)\s*$/i.test(label);
}

/** Strict compatibility recognizer for an old original-format footer line.
 * Grey styling plus exact default brand, locale label, and one or more native
 * mentions are all required; styling or the canonical URL alone proves
 * nothing. */
function isLegacyFormatBFooterLine(line: string): boolean {
  const inner = greyFontInner(line);
  if (inner === null) return false;
  return /^\s*\[botmux\]\(https:\/\/github\.com\/deepcoldy\/botmux\)\s*·\s*(?:发送给：|Sent to:)\s*(?:<at\s+id=(?:"[^"]+"|'[^']+'|[^\s>]+)\s*><\/at>\s*)+$/i
    .test(inner);
}

function extractRenderedCardContent(rawContent: string): string | undefined {
  const match = rawContent.match(/^\s*<card(?:\s+title="([^"]*)")?\s*>([\s\S]*)<\/card>\s*$/);
  if (!match) return undefined;
  const title = match[1]?.trim();
  const body = match[2]
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => !isSignedFormatBFooterLine(line))
    .join('\n')
    .trim();
  return [
    title ? `[卡片: ${title}]` : '',
    body,
  ].filter(Boolean).join('\n') || '[卡片]';
}

/**
 * Extract human-readable text from an interactive card.
 *
 * Lark API returns card content in a **simplified format** (not the original card JSON):
 *   { title: "...", elements: [[{tag:"text",text:"..."}, ...], ...] }
 * This is similar to post message body.  We also handle the original card JSON
 * (header/config/elements with tag objects) for locally-cached cards.
 */
export function extractCardContent(rawContent: string, numberer?: ImgNumberer): string {
  const rendered = extractRenderedCardContent(rawContent);
  if (rendered !== undefined) return rendered;

  try {
    const card = JSON.parse(rawContent);

    // Pre-resolved merged text injected by resolveMergedCardContent (the
    // A+B union for complex cards). Return it verbatim so the merge flows
    // through both parseEventMessage (live) and parseApiMessage (history).
    if (typeof card[RESOLVED_TEXT_KEY] === 'string') return card[RESOLVED_TEXT_KEY];

    // Template-based card — no inline content to extract
    if (card.type === 'template') {
      return '[卡片 (模板)]';
    }

    const parts: string[] = [];

    // --- Format A: Lark API simplified format ---
    // { title: "...", elements: [[{tag,text}, ...], ...] }
    // 只有 title 存在时才 push 标识行；没 title 的卡片（例如 markdown 自动转
    // 卡片的 outgoing 消息）让 elements 内容自己说话，避免在正文前堆一行
    // 多余的 `[卡片]`。整张卡片真的没内容时下方 `parts.join('\n') || '[卡片]'`
    // 会兜底返回占位。
    const title = nestedCardText(card.title) ?? nestedCardText(card.header?.title);
    if (title) parts.push(`[卡片: ${title}]`);
    for (const tagText of extractCardHeaderTagTexts(card.header)) {
      parts.push(`[标签: ${tagText}]`);
    }

    // v2 cards nest elements under `body`; fall back to legacy top-level.
    const rootElements = Array.isArray(card.body?.elements)
      ? card.body.elements
      : Array.isArray(card.elements) ? card.elements : null;

    const imgLabel = (key: string) => numberer ? `[图片 ${numberer.assign(`image:${key}`).num}]` : '[图片]';

    if (rootElements) {
      const isApiFormat = rootElements.length > 0 && Array.isArray(rootElements[0]);

      if (isApiFormat) {
        // Format A: [[{tag:"text",text:"..."}, {tag:"img",...}, {tag:"button",...}], ...]
        let lastMeaningfulParagraphIndex = -1;
        for (let i = rootElements.length - 1; i >= 0; i--) {
          const candidate = rootElements[i];
          if (Array.isArray(candidate) && candidate.some(isMeaningfulFormatANode)) {
            lastMeaningfulParagraphIndex = i;
            break;
          }
        }
        for (let paragraphIndex = 0; paragraphIndex < rootElements.length; paragraphIndex++) {
          const paragraph = rootElements[paragraphIndex];
          if (!Array.isArray(paragraph)) continue;
          if (
            paragraphIndex === lastMeaningfulParagraphIndex
            && isLegacyFormatAFooterParagraph(paragraph)
          ) {
            continue;
          }
          const textNodes: string[] = [];
          const buttons: string[] = [];
          let inSignedFooter = false;
          for (const node of paragraph) {
            if (inSignedFooter) continue;
            if (node.tag === 'text') { if (node.text) textNodes.push(node.text); }
            else if (node.tag === 'a') {
              if (isBotmuxFooterMarkerAnchor(node.href, node.text)) {
                inSignedFooter = true;
                continue;
              }
              // Keep the href so links survive — Format A separates text/href,
              // and dropping href loses real content (规则配置/详情/Trace 链接).
              // Bare long URLs (e.g. Argos Kibana 处理建议) come back with
              // text === href, both cut at the same offset, and the remainder
              // spilling into the FOLLOWING text nodes of the same paragraph.
              // Emitting `text(href)` would double the truncated URL and
              // corrupt the line; a single copy lets join('') below reconnect
              // the full URL from those remainder nodes.
              const t = node.text ?? '';
              if (t && t === node.href) textNodes.push(t);
              else textNodes.push(node.href && t ? `${t}(${node.href})` : (t || node.href || ''));
            }
            else if (node.tag === 'at') textNodes.push(`@${node.user_name ?? 'unknown'}`);
            else if (node.tag === 'img' || node.tag === 'image') {
              const k = node.image_key ?? node.img_key;
              if (k) textNodes.push(imgLabel(k));
            }
            else if (node.tag === 'button') {
              // Same jump-URL policy as Format B: simple cards reach history
              // via the Format A list view WITHOUT a resolve pass, so dropping
              // the URL here would lose button links on that main path.
              if (isBotmuxCallbackButton(node)) continue;
              const btnText = typeof node.text === 'string' ? node.text : node.text?.content;
              if (btnText) {
                const url = buttonOpenUrl(node);
                buttons.push(url ? `[${btnText}](${url})` : `[${btnText}]`);
              }
            }
            else if (node.tag === 'input') {
              const ph = typeof node.placeholder === 'string' ? node.placeholder : node.placeholder?.content;
              if (ph) buttons.push(`[输入框: ${ph}]`);
            }
            else if (node.tag === 'select_static' || node.tag === 'multi_select_static' || node.tag === 'overflow') {
              const ph = typeof node.placeholder === 'string' ? node.placeholder : node.placeholder?.content;
              const opts = Array.isArray(node.options)
                ? node.options.map((o: any) => (typeof o.text === 'string' ? o.text : o.text?.content)).filter(Boolean)
                : [];
              const head = ph ? `[下拉: ${ph}` : '[下拉';
              buttons.push(opts.length ? `${head} | 选项: ${opts.join(' / ')}]` : `${head}]`);
            }
          }
          const line = textNodes.join('').trim();
          if (line) {
            if (inSignedFooter) {
              const lastBreak = line.lastIndexOf('\n');
              if (lastBreak >= 0) {
                const beforeFooter = line.slice(0, lastBreak).trim();
                if (beforeFooter) parts.push(beforeFooter);
              }
              // No newline before the signed marker means the whole paragraph is
              // footer chrome (brand/usage/recipient). Keep nothing.
            } else {
              parts.push(line);
            }
          }
          if (buttons.length) parts.push(buttons.join(' '));
        }
      } else {
        for (const el of rootElements) {
          extractElementText(el, parts, imgLabel);
        }
      }
    }

    // Drop the botmux footer chrome so a receiving bot's prompt isn't polluted
    // by the grey `botmux` badge / `发送给：@owner` line. Line-level (not
    // part-level) so a footer never takes adjacent real content with it.
    // Stable legacy markers may occur inside a multiline element, so remove
    // only their exact line. Marker-less footer-shaped text is deliberately
    // preserved: an arbitrary custom brand is indistinguishable from user data.
    let visibleParts = parts
      .map(part => part
        .split('\n')
        .filter(line => !isSignedFormatBFooterLine(line))
        .join('\n'))
      .filter(part => !!part.trim());
    // Marker-less legacy compatibility is intentionally tail-only. Old
    // botmux footers were always last; applying this heuristic in the middle
    // of a foreign card would turn a footer-shaped body note into data loss.
    if (visibleParts.length > 0) {
      const lastIndex = visibleParts.length - 1;
      const lines = visibleParts[lastIndex].split('\n');
      let lastLine = lines.length - 1;
      while (lastLine >= 0 && !lines[lastLine].trim()) lastLine--;
      if (lastLine >= 0 && isLegacyFormatBFooterLine(lines[lastLine])) {
        lines.splice(lastLine, 1);
        visibleParts[lastIndex] = lines.join('\n');
        visibleParts = visibleParts.filter(part => !!part.trim());
      }
    }
    const cleaned = visibleParts.join('\n');
    return cleaned || '[卡片]';
  } catch {
    return '[卡片]';
  }
}

// ─── Complete card resolution: union of both Lark representations ──────────

/** Sentinel key carrying pre-merged card text through extractCardContent. */
const RESOLVED_TEXT_KEY = '__botmux_card_text__';

/**
 * Marker for sub-cards Lark renders only client-side (collapsible panels,
 * lazy "展开" sections). Neither `im.message.get` representation returns their
 * body — Format A shows the upgrade fallback, Format B omits them — so we
 * surface an honest placeholder instead of a misleading blank or raw fallback.
 */
export const CARD_EMBEDDED_PLACEHOLDER = '[卡片内嵌组件，需在飞书客户端展开查看]';

/** Wrap merged text so extractCardContent returns it verbatim downstream. */
export function wrapResolvedCardText(text: string): string {
  return JSON.stringify({ [RESOLVED_TEXT_KEY]: text });
}

/** Strip inline markup (font/text_tag tags, bold markers) but keep text,
 *  brackets and links so labels and values stay readable. */
function stripInlineMarkup(s: string): string {
  return s.replace(/<\/?[a-z_]+[^>]*>/gi, '').replace(/\*\*/g, '');
}

/** Normalize for content-presence checks: drop whitespace, punctuation, inline
 *  markup and link URLs so the same content rendered by the two API formats
 *  compares equal regardless of cosmetic differences. */
function normalizeForDedup(s: string): string {
  return stripInlineMarkup(s)
    .replace(/\((https?:[^)]+)\)/g, '')         // (https://…) link targets
    .replace(/\s+/g, '')
    .replace(/[，,：:。.\[\]()（）|/、]/g, '');
}

/** Find the value Format A rendered for a `label:` field — the text after the
 *  first occurrence of the label up to the line end. Returns '' if not found. */
function findLabelValue(strippedA: string, label: string): string {
  const idx = strippedA.indexOf(label);
  if (idx < 0) return '';
  const rest = strippedA.slice(idx + label.length);
  return rest.split('\n')[0].trim();
}

/**
 * Merge the two Lark card renderings into one complete text. Format B (full
 * structured) is the base — it preserves links, sub-card bodies and select
 * options. From Format A (server-rendered) we recover only the field VALUES B
 * left blank (e.g. 值班人 names) via targeted label-fill: a B label line whose
 * value is empty is filled from A only when A's value isn't already present in
 * B (so fields B already renders aren't duplicated). Sub-cards Lark serves
 * client-side only — which A shows as upgrade holes and B omits — get one
 * honest placeholder rather than a silent drop or raw "请升级" text.
 */
export function mergeCardText(textA: string, textB: string): string {
  const markHoles = (t: string) =>
    t.split('\n').map(l => isPureCardUpgradeFallback(l) ? CARD_EMBEDDED_PLACEHOLDER : l).join('\n');

  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!b || isPureCardUpgradeFallback(b)) return markHoles(a) || a;
  if (!a || isPureCardUpgradeFallback(a)) return markHoles(b) || b;

  // Drop A's holes from the base, count them so we can flag client-only content.
  const aHoleCount = a.split('\n').filter(isPureCardUpgradeFallback).length;
  const strippedA = stripInlineMarkup(a);

  const baseLines = b.split('\n').filter(l => !isPureCardUpgradeFallback(l));
  const bAll = baseLines.map(normalizeForDedup).join('');

  // CardKit can expose header metadata in only one of the two message-detail
  // representations. B remains authoritative for the single card title, while
  // tags are an exact-value union: if B renders one tag and A renders a second,
  // neither fact may disappear merely because both share the same metadata kind.
  const metadataKind = (line: string): 'card' | 'tag' | undefined => {
    if (/^\[卡片(?::[^\]]+)?\]$/.test(line.trim())) return 'card';
    if (/^\[标签:[^\]]+\]$/.test(line.trim())) return 'tag';
    return undefined;
  };
  const bHasCardMetadata = baseLines.some(line => metadataKind(line) === 'card');
  const bTagMetadata = new Set(
    baseLines
      .filter(line => metadataKind(line) === 'tag')
      .map(normalizeForDedup)
      .filter(Boolean),
  );
  const seenMetadata = new Set<string>();
  const missingMetadata = a.split('\n').filter(line => {
    const kind = metadataKind(line);
    if (!kind) return false;
    const key = normalizeForDedup(line);
    if (kind === 'card' && bHasCardMetadata) return false;
    if (kind === 'tag' && bTagMetadata.has(key)) return false;
    if (!key || seenMetadata.has(key)) return false;
    seenMetadata.add(key);
    return true;
  });

  const filled = baseLines.map(line => {
    const sm = stripInlineMarkup(line).trimEnd();
    // empty-value field label, e.g. "值班人:" — but not bracketed section
    // headers like "[ 检测结果 ]:" whose values live on following lines.
    const m = sm.match(/^([^[\]\n]{1,16}?[:：])$/);
    if (!m) return line;
    const value = findLabelValue(strippedA, m[1]);
    if (!value) return line;
    // Only fill when B genuinely lacks this value (avoids duplicating fields
    // whose values B already renders on adjacent lines, e.g. Tags/检测结果).
    if (normalizeForDedup(value) && bAll.includes(normalizeForDedup(value))) return line;
    return `${line.replace(/\s*$/, '')} ${value}`;
  });
  const missingCards = missingMetadata.filter(line => metadataKind(line) === 'card');
  const missingTags = missingMetadata.filter(line => metadataKind(line) === 'tag');
  if (missingCards.length > 0) filled.unshift(...missingCards);
  if (missingTags.length > 0) {
    let lastCardIndex = -1;
    for (let index = 0; index < filled.length; index++) {
      if (metadataKind(filled[index]) === 'card') lastCardIndex = index;
    }
    filled.splice(lastCardIndex + 1, 0, ...missingTags);
  }

  // One honest marker if A carried sub-cards Lark only renders client-side.
  if (aHoleCount > 0) filled.push(CARD_EMBEDDED_PLACEHOLDER);
  return filled.join('\n');
}

/**
 * Resolve a card to its most complete text by unioning both `im.message.get`
 * representations (server-rendered Format A + full structured Format B). Used
 * by BOTH the live event path and `botmux history` so a single message_id
 * resolves identically everywhere. Returns null when neither representation
 * could be fetched (caller keeps whatever it already had).
 */
export async function resolveMergedCardContent(
  larkAppId: string, messageId: string, numberer?: ImgNumberer,
): Promise<{ text: string; structuredContent: string; resources: MessageResource[] } | null> {
  const [aRes, bRes] = await Promise.all([
    getMessageDetail(larkAppId, messageId, { userCardContent: false }).catch(() => null),
    getMessageDetail(larkAppId, messageId, { userCardContent: true }).catch(() => null),
  ]);
  const aContent = aRes?.items?.[0]?.body?.content;
  const bContent = bRes?.items?.[0]?.body?.content;
  if (!aContent && !bContent) return null;
  const structuredContent = (bContent ?? aContent)!;
  // Resources BEFORE text so the shared numberer assigns [图片 N] in attachment
  // order and the text extraction below reuses those numbers (same ordering
  // contract as parseEventMessage / buildForwardedTree). Callers that don't
  // pass a numberer are unaffected (fresh internal one, unnumbered text).
  const resources = extractResources('interactive', structuredContent, numberer);
  const textA = aContent ? extractCardContent(normalizeApiMessageContent('interactive', aContent), numberer) : '';
  const textB = bContent ? extractCardContent(normalizeApiMessageContent('interactive', bContent), numberer) : '';
  const merged = mergeCardText(textA, textB);
  if (!merged) return null;
  // Carry the structured card JSON (B preferred) alongside the merged text so
  // resource extraction (image_key/file_key) keeps working — extractResources
  // walks elements/body, extractCardContent short-circuits on the text key.
  return { text: merged, structuredContent, resources };
}

/**
 * Resolve an interactive event's card to its complete merged text in place.
 * Stores a sentinel that carries BOTH the merged text (for extractCardContent)
 * and the structured card JSON (for extractResources image/file extraction).
 * Falls back to local user_dsl unwrap if the REST merge yields nothing. Shared
 * by the live daemon path so forwarded cards reach the model fully parsed.
 */
export async function resolveEventCard(data: RawEventData, larkAppId: string): Promise<void> {
  let resolved: { text: string; structuredContent: string } | null = null;
  try {
    resolved = await resolveMergedCardContent(larkAppId, data.message.message_id);
  } catch { /* fall through to local unwrap */ }
  if (resolved) {
    const structured = (() => { try { return JSON.parse(resolved!.structuredContent); } catch { return {}; } })();
    data.message.content = JSON.stringify({ ...structured, [RESOLVED_TEXT_KEY]: resolved.text });
    return;
  }
  unwrapUserDsl(data);
}

/** First non-empty string among the candidates. Deliberately NOT `??` — Lark
 *  payloads carry empty-string placeholders (e.g. multi_url: {url: '', pc_url:
 *  'https://…'}) which nullish coalescing would return, swallowing the valid
 *  platform URL behind it. */
function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return undefined;
}

/** botmux's own card control buttons (🔊 语音总结 / 关闭会话 / 重启 / 配置 …) are
 *  pure callbacks back into the daemon: when another bot reads the card
 *  (history / cross-bot relay / quote), rendering them as `[🔊 语音总结]`
 *  pollutes the receiving prompt with affordances it can never click, so
 *  drop them structurally — same rationale as the botmux grey-footer strip
 *  in extractElementText.
 *
 *  Primary detection is the egress-stamped ownership marker
 *  (callback-button-marker.ts). This wordlist is the LEGACY fallback for
 *  cards sent by pre-marker builds (chat history is long-lived), covering
 *  every action dispatched by card-handler as of the fix — it is frozen;
 *  new botmux buttons rely on the marker, not on growing this list.
 *  Third-party cards' buttons (Argos 确认/创建群组…) stay: they carry no
 *  marker and their `value` never uses botmux's action vocabulary. */
const BOTMUX_INTERNAL_CARD_ACTIONS: ReadonlySet<string> = new Set([
  // session / reply card controls (card-handler's actionType dispatch)
  'close', 'disconnect', 'export_text', 'get_write_link', 'open_local_cli',
  'open_local_terminal', 'refresh_screenshot', 'restart', 'resume',
  'retry_last_task', 'takeover', 'term_action', 'toggle_display',
  'toggle_stream', 'tui_keys', 'tui_text_input', 'voice_summary',
  // pendingRepo gates
  'repo_manual_submit', 'repo_worktree_submit', 'skip_repo',
  'worktree_toggle_mode',
  // config / grant / relay cards
  'config_toggle', 'config_set', 'config_quota', 'config_quota_open',
  'config_quota_save', 'config_text_open', 'config_text_save',
  'grant_chat', 'grant_global', 'grant_deny',
  'relay_search', 'relay_page', 'relay_select', 'relay_confirm',
  // host-overload alert + codex notifier cards
  'overload_noop', 'overload_clean_stopped', 'overload_suspend_idle',
  'codex_notifier_continue', 'codex_notifier_open_app',
]);

/** True when the button is one of botmux's own callback buttons. Primary
 *  signal: the egress-stamped ownership marker (see
 *  callback-button-marker.ts) — future-proof against any new botmux action
 *  name. Legacy fallback: cards sent by pre-marker builds are still
 *  recognized via the internal action wordlist, in EITHER of the two real
 *  payload shapes — legacy top-level `value.action` (session/config cards)
 *  or v2 `behaviors:[{type:'callback', value.action}]` (reply-card voice
 *  button inside column_set). A button that somehow carries BOTH a botmux
 *  signal AND an open_url jump target is kept, since a real link is always
 *  worth surfacing. */
function isBotmuxCallbackButton(el: any): boolean {
  if (buttonOpenUrl(el)) return false;
  if (hasBotmuxCallbackMarker(el)) return true;
  let action: unknown = el?.value?.action;
  if (typeof action !== 'string' && Array.isArray(el?.behaviors)) {
    action = el.behaviors.find((b: any) => b?.type === 'callback')?.value?.action;
  }
  return typeof action === 'string' && BOTMUX_INTERNAL_CARD_ACTIONS.has(action);
}

/** Resolve a card button's jump target across schema generations: v1 `url` /
 *  `multi_url`, v2 `behaviors: [{type:'open_url', default_url, pc_url, …}]`.
 *  Returns undefined for callback-only buttons (they have no followable URL). */
function buttonOpenUrl(el: any): string | undefined {
  const direct = firstNonEmptyString(
    el.url,
    el.multi_url?.url, el.multi_url?.pc_url, el.multi_url?.android_url, el.multi_url?.ios_url,
  );
  if (direct) return direct;
  if (Array.isArray(el.behaviors)) {
    for (const b of el.behaviors) {
      if (b?.type !== 'open_url') continue;
      const u = firstNonEmptyString(b.default_url, b.pc_url, b.url, b.android_url, b.ios_url);
      if (u) return u;
    }
  }
  return undefined;
}

/** Fold an image's alt text into its placeholder: `[图片 2]` + alt →
 *  `[图片 2: 报警前30分钟今(红)昨(蓝)同比]`. Consumers that pattern-match the
 *  placeholder tolerate the suffix (they match `[图片…]` loosely). */
function withImgAlt(label: string, alt: string): string {
  return label.endsWith(']') ? `${label.slice(0, -1)}: ${alt}]` : `${label} (${alt})`;
}

/** Read visible text from a CardKit value. Lark message reads often replace
 *  the builder JSON with a rendered tree (`property.elements[].property.content`).
 *  Header titles/tags and native table labels/cells all use this same normalizer
 *  so quoted/history does not depend on the original send shape. */
function nestedCardText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(nestedCardText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('') : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, any>;
  const direct = firstNonEmptyString(
    record.text?.content,
    record.content,
    record.property?.content,
    typeof record.text === 'string' ? record.text : undefined,
  );
  if (direct) return direct;

  // CardKit may expose both a rendered `elements` tree and markdown metadata.
  // Prefer the rendered tree and only fall back to metadata to avoid repeating
  // the same visible cell text twice.
  const childGroups = [
    record.property?.elements,
    record.elements,
    record.property?.markdownElements,
    record.markdownElements,
  ];
  for (const children of childGroups) {
    if (!Array.isArray(children) || children.length === 0) continue;
    const nested = nestedCardText(children);
    if (nested) return nested;
  }
  return undefined;
}

function extractCardHeaderTagTexts(header: unknown): string[] {
  if (!header || typeof header !== 'object') return [];
  const record = header as Record<string, any>;
  const groups: unknown[] = [record.text_tag_list];
  if (record.i18n_text_tag_list && typeof record.i18n_text_tag_list === 'object') {
    groups.push(...Object.values(record.i18n_text_tag_list));
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const tag of group) {
      const text = nestedCardText(tag?.text ?? tag)?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

/** Newlines become `<br>` so a single value cannot split the reconstructed
 *  table into extra rows. */
function cardTableCellText(value: unknown): string {
  const text = nestedCardText(value);
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
}

/** Reconstruct an original schema-v2 native table as readable pipe Markdown.
 *  `botmux send` deliberately emits native tables because Lark's markdown
 *  widget cannot draw a grid; history/quoted/cross-bot reads must still retain
 *  those facts instead of silently dropping the whole component. */
function extractTableMarkdown(el: any): string | null {
  if (!Array.isArray(el?.columns) || el.columns.length === 0) return null;
  const columns = el.columns.map((column: any, index: number) => ({
    key: typeof column?.name === 'string' && column.name ? column.name : `c${index}`,
    label: cardTableCellText(column?.display_name) || `列 ${index + 1}`,
  }));
  const lines = [
    `| ${columns.map((column: any) => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of Array.isArray(el.rows) ? el.rows : []) {
    const cells = columns.map((column: any, index: number) => {
      const value = Array.isArray(row)
        ? row[index]
        : row && typeof row === 'object'
          ? row[column.key]
          : undefined;
      return cardTableCellText(value);
    });
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

type ResourcePusher = (resources: MessageResource[], r: MessageResource) => void;

/** Recursively extract image resources from an original-format card element. */
function extractElementImages(el: any, resources: MessageResource[], pushIfNew: ResourcePusher): void {
  if (!el || typeof el !== 'object') return;

  const tag = el.tag;
  const key = el.image_key ?? el.img_key;
  if ((tag === 'img' || tag === 'image') && key) {
    pushIfNew(resources, { type: 'image', key, name: `${key}.jpg` });
  }

  // div.extra can contain an image
  if (el.extra) extractElementImages(el.extra, resources, pushIfNew);

  // column_set / column — recurse into nested elements
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (Array.isArray(col.elements)) {
        for (const child of col.elements) extractElementImages(child, resources, pushIfNew);
      }
    }
  }
  if (Array.isArray(el.elements)) {
    for (const child of el.elements) extractElementImages(child, resources, pushIfNew);
  }
}

/** Recursively extract readable text from an original-format card element. */
function extractElementText(el: any, parts: string[], imgLabel: (key: string) => string): void {
  if (!el || typeof el !== 'object') return;

  const tag = el.tag;

  // The public element id alone is not ownership proof: third-party cards may
  // collide with it. New botmux footers carry the id plus the exact reserved
  // marker; unexpected large text stays visible rather than being stripped.
  const elementText = el.text?.content ?? el.content;
  if (
    el.element_id === REPLY_CARD_FOOTER_ELEMENT_ID
    && tag === 'markdown'
    && (
      el.text_size === undefined
      || el.text_size === 'notation'
      || el.text_size === 'notation_small_v2'
    )
    && typeof elementText === 'string'
    && hasExactMarkerMarkdown(elementText)
  ) {
    return;
  }

  // Promoted H1/H2 heading widgets: Lark strips `text_size` when a message is
  // read back, so the ATX prefix is rebuilt from the element id (the only
  // carrier that survives normalization). This keeps heading hierarchy across
  // sessions and lets a cross-bot re-send promote the line again.
  if (tag === 'markdown' && typeof el.element_id === 'string') {
    const idMatch = REPLY_CARD_HEADING_ELEMENT_ID_RE.exec(el.element_id);
    if (idMatch) {
      const heading = (typeof elementText === 'string' ? elementText : nestedCardText(el))?.trim();
      if (heading) {
        parts.push(`${'#'.repeat(Number(idMatch[1]))} ${heading}`);
        return;
      }
    }
  }

  // div / markdown / plain_text blocks
  if (tag === 'div' || tag === 'markdown' || tag === 'plain_text') {
    const text = el.text?.content ?? el.content;
    if (text) parts.push(text);
  }

  if (tag === 'table') {
    const table = extractTableMarkdown(el);
    if (table) parts.push(table);
  }

  // div.fields[] — v2 cards put most body text in a fields array of lark_md
  // cells (规则/报警时间/Tags/检测结果/详情链接…), NOT in el.text. Without this
  // the entire detail section of field-based cards (e.g. Argos alarm cards)
  // silently vanishes. A div can carry both el.text and el.fields, so this is
  // additive rather than an else-branch.
  if (Array.isArray(el.fields)) {
    for (const f of el.fields) {
      const t = f?.text?.content ?? f?.content;
      if (t) parts.push(t);
    }
  }

  // button — text may be a plain_text object (v2) or a string (v1 simplified).
  // Jump buttons carry their target as v1 `url`/`multi_url` or v2 `behaviors`
  // open_url; keep it so the reader can actually follow the link (e.g. Argos
  // [分析报告] → the report URL). Callback buttons have no URL and stay bare.
  // botmux's own callback buttons (🔊 语音总结 …) are dropped entirely.
  if (tag === 'button') {
    if (isBotmuxCallbackButton(el)) return;
    const btnText = typeof el.text === 'string' ? el.text : el.text?.content;
    if (btnText) {
      const url = buttonOpenUrl(el);
      parts.push(url ? `[${btnText}](${url})` : `[${btnText}]`);
    }
  }

  // input — surface the placeholder so the reader knows the field is there.
  if (tag === 'input') {
    const ph = el.placeholder?.content;
    if (ph) parts.push(`[输入框: ${ph}]`);
  }

  // select / multi-select / overflow — surface placeholder + selectable
  // options so the choices the card offers aren't lost.
  if (tag === 'select_static' || tag === 'multi_select_static' || tag === 'overflow') {
    const ph = el.placeholder?.content;
    const opts = Array.isArray(el.options)
      ? el.options.map((o: any) => o.text?.content).filter(Boolean)
      : [];
    const head = ph ? `[下拉: ${ph}` : '[下拉';
    parts.push(opts.length ? `${head} | 选项: ${opts.join(' / ')}]` : `${head}]`);
  }

  // image — emit a numbered placeholder matching the attachment list order.
  // Carry the alt text when present: for chart images (Argos 同比曲线图) the
  // alt is often the only machine-readable description of what the image shows.
  if (tag === 'img' || tag === 'image') {
    const k = el.image_key ?? el.img_key;
    const alt = (typeof el.alt === 'string' ? el.alt : el.alt?.content)?.trim();
    if (k) parts.push(alt ? withImgAlt(imgLabel(k), alt) : imgLabel(k));
  }

  // note blocks (v1 only — v2 removed the tag but we still parse v1 cards)
  if (tag === 'note' && Array.isArray(el.elements)) {
    const noteTexts = el.elements
      .map((n: any) => n.content ?? n.text?.content ?? '')
      .filter(Boolean);
    if (noteTexts.length) parts.push(noteTexts.join(' '));
  }

  // div.extra can host an image
  if (el.extra) extractElementText(el.extra, parts, imgLabel);

  // column_set / column — recurse into nested elements
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (Array.isArray(col.elements)) {
        for (const child of col.elements) extractElementText(child, parts, imgLabel);
      }
    }
  }
  // action blocks hold their children in `actions`, not `elements` — recurse so
  // their buttons / inputs / selects (确认/创建群组/驾驶舱…) get surfaced.
  if (Array.isArray(el.actions)) {
    for (const child of el.actions) extractElementText(child, parts, imgLabel);
  }
  if (Array.isArray(el.elements) && tag !== 'note') {
    for (const child of el.elements) extractElementText(child, parts, imgLabel);
  }
}
