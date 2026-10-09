import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { listChatMessagesUntil, listThreadMessagesWithContext, listMessagesByThreadId, downloadMessageResource } from '../im/lark/client.js';
import { parseApiMessage, createImgNumberer, extractResources, cardContentHasUpgradeFallback, resolveMergedCardContent, structuredMentionRefs, rawPlaceholderText, postMentionRefs } from '../im/lark/message-parser.js';
import { projectGroupContextCard, GROUP_CONTEXT_CARD_CONTENT_VERSION } from '../im/lark/group-context-card.js';
import { getAttachmentsDir } from '../core/attachment-path.js';
import { normalizeImageAttachment } from '../core/attachment-image-format.js';
import { getGroupContextSettings } from './group-context-settings-store.js';
import { getGroupContextHead, getGroupContextMessage, listGroupContextMessages, upsertGroupContextMessage, pruneGroupContext, type GroupContextMessageRecord } from './group-context-store.js';
import { readPreparedGroupContext, writePreparedGroupContext, getDeliveredGroupContextSeqs, recordNativeGroupContextDelivery, type GroupContextDeliveryBinding } from './group-context-delivery-store.js';
import { createGroupContextPreparer, type GroupContextTurnRequest } from './group-context.js';
import type { PreparedGroupContext } from './group-context-delivery-store.js';
import type { GroupContextRenderMessage } from './group-context-render.js';
import type { LarkAttachment } from '../types.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { groupContextRecallGap } from './group-context-health.js';
import { isGroupContextNoise, isUnavailableGroupContextCard, sanitizeGroupContextText, groupContextRepresentationsMatch, sameGroupContextPlatformVersion, sameGroupContextMentions } from './group-context-content.js';
import { groupContextCardObservationTime } from './group-context-card-observation.js';
import { normalizeGroupContextEvent } from './group-context-ingest.js';

const syncBoundaries = new Map<string, { startedAt: number; olderGap: boolean }>();
const scopeKey = (appId: string, chatId: string) => JSON.stringify([config.session.dataDir, appId, chatId]);

function boundedCacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

interface ObservedMessage extends GroupContextRenderMessage {
  updateTime?: number;
  historyStartedAt?: number;
  needsCardProjection?: boolean;
}

/** Actual publication destination; authorship/session routing is independent. */
export interface GroupContextPublicationContext {
  conversationScope?: 'main' | 'thread';
  rootId?: string;
  threadId?: string;
}

interface HistoryObservationContext extends GroupContextPublicationContext {
  source: 'chat-history' | 'thread-history' | 'thread-fallback' | 'publication';
}

function renderRecord(record: GroupContextMessageRecord): GroupContextRenderMessage {
  return { ...record, createTime: String(record.createTime), senderType: record.senderType === 'app' ? 'bot' : record.senderType,
    resourceRefs: record.resourceRefs.map(resource => ({ ...resource })) };
}

