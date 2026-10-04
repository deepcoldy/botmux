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
 *  - 淘汰有界（默认 30 天 / 10000 条每群），并把被淘汰的区间记在 chat_meta 里，
 *    list 在游标落在淘汰区时显式返回 `retentionGap`，绝不默默当作完整记录。
 *  - SQLite（sqlite-compat，Node/Bun 双引擎）+ busy_timeout + WAL：多个 daemon 进程
 *    （一个 app 一个进程）各写各的 app 文件；`botmux send` 一类子进程若回填自己的
 *    发送回执，与 daemon 并发写同一文件也靠 SQLite 串行化，不走 JSON 多进程覆盖。
 *  - ID 保留身份域：senderId 是观察方 app 视角下的 open_id/app_id，sourceAppId 记录
 *    观察视角；不把 open_id 当跨 app 的全局身份。
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

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
  /** 观察方 app 视角下的发送者 id（open_id 或 bot 的 app_id）。 */
  senderId: string;
  senderType: GroupContextSenderType;
  senderName?: string;
  msgType: string;
  /** 解析后的纯文本 / 卡片摘要（含 [图片 N] 占位）。 */
  text: string;
  /** 毫秒时间戳。 */
  createTime: number;
  /** 附件只存引用，不存内容。 */
  resourceRefs: GroupContextResourceRef[];
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
  /** 该 chat 已淘汰到的最大 seq（含）。 */
  prunedThroughSeq: number;
  /** 累计淘汰条数。 */
  prunedCount: number;
}

export interface ListResult {
  messages: GroupContextMessageRecord[];
  hasMore: boolean;
  /** 本页最后一条 seq；空页时等于 afterSeq（或 0），可直接作为下一页游标。 */
  throughSeq: number;
  /** 游标（afterSeq）落在已淘汰区间内时给出，告知读方记录不完整。 */
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
const SCHEMA_VERSION = 1;

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
  mkdirSync(join(path, '..'), { recursive: true });
  const db = openDatabaseSyncOrThrow(path);
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
  if (version === SCHEMA_VERSION) return;
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
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    throw err;
  }
}

function contentHash(input: Pick<GroupContextMessageInput, 'text' | 'msgType' | 'resourceRefs' | 'deleted'>): string {
  const h = createHash('sha1');
  h.update(input.msgType);
  h.update('\u0000');
  h.update(input.text);
  h.update('\u0000');
  h.update(JSON.stringify(input.resourceRefs ?? []));
  h.update('\u0000');
  h.update(input.deleted ? '1' : '0');
  return h.digest('hex');
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`group-context: ${field} is required`);
  return value;
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
    senderId: row.sender_id,
    senderType: row.sender_type,
    senderName: row.sender_name ?? undefined,
    msgType: row.msg_type,
    text: row.text,
    createTime: Number(row.create_time),
    resourceRefs,
    sourceAppId: row.source_app_id,
    deleted: Number(row.deleted) === 1,
    deletedAt: row.deleted_at == null ? undefined : Number(row.deleted_at),
    isLatest: Number(row.revision) === latestRevision,
    observedAt: Number(row.observed_at),
  };
}

function latestRow(db: DatabaseSyncLike, chatId: string, messageId: string): any | undefined {
  return db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND message_id = ? ORDER BY revision DESC LIMIT 1',
  ).get(chatId, messageId) as any | undefined;
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
    if (prev && prev.content_hash === hash) {
      db.exec('COMMIT;');
      return { seq: Number(prev.seq), revision: Number(prev.revision), inserted: false };
    }
    const revision = prev ? Number(prev.revision) + 1 : 0;
    const res = db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, revision, root_id, thread_id, parent_id,
        sender_id, sender_type, sender_name, msg_type, text, create_time,
        resource_refs, source_app_id, deleted, deleted_at, content_hash, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId, messageId, revision,
      message.rootId || null, message.threadId || null, message.parentId || null,
      message.senderId ?? '', message.senderType ?? 'unknown', message.senderName ?? null,
      message.msgType ?? 'unknown', message.text ?? '', Math.trunc(Number(message.createTime) || 0),
      JSON.stringify(message.resourceRefs ?? []), message.sourceAppId ?? larkAppId,
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
  return upsertGroupContextMessage(larkAppId, {
    ...base,
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

/**
 * 按 maxAgeMs / maxRows 淘汰最旧记录（按 seq 顺序），并把淘汰区间记入 chat_meta。
 * 淘汰以整条 messageId 的 revision 行为单位，不保证一条消息的所有 revision 同时淘汰——
 * 读方只认 seq 游标，旧 revision 先走是预期行为。
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
    // 1) 按年龄：create_time 早于 cutoff 的全部淘汰
    const aged = db.prepare('SELECT MAX(seq) AS s, COUNT(*) AS c FROM messages WHERE chat_id = ? AND create_time < ?').get(chatId, cutoffTime) as any;
    let prunedThroughSeq = 0;
    let prunedCount = 0;
    if (Number(aged?.c ?? 0) > 0) {
      db.prepare('DELETE FROM messages WHERE chat_id = ? AND create_time < ?').run(chatId, cutoffTime);
      prunedThroughSeq = Math.max(prunedThroughSeq, Number(aged.s));
      prunedCount += Number(aged.c);
    }
    // 2) 按条数：超出 maxRows 的部分按 seq 最旧淘汰
    const total = Number((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?').get(chatId) as any)?.c ?? 0);
    if (total > maxRows) {
      const excess = total - maxRows;
      const boundary = db.prepare(
        'SELECT seq FROM messages WHERE chat_id = ? ORDER BY seq ASC LIMIT 1 OFFSET ?',
      ).get(chatId, excess - 1) as any;
      if (boundary?.seq != null) {
        db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq <= ?').run(chatId, Number(boundary.seq));
        prunedThroughSeq = Math.max(prunedThroughSeq, Number(boundary.seq));
        prunedCount += excess;
      }
    }
    if (prunedCount > 0) {
      const meta = chatMeta(db, chatId);
      // 淘汰区间只会往前推：年龄淘汰可能删到比条数边界更晚的 seq，取两者最大。
      // 但中间若有未被删的更早 seq（年龄淘汰跳过的），后续 list 仍能读到它们——
      // gap 语义是「<= prunedThroughSeq 的区间不完整」，不是「全部缺失」。
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
