import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { listChatMessagesUntil, listThreadMessages, downloadMessageResource } from '../im/lark/client.js';
import { parseApiMessage, createImgNumberer, extractResources, cardContentHasUpgradeFallback, resolveMergedCardContent } from '../im/lark/message-parser.js';
import { getAttachmentsDir } from '../core/attachment-path.js';
import { normalizeImageAttachment } from '../core/attachment-image-format.js';
import { getGroupContextSettings } from './group-context-settings-store.js';
import { getGroupContextHead, getGroupContextMessage, listGroupContextMessages, upsertGroupContextMessage, pruneGroupContext, type GroupContextMessageRecord } from './group-context-store.js';
import { readPreparedGroupContext, writePreparedGroupContext, getDeliveredGroupContextSeqs } from './group-context-delivery-store.js';
import { createGroupContextPreparer, type GroupContextTurnRequest } from './group-context.js';
import type { GroupContextRenderMessage } from './group-context-render.js';
import type { LarkAttachment } from '../types.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { groupContextRecallGap } from './group-context-health.js';

const syncBoundaries = new Map<string, { startedAt: number; olderGap: boolean }>();
const localSnapshots = new Map<string, { headSeq: number; prunedCount: number; records: GroupContextMessageRecord[] }>();
const scopeKey = (appId: string, chatId: string) => JSON.stringify([config.session.dataDir, appId, chatId]);

function boundedCacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

interface ObservedMessage extends GroupContextRenderMessage {
  updateTime?: number;
  historyStartedAt?: number;
}

function renderRecord(record: GroupContextMessageRecord): GroupContextRenderMessage {
  return { ...record, createTime: String(record.createTime), senderType: record.senderType === 'app' ? 'bot' : record.senderType,
    resourceRefs: record.resourceRefs.map(resource => ({ ...resource })) };
}

function normalizeHistoryMessage(appId: string, chatId: string, message: any, historyStartedAt: number): ObservedMessage | undefined {
  if (!message?.message_id || (message.chat_id && message.chat_id !== chatId)) return undefined;
  const numberer = createImgNumberer();
  const resources = extractResources(message.msg_type ?? 'text', message.body?.content ?? '', numberer);
  const parsed = parseApiMessage(message, numberer);
  const updateTime = Number(message.update_time);
  return {
    seq: 0, messageId: parsed.messageId, chatId,
    rootId: message.root_id || undefined, threadId: message.thread_id || undefined,
    senderId: parsed.senderId || '', senderName: parsed.senderName,
    senderType: !parsed.senderId ? 'unknown' : parsed.senderType === 'app' || parsed.senderType === 'bot' ? 'bot' : parsed.senderType === 'user' ? 'user' : 'unknown',
    msgType: parsed.msgType, text: parsed.content, createTime: parsed.createTime,
    resourceRefs: resources.map(resource => ({ ...resource })),
    deleted: message.deleted === true || message.is_recalled === true,
    historyStartedAt,
    ...(Number.isFinite(updateTime) && updateTime > 0 ? { updateTime } : {}),
  };
}

function ingestHistory(record: GroupContextRenderMessage, appId: string): boolean {
  const incoming = record as ObservedMessage;
  const previous = getGroupContextMessage(appId, record.chatId, record.messageId);
  // A slow history response must not undo a newer event received in flight.
  if (previous && incoming.historyStartedAt && previous.observedAt > incoming.historyStartedAt
      && (previous.text !== incoming.text || JSON.stringify(previous.resourceRefs) !== JSON.stringify(incoming.resourceRefs ?? []))
      && !incoming.deleted) return false;
  if (previous && ((!previous.senderName && incoming.senderName) || (!previous.rootId && incoming.rootId) || (!previous.threadId && incoming.threadId))) {
    localSnapshots.delete(scopeKey(appId, record.chatId));
  }
  const settings = getGroupContextSettings(appId, record.chatId);
  upsertGroupContextMessage(appId, {
    messageId: record.messageId, chatId: record.chatId, rootId: record.rootId, threadId: record.threadId,
    senderId: record.senderId, senderType: record.senderType, senderName: record.senderName,
    msgType: record.msgType, text: record.text, createTime: Number(record.createTime),
    resourceRefs: (record.resourceRefs ?? []).filter(resource => !!resource.key).map(resource => ({
      type: resource.type, key: resource.key!, ...(resource.name ? { name: resource.name } : {}),
    })),
    sourceAppId: appId, deleted: record.deleted,
    ...(incoming.updateTime ? { updateTime: incoming.updateTime } : {}),
  }, { maxAgeMs: settings.retentionDays * 86_400_000, maxRows: settings.maxMessages });
  return true;
}

