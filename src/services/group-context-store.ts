/**
 * group-context-store.ts — 群聊旁听消息的共享记录层。
 *
 * 用途：让「没被 @ 的 bot」在下次被唤醒前，能拿到群里期间发生的对话。daemon 收到每条
 * 群消息事件后（见 group-context-ingest.ts）把解析后的正文按 app + chat 写进这里；
 * turn 前补齐层按 seq 游标读走。本模块只管存取，不做唤醒、不做权限判断。
 *
 * 设计要点：
 *  - **seq 是唯一的前进游标**。messageId / createTime 都不单调（重推、编辑、乱序到达），
 *    所以每次「新增或正文更正」都分配一个本地递增 seq；同 messageId 同正文的重复写入
 *    （飞书 at-least-once 重推、history 回填与实时事件重叠）**不**分配新 seq。
 *  - 编辑 / 撤回以新 revision 追加，不原地改写：读方按 seq 往前走就自然看到更正，
 *    `isLatest` 标出哪条是当前版本，`deleted` 是 tombstone。
 *  - 淘汰有界（默认 30 天 / 10000 条每群），**按消息的有效时间**（创建/编辑/撤回里最晚的）
 *    删最旧，不按 seq：history 回填是新→旧返回的，迟到的老消息会拿到大 seq。被淘汰记录的
 *    最大 seq 记在 chat_meta，list 在游标落在该区间时显式返回 `retentionGap`，绝不默默当作
 *    完整记录。
 *  - SQLite（sqlite-compat，Node/Bun 双引擎）+ busy_timeout + WAL：多个 daemon 进程
 *    （一个 app 一个进程）各写各的 app 文件；`botmux send` 一类子进程若回填自己的
 *    发送回执，与 daemon 并发写同一文件也靠 SQLite 串行化，不走 JSON 多进程覆盖。
 *  - ID 保留身份域：senderId 是观察方 app 视角下的 open_id/app_id，sourceAppId 记录
 *    观察视角；不把 open_id 当跨 app 的全局身份。
 */

import { createHash } from 'node:crypto';
import { groupContextRepresentationsMatch, sameGroupContextPlatformVersion, groupContextMentionIdentities, type GroupContextMentionRef } from './group-context-content.js';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

export type GroupContextConversationScope = 'main' | 'thread';

export type GroupContextSenderType = 'user' | 'bot' | 'app' | 'unknown';

export interface GroupContextResourceRef {
  type: string;
  key: string;
  name?: string;
}

/** 写入形态：解析后的一条群消息。 */
export interface GroupContextMessageInput {
  messageId: string;
  chatId: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  /** Proven original conversation; rootId alone can also be a lobby quote. */
  conversationScope?: GroupContextConversationScope;
  /** 观察方 app 视角下的发送者 id（open_id 或 bot 的 app_id）。 */
  senderId: string;
  senderType: GroupContextSenderType;
  senderName?: string;
  msgType: string;
  /** 解析后的纯文本 / 卡片摘要（含 [图片 N] 占位）。 */
  text: string;
  /** 毫秒时间戳。 */
  createTime: number;
  /**
   * 平台给出的最后编辑时间（ms）。只在平台真有这个值时填，没有就留空、**不伪造**。
   * 双方都带版本时，store 用它拒绝更旧的正文（乱序编辑 / 过期回填）；任一方没有则无法
   * 消歧，按到达顺序追加。
   */
  updateTime?: number;
  /** 已完成对话正文投影的版本；1 = 已剥离运行状态 / 过程 / 控件。缺省表示旧版未验证正文。 */
  cardContentVersion?: number;
  /** 同一投影正文首次被本地观察到的时间（ms），仅供可见时间边界使用，绝不是平台编辑版本。 */
  cardObservedAt?: number;
  /** 附件只存引用，不存内容。 */
  resourceRefs: GroupContextResourceRef[];
  /** 事件 / history 携带的结构化 @ 提及（key/name/id）。实时事件把 `@_user_N`
   *  解析成「@名字」，无 mentions 的 history 回读则整个丢掉；有了这份证据，
   *  同一平台版本的两种表示才能被判定为同一内容，而不是靠通配去掉任意 @token。 */
  mentions?: GroupContextMentionRef[];
  /** 平台原文（text 消息保留 `@_user_N` 占位符）。有占位符的原文才是正文身份：
   *  实时事件与 history 回读不管有没有 mentions 列表，这一份都相同；正文里字面的
   *  `@名字` 不会被当成 mention 抹掉。 */
  rawText?: string;
  /** 观察视角：是哪个 app 看到的这条消息。 */
  sourceAppId: string;
  /** 已撤回 / 删除。 */
  deleted?: boolean;
  deletedAt?: number;
}