function normalizeHistoryMessage(appId: string, chatId: string, message: any, historyStartedAt: number,
  context: HistoryObservationContext): ObservedMessage | undefined {
  if (!message?.message_id || (message.chat_id && message.chat_id !== chatId)) return undefined;
  const isBot = message.sender?.sender_type === 'app' || message.sender?.sender_type === 'bot';
  const deleted = message.deleted === true || message.is_recalled === true;
  const projection = !deleted && isBot && message.msg_type === 'interactive'
    ? projectGroupContextCard(message.body?.content ?? '') : undefined;
  if (projection?.kind === 'runtime') return undefined;
  if (projection?.kind === 'conversation') message = { ...message, body: { ...message.body, content: projection.content } };
  const numberer = createImgNumberer();
  const resources = extractResources(message.msg_type ?? 'text', message.body?.content ?? '', numberer);
  // Render structured mentions as the live event does, so one platform version
  // has one body; the identities travel with the record for equivalence checks.
  const parsed = parseApiMessage(message, numberer, { resolveMentions: true });
  const mentions = !projection && !deleted && message.msg_type === 'post' && typeof message.body?.content === 'string'
    ? postMentionRefs(message.body.content, message.mentions)
    : structuredMentionRefs(message.mentions);
  const rawText = !projection && !deleted && typeof message.body?.content === 'string' ? rawPlaceholderText(message.msg_type ?? 'text', message.body.content) : undefined;
  const platformUpdateTime = Number(message.update_time);
  const updateTime = Number.isFinite(platformUpdateTime) && platformUpdateTime > 0 ? platformUpdateTime : undefined;
  const cardObservedAt = updateTime === undefined && projection?.kind === 'conversation' && projection.turnReply
    ? groupContextCardObservationTime(getGroupContextMessage(appId, chatId, message.message_id), parsed.content, resources)
    : undefined;
  const threadId = message.thread_id || context.threadId || undefined;
  // Full chat-list rows can prove a main-chat quote. Publication receipts and
  // root-only fallback scans cannot: both may omit native topic identifiers.
  const conversationScope = threadId ? 'thread' : context.conversationScope
    ?? (context.source === 'chat-history' ? 'main' : undefined);
  return {
    seq: 0, messageId: parsed.messageId, chatId,
    rootId: message.root_id || context.rootId || undefined, threadId, conversationScope,
    parentId: message.parent_id || undefined,
    senderId: parsed.senderId || '', senderName: parsed.senderName,
    senderType: !parsed.senderId ? 'unknown' : parsed.senderType === 'app' || parsed.senderType === 'bot' ? 'bot' : parsed.senderType === 'user' ? 'user' : 'unknown',
    msgType: parsed.msgType, text: parsed.content, createTime: parsed.createTime,
    resourceRefs: resources.map(resource => ({ ...resource })),
    ...(mentions ? { mentions } : {}),
    ...(rawText !== undefined ? { rawText } : {}),
    deleted: message.deleted === true || message.is_recalled === true,
    historyStartedAt,
    ...(projection?.kind === 'conversation' ? { cardContentVersion: GROUP_CONTEXT_CARD_CONTENT_VERSION } : {}),
    ...(projection?.kind === 'unresolved' ? { needsCardProjection: true } : {}),
    ...(updateTime !== undefined ? { updateTime } : {}),
    ...(cardObservedAt !== undefined ? { cardObservedAt } : {}),
  };
}

function ingestHistory(record: GroupContextRenderMessage, appId: string): boolean {
  if ((record as ObservedMessage).needsCardProjection) return false;
  if (!record.deleted && record.cardContentVersion === GROUP_CONTEXT_CARD_CONTENT_VERSION
      && (!record.text.trim() || record.text.trim() === '[卡片]') && !record.resourceRefs?.length) return true;
  // Presentation noise may be hidden, but every tombstone must reach storage
  // so a late original cannot resurrect a recalled message.
  if (!record.deleted && isGroupContextNoise(record)) return true;
  record = { ...record, text: sanitizeGroupContextText(record.text), ...(record.rawText !== undefined ? { rawText: sanitizeGroupContextText(record.rawText) } : {}) };
  const incoming = record as ObservedMessage;
  const previous = getGroupContextMessage(appId, record.chatId, record.messageId);
  // A slow history response must not undo a newer event received in flight.
  if (previous && incoming.historyStartedAt && previous.observedAt > incoming.historyStartedAt
      && (previous.text !== incoming.text || JSON.stringify(previous.resourceRefs) !== JSON.stringify(incoming.resourceRefs ?? []))
      && !incoming.deleted) return false;
  const settings = getGroupContextSettings(appId, record.chatId);
  upsertGroupContextMessage(appId, {
    messageId: record.messageId, chatId: record.chatId, rootId: record.rootId, threadId: record.threadId,
    parentId: record.parentId,
    conversationScope: record.conversationScope,
    senderId: record.senderId, senderType: record.senderType, senderName: record.senderName,
    msgType: record.msgType, text: record.text, createTime: Number(record.createTime),
    resourceRefs: (record.resourceRefs ?? []).filter(resource => !!resource.key).map(resource => ({
      type: resource.type, key: resource.key!, ...(resource.name ? { name: resource.name } : {}),
    })),
    ...(record.mentions?.length ? { mentions: record.mentions } : {}),
    ...(record.rawText !== undefined ? { rawText: record.rawText } : {}),
    sourceAppId: appId, deleted: record.deleted,
    ...(record.cardContentVersion !== undefined ? { cardContentVersion: record.cardContentVersion } : {}),
    ...(record.cardObservedAt !== undefined ? { cardObservedAt: record.cardObservedAt } : {}),
    ...(incoming.updateTime ? { updateTime: incoming.updateTime } : {}),
  }, { maxAgeMs: settings.retentionDays * 86_400_000, maxRows: settings.maxMessages });
  return true;
}

