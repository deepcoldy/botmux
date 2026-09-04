import {
  getAllBots,
  type BotState,
  type MessageListenerBehavior,
  type MessageListenerConfig,
  type MessageListenerSubjectPolicy,
} from '../bot-registry.js';
import { extractCardContent, unwrapUserDslContent } from '../im/lark/message-parser.js';
import { resolveCurrentChatBotOpenIdsByLarkAppIds } from '../im/lark/client.js';
import { BOTMUX_SUBJECT_PROTOCOL } from './subject-listener-protocol.js';
import {
  renderSubjectListenerHistory,
  type SubjectListenerContextSnapshot,
} from './subject-listener-context.js';
import { logger } from '../utils/logger.js';

export const MAX_MESSAGE_LISTENER_PROMPT_BYTES = 32 * 1024;

export type MessageListenerSenderType = 'user' | 'bot';

export interface MessageListenerMatch {
  behavior: MessageListenerBehavior;
  subjectPolicy?: MessageListenerSubjectPolicy;
  name?: string;
  replyCardTitle?: string;
  prompt: string;
  workingDir?: string;
  messageText: string;
  messageTitle?: string;
  msgType: string;
  senderOpenId?: string;
  senderName?: string;
  senderType: MessageListenerSenderType;
  trigger: {
    messageId: string;
    createTime?: string;
  };
}

export interface MessageListenerPreviewMatch extends MessageListenerMatch {
  messageId: string;
  createTime?: string;
}

export interface SubjectMessageListenerPromptContext {
  chatId: string;
  chatName?: string;
  chatDescription?: string;
  snapshot: SubjectListenerContextSnapshot;
}

export const DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT = 5;
export const MAX_MESSAGE_LISTENER_PREVIEW_LIMIT = 20;

export function listenerSenderType(raw: unknown): MessageListenerSenderType {
  return raw === 'app' || raw === 'bot' ? 'bot' : 'user';
}

export function messageTypeOf(message: any): string {
  return String(message?.message_type ?? message?.msg_type ?? '').trim() || 'text';
}

function listenerMessageRawContent(message: any): string {
  const content = message?.content ?? message?.body?.content;
  return typeof content === 'string' ? content : '';
}