/** 读出形态：每条 revision 一行。 */
export interface GroupContextMessageRecord extends GroupContextMessageInput {
  seq: number;
  revision: number;
  deleted: boolean;
  /** 该 messageId 的最新 revision 是否就是本行。 */
  isLatest: boolean;
  /** 本进程观察到这条 revision 的时间（ms）。 */
  observedAt: number;
}

export interface UpsertResult {
  seq: number;
  revision: number;
  /** false = 同 messageId 同正文重复，未分配新 seq。 */
  inserted: boolean;
}

export interface ListOptions {
  /** 只返回 seq > afterSeq 的记录。 */
  afterSeq?: number;
  /** 只返回 seq <= throughSeq 的记录。 */
  throughSeq?: number;
  /** 只返回 createTime < beforeCreateTime 的记录。 */
  beforeCreateTime?: number;
  /** 只返回该话题根下的记录（rootId 精确匹配）。 */
  rootId?: string;
  /** 默认 200，上限 2000。 */
  limit?: number;
}

export interface RetentionGap {
  /** 被淘汰记录里最大的 seq = 有缺口的最大序号：<= 它的区间可能不完整，不表示更小的序号全没了。 */
  prunedThroughSeq: number;
  /** 累计淘汰条数。 */
  prunedCount: number;
}

export interface ListResult {
  messages: GroupContextMessageRecord[];
  hasMore: boolean;
  /** 本页最后一条 seq；空页时等于 afterSeq（或 0），可直接作为下一页游标。 */
  throughSeq: number;
  /** 游标（afterSeq）落在有缺口的序号区间内时给出，告知读方记录可能不完整。 */
  retentionGap?: RetentionGap;
}

export interface GroupContextHead {
  headSeq: number;
  count: number;
  oldestSeq: number;
  newestCreateTime: number | undefined;
  prunedThroughSeq: number;
  prunedCount: number;
}

export interface RetentionOptions {
  /** 默认 30 天。 */
  maxAgeMs?: number;
  /** 默认 10000 条 / 群。 */
  maxRows?: number;
  now?: number;
}

export interface PruneResult {
  prunedCount: number;
  prunedThroughSeq: number;
}

export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;
/** 每多少次插入做一次自动淘汰检查（淘汰本身也会按阈值判断，这里只是省掉每次都 COUNT）。 */
const AUTO_PRUNE_EVERY = 64;
const SCHEMA_VERSION = 5;

interface AppHandle {
  db: DatabaseSyncLike;
  path: string;
  insertsSinceAutoPrune: number;
}

const handles = new Map<string, AppHandle>();

export function groupContextDbPath(larkAppId: string): string {
  return join(config.session.dataDir, 'group-context', `${fileTokenFor(larkAppId)}.sqlite`);
}

/**
 * app 文件名：合法的飞书 app id（`cli_` + 字母数字）原样用；其它任何形态（含路径分隔符、
 * `..`、空串）一律取 sha256 前 32 位，**不做有损替换**——有损替换会让 `turn/a` 与 `turn?a`
 * 撞成同一个文件。
 */
function fileTokenFor(larkAppId: string): string {
  if (/^[A-Za-z0-9_-]{1,96}$/.test(larkAppId) && larkAppId !== '-' && larkAppId !== '_') return larkAppId;
  return createHash('sha256').update(larkAppId).digest('hex').slice(0, 32);
}

/**
 * 写锁争用的最长同步等待（ms）。这里的写入都在 daemon 事件循环上同步执行，不能像
 * feedback store 那样等 5s：争不到就抛 SQLITE_BUSY，由 ingest 记一次 error、本条丢弃
 * （history 回填层会把缺口补回），绝不卡住消息事件分发。
 */
const BUSY_TIMEOUT_MS = 250;

function open(larkAppId: string): AppHandle {
  const existing = handles.get(larkAppId);
  if (existing) return existing;
  const path = groupContextDbPath(larkAppId);
  // 群正文是私密数据：目录 0700、主文件 0600（在 WAL 初始化前收紧，-wal/-shm 由 SQLite
  // 按主文件权限创建），和交付 ledger / 设置文件的私有权限一致，别落成默认 0644。
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const db = openDatabaseSyncOrThrow(path);
  try { chmodSync(path, 0o600); } catch (err) {
    logger.warn(`[group-context-store] chmod 0600 failed for ${path}: ${err}`);
  }
  // busy_timeout 先于一切（含 WAL 切换的写锁）。
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
  try { db.exec('PRAGMA journal_mode=WAL;'); } catch (err) {
    logger.warn(`[group-context-store] WAL unavailable for ${path}: ${err}`);
  }
  migrate(db);
  const handle: AppHandle = { db, path, insertsSinceAutoPrune: 0 };
  handles.set(larkAppId, handle);
  return handle;
}