async function backfill(request: GroupContextTurnRequest, signal: AbortSignal) {
  const started = Date.now();
  const enrichmentDeadline = started + 2700;
  const settings = getGroupContextSettings(request.appId, request.chatId);
  const cutoff = started - settings.retentionDays * 86_400_000;
  const head = getGroupContextHead(request.appId, request.chatId);
  const key = scopeKey(request.appId, request.chatId);
  const boundary = syncBoundaries.get(key);
  const scanLimit = head.count > 1 ? 200 : 600;
  let hitLimit = false;
  let incomplete = !!boundary?.olderGap;
  const available = new Map<string, ObservedMessage>();
  const pendingCards = new Map<string, ObservedMessage>();
  const collect = (message: any, context: HistoryObservationContext): void => {
    if (signal.aborted) return;
    try {
      const normalized = normalizeHistoryMessage(request.appId, request.chatId, message, started, context);
      if (!normalized) return;
      if (!normalized.deleted && isGroupContextNoise(normalized)) return;
      normalized.text = sanitizeGroupContextText(normalized.text);
      if (!normalized.deleted && normalized.msgType === 'interactive'
          && (normalized.needsCardProjection || isUnavailableGroupContextCard(normalized) || cardContentHasUpgradeFallback(normalized.text))) {
        // A list placeholder is not a new content revision. Keep any already
        // observed complete body and resolve this representation separately.
        pendingCards.set(normalized.messageId, normalized);
        return;
      }
      pendingCards.delete(normalized.messageId);
      available.set(normalized.messageId, normalized);
      if (ingestHistory(normalized, request.appId) === false) incomplete = true;
    } catch { incomplete = true; }
  };
  const groupRead = listChatMessagesUntil(request.appId, request.chatId, {
    pageSize: 50,
    stopAfter: (message, count) => {
      if (signal.aborted) return true;
      // Persist usable rows as each page arrives. A later slow page or card
      // must not discard the history which the server already supplied.
      collect(message, { source: 'chat-history' });
      if (count >= scanLimit) { hitLimit = true; return true; }
      // Only a completed API scan creates this boundary. The local head may be
      // the current @ message and is NOT evidence that the intervening gap was read.
      if (boundary && count >= 50 && Number(message.create_time) <= boundary.startedAt - 60_000) return true;
      return Number(message.create_time) < cutoff;
    },
  }).then(raw => {
    if (signal.aborted) return;
    for (const message of raw) collect(message, { source: 'chat-history' });
    // Card enrichment is not required to establish a completed list boundary.
    boundedCacheSet(syncBoundaries, key, { startedAt: started, olderGap: hitLimit || !!boundary?.olderGap }, 128);
  });
  const threadRead = request.threadId
    ? listMessagesByThreadId(request.appId, request.threadId, 100).then(messages => ({ messages, threadId: request.threadId, verifiedThread: true }))
    : request.rootId && request.rootId !== request.turnId
      ? listThreadMessagesWithContext(request.appId, request.chatId, request.rootId, 100)
      : undefined;
  const collectThread = threadRead?.then(thread => {
    if (signal.aborted) return;
    const context: HistoryObservationContext = thread.verifiedThread
      ? { source: 'thread-history', conversationScope: 'thread', threadId: thread.threadId, rootId: request.rootId }
      : { source: 'thread-fallback' };
    for (const message of thread.messages) collect(message, context);
    if (!thread.verifiedThread || thread.messages.length >= 100) incomplete = true;
  }) ?? Promise.resolve();
  await Promise.all([groupRead, collectThread]);
  if (signal.aborted) throw new Error('history_timeout');

  // Cold rooms may contain hundreds of fallback cards. Prioritize uncached
  // recent bodies and bound enrichment independently of the valid text rows.
  const cards = [...pendingCards.values()].sort((a, b) => {
    const cachedA = getGroupContextMessage(request.appId, request.chatId, a.messageId);
    const cachedB = getGroupContextMessage(request.appId, request.chatId, b.messageId);
    return Number(!!cachedA && !cardContentHasUpgradeFallback(cachedA.text))
      - Number(!!cachedB && !cardContentHasUpgradeFallback(cachedB.text))
      || Number(b.createTime) - Number(a.createTime);
  });
  let resolvedCards = 0;
  let enrichmentClosed = false;
  const remainingMs = enrichmentDeadline - Date.now();
  if (cards.length && remainingMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(cards.slice(0, 8).map(async normalized => {
          try {
            const enriched = await resolveMergedCardContent(request.appId, normalized.messageId, createImgNumberer());
            if (signal.aborted || enrichmentClosed) return;
            if (!enriched || cardContentHasUpgradeFallback(enriched.text)) { incomplete = true; return; }
            const projection = normalized.senderType === 'bot' ? projectGroupContextCard(enriched.structuredContent) : undefined;
            if (projection?.kind === 'runtime') { resolvedCards++; return; }
            if (projection?.kind === 'unresolved') { incomplete = true; return; }
            if (projection?.kind === 'conversation') {
              const numberer = createImgNumberer();
              normalized.resourceRefs = extractResources('interactive', projection.content, numberer).map(resource => ({ ...resource }));
              normalized.text = parseApiMessage({ message_id: normalized.messageId, msg_type: 'interactive', body: { content: projection.content } }, numberer).content;
              normalized.cardContentVersion = GROUP_CONTEXT_CARD_CONTENT_VERSION;
            } else {
              normalized.text = enriched.text;
              normalized.resourceRefs = enriched.resources.map(resource => ({ ...resource }));
            }
            normalized.needsCardProjection = false;
            // The detail body may have changed since list() was fetched. Its
            // version must travel with that body; never keep the older list time.
            normalized.updateTime = enriched.updateTime;
            normalized.cardObservedAt = enriched.updateTime === undefined && projection?.kind === 'conversation' && projection.turnReply
                ? groupContextCardObservationTime(getGroupContextMessage(request.appId, request.chatId, normalized.messageId), normalized.text, normalized.resourceRefs ?? [])
                : undefined;
            if (isUnavailableGroupContextCard(normalized)) { incomplete = true; return; }
            if (isGroupContextNoise(normalized)) { resolvedCards++; return; }
            normalized.text = sanitizeGroupContextText(normalized.text);
            if (ingestHistory(normalized, request.appId) === false) incomplete = true;
            else {
              available.set(normalized.messageId, normalized);
              resolvedCards++;
            }
          } catch { incomplete = true; }
        })),
        new Promise<void>(resolve => { timer = setTimeout(resolve, remainingMs); }),
      ]);
    } finally {
      enrichmentClosed = true;
      if (timer) clearTimeout(timer);
    }
  }
  incomplete ||= hitLimit || resolvedCards < cards.length;
  const recallGap = groupContextRecallGap(request.appId);
  const reason = [hitLimit || boundary?.olderGap ? 'history_scan_limit' : incomplete ? 'card_content_unavailable' : '', recallGap].filter(Boolean).join(', ');
  return { messages: [...available.values()], incomplete: incomplete || !!recallGap, reason: reason || undefined };
}

