/**
 * group-context-ingest.ts — 把飞书群消息事件静默写进 group-context-store。
 *
 * 位置：event-dispatcher 的 processMessageEvent 里，拿到 chat_id / message_id 之后、
 * 任何 sender 分支 / self return / mention gate **之前**调用。它只旁听、只记录：
 *  - 不改唤醒与权限规则，不启动 worker，不发卡片；
 *  - 不触碰 seen-message 去重（既不读也不推进）；
 *  - 受 settings resolver 保护，默认关：resolver 未注册或返回 enabled=false 时零写入；
 *  - 任何异常（存储打不开、写锁争用、解析失败）都在这里吞掉，只返回 outcome 并限流告警，
 *    绝不让原 mention 流程因它失败。缺的那条由 history 回填层补。
 *
 * 开关来源：`setGroupContextSettingsResolver(getGroupContextSettings)` 由集成方在 daemon
 * 装配时注册（settings store 另有文件维护，本模块不直接 import，避免模块耦合）。
 */

import { parseEventMessage, structuredMentionRefs, rawPlaceholderText, postMentionRefs } from '../im/lark/message-parser.js';
import { projectGroupContextCard, GROUP_CONTEXT_CARD_CONTENT_VERSION } from '../im/lark/group-context-card.js';
import { logger } from '../utils/logger.js';
import { isGroupContextNoise, isUnavailableGroupContextCard, sanitizeGroupContextText } from './group-context-content.js';
import { groupContextCardObservationTime } from './group-context-card-observation.js';
import {
  upsertGroupContextMessage,
  getGroupContextMessage,
  markGroupContextMessageDeleted,
  type GroupContextMessageInput,
  type GroupContextSenderType,
} from './group-context-store.js';

export interface GroupContextSettings {
  enabled: boolean;
  maxContextChars?: number;
  retentionDays?: number;
  maxMessages?: number;
}

export type GroupContextSettingsResolver = (larkAppId: string, chatId: string) => GroupContextSettings | undefined;

export type GroupContextIngestOutcome =
  | 'disabled'
  | 'skipped_p2p'
  | 'skipped_invalid'
  | 'skipped_noise'
  | 'stored'
  | 'duplicate'
  | 'error';

/** 默认关：没人注册 resolver 就永远不写。 */
let resolver: GroupContextSettingsResolver = () => undefined;

export function setGroupContextSettingsResolver(fn: GroupContextSettingsResolver | undefined): void {
  resolver = fn ?? (() => undefined);
}

/** 调用方在做任何有成本的准备（比如查群类型）之前先问一句，关着就别花这个钱。 */
export function isGroupContextEnabled(larkAppId: string, chatId: string): boolean {
  return !!resolveSettings(larkAppId, chatId)?.enabled;
}

function resolveSettings(larkAppId: string, chatId: string): GroupContextSettings | undefined {
  try {
    return resolver(larkAppId, chatId);
  } catch (err) {
    warnThrottled(larkAppId, `settings resolver threw: ${err}`);
    return undefined;
  }
}

/** 告警限流：同一 app 每分钟最多一条，避免存储持续失败时刷日志。 */
const WARN_INTERVAL_MS = 60_000;
const lastWarnAt = new Map<string, number>();
function warnThrottled(larkAppId: string, message: string, now = Date.now()): void {
  const last = lastWarnAt.get(larkAppId) ?? 0;
  if (now - last < WARN_INTERVAL_MS) return;
  lastWarnAt.set(larkAppId, now);
  logger.warn(`[group-context:${larkAppId}] ${message}`);
}

function normalizeSenderType(raw: unknown): GroupContextSenderType {
  if (raw === 'user') return 'user';
  if (raw === 'app' || raw === 'bot') return 'bot';
  return 'unknown';
}

function retentionFromSettings(settings: GroupContextSettings): { maxAgeMs?: number; maxRows?: number } {
  const out: { maxAgeMs?: number; maxRows?: number } = {};
  if (typeof settings.retentionDays === 'number' && settings.retentionDays > 0) {
    out.maxAgeMs = settings.retentionDays * 24 * 60 * 60_000;
  }
  if (typeof settings.maxMessages === 'number' && settings.maxMessages > 0) {
    out.maxRows = Math.trunc(settings.maxMessages);
  }
  return out;
}

/**
 * 把 receive_v1 事件（或同构的 updated/回填形态）归一为存储输入。解析失败时退化为
 * 原始 content 作正文，宁可存一条粗糙的也不丢。
 */