function migrate(db: DatabaseSyncLike): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  if (version > SCHEMA_VERSION) throw new Error(`group_context_schema_newer:${version}`);
  const hasCardObservedAt = () => (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
    .some(column => column.name === 'card_observed_at');
  if (version === SCHEMA_VERSION && hasCardObservedAt()) return;
  db.exec('BEGIN IMMEDIATE;');
  try {
    // 多进程并发冷启动：拿到写锁后再读一次版本，输家直接退出。
    const again = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (again < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          root_id TEXT,
          thread_id TEXT,
          parent_id TEXT,
          sender_id TEXT NOT NULL,
          sender_type TEXT NOT NULL,
          sender_name TEXT,
          msg_type TEXT NOT NULL,
          text TEXT NOT NULL,
          create_time INTEGER NOT NULL,
          resource_refs TEXT NOT NULL DEFAULT '[]',
          mentions TEXT,
          raw_text TEXT,
          source_app_id TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          deleted_at INTEGER,
          content_hash TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_chat_msg_rev ON messages(chat_id, message_id, revision);
        CREATE INDEX IF NOT EXISTS ix_messages_chat_seq ON messages(chat_id, seq);
        CREATE INDEX IF NOT EXISTS ix_messages_chat_root_seq ON messages(chat_id, root_id, seq);
        CREATE INDEX IF NOT EXISTS ix_messages_chat_ctime ON messages(chat_id, create_time);
        CREATE TABLE IF NOT EXISTS chat_meta (
          chat_id TEXT PRIMARY KEY,
          pruned_through_seq INTEGER NOT NULL DEFAULT 0,
          pruned_count INTEGER NOT NULL DEFAULT 0
        );
        PRAGMA user_version=1;
      `);
    }
    const afterV1 = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (afterV1 < 2) {
      // v2：平台编辑时间，用于拒绝更旧版本的正文。旧库补列，历史行保持 NULL（= 未知版本）。
      db.exec(`
        ALTER TABLE messages ADD COLUMN update_time INTEGER;
        PRAGMA user_version=2;
      `);
    }
    const afterV2 = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (afterV2 < 3) {
      // 不推断旧行已经投影；NULL 让读方等待可信 history 回填后再展示运行卡正文。
      db.exec(`
        ALTER TABLE messages ADD COLUMN card_content_version INTEGER;
        PRAGMA user_version=3;
      `);
    }
    // Early v3 development databases may already have provenance but no local
    // body observation bound. Recheck under the write lock for concurrent opens.
    if (!hasCardObservedAt()) db.exec('ALTER TABLE messages ADD COLUMN card_observed_at INTEGER;');
    const afterV3 = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (afterV3 < 4) {
      // Unknown legacy rows stay NULL: a reply root cannot prove topic membership.
      db.exec(`
        ALTER TABLE messages ADD COLUMN conversation_scope TEXT;
        PRAGMA user_version=4;
      `);
    }
    const afterV4 = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (afterV4 < 5) {
      // v5: structured mention identities and the platform body with
      // placeholders. Legacy rows stay NULL (name-stripping fallback applies).
      // Development databases may already carry the columns from before the
      // version bump; the ALTERs are guarded so the bump is still recorded.
      const columns = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(c => c.name);
      if (!columns.includes('mentions')) db.exec('ALTER TABLE messages ADD COLUMN mentions TEXT;');
      if (!columns.includes('raw_text')) db.exec('ALTER TABLE messages ADD COLUMN raw_text TEXT;');
      db.exec('PRAGMA user_version=5;');
    }
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    throw err;
  }
}

function contentHash(input: Pick<GroupContextMessageInput, 'text' | 'rawText' | 'mentions' | 'msgType' | 'resourceRefs' | 'deleted'>): string {
  const h = createHash('sha1');
  h.update(input.msgType);
  h.update('\u0000');
  // The platform body with placeholders is the identity; the resolved display
  // text is a rendering of it. Mention identities are part of the content: the
  // same body addressed to a different target is a different message.
  h.update(input.rawText ?? input.text);
  h.update('\u0000');
  h.update(JSON.stringify(input.resourceRefs ?? []));
  h.update('\u0000');
  h.update(JSON.stringify(groupContextMentionIdentities(input.mentions, input.rawText, input.msgType)));
  h.update('\u0000');
  h.update(input.deleted ? '1' : '0');
  return h.digest('hex');
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`group-context: ${field} is required`);
  return value;
}

function parseMentions(value: unknown): GroupContextMentionRef[] | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed.filter((m): m is GroupContextMentionRef => !!m && typeof m === 'object'
      && typeof (m as GroupContextMentionRef).key === 'string' && typeof (m as GroupContextMentionRef).name === 'string');
    return out.length ? out : undefined;
  } catch { return undefined; }
}

function serializeMentions(mentions: readonly GroupContextMentionRef[] | undefined): string | null {
  if (!mentions?.length) return null;
  return JSON.stringify(mentions.map(m => ({ key: m.key, name: m.name,
    ...(m.openId ? { openId: m.openId } : {}), ...(m.appId ? { appId: m.appId } : {}), ...(m.userId ? { userId: m.userId } : {}), ...(m.unionId ? { unionId: m.unionId } : {}) })));
}

function rowToRecord(row: any, latestRevision: number): GroupContextMessageRecord {
  let resourceRefs: GroupContextResourceRef[] = [];
  try { resourceRefs = JSON.parse(row.resource_refs ?? '[]'); } catch { resourceRefs = []; }
  return {
    seq: Number(row.seq),
    revision: Number(row.revision),
    messageId: row.message_id,
    chatId: row.chat_id,
    rootId: row.root_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    conversationScope: normalizeConversationScope(row.conversation_scope),
    senderId: row.sender_id,
    senderType: row.sender_type,
    senderName: row.sender_name ?? undefined,
    msgType: row.msg_type,
    text: row.text,
    createTime: Number(row.create_time),
    updateTime: row.update_time == null ? undefined : Number(row.update_time),
    cardContentVersion: normalizeCardContentVersion(row.card_content_version),
    cardObservedAt: normalizeCardContentVersion(row.card_content_version) === 1 ? normalizeVersion(row.card_observed_at) : undefined,
    resourceRefs,
    ...(parseMentions(row.mentions) ? { mentions: parseMentions(row.mentions) } : {}),
    ...(typeof row.raw_text === 'string' ? { rawText: row.raw_text } : {}),
    sourceAppId: row.source_app_id,
    deleted: Number(row.deleted) === 1,
    deletedAt: row.deleted_at == null ? undefined : Number(row.deleted_at),
    isLatest: Number(row.revision) === latestRevision,
    observedAt: Number(row.observed_at),
  };
}

/** 平台版本号：只接受正数毫秒时间戳，其它一律当「未知」。 */
function normalizeVersion(value: unknown): number | undefined {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizeConversationScope(value: unknown): GroupContextConversationScope | undefined {
  return value === 'main' || value === 'thread' ? value : undefined;
}

function normalizeCardContentVersion(value: unknown): number | undefined {
  return value === 1 ? value : undefined;
}

/** 只补元数据，不改正文、不改 seq；正文投影标记只能来自同正文且未过期的观察。 */
function enrichLatestRow(db: DatabaseSyncLike, prev: any, incoming: GroupContextMessageInput, sameCurrentContent: boolean): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const fill = (col: string, current: unknown, next: unknown) => {
    if ((current == null || current === '') && typeof next === 'string' && next.length > 0) {
      sets.push(`${col} = ?`);
      params.push(next);
    }
  };
  fill('sender_name', prev.sender_name, incoming.senderName);
  if (sameCurrentContent) {
    fill('root_id', prev.root_id, incoming.rootId);
    fill('thread_id', prev.thread_id, incoming.threadId);
    fill('parent_id', prev.parent_id, incoming.parentId);
    fill('conversation_scope', prev.conversation_scope, normalizeConversationScope(incoming.conversationScope));
  }
  // 版本号只补空缺或往前推，绝不回退（同正文而版本更新 = 平台记了一次无文本变化的编辑）。
  const incomingVersion = normalizeVersion(incoming.updateTime);
  const prevVersion = normalizeVersion(prev.update_time);
  if (incomingVersion !== undefined && (prevVersion === undefined || incomingVersion > prevVersion)) {
    sets.push('update_time = ?');
    params.push(incomingVersion);
  }
  const cardContentVersion = normalizeCardContentVersion(incoming.cardContentVersion);
  if (sameCurrentContent && normalizeCardContentVersion(prev.card_content_version) === undefined && cardContentVersion !== undefined) {
    sets.push('card_content_version = ?');
    params.push(cardContentVersion);
  }
  const cardObservedAt = cardContentVersion === 1 ? normalizeVersion(incoming.cardObservedAt) : undefined;
  const previousCardObservedAt = normalizeVersion(prev.card_observed_at);
  if (sameCurrentContent && cardObservedAt !== undefined
      && (previousCardObservedAt === undefined || cardObservedAt < previousCardObservedAt)) {
    sets.push('card_observed_at = ?');
    params.push(cardObservedAt);
  }
  if (sets.length === 0) return;
  params.push(Number(prev.seq));
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE seq = ?`).run(...params);
}

function latestRow(db: DatabaseSyncLike, chatId: string, messageId: string): any | undefined {
  return db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND message_id = ? ORDER BY revision DESC LIMIT 1',
  ).get(chatId, messageId) as any | undefined;
}