function readLocal(appId: string, chatId: string) {
  const settings = getGroupContextSettings(appId, chatId);
  // Ingest prunes in batches. Settle retention now so a burst cannot make an
  // oldest-first bounded scan drop the newest messages beyond the row cap.
  pruneGroupContext(appId, chatId, { maxAgeMs: settings.retentionDays * 86_400_000, maxRows: settings.maxMessages });
  const head = getGroupContextHead(appId, chatId);
  // Metadata enrichment intentionally preserves seq and can come from another
  // process (CLI send). A head-seq cache misses those updates. Read this bounded
  // SQLite snapshot afresh so versions/provenance cannot remain stale.
  const records: GroupContextMessageRecord[] = [];
  let afterSeq = 0;
  let gap = head.prunedCount > 0;
  let hasMore = false;
  while (afterSeq < head.headSeq && records.length < settings.maxMessages) {
    const page = listGroupContextMessages(appId, chatId, { afterSeq, throughSeq: head.headSeq, limit: Math.min(2000, settings.maxMessages - records.length) });
    records.push(...page.messages);
    gap ||= !!page.retentionGap;
    hasMore = page.hasMore;
    if (page.throughSeq <= afterSeq) break;
    afterSeq = page.throughSeq;
    if (!hasMore) break;
  }
  return { messages: records.map(renderRecord), incomplete: gap || hasMore, reason: gap ? 'retention_gap' : hasMore ? 'local_scan_limit' : undefined };
}

