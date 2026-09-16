import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { localeForBot, type Locale } from '../i18n/index.js';
import { sendEphemeralCard, sendMessage, sendUserMessage, replyMessage, deleteEphemeralCard, deleteMessage } from '../im/lark/client.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { resolvedPrivateReplyReviewConfig, type PrivateReplyReviewConfig } from './private-reply-review-config.js';

export const PRIVATE_REPLY_PUBLISH_ACTION = 'private_reply_publish';
export const PRIVATE_REPLY_DISCARD_ACTION = 'private_reply_discard';

export type PrivateReplyPlacement =
  | { mode: 'plain'; chatId: string }
  | { mode: 'reply'; rootMessageId: string; replyInThread: false }
  | { mode: 'thread'; rootMessageId: string; replyInThread: true };

export interface PrivateReplyPublication {
  schemaVersion: 1;
  publishId: string;
  nonceHash: string;
  larkAppId: string;
  chatId: string;
  sessionId: string;
  turnId?: string;
  placement: PrivateReplyPlacement;
  msgType: 'interactive' | 'post' | 'text';
  content: string;
  audienceOpenIds: string[];
  ephemeralMessageIds: string[];
  dmMessageIds?: string[];
  publicUuid: string;
  publicMessageId?: string;
  state: 'pending' | 'publishing' | 'published' | 'discarded' | 'expired';
  createdAt: number;
  expiresAt: number;
  publishedAt?: number;
  publishedByOpenId?: string;
}

export interface StagePrivateReplyInput {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  sessionId: string;
  turnId?: string;
  requesterOpenId?: string;
  placement: PrivateReplyPlacement;
  msgType: 'interactive' | 'post' | 'text';
  content: string;
  idempotencySeed: string;
  reviewConfig?: PrivateReplyReviewConfig;
  locale?: Locale;
}

export type StagePrivateReplyResult =
  | { staged: true; publishId: string; privateMessageIds: string[] }
  | { staged: false; reason: 'disabled' | 'unsupported' | 'no_audience' | 'delivery_failed' | 'public_fallback' };