/** Older journals could drop routing when an edit omitted it. Recover that
 * retained evidence before writing another revision; do not guess from root. */
function knownConversationMetadata(db: DatabaseSyncLike, prev: any | undefined): Pick<GroupContextMessageInput,
  'conversationScope' | 'rootId' | 'threadId' | 'parentId'> {
  const known = {
    conversationScope: normalizeConversationScope(prev?.conversation_scope) ?? (prev?.thread_id ? 'thread' as const : undefined),
    rootId: prev?.root_id || undefined,
    threadId: prev?.thread_id || undefined,
    parentId: prev?.parent_id || undefined,
  };
  if (!prev || Number(prev.revision) === 0) return known;
  const earlier = db.prepare(`
    SELECT conversation_scope, root_id, thread_id, parent_id FROM messages
    WHERE chat_id = ? AND message_id = ? AND revision < ? ORDER BY revision DESC
  `).all(prev.chat_id, prev.message_id, Number(prev.revision)) as any[];
  for (const row of earlier) {
    // First proven origin wins, including a lobby starter that becomes a topic.
    known.conversationScope = normalizeConversationScope(row.conversation_scope)
      ?? (row.thread_id ? 'thread' : undefined) ?? known.conversationScope;
    known.rootId ||= row.root_id || undefined;
    known.threadId ||= row.thread_id || undefined;
    known.parentId ||= row.parent_id || undefined;
  }
  return known;
}