async function backfill(request: GroupContextTurnRequest, signal: AbortSignal) {
  const started = Date.now();
  const settings = getGroupContextSettings(request.appId, request.chatId);
  const cutoff = started - settings.retentionDays * 86_400_000;
  const head = getGroupContextHead(request.appId, request.chatId);
  const key = scopeKey(request.appId, request.chatId);
  const boundary = syncBoundaries.get(key);
  const scanLimit = head.count > 1 ? 200 : 600;
  let hitLimit = false;
  const raw = await listChatMessagesUntil(request.appId, request.chatId, {
    pageSize: 50,
    stopAfter: (message, count) => {
      if (signal.aborted) return true;
      if (count >= scanLimit) { hitLimit = true; return true; }
      // Only a completed API scan creates this boundary. The local head may be
      // the current @ message and is NOT evidence that the intervening gap was read.
      if (boundary && count >= 50 && Number(message.create_time) <= boundary.startedAt - 60_000) return true;
      return Number(message.create_time) < cutoff;
    },
  });
  if (signal.aborted) throw new Error('history_timeout');
  if (request.rootId && request.rootId !== request.turnId) {
    const thread = await listThreadMessages(request.appId, request.chatId, request.rootId, 200);
    raw.push(...thread);
    if (thread.length >= 200) hitLimit = true;
  }
  const messages: ObservedMessage[] = [];
  const ids = new Set<string>();
  let incomplete = hitLimit || !!boundary?.olderGap;
  for (const message of raw) {
    if (signal.aborted) throw new Error('history_timeout');
    if (ids.has(message.message_id)) continue;
    ids.add(message.message_id);
    const normalized = normalizeHistoryMessage(request.appId, request.chatId, message, started);
    if (!normalized) continue;
    if (normalized.msgType === 'interactive' && cardContentHasUpgradeFallback(normalized.text)) {
      try {
        const enriched = await resolveMergedCardContent(request.appId, normalized.messageId, createImgNumberer());
        if (enriched) {
          normalized.text = enriched.text;
          normalized.resourceRefs = enriched.resources.map(resource => ({ ...resource }));
        } else incomplete = true;
      } catch { incomplete = true; }
    }
    messages.push(normalized);
  }
  boundedCacheSet(syncBoundaries, key, { startedAt: started, olderGap: hitLimit || !!boundary?.olderGap }, 128);
  const recallGap = groupContextRecallGap(request.appId);
  const reason = [hitLimit || boundary?.olderGap ? 'history_scan_limit' : incomplete ? 'card_content_unavailable' : '', recallGap].filter(Boolean).join(', ');
  return { messages, incomplete: incomplete || !!recallGap, reason: reason || undefined };
}

function readLocal(appId: string, chatId: string) {
  const settings = getGroupContextSettings(appId, chatId);
  // Ingest prunes in batches. Settle retention now so a burst cannot make an
  // oldest-first bounded scan drop the newest messages beyond the row cap.
  pruneGroupContext(appId, chatId, { maxAgeMs: settings.retentionDays * 86_400_000, maxRows: settings.maxMessages });
  const head = getGroupContextHead(appId, chatId);
  const key = scopeKey(appId, chatId);
  const cached = localSnapshots.get(key);
  const reusable = cached && cached.headSeq <= head.headSeq && cached.prunedCount === head.prunedCount;
  const records: GroupContextMessageRecord[] = reusable ? [...cached.records] : [];
  let afterSeq = reusable ? cached.headSeq : 0;
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
  // Cache modest rooms and append only their new revisions on the next turn.
  // Large source text remains on disk rather than multiplying daemon RSS.
  if (records.reduce((size, record) => size + record.text.length, 0) <= 2_000_000) {
    boundedCacheSet(localSnapshots, key, { headSeq: afterSeq, prunedCount: head.prunedCount, records }, 8);
  } else localSnapshots.delete(key);
  return { messages: records.map(renderRecord), incomplete: gap || hasMore, reason: gap ? 'retention_gap' : hasMore ? 'local_scan_limit' : undefined };
}

async function resolveAttachments(request: GroupContextTurnRequest, records: GroupContextRenderMessage[], signal: AbortSignal) {
  if (!/图|照片|菜单|附件|文件|image|photo|picture|attachment|document|menu/i.test(request.query)) return { attachments: [], incomplete: false };
  const latest = new Map<string, GroupContextRenderMessage>();
  for (const record of records) {
    if (!latest.has(record.messageId) || latest.get(record.messageId)!.seq < record.seq) latest.set(record.messageId, record);
  }
  const selected = [...latest.values()].filter(record => !record.deleted && record.resourceRefs?.length)
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
  readPrepared: readPreparedGroupContext,
  writePrepared: writePreparedGroupContext,
  backfill,
  ingest: ingestHistory,
  readLocal,
  deliveredSeqs: getDeliveredGroupContextSeqs,
  resolveAttachments,
  timeoutMs: 3_000,
});

/** Store only the body actually published to the group; no native/tool transcript. */
export function observePublishedGroupMessage(appId: string, message: any): void {
  const chatId = message?.chat_id;
  if (typeof chatId !== 'string' || !getGroupContextSettings(appId, chatId).enabled) return;
  try {
    const normalized = normalizeHistoryMessage(appId, chatId, {
      ...message,
      create_time: message.create_time ?? String(Date.now()),
      sender: message.sender ?? { id: appId, sender_type: 'app' },
    }, 0);
    if (normalized) ingestHistory(normalized, appId);
  } catch { logger.warn('[group-context] published message could not be recorded; next activation will backfill'); }
}