export interface PrivateReplyReviewDeps {
  dataDir?: string;
  sendEphemeralCard?: typeof sendEphemeralCard;
  sendUserMessage?: typeof sendUserMessage;
  sendMessage?: typeof sendMessage;
  replyMessage?: typeof replyMessage;
  deleteEphemeralCard?: typeof deleteEphemeralCard;
  deleteMessage?: typeof deleteMessage;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function appDir(larkAppId: string, dataDir = config.session.dataDir): string {
  return join(dataDir, 'private-reply-publications', encodeURIComponent(larkAppId));
}

function recordPath(larkAppId: string, publishId: string, dataDir = config.session.dataDir): string {
  return join(appDir(larkAppId, dataDir), `${publishId}.json`);
}

function nonceHash(nonce: string): string {
  return `sha256:${sha256(nonce)}`;
}

function stablePublishId(input: StagePrivateReplyInput): string {
  return `prv_${sha256(JSON.stringify([
    input.larkAppId,
    input.sessionId,
    input.turnId ?? '',
    input.idempotencySeed,
  ])).slice(0, 40)}`;
}

function publicUuidFor(publishId: string): string {
  return `pr_${sha256(publishId).slice(0, 47)}`;
}

function isValidPublishId(value: unknown): value is string {
  return typeof value === 'string' && /^prv_[a-f0-9]{40}$/.test(value);
}

function readRecord(larkAppId: string, publishId: string, dataDir = config.session.dataDir): PrivateReplyPublication | undefined {
  if (!isValidPublishId(publishId)) return undefined;
  const path = recordPath(larkAppId, publishId, dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PrivateReplyPublication;
    if (parsed?.schemaVersion !== 1 || parsed.larkAppId !== larkAppId || parsed.publishId !== publishId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeRecord(record: PrivateReplyPublication, dataDir = config.session.dataDir): void {
  const dir = appDir(record.larkAppId, dataDir);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(recordPath(record.larkAppId, record.publishId, dataDir), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

function withRecordLock<T>(larkAppId: string, publishId: string, dataDir: string, fn: () => T): T {
  mkdirSync(appDir(larkAppId, dataDir), { recursive: true });
  return withFileLockSync(recordPath(larkAppId, publishId, dataDir), fn);
}

function normalizePlacement(value: PrivateReplyPlacement): PrivateReplyPlacement | undefined {
  if (value.mode === 'plain' && value.chatId) return { mode: 'plain', chatId: value.chatId };
  if (value.mode === 'thread' && value.rootMessageId) return { mode: 'thread', rootMessageId: value.rootMessageId, replyInThread: true };
  if (value.mode === 'reply' && value.rootMessageId) return { mode: 'reply', rootMessageId: value.rootMessageId, replyInThread: false };
  return undefined;
}

function resolvedAudience(input: StagePrivateReplyInput, pref: PrivateReplyReviewConfig): string[] {
  const bot = getBot(input.larkAppId);
  const allowedUsers = [...new Set(bot.resolvedAllowedUsers.filter(id => id.startsWith('ou_')))];
  const owners = [...new Set([
    ...(bot.config.ownerOpenId?.startsWith('ou_') ? [bot.config.ownerOpenId] : []),
    ...allowedUsers,
  ])];
  if (pref.audience === 'allowedUsers') return allowedUsers;
  if (pref.audience === 'owners') return owners;
  const out = new Set<string>();
  if (input.requesterOpenId?.startsWith('ou_')) out.add(input.requesterOpenId);
  if (out.size === 0) for (const owner of owners) out.add(owner);
  return [...out];
}

function operatorAdminOpenIds(larkAppId: string): Set<string> {
  const bot = getBot(larkAppId);
  return new Set([
    ...(bot.config.ownerOpenId?.startsWith('ou_') ? [bot.config.ownerOpenId] : []),
    ...bot.resolvedAllowedUsers.filter(id => id.startsWith('ou_')),
  ]);
}

function cleanupPrivateReplyReviewMessages(
  larkAppId: string,
  ephemeralMessageIds: readonly string[],
  dmMessageIds: readonly string[],
  deps: PrivateReplyReviewDeps,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const id of ephemeralMessageIds) {
    try {
      tasks.push(Promise.resolve((deps.deleteEphemeralCard ?? deleteEphemeralCard)(larkAppId, id)).catch(() => false));
    } catch {
      // Best-effort cleanup must never affect the publish/discard callback.
    }
  }
  for (const id of dmMessageIds) {
    try {
      tasks.push(Promise.resolve((deps.deleteMessage ?? deleteMessage)(larkAppId, id)).catch(() => false));
    } catch {
      // Best-effort cleanup must never affect the publish/discard callback.
    }
  }
  return Promise.all(tasks).then(() => undefined);
}

function cleanupPrivateReplyReviewMessagesInBackground(
  larkAppId: string,
  ephemeralMessageIds: readonly string[],
  dmMessageIds: readonly string[],
  deps: PrivateReplyReviewDeps,
  publishId: string,
): void {
  const timer = setTimeout(() => {
    void cleanupPrivateReplyReviewMessages(larkAppId, ephemeralMessageIds, dmMessageIds, deps)
      .catch(error => logger.debug(`[private-reply:${publishId}] cleanup failed after callback ack: ${error instanceof Error ? error.message : String(error)}`));
  }, 0);
  timer.unref?.();
}

function appendReviewActions(cardJson: string, publishId: string, nonce: string, locale: Locale): string {
  let card: any;
  try { card = JSON.parse(cardJson); }
  catch {
    card = {
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: cardJson }] },
    };
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    card = {
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: String(cardJson) }] },
    };
  }
  card.schema ??= '2.0';
  card.config = { update_multi: true, width_mode: 'fill', ...(card.config && typeof card.config === 'object' ? card.config : {}) };
  card.body = card.body && typeof card.body === 'object' && !Array.isArray(card.body)
    ? card.body
    : { direction: 'vertical', elements: [] };
  card.body.direction ??= 'vertical';
  if (!Array.isArray(card.body.elements)) card.body.elements = [];
  const publishText = locale === 'en' ? 'Publish to chat' : '公开到群里';
  const discardText = locale === 'en' ? 'Discard' : '丢弃';
  card.body.elements.push({ tag: 'hr' });
  card.body.elements.push({
    tag: 'markdown',
    text_size: 'notation',
    content: locale === 'en'
      ? '<font color="grey">Visible only to reviewers. Publish after confirming the answer is correct.</font>'
      : '<font color="grey">仅审核人可见。确认内容正确后再公开给群成员。</font>',
  });
  card.body.elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: publishText },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: PRIVATE_REPLY_PUBLISH_ACTION, publish_id: publishId, nonce } }],
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: discardText },
          type: 'default',
          behaviors: [{ type: 'callback', value: { action: PRIVATE_REPLY_DISCARD_ACTION, publish_id: publishId, nonce } }],
        }],
      },
    ],
  });
  return JSON.stringify(card);
}