/**
 * 写入一条观察到的消息。同 messageId 同正文 → 不分配新 seq（inserted=false）；
 * 正文/附件/删除状态变化 → 新 revision + 新 seq。
 */
export function upsertGroupContextMessage(
  larkAppId: string,
  message: GroupContextMessageInput,
  retention: RetentionOptions = {},
): UpsertResult {
  const messageId = requireNonEmpty(message.messageId, 'messageId');
  const chatId = requireNonEmpty(message.chatId, 'chatId');
  const handle = open(larkAppId);
  const { db } = handle;
  const hash = contentHash(message);
  const now = retention.now ?? Date.now();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const prev = latestRow(db, chatId, messageId);
    const knownConversation = knownConversationMetadata(db, prev);
    const incomingVersion = normalizeVersion(message.updateTime);
    const prevVersion = prev ? normalizeVersion(prev.update_time) : undefined;
    // 版本新旧只约束「正文」。撤回（deleted=true）压过任何正文版本：撤回事件本身不带编辑时间，
    // markGroupContextMessageDeleted 复制的是读到的旧版本号，若此时另一 writer 刚写入更新的
    // 正文，按版本拒绝就会把撤回弄丢。tombstone 一旦写入即终态（上面的 b 分支守住）。
    const staleVersion = !message.deleted
      && incomingVersion !== undefined && prevVersion !== undefined && incomingVersion < prevVersion;
    // 同一平台版本（create_time 与 update_time 都相同）、附件与删除状态相同，正文只差
    // `@名字` 的呈现形式（实时事件把 @_user_N 解析成 @名字，history 回读则整个丢掉）——
    // 这是同一条消息的两种表示，不是用户编辑；真实编辑必然带新的 update_time。
    const prevMentions = parseMentions(prev?.mentions);
    const representationalDuplicate = !!prev && !message.deleted && Number(prev.deleted) === 0
      && prev.content_hash !== hash
      && prev.msg_type === (message.msgType ?? 'unknown')
      && Number(prev.create_time) === Math.trunc(Number(message.createTime) || 0)
      && sameGroupContextPlatformVersion(Math.trunc(Number(message.createTime) || 0), prevVersion, incomingVersion)
      && JSON.stringify(message.resourceRefs ?? []) === String(prev.resource_refs ?? '[]')
      && groupContextRepresentationsMatch(
        { msgType: String(prev.msg_type), text: String(prev.text ?? ''), mentions: prevMentions, ...(typeof prev.raw_text === 'string' ? { rawText: prev.raw_text } : {}) },
        { msgType: message.msgType, text: message.text ?? '', mentions: message.mentions, ...(message.rawText !== undefined ? { rawText: message.rawText } : {}) });
    if (prev && (prev.content_hash === hash || representationalDuplicate || (Number(prev.deleted) === 1 && !message.deleted) || staleVersion)) {
      // 三种情况都不分配新 seq：
      //  a) 同正文重复（飞书重推 / history 回填与实时事件重叠）；
      //  b) 已有 tombstone，又来了一条「未删除」形态（history 旧数据、乱序到达的原消息）——
      //     撤回是终态，绝不被旧数据复活；
      //  c) 双方都带平台 update_time 且来的这条更旧（乱序编辑 / 过期回填）——拒绝回退正文。
      //     任一方没有版本号就无法消歧，不走这里，按到达顺序追加（不伪造版本）。
      // 但 history 回填可能带来实时事件缺的元数据（senderName、root/thread/parent），
      // 原地补全到最新 revision 上，不制造无意义 revision。
      enrichLatestRow(db, prev, {
        ...message,
        conversationScope: knownConversation.conversationScope ?? message.conversationScope,
        rootId: message.rootId || knownConversation.rootId,
        threadId: message.threadId || knownConversation.threadId,
        parentId: message.parentId || knownConversation.parentId,
      }, (prev.content_hash === hash || representationalDuplicate) && !staleVersion);
      // 保留带结构化 mentions 的那份表示（信息更完整），原地替换，不分配新 seq / revision；
      // 同身份只是显示名变了（@Alice → @Alice Example）也只刷新显示文本。原文与身份
      // 一起进 content_hash，所以不会把不同目标的同名 @ 当成同一条。
      if (representationalDuplicate && message.mentions?.length) {
        db.prepare('UPDATE messages SET text = ?, content_hash = ?, mentions = ?, raw_text = COALESCE(?, raw_text) WHERE chat_id = ? AND message_id = ? AND revision = ?')
          .run(message.text ?? '', hash, serializeMentions(message.mentions), message.rawText ?? null, chatId, messageId, Number(prev.revision));
      } else if (representationalDuplicate && message.rawText !== undefined && typeof prev.raw_text !== 'string') {
        db.prepare('UPDATE messages SET raw_text = ? WHERE chat_id = ? AND message_id = ? AND revision = ?')
          .run(message.rawText, chatId, messageId, Number(prev.revision));
      } else if (prev.content_hash === hash && message.mentions?.length && (message.text !== String(prev.text ?? '') || !prevMentions)) {
        // Same body and identities (the hash covers both): only the rendering of
        // the display names differs, so refresh the rendering in place.
        db.prepare('UPDATE messages SET text = ?, mentions = ? WHERE chat_id = ? AND message_id = ? AND revision = ?')
          .run(message.text ?? '', serializeMentions(message.mentions), chatId, messageId, Number(prev.revision));
      }
      db.exec('COMMIT;');
      return { seq: Number(prev.seq), revision: Number(prev.revision), inserted: false };
    }
    const revision = prev ? Number(prev.revision) + 1 : 0;
    const res = db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, revision, root_id, thread_id, parent_id, conversation_scope,
        sender_id, sender_type, sender_name, msg_type, text, create_time, update_time, card_content_version, card_observed_at,
        resource_refs, mentions, raw_text, source_app_id, deleted, deleted_at, content_hash, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId, messageId, revision,
      message.rootId || knownConversation.rootId || null, message.threadId || knownConversation.threadId || null, message.parentId || knownConversation.parentId || null,
      knownConversation.conversationScope ?? normalizeConversationScope(message.conversationScope) ?? null,
      message.senderId ?? '', message.senderType ?? 'unknown', message.senderName ?? null,
      message.msgType ?? 'unknown', message.text ?? '', Math.trunc(Number(message.createTime) || 0),
      incomingVersion ?? null,
      normalizeCardContentVersion(message.cardContentVersion) ?? null,
      message.cardContentVersion === 1 ? normalizeVersion(message.cardObservedAt) ?? null : null,
      JSON.stringify(message.resourceRefs ?? []), serializeMentions(message.mentions), message.rawText ?? null, message.sourceAppId ?? larkAppId,
      message.deleted ? 1 : 0, message.deletedAt ?? null, hash, now,
    );
    db.exec('COMMIT;');
    const seq = Number(res.lastInsertRowid);
    handle.insertsSinceAutoPrune += 1;
    if (handle.insertsSinceAutoPrune >= AUTO_PRUNE_EVERY || retention.maxRows !== undefined) {
      handle.insertsSinceAutoPrune = 0;
      try { pruneGroupContext(larkAppId, chatId, { ...retention, now }); } catch (err) {
        logger.warn(`[group-context-store] auto prune failed app=${larkAppId} chat=${chatId}: ${err}`);
      }
    }
    return { seq, revision, inserted: true };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    throw err;
  }
}