async function resolveAttachments(request: GroupContextTurnRequest, records: GroupContextRenderMessage[], signal: AbortSignal) {
  if (!/图|照片|菜单|附件|文件|image|photo|picture|attachment|document|menu/i.test(request.query)) return { attachments: [], incomplete: false };
  const latest = new Map<string, GroupContextRenderMessage>();
  for (const record of records) {
    if (!latest.has(record.messageId) || latest.get(record.messageId)!.seq < record.seq) latest.set(record.messageId, record);
  }
  const selected = [...latest.values()].filter(record => !record.deleted && record.resourceRefs?.length
    && !isGroupContextNoise(record) && !isUnavailableGroupContextCard(record))
    .sort((a, b) => b.seq - a.seq).slice(0, 5).reverse();
  const attachments: LarkAttachment[] = [];
  let incomplete = false;
  for (const record of selected) {
    for (const resource of (record.resourceRefs ?? []).slice(0, 5 - attachments.length)) {
      if (signal.aborted) return { attachments, incomplete: true };
      if (!resource.key || !['image', 'file'].includes(resource.type)) continue;
      try {
        // Never turn an API-supplied filename into a filesystem traversal.
        if (!/^om_[A-Za-z0-9_-]+$/.test(record.messageId)) throw new Error('invalid_message_id');
        const dir = getAttachmentsDir(request.appId, record.messageId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const extension = extname(resource.name ?? '').replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
        const path = join(dir, `context-${createHash('sha256').update(resource.key).digest('hex').slice(0, 20)}${extension || (resource.type === 'image' ? '.png' : '.bin')}`);
        if (!existsSync(path)) await downloadMessageResource(request.appId, record.messageId, resource.key, resource.type as 'image' | 'file', path, undefined, { allowUserTokenFallback: false });
        const attachment: LarkAttachment = { type: resource.type as 'image' | 'file', path, name: basename(resource.name ?? path), resourceKey: resource.key };
        attachments.push(await normalizeImageAttachment(attachment));
      } catch { incomplete = true; }
    }
    if (attachments.length >= 5) break;
  }
  return { attachments, incomplete };
}

export const prepareGroupContextForTurn = createGroupContextPreparer({
  settings: getGroupContextSettings,
  readPrepared: (appId, chatId, turnId, epoch) => readPreparedGroupContext(appId, chatId, turnId, undefined, epoch),
  writePrepared: writePreparedGroupContext,
  backfill,
  ingest: ingestHistory,
  readLocal,
  deliveredSeqs: getDeliveredGroupContextSeqs,
  resolveAttachments,
  timeoutMs: 3_000,
});

/** Capture the version actually present in the admitted input, never a later
 * version fetched after backfill or at completion. A mismatch repeats safely. */
export function captureNativeGroupContextInput(appId: string, data: any): number[] {
  try {
    const input = normalizeGroupContextEvent(appId, data);
    if (!input) return [];
    const stored = getGroupContextMessage(appId, input.chatId, input.messageId);
    if (!stored || stored.deleted || stored.msgType !== input.msgType
        || !groupContextRepresentationsMatch(
          { msgType: stored.msgType, text: stored.text, mentions: stored.mentions, ...(stored.rawText !== undefined ? { rawText: stored.rawText } : {}) },
          { msgType: input.msgType, text: sanitizeGroupContextText(input.text), mentions: input.mentions, ...(input.rawText !== undefined ? { rawText: sanitizeGroupContextText(input.rawText) } : {}) })
        || stored.createTime !== input.createTime
        // Two unknown versions prove nothing about a *different* representation:
        // only equal versions, one side proving the message was never edited, or
        // a byte-identical body with identical mention identities bind the
        // input to this record.
        || !(sameGroupContextPlatformVersion(input.createTime, stored.updateTime, input.updateTime)
          || (stored.updateTime === undefined && input.updateTime === undefined
            && (stored.rawText !== undefined && input.rawText !== undefined
              ? stored.rawText === sanitizeGroupContextText(input.rawText) : stored.text === sanitizeGroupContextText(input.text))
            && sameGroupContextMentions(stored.mentions, input.mentions, stored.rawText, input.rawText, stored.msgType)))
        || JSON.stringify(stored.resourceRefs) !== JSON.stringify(input.resourceRefs)) return [];
    return [stored.seq];
  } catch { return []; }
}

/** Store only the body actually published to the group; no native/tool transcript. */
export function observePublishedGroupMessage(appId: string, message: any, authorOrigin?: GroupContextDeliveryBinding,
  context: GroupContextPublicationContext = {}): void {
  const chatId = message?.chat_id;
  if (typeof chatId !== 'string' || !getGroupContextSettings(appId, chatId).enabled) return;
  try {
    const normalized = normalizeHistoryMessage(appId, chatId, {
      ...message,
      create_time: message.create_time ?? String(getGroupContextMessage(appId, chatId, message.message_id)?.createTime ?? Date.now()),
      sender: message.sender ?? { id: appId, sender_type: 'app' },
    }, 0, { ...context, source: 'publication' });
    if (normalized && ingestHistory(normalized, appId)) {
      const stored = getGroupContextMessage(appId, chatId, normalized.messageId);
      // Late/stale history must not certify an unrelated retained revision as
      // native output. Only the exact canonical body acknowledged here qualifies.
      if (authorOrigin?.appId === appId && authorOrigin.chatId === chatId && stored && !stored.deleted
          && stored.msgType === normalized.msgType && stored.createTime === Number(normalized.createTime)
          && (normalized.updateTime === undefined || stored.updateTime === normalized.updateTime)
          && groupContextRepresentationsMatch(
            { msgType: stored.msgType, text: stored.text, mentions: stored.mentions, ...(stored.rawText !== undefined ? { rawText: stored.rawText } : {}) },
            { msgType: normalized.msgType, text: sanitizeGroupContextText(normalized.text), mentions: normalized.mentions, ...(normalized.rawText !== undefined ? { rawText: sanitizeGroupContextText(normalized.rawText) } : {}) })
          && JSON.stringify(stored.resourceRefs) === JSON.stringify(normalized.resourceRefs ?? [])) {
        recordNativeGroupContextDelivery(authorOrigin, [stored.seq]);
      }
    }
  } catch { logger.warn('[group-context] published message could not be recorded; next activation will backfill'); }
}