function textToCard(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export function privateReplyReviewEnabled(larkAppId: string): boolean {
  try {
    return resolvedPrivateReplyReviewConfig(getBot(larkAppId).config.privateReplyReview).enabled === true;
  } catch {
    return false;
  }
}

export async function stagePrivateReplyForReview(input: StagePrivateReplyInput, deps: PrivateReplyReviewDeps = {}): Promise<StagePrivateReplyResult> {
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const pref = resolvedPrivateReplyReviewConfig(input.reviewConfig ?? getBot(input.larkAppId).config.privateReplyReview);
  if (!pref.enabled) return { staged: false, reason: 'disabled' };
  if (!input.larkAppId || !input.chatId || !input.sessionId) return { staged: false, reason: 'unsupported' };
  const placement = normalizePlacement(input.placement);
  if (!placement) return { staged: false, reason: 'unsupported' };

  const publishId = stablePublishId(input);
  const audience = resolvedAudience(input, pref);
  if (audience.length === 0) {
    return pref.fallback === 'public'
      ? { staged: false, reason: 'public_fallback' }
      : pref.fallback === 'drop'
        ? { staged: true, publishId, privateMessageIds: [] }
        : { staged: false, reason: 'no_audience' };
  }

  const nonce = randomBytes(18).toString('base64url');
  const now = Date.now();
  let record: PrivateReplyPublication = {
    schemaVersion: 1,
    publishId,
    nonceHash: nonceHash(nonce),
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    placement,
    msgType: input.msgType,
    content: input.content,
    audienceOpenIds: audience,
    ephemeralMessageIds: [],
    publicUuid: publicUuidFor(publishId),
    state: 'pending',
    createdAt: now,
    expiresAt: now + pref.expireHours * 60 * 60 * 1000,
  };
  const early = withRecordLock(input.larkAppId, publishId, dataDir, () => {
    const existing = readRecord(input.larkAppId, publishId, dataDir);
    if (existing?.state === 'published' && existing.publicMessageId) {
      return { staged: true as const, publishId, privateMessageIds: [...existing.ephemeralMessageIds, ...(existing.dmMessageIds ?? [])] };
    }
    if (existing?.state === 'pending') {
      if (existing.ephemeralMessageIds.length === 0 && (existing.dmMessageIds ?? []).length === 0) {
        record = {
          ...existing,
          nonceHash: nonceHash(nonce),
          audienceOpenIds: audience,
          placement,
          msgType: input.msgType,
          content: input.content,
          createdAt: now,
          expiresAt: now + pref.expireHours * 60 * 60 * 1000,
        };
        writeRecord(record, dataDir);
        return undefined;
      }
      return { staged: true as const, publishId, privateMessageIds: [...existing.ephemeralMessageIds, ...(existing.dmMessageIds ?? [])] };
    }
    if (existing?.state === 'publishing') {
      return { staged: true as const, publishId, privateMessageIds: [...existing.ephemeralMessageIds, ...(existing.dmMessageIds ?? [])] };
    }
    if (existing?.state === 'discarded' || existing?.state === 'expired') {
      return { staged: true as const, publishId, privateMessageIds: [] };
    }
    writeRecord(record, dataDir);
    return undefined;
  });
  if (early) return early;

  const reviewCard = appendReviewActions(input.msgType === 'interactive' ? input.content : textToCard(input.content), publishId, nonce, input.locale ?? localeForBot(input.larkAppId));
  let deliveredCount = 0;
  const ephemeralIds: string[] = [];
  const dmIds: string[] = [];
  for (const openId of audience) {
    try {
      if (input.chatType !== 'p2p' && placement.mode === 'plain') {
        const id = await (deps.sendEphemeralCard ?? sendEphemeralCard)(input.larkAppId, input.chatId, openId, reviewCard);
        deliveredCount++;
        if (id) ephemeralIds.push(id);
      } else if (pref.fallback === 'dm') {
        const id = await (deps.sendUserMessage ?? sendUserMessage)(input.larkAppId, openId, reviewCard, 'interactive');
        deliveredCount++;
        if (id) dmIds.push(id);
      } else {
        continue;
      }
    } catch (error) {
      if (pref.fallback === 'dm') {
        try {
          const id = await (deps.sendUserMessage ?? sendUserMessage)(input.larkAppId, openId, reviewCard, 'interactive');
          deliveredCount++;
          if (id) dmIds.push(id);
          continue;
        } catch (dmError) {
          logger.warn(`[private-reply:${publishId}] DM fallback to ${openId.substring(0, 8)} failed: ${dmError instanceof Error ? dmError.message : String(dmError)}`);
        }
      } else {
        logger.warn(`[private-reply:${publishId}] review card to ${openId.substring(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (deliveredCount === 0) {
    if (pref.fallback === 'public') {
      try { unlinkSync(recordPath(input.larkAppId, publishId, dataDir)); } catch { /* best effort */ }
      return { staged: false, reason: 'public_fallback' };
    }
    if (pref.fallback === 'drop') {
      record.state = 'discarded';
      writeRecord(record, dataDir);
      return { staged: true, publishId, privateMessageIds: [] };
    }
    try { unlinkSync(recordPath(input.larkAppId, publishId, dataDir)); } catch { /* best effort */ }
    return { staged: false, reason: 'delivery_failed' };
  }

  let cleanupEphemeralIds: string[] = [];
  let cleanupDmIds: string[] = [];
  withRecordLock(input.larkAppId, publishId, dataDir, () => {
    const latest = readRecord(input.larkAppId, publishId, dataDir);
    if (!latest) return;
    if (latest.state !== 'pending' && latest.state !== 'publishing' && latest.state !== 'published' && latest.state !== 'discarded') return;
    latest.ephemeralMessageIds = [...new Set([...latest.ephemeralMessageIds, ...ephemeralIds])];
    latest.dmMessageIds = [...new Set([...(latest.dmMessageIds ?? []), ...dmIds])];
    writeRecord(latest, dataDir);
    if (latest.state === 'published' || latest.state === 'discarded') {
      cleanupEphemeralIds = ephemeralIds;
      cleanupDmIds = dmIds;
    }
  });
  await cleanupPrivateReplyReviewMessages(input.larkAppId, cleanupEphemeralIds, cleanupDmIds, deps);
  return { staged: true, publishId, privateMessageIds: [...ephemeralIds, ...dmIds] };
}

export async function publishPrivateReply(input: {
  larkAppId: string;
  publishId: string;
  nonce: string;
  operatorOpenId?: string;
}, deps: PrivateReplyReviewDeps = {}): Promise<{ ok: true; messageId?: string; already?: boolean } | { ok: false; reason: string }> {
  if (!isValidPublishId(input.publishId)) return { ok: false, reason: 'invalid' };
  const dataDir = deps.dataDir ?? config.session.dataDir;
  let record: PrivateReplyPublication | undefined;
  const claim = withRecordLock(input.larkAppId, input.publishId, dataDir, () => {
    record = readRecord(input.larkAppId, input.publishId, dataDir);
    if (!record) return { ok: false as const, reason: 'not_found' };
    if (record.nonceHash !== nonceHash(input.nonce)) return { ok: false as const, reason: 'expired' };
    if (record.state === 'published') return { ok: true as const, messageId: record.publicMessageId, already: true };
    if (record.state === 'publishing') return { ok: false as const, reason: 'publishing' };
    if (record.state === 'discarded') return { ok: false as const, reason: 'discarded' };
    if (Date.now() > record.expiresAt) {
      record.state = 'expired';
      writeRecord(record, dataDir);
      return { ok: false as const, reason: 'expired' };
    }
    const admins = operatorAdminOpenIds(input.larkAppId);
    const allowed = !!input.operatorOpenId && (record.audienceOpenIds.includes(input.operatorOpenId) || admins.has(input.operatorOpenId));
    if (!allowed) return { ok: false as const, reason: 'forbidden' };
    record.state = 'publishing';
    writeRecord(record, dataDir);
    return { ok: true as const };
  });
  if (!claim.ok) return claim;
  if ('already' in claim && claim.already) return claim;
  if (!record) return { ok: false, reason: 'not_found' };

  try {
    const messageId = record.placement.mode === 'plain'
      ? await (deps.sendMessage ?? sendMessage)(record.larkAppId, record.placement.chatId, record.content, record.msgType, record.publicUuid)
      : await (deps.replyMessage ?? replyMessage)(record.larkAppId, record.placement.rootMessageId, record.content, record.msgType, record.placement.replyInThread, record.publicUuid);
    const finalRecord = withRecordLock(record.larkAppId, record.publishId, dataDir, () => {
      const latest = readRecord(record!.larkAppId, record!.publishId, dataDir) ?? record!;
      const next = { ...latest, state: 'published' as const, publicMessageId: messageId, publishedAt: Date.now(), ...(input.operatorOpenId ? { publishedByOpenId: input.operatorOpenId } : {}) };
      writeRecord(next, dataDir);
      return next;
    });
    cleanupPrivateReplyReviewMessagesInBackground(
      finalRecord.larkAppId,
      finalRecord.ephemeralMessageIds,
      finalRecord.dmMessageIds ?? [],
      deps,
      finalRecord.publishId,
    );
    return { ok: true, messageId };
  } catch (error) {
    // The provider call may have been accepted while the response was lost.
    // Keep the record in `publishing` so a repeated click cannot create a second
    // public message after Feishu's uuid idempotency window. Operators can
    // reconcile manually from logs if this rare ambiguous state happens.
    return { ok: false, reason: `publish_ambiguous: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function discardPrivateReply(input: {
  larkAppId: string;
  publishId: string;
  nonce: string;
  operatorOpenId?: string;
}, deps: PrivateReplyReviewDeps = {}): Promise<{ ok: true; already?: boolean } | { ok: false; reason: string }> {
  if (!isValidPublishId(input.publishId)) return { ok: false, reason: 'invalid' };
  const dataDir = deps.dataDir ?? config.session.dataDir;
  let ids: string[] = [];
  let dmIds: string[] = [];
  const result = withRecordLock(input.larkAppId, input.publishId, dataDir, () => {
    const record = readRecord(input.larkAppId, input.publishId, dataDir);
    if (!record) return { ok: false as const, reason: 'not_found' };
    if (record.nonceHash !== nonceHash(input.nonce)) return { ok: false as const, reason: 'expired' };
    if (record.state === 'published') return { ok: false as const, reason: 'published' };
    if (record.state === 'publishing') return { ok: false as const, reason: 'publishing' };
    if (record.state === 'discarded') return { ok: true as const, already: true };
    const admins = operatorAdminOpenIds(input.larkAppId);
    const allowed = !!input.operatorOpenId && (record.audienceOpenIds.includes(input.operatorOpenId) || admins.has(input.operatorOpenId));
    if (!allowed) return { ok: false as const, reason: 'forbidden' };
    record.state = 'discarded';
    ids = [...record.ephemeralMessageIds];
    dmIds = [...(record.dmMessageIds ?? [])];
    writeRecord(record, dataDir);
    return { ok: true as const };
  });
  if (!result.ok) return result;
  cleanupPrivateReplyReviewMessagesInBackground(input.larkAppId, ids, dmIds, deps, input.publishId);
  return result;
}