/** 撤回 / 删除：追加 tombstone revision。从未观察到的消息写入占位 tombstone。 */
export function markGroupContextMessageDeleted(
  larkAppId: string,
  chatId: string,
  messageId: string,
  opts: { deletedAt?: number; sourceAppId?: string } = {},
): UpsertResult {
  requireNonEmpty(messageId, 'messageId');
  requireNonEmpty(chatId, 'chatId');
  const { db } = open(larkAppId);
  const prev = latestRow(db, chatId, messageId);
  const base: GroupContextMessageInput = prev
    ? { ...rowToRecord(prev, Number(prev.revision)) }
    : {
      messageId, chatId, senderId: '', senderType: 'unknown', msgType: 'unknown', text: '',
      createTime: opts.deletedAt ?? Date.now(), resourceRefs: [], sourceAppId: opts.sourceAppId ?? larkAppId,
    };
  // 不带上读到的 updateTime：撤回没有自己的编辑版本，复制旧快照只会在并发写入时被当成
  //「过期正文」。版本号留空，tombstone 行的 update_time 为 NULL（= 未知版本）。
  const { updateTime: _ignored, ...withoutVersion } = base;
  return upsertGroupContextMessage(larkAppId, {
    ...withoutVersion,
    deleted: true,
    deletedAt: opts.deletedAt ?? base.deletedAt ?? Date.now(),
  });
}