function listenerMessageContent(message: any): string {
  const content = listenerMessageRawContent(message);
  if (!content) return '';
  return messageTypeOf(message) === 'interactive'
    ? unwrapUserDslContent(content) ?? content
    : content;
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function extractListenerMessageTitle(message: any): string | undefined {
  const content = listenerMessageContent(message);
  if (!content) return undefined;
  const msgType = messageTypeOf(message);
  if (msgType === 'interactive') {
    const renderedTitle = content.match(/<card\s+title=(["'])(.*?)\1/i)?.[2];
    if (renderedTitle?.trim()) return renderedTitle.trim();
    try {
      const card = JSON.parse(content);
      return firstTrimmedString(
        card?.title,
        card?.header?.title?.content,
        card?.header?.title?.i18n?.zh_cn,
        card?.header?.title?.i18n?.en_us,
      );
    } catch {
      return undefined;
    }
  }
  if (msgType === 'post') {
    try {
      const obj = JSON.parse(content);
      const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
      return firstTrimmedString(inner?.title, obj?.title);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function extractListenerMessageText(message: any): string {
  const content = listenerMessageContent(message);
  if (!content) return '';
  const msgType = messageTypeOf(message);
  if (msgType === 'interactive') return extractCardContent(content);
  if (msgType === 'image') {
    try {
      const obj = JSON.parse(content);
      const key = firstTrimmedString(obj?.image_key, obj?.img_key);
      return key ? `[图片消息: ${key}]` : '[图片消息]';
    } catch {
      return '[图片消息]';
    }
  }
  try {
    const obj = JSON.parse(content);
    if (typeof obj?.text === 'string') return obj.text.trim();
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
        }
      }
      return parts.join('').trim();
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Refresh a card match's observed text/title from the (now-resolved) message.
 *
 * The listener match is computed during filtering, off the SIMPLIFIED card the
 * WS/history API first delivers — that view drops button jump URLs and lazy
 * sub-card bodies. The live delivery path (daemon handleNewTopic) later runs
 * resolveNonsupportMessage(data), merging the card's two representations
 * (server-rendered + structured body.elements, incl. button open_url) into
 * `message.content` — the same depth the direct-@bot path uses. Re-extracting
 * here lets the model receive the button links, not the lossy match-time
 * snapshot. Only interactive cards can differ (plain text/post already carried
 * full content at match time). Fail-safe: a resolver miss (cross-tenant, REST
 * unavailable) leaves `message.content` as the simplified view and yields the
 * SAME text as match time, so guarding on a non-empty result never blanks a
 * match — it only ever upgrades. Mutates `match` in place.
 */
export function refreshListenerCardTextFromResolved(match: MessageListenerMatch, message: any): void {
  if (match.msgType !== 'interactive') return;
  const text = extractListenerMessageText(message);
  if (text.trim()) match.messageText = text;
  const title = extractListenerMessageTitle(message);
  if (title?.trim()) match.messageTitle = title;
}

function contains(list: readonly string[] | undefined, value: string | undefined): boolean {
  return !!value && !!list && list.includes(value);
}

function senderTypeAllowed(listener: MessageListenerConfig, type: MessageListenerSenderType): boolean {
  const policy = listener.senderPolicy;
  if (policy?.includeSenderTypes && policy.includeSenderTypes.length > 0 && !policy.includeSenderTypes.includes(type)) {
    return false;
  }
  if (policy?.excludeSenderTypes?.includes(type)) return false;
  return true;
}

/**
 * An exclusion entry can "collide" with an unverified bot sender when we cannot
 * prove the sender is NOT that entry. `ou_` vs `cli_` STRING inequality does not
 * prove ENTITY inequality — the same bot is `cli_x` in the polled history and
 * `ou_y` in config. So we classify each exclusion by its persisted sender KIND,
 * not by id prefix:
 *   - kind 'user'         → a human; an unverified BOT sender can never be it.
 *   - kind 'bot'/'unknown'→ could be this unverified bot → fail closed.
 *   - no kind recorded (legacy config, or an id in app_id/cli_ form) → treat as
 *     a possible bot and fail closed conservatively. Prefix is only ever used to
 *     UPGRADE an unknown entry to "definitely a bot", never to downgrade to user.
 */
function exclusionMayBeUnverifiedBot(
  id: string,
  kinds: Readonly<Record<string, 'user' | 'bot'>> | undefined,
): boolean {
  const kind = kinds?.[id];
  if (kind === 'user') return false;
  if (kind === 'bot') return true;
  // No recorded kind: an app_id/cli_ form is certainly a bot; an ou_ (or any
  // other) form is ambiguous under legacy configs, so stay conservative.
  return true;
}

function senderOpenIdAllowed(
  listener: MessageListenerConfig,
  openId: string | undefined,
  identityUnverified: boolean,
): boolean {
  const policy = listener.senderPolicy;
  const mode = policy?.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  if (mode === 'include_only') {
    // Allow-list: an unverified sender (a bot whose identity could not be
    // canonicalized to a per-app open_id) can never appear in an open_id
    // include list, so it simply does not match — already fail-safe.
    return contains(policy?.includeSenderOpenIds, openId);
  }
  // all_except_excluded: an unverified bot sender (reported by app_id, not
  // canonicalized to an open_id) defeats an exclusion when we cannot prove the
  // sender is NOT that excluded entry. Decide by the exclusion's persisted
  // sender KIND, never by id prefix: only user-kind exclusions are provably
  // disjoint from an unverified bot. Any bot/unknown/legacy exclusion fails
  // closed. When EVERY exclusion is a known user, nothing is being bypassed, so
  // "listen to all bots, just mute these users" keeps working. Empty list too.
  const excludes = policy?.excludeSenderOpenIds ?? [];
  if (identityUnverified && excludes.some(id => exclusionMayBeUnverifiedBot(id, policy?.excludeSenderKinds))) {
    return false;
  }
  return !contains(policy?.excludeSenderOpenIds, openId);
}

function msgTypeAllowed(listener: MessageListenerConfig, msgType: string): boolean {
  const include = listener.messagePolicy?.includeMsgTypes;
  if (!include || include.length === 0) return msgType === 'text' || msgType === 'post';
  return include.includes(msgType);
}

export type MessageListenerContentPolicy = NonNullable<MessageListenerConfig['contentPolicy']>;

/**
 * Pure keyword pre-filter for listener messages. SHARED by every leg that
 * feeds evaluateMessageListener (realtime delivery, polled backfill, dashboard
 * preview) so they can never diverge on content matching.
 *
 * - Absent policy, or one with no keywords → match everything (legacy
 *   behavior: every non-mention text message woke the Agent).
 * - Keywords: case-insensitive substring match (Chinese-friendly; both sides
 *   lowercased, plain `includes`). Substring search is linear-time, so an
 *   attacker-controlled group message cannot stall the daemon main loop.
 * - matchMode 'any' (default): at least one keyword hits.
 * - matchMode 'all': every keyword must hit.
 *
 * V1 deliberately has NO regex support: a JS regex with catastrophic
 * backtracking (e.g. the 6-char `(a+)+$`) runs on the daemon's main event
 * loop for every inbound AND backfilled message, so a ~30-char payload lying
 * in listener-group history could freeze this single-daemon, multi-bot
 * process for tens of seconds every poll round. A pattern-length cap does not
 * bound backtracking. Regex can return later behind a linear-time engine.
 */
export function matchesContentPolicy(text: string, policy: MessageListenerContentPolicy | undefined): boolean {
  if (!policy) return true;
  const keywords = (policy.includeKeywords ?? []).filter(keyword => keyword.length > 0);
  if (keywords.length === 0) return true;
  const haystack = text.toLowerCase();
  const keywordHits = (keyword: string): boolean => haystack.includes(keyword.toLowerCase());
  if (policy.matchMode === 'all') {
    return keywords.every(keywordHits);
  }
  return keywords.some(keywordHits);
}

export function findMessageListenerForChat(bot: BotState, chatId: string): MessageListenerConfig | undefined {
  const listener = bot.config.messageListeners?.[chatId];
  if (!listener?.enabled) return undefined;
  if ((listener.behavior ?? 'prompt') === 'prompt' && !listener.prompt?.trim()) return undefined;
  return listener;
}

export function evaluateMessageListener(input: {
  bot: BotState;
  chatId: string;
  message: any;
  senderOpenId?: string;
  senderName?: string;
  senderTypeRaw?: string;
  /**
   * True when `senderOpenId` is a bot's app_id form that could NOT be resolved
   * to a per-app open_id (the polled history API reports bots by app_id; a
   * third-party bot with no cross-ref / observed mapping stays unresolved).
   * Such a sender defeats open_id-based exclusion, so the exclude path fails
   * closed. The caller resolves app_id→open_id where possible before this.
   */
  senderIdentityUnverified?: boolean;
  explicitlyMentionedThisBot: boolean;
}): MessageListenerMatch | undefined {
  if (input.explicitlyMentionedThisBot) return undefined;
  const messageId = String(input.message?.message_id ?? '');
  const rootId = input.message?.root_id ? String(input.message.root_id) : '';
  const threadId = input.message?.thread_id ? String(input.message.thread_id) : '';
  const parentId = input.message?.parent_id ? String(input.message.parent_id) : '';
  // REST history returns a top-level topic root as message_id=om_* plus
  // thread_id=omt_*. Replies carry root_id/parent_id. Do not reject the root
  // solely because thread_id uses a different id namespace.
  if ((rootId && rootId !== messageId) || (parentId && parentId !== messageId)) return undefined;
  if (threadId && threadId.startsWith('om_') && threadId !== messageId) return undefined;

  const listener = findMessageListenerForChat(input.bot, input.chatId);
  if (!listener) return undefined;

  const senderType = listenerSenderType(input.senderTypeRaw);
  // Self-exclusion must cover BOTH identity forms the bot appears under:
  // realtime events carry the bot's open_id (ou_…), but the message-history API
  // (polled backfill) reports the bot's own messages under its app_id
  // (== larkAppId). Comparing only against botOpenId (an open_id) silently
  // fails on the polled path and would let the bot's own posts self-trigger.
  const ownIds = [input.bot.botOpenId, input.bot.config.larkAppId].filter(Boolean);
  if ((listener.senderPolicy?.excludeSelf ?? true) && input.senderOpenId && ownIds.includes(input.senderOpenId)) {
    return undefined;
  }
  if (!senderTypeAllowed(listener, senderType)) return undefined;
  if (!senderOpenIdAllowed(listener, input.senderOpenId, input.senderIdentityUnverified ?? false)) return undefined;

  const msgType = messageTypeOf(input.message);
  if (!msgTypeAllowed(listener, msgType)) return undefined;

  const messageText = extractListenerMessageText(input.message);
  if (!messageText && (msgType === 'text' || msgType === 'post')) return undefined;
  const messageTitle = extractListenerMessageTitle(input.message);

  // Daemon-side keyword/regex pre-filter: the shared choke point for the
  // realtime, polled-backfill and dashboard-preview legs. A configured policy
  // that does not hit means the message never wakes the Agent (no model call).
  if (!matchesContentPolicy(messageText, listener.contentPolicy)) return undefined;

  return {
    behavior: listener.behavior ?? 'prompt',
    subjectPolicy: listener.subjectPolicy,
    name: listener.name,
    replyCardTitle: listener.replyCardTitle,
    prompt: listener.prompt,
    workingDir: listener.workingDir,
    messageText,
    messageTitle,
    msgType,
    senderOpenId: input.senderOpenId,
    senderName: input.senderName,
    senderType,
    trigger: {
      messageId,
      ...(input.message?.create_time ? { createTime: String(input.message.create_time) } : {}),
    },
  };
}

/** Raw sender fields as parsed from a message (realtime event or REST history). */
export interface ListenerRawSender {
  senderOpenId?: string;
  senderName?: string;
  senderTypeRaw?: string;
  senderIdType?: string;
}

/**
 * Canonicalize a message sender to the identity domain listener configs are
 * keyed on (open_id). SHARED by every leg that feeds evaluateMessageListener
 * (30s poll backfill AND dashboard preview/run-preview) so they can never
 * diverge on identity handling.
 *
 * Bots are reported by app_id in the REST message-history API; a listener's
 * sender filters store per-app open_ids. We map app_id → open_id ONLY via an
 * authorization-grade map (see buildListenerBotAppIdToOpenId, which uses the
 * strict resolver). A bot we cannot prove stays `identityUnverified`, so the
 * matcher fails closed on open_id-based exclusion. Non-bot senders and bots
 * already carrying an open_id pass through verified.
 */
export function resolveListenerSenderIdentity(
  sender: ListenerRawSender,
  appIdToOpenId: Map<string, string>,
): { senderOpenId?: string; identityUnverified: boolean } {
  const isBotAppId = sender.senderIdType === 'app_id'
    || sender.senderTypeRaw === 'app'
    || sender.senderTypeRaw === 'bot';
  if (!isBotAppId) {
    return { senderOpenId: sender.senderOpenId, identityUnverified: false };
  }
  // A bot with no sender id at all cannot be evaluated against open_id filters.
  if (!sender.senderOpenId) {
    return { senderOpenId: undefined, identityUnverified: true };
  }
  // Already an open_id (some history rows carry open_id for bots) → verified.
  if (sender.senderOpenId.startsWith('ou_')) {
    return { senderOpenId: sender.senderOpenId, identityUnverified: false };
  }
  const mapped = appIdToOpenId.get(sender.senderOpenId);
  if (mapped) return { senderOpenId: mapped, identityUnverified: false };
  // app_id-form bot we could not strictly resolve: keep the app_id but flag it
  // unverified so open_id-based exclusion fails closed.
  return { senderOpenId: sender.senderOpenId, identityUnverified: true };
}

/**
 * Build an authorization-grade app_id → open_id map for the candidate bot
 * senders. Uses the STRICT resolver (three-signal agreement, never the stale
 * discovery stores) and only asks about CONFIGURED app_ids (the strict resolver
 * rejects the whole batch on any non-configured subject, and a genuine
 * third-party bot must stay unverified regardless). Anything unproven is absent
 * from the map → resolveListenerSenderIdentity marks it unverified.
 *
 * SHARED by the poll and preview legs so both resolve identity identically.
 */
export async function buildListenerBotAppIdToOpenId(
  larkAppId: string,
  chatId: string,
  candidateAppIds: Set<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (candidateAppIds.size === 0) return map;
  const configuredAppIds = new Set(getAllBots().map(b => b.config.larkAppId).filter(Boolean));
  const subjectAppIds = [...candidateAppIds].filter(appId => configuredAppIds.has(appId));
  if (subjectAppIds.length === 0) return map;
  try {
    const resolution = await resolveCurrentChatBotOpenIdsByLarkAppIds(larkAppId, chatId, subjectAppIds);
    if (resolution.ok) {
      for (const mapping of resolution.mappings) {
        if (mapping.larkAppId && mapping.subjectOpenId) {
          map.set(mapping.larkAppId, mapping.subjectOpenId);
        }
      }
    } else {
      logger.debug(`[message-listener:${larkAppId}] strict bot-id resolution declined for ${chatId.substring(0, 12)}: ${resolution.error}`);
    }
  } catch (err) {
    logger.debug(`[message-listener:${larkAppId}] strict bot-id resolution threw for ${chatId.substring(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}

/** Collect the app_id-form bot senders present in a message batch (the only
 *  subjects worth asking the strict resolver about). */
export function collectListenerBotAppIds(
  messages: any[],
  senderForMessage: (message: any) => ListenerRawSender,
): Set<string> {
  const appIds = new Set<string>();
  for (const message of messages) {
    const s = senderForMessage(message);
    const isBotAppId = s.senderIdType === 'app_id' || s.senderTypeRaw === 'app' || s.senderTypeRaw === 'bot';
    if (isBotAppId && s.senderOpenId && !s.senderOpenId.startsWith('ou_')) {
      appIds.add(s.senderOpenId);
    }
  }
  return appIds;
}

export function normalizeMessageListenerPreviewLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT;
  return Math.min(MAX_MESSAGE_LISTENER_PREVIEW_LIMIT, Math.max(1, Math.floor(value)));
}

export function previewMessageListenerMatches(input: {
  bot: BotState;
  chatId: string;
  messages: any[];
  limit: number;
  senderForMessage(message: any): ListenerRawSender;
  /** Authorization-grade app_id → open_id map (see buildListenerBotAppIdToOpenId).
   *  Omitted → every bot sender in app_id form is treated as unverified. */
  appIdToOpenId?: Map<string, string>;
  explicitlyMentionedThisBot?: (message: any, senderOpenId?: string) => boolean;
}): MessageListenerPreviewMatch[] {
  const limit = normalizeMessageListenerPreviewLimit(input.limit);
  const appIdToOpenId = input.appIdToOpenId ?? new Map<string, string>();
  const matches: MessageListenerPreviewMatch[] = [];
  for (const message of input.messages) {
    const messageId = String(message?.message_id ?? '');
    if (!messageId) continue;
    const sender = input.senderForMessage(message);
    const resolved = resolveListenerSenderIdentity(sender, appIdToOpenId);
    const match = evaluateMessageListener({
      bot: input.bot,
      chatId: input.chatId,
      message,
      senderOpenId: resolved.senderOpenId,
      senderName: sender.senderName,
      senderTypeRaw: sender.senderTypeRaw,
      senderIdentityUnverified: resolved.identityUnverified,
      explicitlyMentionedThisBot: input.explicitlyMentionedThisBot?.(message, resolved.senderOpenId) ?? false,
    });
    if (!match) continue;
    matches.push({
      ...match,
      messageId,
      createTime: message?.create_time ? String(message.create_time) : undefined,
    });
  }
  return matches.slice(Math.max(0, matches.length - limit));
}

/**
 * Trusted operator directive for a listener match: the admin-authored name +
 * prompt only. Contains NO observed (untrusted) group-message bytes, so it is
 * safe to place in a trusted application-context block (e.g. triggerSessionTurn's
 * `<botmux_task trusted="true">`). The observed message must be delivered
 * separately through the untrusted event channel (payload / rawText).
 */
export function renderMessageListenerInstruction(match: MessageListenerMatch): string {
  return [
    '<message_listener>',
    match.name ? `  <name>${escapeXml(match.name)}</name>` : '',
    '  <instruction>',
    match.prompt,
    '  </instruction>',
    '</message_listener>',
  ].filter(Boolean).join('\n');
}

/**
 * Self-contained listener prompt for callers that feed a SINGLE string to the
 * CLI as the whole turn (the daemon new-topic path). The trusted operator
 * `<instruction>` and the untrusted `<observed_message>` are kept in separate
 * blocks, and the observed body is BOTH xml-escaped AND explicitly marked
 * `trusted="false"` so a group member cannot close `</observed_message>` /
 * `</message_listener>` early and forge a trusted `<instruction>`. `match.prompt`
 * stays raw because it is operator-authored config, not attacker-controlled.
 */
export function renderMessageListenerPrompt(
  match: MessageListenerMatch,
  subjectContext?: SubjectMessageListenerPromptContext,
): string {
  if (match.behavior === 'subject') {
    if (!subjectContext) throw new Error('Subject listener prompt requires Lark context');
    return renderSubjectMessageListenerPrompt(match, subjectContext);
  }
  const observedText = escapeXml(truncateUtf8(match.messageText, MAX_MESSAGE_LISTENER_PROMPT_BYTES));
  return [
    '<message_listener>',
    match.name ? `  <name>${escapeXml(match.name)}</name>` : '',
    '  <instruction>',
    match.prompt,
    '  </instruction>',
    '  <observed_message',
    '    trusted="false"',
    `    sender_type="${escapeXml(match.senderType)}"`,
    match.senderOpenId ? `    sender_open_id="${escapeXml(match.senderOpenId)}"` : '',
    match.senderName ? `    sender_name="${escapeXml(match.senderName)}"` : '',
    `    msg_type="${escapeXml(match.msgType)}"`,
    match.messageTitle ? `    message_title="${escapeXml(match.messageTitle)}"` : '',
    '  >',
    observedText,
    '  </observed_message>',
    '</message_listener>',
  ].filter(Boolean).join('\n');
}

/**
 * Deterministic Subject turn: trusted protocol/config are kept separate from
 * the provider-controlled group, sender, and message history envelopes.
 */
export function renderSubjectMessageListenerPrompt(
  match: MessageListenerMatch,
  context: SubjectMessageListenerPromptContext,
): string {
  const scope = match.prompt.trim();
  return [
    '<subject_protocol trusted="true">',
    BOTMUX_SUBJECT_PROTOCOL.trim(),
    '</subject_protocol>',
    scope ? '<subject_scope trusted="true">' : '',
    scope || '',
    scope ? '</subject_scope>' : '',
    '<subject_lark_context trusted="false">',
    '  <chat',
    `    chat_id="${escapeXml(context.chatId)}"`,
    context.chatName ? `    name="${escapeXml(context.chatName)}"` : '',
    '  >',
    context.chatDescription ? `    ${escapeXml(context.chatDescription)}` : '',
    '  </chat>',
    '  <triggering_sender',
    `    sender_type="${escapeXml(match.senderType)}"`,
    match.senderOpenId ? `    sender_open_id="${escapeXml(match.senderOpenId)}"` : '',
    match.senderName ? `    sender_name="${escapeXml(match.senderName)}"` : '',
    '  />',
    renderSubjectListenerHistory(context.snapshot),
    '</subject_lark_context>',
  ].filter(Boolean).join('\n');
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf-8') <= maxBytes) return s;
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