export function normalizeGroupContextEvent(larkAppId: string, data: any): GroupContextMessageInput | undefined {
  let message = data?.message;
  const sender = data?.sender;
  if (!message || typeof message !== 'object') return undefined;
  const messageId = typeof message.message_id === 'string' ? message.message_id : '';
  const chatId = typeof message.chat_id === 'string' ? message.chat_id : '';
  if (!messageId || !chatId) return undefined;

  const senderId: string = sender?.sender_id?.open_id ?? sender?.sender_id?.app_id ?? '';
  const senderType = normalizeSenderType(sender?.sender_type);
  const msgType: string = typeof message.message_type === 'string' ? message.message_type : 'unknown';
  const projection = senderType === 'bot' && msgType === 'interactive'
    ? projectGroupContextCard(message.content ?? '') : undefined;
  if (projection && projection.kind !== 'conversation') return undefined;
  if (projection?.kind === 'conversation') message = { ...message, content: projection.content };
  const createTime = Math.trunc(Number(message.create_time) || 0);
  // 平台给了 update_time 才填（编辑事件 / history 带），没有就留空，不拿 create_time 冒充。
  const updateTimeRaw = Math.trunc(Number(message.update_time));
  const updateTime = Number.isFinite(updateTimeRaw) && updateTimeRaw > 0 ? updateTimeRaw : undefined;

  let text = '';
  let resourceRefs: GroupContextMessageInput['resourceRefs'] = [];
  try {
    const { parsed, resources } = parseEventMessage({
      ...data,
      message,
      sender: { sender_id: sender?.sender_id ?? {}, sender_type: sender?.sender_type ?? 'unknown' },
    });
    text = parsed.content ?? '';
    resourceRefs = (resources ?? []).map(r => ({ type: r.type, key: r.key, ...(r.name ? { name: r.name } : {}) }));
  } catch {
    text = '';
  }
  if (!text && !projection && typeof message.content === 'string') text = message.content;
  if (projection && (!text.trim() || text.trim() === '[卡片]') && !resourceRefs.length) return undefined;
  const cardObservedAt = updateTime === undefined && projection?.kind === 'conversation' && projection.turnReply
    ? groupContextCardObservationTime(getGroupContextMessage(larkAppId, chatId, messageId), text, resourceRefs) : undefined;

  const mentions = !projection && msgType === 'post' && typeof message.content === 'string'
    ? postMentionRefs(message.content, message.mentions)
    : structuredMentionRefs(message.mentions);
  const rawText = !projection && typeof message.content === 'string' ? rawPlaceholderText(msgType, message.content) : undefined;
  return {
    messageId,
    chatId,
    ...(mentions ? { mentions } : {}),
    ...(rawText !== undefined ? { rawText } : {}),
    // Receive events distinguish a real topic from an ordinary quote bubble:
    // root_id alone is a reply-tree reference, not a conversation boundary.
    conversationScope: message.thread_id ? 'thread' : 'main',
    rootId: typeof message.root_id === 'string' && message.root_id ? message.root_id : undefined,
    threadId: typeof message.thread_id === 'string' && message.thread_id ? message.thread_id : undefined,
    parentId: typeof message.parent_id === 'string' && message.parent_id ? message.parent_id : undefined,
    senderId,
    senderType,
    senderName: typeof data?.senderName === 'string' ? data.senderName : undefined,
    msgType,
    text,
    createTime,
    ...(updateTime !== undefined ? { updateTime } : {}),
    ...(cardObservedAt !== undefined ? { cardObservedAt } : {}),
    resourceRefs,
    sourceAppId: larkAppId,
    ...(projection ? { cardContentVersion: GROUP_CONTEXT_CARD_CONTENT_VERSION } : {}),
  };
}

/** receive_v1 / updated_v1：旁听写入。永不抛出。 */
export function ingestGroupContextEvent(larkAppId: string, data: any): GroupContextIngestOutcome {
  try {
    const message = data?.message;
    if (!message || typeof message !== 'object') return 'skipped_invalid';
    if (message.chat_type === 'p2p') return 'skipped_p2p';
    const chatId = typeof message.chat_id === 'string' ? message.chat_id : '';
    if (!chatId || typeof message.message_id !== 'string' || !message.message_id) return 'skipped_invalid';

    const settings = resolveSettings(larkAppId, chatId);
    if (!settings?.enabled) return 'disabled';

    const input = normalizeGroupContextEvent(larkAppId, data);
    if (!input) return data?.message?.message_type === 'interactive'
      && !!data?.message?.message_id && !!data?.message?.chat_id
      && normalizeSenderType(data?.sender?.sender_type) === 'bot' ? 'skipped_noise' : 'skipped_invalid';
    if (isGroupContextNoise({ ...input, senderType: input.senderType === 'app' ? 'bot' : input.senderType })) return 'skipped_noise';
    if (isUnavailableGroupContextCard({ ...input, senderType: input.senderType === 'app' ? 'bot' : input.senderType })) return 'skipped_noise';
    input.text = sanitizeGroupContextText(input.text);
    if (input.rawText !== undefined) input.rawText = sanitizeGroupContextText(input.rawText);

    const res = upsertGroupContextMessage(larkAppId, input, retentionFromSettings(settings));
    return res.inserted ? 'stored' : 'duplicate';
  } catch (err) {
    warnThrottled(larkAppId, `ingest failed msg=${String(data?.message?.message_id ?? '?').slice(0, 16)}: ${err}`);
    return 'error';
  }
}

/** recalled_v1：写 tombstone revision。永不抛出。 */
export function ingestGroupContextRecall(
  larkAppId: string,
  recall: { chatId?: string; messageId?: string; recallTime?: string | number },
): GroupContextIngestOutcome {
  try {
    const chatId = typeof recall?.chatId === 'string' ? recall.chatId : '';
    const messageId = typeof recall?.messageId === 'string' ? recall.messageId : '';
    if (!chatId || !messageId) return 'skipped_invalid';
    const settings = resolveSettings(larkAppId, chatId);
    if (!settings?.enabled) return 'disabled';
    const deletedAt = recall.recallTime !== undefined ? Math.trunc(Number(recall.recallTime)) || Date.now() : Date.now();
    const res = markGroupContextMessageDeleted(larkAppId, chatId, messageId, { deletedAt, sourceAppId: larkAppId });
    return res.inserted ? 'stored' : 'duplicate';
  } catch (err) {
    warnThrottled(larkAppId, `recall ingest failed msg=${String(recall?.messageId ?? '?').slice(0, 16)}: ${err}`);
    return 'error';
  }
}

export function _resetGroupContextIngestForTest(): void {
  resolver = () => undefined;
  lastWarnAt.clear();
}