function chatMeta(db: DatabaseSyncLike, chatId: string): { prunedThroughSeq: number; prunedCount: number } {
  const row = db.prepare('SELECT pruned_through_seq, pruned_count FROM chat_meta WHERE chat_id = ?').get(chatId) as any;
  return {
    prunedThroughSeq: Number(row?.pruned_through_seq ?? 0),
    prunedCount: Number(row?.pruned_count ?? 0),
  };
}

export function listGroupContextMessages(larkAppId: string, chatId: string, opts: ListOptions = {}): ListResult {
  requireNonEmpty(chatId, 'chatId');
  const { db } = open(larkAppId);
  const afterSeq = Math.max(0, Math.trunc(Number(opts.afterSeq) || 0));
  let limit = Math.trunc(Number(opts.limit) || 0);
  if (limit <= 0) limit = DEFAULT_LIST_LIMIT;
  if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;

  const where: string[] = ['m.chat_id = ?', 'm.seq > ?'];
  const params: unknown[] = [chatId, afterSeq];
  if (opts.throughSeq !== undefined) { where.push('m.seq <= ?'); params.push(Math.trunc(Number(opts.throughSeq) || 0)); }
  if (opts.beforeCreateTime !== undefined) { where.push('m.create_time < ?'); params.push(Math.trunc(Number(opts.beforeCreateTime) || 0)); }
  if (opts.rootId !== undefined) { where.push('m.root_id = ?'); params.push(opts.rootId); }

  const rows = db.prepare(`
    SELECT m.*, (
      SELECT MAX(revision) FROM messages x WHERE x.chat_id = m.chat_id AND x.message_id = m.message_id
    ) AS latest_revision
    FROM messages m
    WHERE ${where.join(' AND ')}
    ORDER BY m.seq ASC
    LIMIT ?
  `).all(...params, limit + 1) as any[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = page.map(r => rowToRecord(r, Number(r.latest_revision)));
  const throughSeq = messages.length > 0 ? messages[messages.length - 1].seq : afterSeq;

  const meta = chatMeta(db, chatId);
  const retentionGap = meta.prunedCount > 0 && afterSeq < meta.prunedThroughSeq
    ? { prunedThroughSeq: meta.prunedThroughSeq, prunedCount: meta.prunedCount }
    : undefined;

  return { messages, hasMore, throughSeq, ...(retentionGap ? { retentionGap } : {}) };
}

export function getGroupContextHead(larkAppId: string, chatId: string): GroupContextHead {
  requireNonEmpty(chatId, 'chatId');
  const { db } = open(larkAppId);
  const row = db.prepare(
    'SELECT MAX(seq) AS head_seq, MIN(seq) AS oldest_seq, COUNT(*) AS cnt, MAX(create_time) AS newest_ctime FROM messages WHERE chat_id = ?',
  ).get(chatId) as any;
  const meta = chatMeta(db, chatId);
  const count = Number(row?.cnt ?? 0);
  return {
    headSeq: Number(row?.head_seq ?? 0),
    count,
    oldestSeq: Number(row?.oldest_seq ?? 0),
    newestCreateTime: count > 0 && row?.newest_ctime != null ? Number(row.newest_ctime) : undefined,
    prunedThroughSeq: meta.prunedThroughSeq,
    prunedCount: meta.prunedCount,
  };
}

/** 最新 revision；没有记录返回 undefined。 */
export function getGroupContextMessage(larkAppId: string, chatId: string, messageId: string): GroupContextMessageRecord | undefined {
  requireNonEmpty(chatId, 'chatId');
  requireNonEmpty(messageId, 'messageId');
  const { db } = open(larkAppId);
  const row = latestRow(db, chatId, messageId);
  return row ? rowToRecord(row, Number(row.revision)) : undefined;
}

/** 消息的「有效时间」：创建、已知编辑、撤回里最晚的一个。淘汰只按它排序，不按 seq。 */
const EFFECTIVE_TIME_SQL = 'MAX(create_time, COALESCE(update_time, 0), COALESCE(deleted_at, 0))';

/**
 * 按 maxAgeMs / maxRows 淘汰**聊天时间最旧**的记录，并把淘汰区间记入 chat_meta。
 *
 * seq 只表示接收 / 修订顺序：history 回填是新→旧返回的，迟到的老消息会拿到更大的 seq，
 * 所以 seq 既不能当聊天新旧用，也不能当容量淘汰的依据。这里按有效时间
 * （max(createTime, updateTime, deletedAt)）升序删，seq 只作同时间的稳定 tie-break。
 * prunedThroughSeq 记录的是「被淘汰记录里最大的 seq」= 有缺口的最大序号：
 * <= 它的区间**可能**不完整，不表示更小的序号全没了。
 */
export function pruneGroupContext(larkAppId: string, chatId: string, opts: RetentionOptions = {}): PruneResult {
  requireNonEmpty(chatId, 'chatId');
  const { db } = open(larkAppId);
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxRows = Math.max(1, Math.trunc(opts.maxRows ?? DEFAULT_MAX_ROWS));
  const cutoffTime = now - maxAgeMs;

  db.exec('BEGIN IMMEDIATE;');
  try {
    let prunedThroughSeq = 0;
    let prunedCount = 0;
    // 1) 按年龄：有效时间早于 cutoff 的全部淘汰
    const aged = db.prepare(
      `SELECT MAX(seq) AS s, COUNT(*) AS c FROM messages WHERE chat_id = ? AND ${EFFECTIVE_TIME_SQL} < ?`,
    ).get(chatId, cutoffTime) as any;
    if (Number(aged?.c ?? 0) > 0) {
      db.prepare(`DELETE FROM messages WHERE chat_id = ? AND ${EFFECTIVE_TIME_SQL} < ?`).run(chatId, cutoffTime);
      prunedThroughSeq = Math.max(prunedThroughSeq, Number(aged.s));
      prunedCount += Number(aged.c);
    }
    // 2) 按条数：超出 maxRows 的部分按有效时间最旧淘汰（seq 作 tie-break）
    const total = Number((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?').get(chatId) as any)?.c ?? 0);
    if (total > maxRows) {
      const excess = total - maxRows;
      const victims = `SELECT seq FROM messages WHERE chat_id = ? ORDER BY ${EFFECTIVE_TIME_SQL} ASC, seq ASC LIMIT ?`;
      const stat = db.prepare(`SELECT MAX(seq) AS s, COUNT(*) AS c FROM (${victims})`).get(chatId, excess) as any;
      if (Number(stat?.c ?? 0) > 0) {
        db.prepare(`DELETE FROM messages WHERE chat_id = ? AND seq IN (${victims})`).run(chatId, chatId, excess);
        prunedThroughSeq = Math.max(prunedThroughSeq, Number(stat.s));
        prunedCount += Number(stat.c);
      }
    }
    if (prunedCount > 0) {
      const meta = chatMeta(db, chatId);
      db.prepare(`
        INSERT INTO chat_meta (chat_id, pruned_through_seq, pruned_count) VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET pruned_through_seq = excluded.pruned_through_seq, pruned_count = excluded.pruned_count
      `).run(chatId, Math.max(meta.prunedThroughSeq, prunedThroughSeq), meta.prunedCount + prunedCount);
      prunedThroughSeq = Math.max(meta.prunedThroughSeq, prunedThroughSeq);
    } else {
      prunedThroughSeq = chatMeta(db, chatId).prunedThroughSeq;
    }
    db.exec('COMMIT;');
    return { prunedCount, prunedThroughSeq };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    throw err;
  }
}

/** 关闭并清空进程内句柄（测试 / 模拟重启用）。 */
export function _resetGroupContextStoreForTest(): void {
  for (const h of handles.values()) {
    try { h.db.close(); } catch { /* ignore */ }
  }
  handles.clear();
}
