/**
 * 决策看板的持久层：`<dataDir>/decision-board.sqlite`，整机一个文件，按 app_id（管家 bot 的
 * larkAppId）分区；附图按 sha256 存在 `<dataDir>/decision-board/<app_id>/files/`。
 *
 * 写法照 grants.sqlite：WAL + busy_timeout，建表与版本判定在同一把写锁里。只有管家 bot
 * 自己的 daemon 会打开它（Dashboard 与 CLI 都经 daemon IPC），所以同一 app_id 的写入天然
 * 串行；多个管家 daemon 共用文件时由 SQLite 事务串行化。
 *
 * 第一次有人用看板时才打开 / 创建（见 decision-board/service.ts 的懒加载），没开管家的
 * 机器磁盘上不多任何文件。
 *
 * 不清理附件、不限历史条数：看板是给人读的台账，规模由人维护的事项数决定（几十到几百项）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike, type StatementLike } from './sqlite-compat.js';
import type { Locale } from '../i18n/types.js';
import {
  BOARD_LIMITS,
  BOARD_STATE_LABELS,
  type BoardActor,
  type BoardBatch,
  type BoardDecision,
  type BoardDraft,
  type BoardEvent,
  type BoardEventKind,
  type BoardFile,
  type BoardItem,
  type BoardLink,
  type BoardOption,
  type BoardState,
  type BoardView,
  isBoardState,
  stateInView,
} from '../core/decision-board/model.js';

export const decisionBoardDbPath = (dataDir: string): string => join(dataDir, 'decision-board.sqlite');
export const decisionBoardFilesDir = (dataDir: string, appId: string): string =>
  join(dataDir, 'decision-board', appId, 'files');

const SCHEMA_VERSION = 1;

/** 管家写入的字段补丁。undefined = 不动；null = 清空（仅可选字段）。 */
export interface ItemPatch {
  title?: string;
  key?: string;
  state?: BoardState;
  stage?: string | null;
  kind?: string | null;
  repo?: string | null;
  summary?: string | null;
  progress?: string | null;
  question?: string | null;
  options?: BoardOption[];
  recommend?: string | null;
  recommendReason?: string | null;
  links?: BoardLink[];
  note?: string;
}

export interface ItemSummary extends BoardItem {
  links: BoardLink[];
  hasDraft: boolean;
  pendingDecisions: number;
  /** 管家在 owner 上次打开详情之后写过东西。 */
  unseen: boolean;
}

export interface ItemDetail {
  item: BoardItem;
  links: BoardLink[];
  events: BoardEvent[];
  files: BoardFile[];
  draft?: BoardDraft;
  pendingDecisions: BoardDecision[];
}

export interface SubmitInput {
  /** 草稿归属（Dashboard 固定为 'owner'：一张看板一份草稿，飞书侧栏与电脑上看到的是同一份）。 */
  author: string;
  /** 实际点提交的人（'local' 或 'u:<union_id>'），记进批次和历史；缺省同 author。 */
  submitter?: string;
  authorName?: string;
  nonce: string;
  /** 只提交这些项；每项带 Dashboard 看到的草稿更新时间，草稿在别的标签页被改过就拒绝。 */
  items: Array<{ seq: number; draftUpdatedAt: number }>;
}

export class BoardError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'BoardError';
  }
}

interface ItemRow {
  seq: number; item_key: string | null; title: string; state: string; stage: string | null;
  kind: string | null; repo: string | null; summary: string | null; progress: string | null;
  question: string | null; options_json: string; recommend: string | null; recommend_reason: string | null;
  rev: number; created_at: number; updated_at: number; state_at: number;
  steward_event_at: number | null; owner_seen_at: number | null;
}

function rowToItem(r: ItemRow): BoardItem {
  let options: BoardOption[] = [];
  try {
    const parsed = JSON.parse(r.options_json);
    if (Array.isArray(parsed)) options = parsed as BoardOption[];
  } catch { /* 损坏的行按无选项处理 */ }
  return {
    seq: r.seq,
    ...(r.item_key ? { key: r.item_key } : {}),
    title: r.title,
    state: isBoardState(r.state) ? r.state : 'active',
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.repo ? { repo: r.repo } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.progress ? { progress: r.progress } : {}),
    ...(r.question ? { question: r.question } : {}),
    options,
    ...(r.recommend ? { recommend: r.recommend } : {}),
    ...(r.recommend_reason ? { recommendReason: r.recommend_reason } : {}),
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stateAt: r.state_at,
    ...(r.steward_event_at ? { stewardEventAt: r.steward_event_at } : {}),
    ...(r.owner_seen_at ? { ownerSeenAt: r.owner_seen_at } : {}),
  };
}

function parseIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function checkLen(field: string, value: string | null | undefined, max: number): void {
  if (typeof value === 'string' && value.length > max) {
    throw new BoardError('field_too_long', `${field} 太长（上限 ${max} 字）`);
  }
}

const FILE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
};

export class DecisionBoardStore {
  private readonly statements = new Map<string, StatementLike>();

  private constructor(private readonly db: DatabaseSyncLike, private readonly dataDir: string) {}

  static open(dataDir: string): DecisionBoardStore {
    const path = decisionBoardDbPath(dataDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = openDatabaseSyncOrThrow(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      db.exec('BEGIN IMMEDIATE;');
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
      if (version > SCHEMA_VERSION) {
        throw new Error(`decision board store ${path} has schema v${version}, newer than this botmux (v${SCHEMA_VERSION})`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS board_items (
          app_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          item_key TEXT,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          stage TEXT,
          kind TEXT,
          repo TEXT,
          summary TEXT,
          progress TEXT,
          question TEXT,
          options_json TEXT NOT NULL DEFAULT '[]',
          recommend TEXT,
          recommend_reason TEXT,
          rev INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          state_at INTEGER NOT NULL,
          steward_event_at INTEGER,
          owner_seen_at INTEGER,
          PRIMARY KEY (app_id, seq)
        ) WITHOUT ROWID;
        CREATE UNIQUE INDEX IF NOT EXISTS board_items_key ON board_items(app_id, item_key) WHERE item_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS board_links (
          app_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, seq, kind, ref)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS board_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          actor_ref TEXT,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          file_ids_json TEXT,
          batch_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS board_events_item ON board_events(app_id, seq, id);
        CREATE TABLE IF NOT EXISTS board_files (
          app_id TEXT NOT NULL,
          id TEXT NOT NULL,
          seq INTEGER,
          sha256 TEXT NOT NULL,
          mime TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          name TEXT NOT NULL,
          uploader TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS board_drafts (
          app_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          author TEXT NOT NULL,
          choice TEXT,
          text TEXT NOT NULL,
          file_ids_json TEXT NOT NULL DEFAULT '[]',
          base_rev INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, seq, author)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS board_batches (
          app_id TEXT NOT NULL,
          id INTEGER NOT NULL,
          author TEXT NOT NULL,
          author_name TEXT,
          nonce TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          delivery TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          turn_id TEXT,
          delivered_at INTEGER,
          error TEXT,
          PRIMARY KEY (app_id, id)
        ) WITHOUT ROWID;
        CREATE UNIQUE INDEX IF NOT EXISTS board_batches_nonce ON board_batches(app_id, nonce);
        CREATE TABLE IF NOT EXISTS board_decisions (
          app_id TEXT NOT NULL,
          batch_id INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          choice TEXT,
          text TEXT NOT NULL,
          file_ids_json TEXT NOT NULL DEFAULT '[]',
          item_rev INTEGER NOT NULL,
          handled_at INTEGER,
          PRIMARY KEY (app_id, batch_id, seq)
        ) WITHOUT ROWID;
      `);
      if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      db.exec('COMMIT;');
      return new DecisionBoardStore(db, dataDir);
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no transaction */ }
      try { db.close(); } catch { /* preserve the initialization error */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private stmt(sql: string): StatementLike {
    let s = this.statements.get(sql);
    if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s); }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      this.db.exec('COMMIT;');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  // ─── 事项 ───────────────────────────────────────────────────────────────

  private itemRow(appId: string, seq: number): ItemRow | undefined {
    return this.stmt('SELECT * FROM board_items WHERE app_id = ? AND seq = ?').get(appId, seq) as ItemRow | undefined;
  }

  /** `12` / `#12` / key → seq；找不到返回 undefined。 */
  resolveSeq(appId: string, ref: { seq: number } | { key: string }): number | undefined {
    if ('seq' in ref) return this.itemRow(appId, ref.seq) ? ref.seq : undefined;
    const row = this.stmt('SELECT seq FROM board_items WHERE app_id = ? AND item_key = ?').get(appId, ref.key) as { seq: number } | undefined;
    return row?.seq;
  }

  getItem(appId: string, seq: number): BoardItem | undefined {
    const row = this.itemRow(appId, seq);
    return row ? rowToItem(row) : undefined;
  }

  private insertEvent(appId: string, seq: number, at: number, actor: BoardActor, actorRef: string | undefined,
    kind: BoardEventKind, text: string, fileIds: string[] = [], batchId?: number): number {
    const r = this.stmt(`INSERT INTO board_events (app_id, seq, at, actor, actor_ref, kind, text, file_ids_json, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(appId, seq, at, actor, actorRef ?? null, kind, text,
      fileIds.length ? JSON.stringify(fileIds) : null, batchId ?? null);
    if (actor === 'steward') {
      this.stmt('UPDATE board_items SET steward_event_at = ? WHERE app_id = ? AND seq = ?').run(at, appId, seq);
    }
    return Number(r.lastInsertRowid);
  }

  private validatePatch(patch: ItemPatch): void {
    checkLen('标题', patch.title, BOARD_LIMITS.title);
    checkLen('key', patch.key, BOARD_LIMITS.ref);
    checkLen('阶段', patch.stage, BOARD_LIMITS.shortText);
    checkLen('类型', patch.kind, BOARD_LIMITS.shortText);
    checkLen('仓库', patch.repo, BOARD_LIMITS.shortText);
    checkLen('一句话说明', patch.summary, BOARD_LIMITS.shortText * 2);
    checkLen('当前进展', patch.progress, BOARD_LIMITS.longText);
    checkLen('待拍板问题', patch.question, BOARD_LIMITS.longText);
    checkLen('推荐理由', patch.recommendReason, BOARD_LIMITS.longText);
    checkLen('历史', patch.note, BOARD_LIMITS.note);
    if (patch.options && patch.options.length > BOARD_LIMITS.optionCount) {
      throw new BoardError('too_many_options', `选项最多 ${BOARD_LIMITS.optionCount} 个`);
    }
    if (patch.options) {
      const keys = new Set<string>();
      for (const o of patch.options) {
        if (keys.has(o.key)) throw new BoardError('duplicate_option', `选项 ${o.key} 重复`);
        keys.add(o.key);
      }
    }
    if (patch.links && patch.links.length > BOARD_LIMITS.linksPerItem) {
      throw new BoardError('too_many_links', `关联对象最多 ${BOARD_LIMITS.linksPerItem} 个`);
    }
  }

  private addLinks(appId: string, seq: number, links: BoardLink[], at: number, actorRef?: string): number {
    let added = 0;
    for (const l of links) {
      const r = this.stmt(`INSERT INTO board_links (app_id, seq, kind, ref, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, seq, kind, ref) DO UPDATE SET label = COALESCE(excluded.label, board_links.label)`)
        .run(appId, seq, l.kind, l.ref, l.label ?? null, at);
      if (Number(r.changes) > 0) added++;
    }
    const count = (this.stmt('SELECT COUNT(*) AS n FROM board_links WHERE app_id = ? AND seq = ?').get(appId, seq) as { n: number }).n;
    if (count > BOARD_LIMITS.linksPerItem) throw new BoardError('too_many_links', `关联对象最多 ${BOARD_LIMITS.linksPerItem} 个`);
    if (links.length) {
      this.insertEvent(appId, seq, at, 'steward', actorRef, 'link',
        links.map(l => `${l.kind}=${l.ref}`).join('，'));
    }
    return added;
  }

  /**
   * 新建一项；带 key 且已存在时按 update 处理（管家不用记编号，同一件事反复 add 不会重复建）。
   */
  addItem(appId: string, patch: ItemPatch & { title: string }, actorRef?: string, now = Date.now(), locale: Locale = 'zh'):
    { item: BoardItem; created: boolean } {
    this.validatePatch(patch);
    if (!patch.title.trim()) throw new BoardError('title_required', '缺少标题');
    if (patch.key) {
      const existing = this.resolveSeq(appId, { key: patch.key });
      if (existing !== undefined) {
        return { item: this.updateItem(appId, existing, patch, actorRef, now, locale), created: false };
      }
    }
    return this.tx(() => {
      const next = ((this.stmt('SELECT MAX(seq) AS m FROM board_items WHERE app_id = ?').get(appId) as { m: number | null }).m ?? 0) + 1;
      const state: BoardState = patch.state ?? (patch.question ? 'decide' : 'active');
      this.stmt(`INSERT INTO board_items (app_id, seq, item_key, title, state, stage, kind, repo, summary, progress,
        question, options_json, recommend, recommend_reason, rev, created_at, updated_at, state_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        appId, next, patch.key ?? null, patch.title.trim(), state, patch.stage ?? null, patch.kind ?? null,
        patch.repo ?? null, patch.summary ?? null, patch.progress ?? null, patch.question ?? null,
        JSON.stringify(patch.options ?? []), patch.recommend ?? null, patch.recommendReason ?? null, now, now, now);
      this.insertEvent(appId, next, now, 'steward', actorRef, 'create', patch.note?.trim() || patch.title.trim());
      if (patch.links?.length) this.addLinks(appId, next, patch.links, now, actorRef);
      return { item: rowToItem(this.itemRow(appId, next)!), created: true };
    });
  }

  updateItem(appId: string, seq: number, patch: ItemPatch, actorRef?: string, now = Date.now(), locale: Locale = 'zh'): BoardItem {
    this.validatePatch(patch);
    return this.tx(() => {
      const row = this.itemRow(appId, seq);
      if (!row) throw new BoardError('item_not_found', `没有 #${seq}`);
      const before = rowToItem(row);
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, value: unknown) => { sets.push(`${col} = ?`); params.push(value); };
      let contentChanged = false;
      const textField = (col: string, next: string | null | undefined, prev: string | undefined) => {
        if (next === undefined) return false;
        const value = next === null || next.trim() === '' ? null : next;
        if ((value ?? undefined) === prev) return false;
        set(col, value);
        contentChanged = true;
        return true;
      };
      if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== before.title) {
        set('title', patch.title.trim()); contentChanged = true;
      }
      if (patch.key !== undefined && patch.key !== before.key) {
        const clash = this.resolveSeq(appId, { key: patch.key });
        if (clash !== undefined && clash !== seq) throw new BoardError('key_conflict', `key 已被 #${clash} 使用`);
        set('item_key', patch.key || null);
      }
      textField('stage', patch.stage, before.stage);
      textField('kind', patch.kind, before.kind);
      textField('repo', patch.repo, before.repo);
      textField('summary', patch.summary, before.summary);
      const progressChanged = textField('progress', patch.progress, before.progress);
      const questionChanged = textField('question', patch.question, before.question);
      let optionsChanged = false;
      if (patch.options !== undefined && JSON.stringify(patch.options) !== JSON.stringify(before.options)) {
        set('options_json', JSON.stringify(patch.options)); contentChanged = true; optionsChanged = true;
      }
      const recommendChanged = textField('recommend', patch.recommend, before.recommend);
      textField('recommend_reason', patch.recommendReason, before.recommendReason);
      let stateChanged = false;
      if (patch.state !== undefined && patch.state !== before.state) {
        set('state', patch.state); set('state_at', now); contentChanged = true; stateChanged = true;
      }
      if (sets.length) {
        if (contentChanged) { sets.push('rev = rev + 1'); }
        set('updated_at', now);
        this.stmt(`UPDATE board_items SET ${sets.join(', ')} WHERE app_id = ? AND seq = ?`).run(...params, appId, seq);
      }
      // 状态和待拍板内容的变化自动进历史，管家不用再手写一遍。状态名按管家自己的界面语言。
      if (stateChanged) {
        const labels = BOARD_STATE_LABELS[locale];
        this.insertEvent(appId, seq, now, 'steward', actorRef, 'state', `${labels[before.state]} → ${labels[patch.state!]}`);
      }
      if (questionChanged || optionsChanged || recommendChanged) {
        this.insertEvent(appId, seq, now, 'steward', actorRef, 'edit', '更新了待拍板的问题 / 选项');
      } else if (progressChanged) {
        this.insertEvent(appId, seq, now, 'steward', actorRef, 'edit', '更新了当前进展');
      }
      if (patch.links?.length) this.addLinks(appId, seq, patch.links, now, actorRef);
      if (patch.note?.trim()) this.insertEvent(appId, seq, now, 'steward', actorRef, 'note', patch.note.trim());
      return rowToItem(this.itemRow(appId, seq)!);
    });
  }

  /**
   * 管家追加一条历史；handled=true 时把这一项【最早一个未执行批次】里的决定标为已执行
   * （时间线上这条历史就是对那条决定的回复）。只标最早批次：同一事项连提多个批次时，
   * 管家按 pending 的批次顺序逐项处理，一条 --handled 不能把后面批次的决定连带标掉。
   */
  appendHistory(appId: string, seq: number, text: string, opts: { handled?: boolean; actorRef?: string; fileIds?: string[] } = {},
    now = Date.now()): { eventId: number; handled: number } {
    checkLen('历史', text, BOARD_LIMITS.note);
    if (!text.trim()) throw new BoardError('text_required', '历史内容不能为空');
    return this.tx(() => {
      if (!this.itemRow(appId, seq)) throw new BoardError('item_not_found', `没有 #${seq}`);
      const eventId = this.insertEvent(appId, seq, now, 'steward', opts.actorRef, opts.handled ? 'reply' : 'note',
        text.trim(), opts.fileIds ?? []);
      let handled = 0;
      if (opts.handled) {
        handled = Number(this.stmt(`UPDATE board_decisions SET handled_at = ?
          WHERE app_id = ? AND seq = ? AND handled_at IS NULL
            AND batch_id = (SELECT MIN(batch_id) FROM board_decisions
              WHERE app_id = ? AND seq = ? AND handled_at IS NULL)`)
          .run(now, appId, seq, appId, seq).changes);
      }
      this.stmt('UPDATE board_items SET updated_at = ? WHERE app_id = ? AND seq = ?').run(now, appId, seq);
      return { eventId, handled };
    });
  }

  links(appId: string, seq: number): BoardLink[] {
    return (this.stmt('SELECT kind, ref, label FROM board_links WHERE app_id = ? AND seq = ? ORDER BY created_at, kind, ref')
      .all(appId, seq) as Array<{ kind: string; ref: string; label: string | null }>)
      .map(r => ({ kind: r.kind as BoardLink['kind'], ref: r.ref, ...(r.label ? { label: r.label } : {}) }));
  }

  events(appId: string, seq: number, limit = 200): BoardEvent[] {
    return (this.stmt(`SELECT * FROM (SELECT * FROM board_events WHERE app_id = ? AND seq = ? ORDER BY id DESC LIMIT ?)
      ORDER BY id DESC`).all(appId, seq, limit) as Array<{
      id: number; seq: number; at: number; actor: string; actor_ref: string | null; kind: string; text: string;
      file_ids_json: string | null; batch_id: number | null;
    }>).map(r => ({
      id: r.id, seq: r.seq, at: r.at, actor: r.actor as BoardActor,
      ...(r.actor_ref ? { actorRef: r.actor_ref } : {}),
      kind: r.kind as BoardEventKind, text: r.text, fileIds: parseIds(r.file_ids_json),
      ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
    }));
  }

  listItems(appId: string, view: BoardView, opts: { author?: string; query?: string } = {}): ItemSummary[] {
    const rows = this.stmt('SELECT * FROM board_items WHERE app_id = ?').all(appId) as ItemRow[];
    const drafts = new Set(opts.author
      ? (this.stmt('SELECT seq FROM board_drafts WHERE app_id = ? AND author = ?').all(appId, opts.author) as Array<{ seq: number }>).map(r => r.seq)
      : []);
    const pending = new Map((this.stmt('SELECT seq, COUNT(*) AS n FROM board_decisions WHERE app_id = ? AND handled_at IS NULL GROUP BY seq')
      .all(appId) as Array<{ seq: number; n: number }>).map(r => [r.seq, r.n]));
    const q = opts.query?.trim().toLowerCase();
    const out: ItemSummary[] = [];
    for (const row of rows) {
      const item = rowToItem(row);
      if (!stateInView(item.state, view)) continue;
      const links = this.links(appId, item.seq);
      if (q) {
        const hay = [item.title, item.summary, item.stage, item.repo, item.kind, item.key, `#${item.seq}`,
          ...links.map(l => l.ref)].filter(Boolean).join('\n').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push({
        ...item,
        links,
        hasDraft: drafts.has(item.seq),
        pendingDecisions: pending.get(item.seq) ?? 0,
        unseen: !!item.stewardEventAt && (!item.ownerSeenAt || item.stewardEventAt > item.ownerSeenAt),
      });
    }
    // 待拍板按进入该状态的时间（先进先拍）；其它按最近更新。
    out.sort((a, b) => view === 'decide' ? a.stateAt - b.stateAt : b.updatedAt - a.updatedAt);
    return out;
  }

  counts(appId: string): Record<BoardView, number> {
    const rows = this.stmt('SELECT state, COUNT(*) AS n FROM board_items WHERE app_id = ? GROUP BY state').all(appId) as Array<{ state: string; n: number }>;
    const counts: Record<BoardView, number> = { decide: 0, active: 0, all: 0 };
    for (const r of rows) {
      if (!isBoardState(r.state)) continue;
      counts.all += r.n;
      if (stateInView(r.state, 'decide')) counts.decide += r.n;
      if (stateInView(r.state, 'active')) counts.active += r.n;
    }
    return counts;
  }

  detail(appId: string, seq: number, author?: string): ItemDetail | undefined {
    const item = this.getItem(appId, seq);
    if (!item) return undefined;
    const files = (this.stmt('SELECT * FROM board_files WHERE app_id = ? AND seq = ? ORDER BY created_at').all(appId, seq) as FileRow[]).map(rowToFile);
    return {
      item,
      links: this.links(appId, seq),
      events: this.events(appId, seq),
      files,
      ...(author ? { draft: this.getDraft(appId, seq, author) } : {}),
      pendingDecisions: this.decisionsFor(appId, seq, true),
    };
  }

  markSeen(appId: string, seq: number, now = Date.now()): void {
    this.stmt('UPDATE board_items SET owner_seen_at = ? WHERE app_id = ? AND seq = ?').run(now, appId, seq);
  }

  // ─── 附件 ───────────────────────────────────────────────────────────────

  /** 落盘按 sha256 去重；同一张图传两次只存一份文件，但各自有一条元数据。 */
  addFile(appId: string, input: { seq?: number; bytes: Buffer; mime: string; name: string; by: 'owner' | 'steward' },
    now = Date.now()): BoardFile {
    const ext = FILE_EXT[input.mime];
    if (!ext) throw new BoardError('unsupported_file', '只支持 png / jpg / gif / webp 图片');
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const dir = decisionBoardFilesDir(this.dataDir, appId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${sha256}${ext}`);
    if (!existsSync(path)) {
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, input.bytes, { mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 20);
    if (input.seq !== undefined && !this.itemRow(appId, input.seq)) throw new BoardError('item_not_found', `没有 #${input.seq}`);
    this.stmt(`INSERT INTO board_files (app_id, id, seq, sha256, mime, bytes, name, uploader, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(appId, id, input.seq ?? null, sha256, input.mime, input.bytes.length,
      input.name, input.by, now);
    return { id, ...(input.seq !== undefined ? { seq: input.seq } : {}), sha256, mime: input.mime, bytes: input.bytes.length,
      name: input.name, by: input.by, createdAt: now };
  }

  getFile(appId: string, id: string): { file: BoardFile; path: string } | undefined {
    const row = this.stmt('SELECT * FROM board_files WHERE app_id = ? AND id = ?').get(appId, id) as FileRow | undefined;
    if (!row) return undefined;
    const file = rowToFile(row);
    return { file, path: join(decisionBoardFilesDir(this.dataDir, appId), `${file.sha256}${FILE_EXT[file.mime] ?? ''}`) };
  }

  readFile(appId: string, id: string): { file: BoardFile; data: Buffer } | undefined {
    const found = this.getFile(appId, id);
    if (!found) return undefined;
    try { return { file: found.file, data: readFileSync(found.path) }; } catch { return undefined; }
  }

  /** 管家附截图：文件 + 一条历史，同一事务。 */
  attachFiles(appId: string, seq: number, files: Array<{ bytes: Buffer; mime: string; name: string }>, note: string | undefined,
    actorRef?: string, now = Date.now()): BoardFile[] {
    checkLen('说明', note, BOARD_LIMITS.note);
    return this.tx(() => {
      if (!this.itemRow(appId, seq)) throw new BoardError('item_not_found', `没有 #${seq}`);
      const saved = files.map(f => this.addFile(appId, { ...f, seq, by: 'steward' }, now));
      this.insertEvent(appId, seq, now, 'steward', actorRef, 'attach', note?.trim() || `附了 ${saved.length} 张截图`,
        saved.map(f => f.id));
      return saved;
    });
  }

  // ─── 草稿 ───────────────────────────────────────────────────────────────

  getDraft(appId: string, seq: number, author: string): BoardDraft | undefined {
    const r = this.stmt('SELECT * FROM board_drafts WHERE app_id = ? AND seq = ? AND author = ?').get(appId, seq, author) as
      { seq: number; author: string; choice: string | null; text: string; file_ids_json: string; base_rev: number; updated_at: number } | undefined;
    if (!r) return undefined;
    return { seq: r.seq, author: r.author, ...(r.choice ? { choice: r.choice } : {}), text: r.text,
      fileIds: parseIds(r.file_ids_json), baseRev: r.base_rev, updatedAt: r.updated_at };
  }

  listDrafts(appId: string, author: string): BoardDraft[] {
    const seqs = (this.stmt('SELECT seq FROM board_drafts WHERE app_id = ? AND author = ? ORDER BY updated_at')
      .all(appId, author) as Array<{ seq: number }>).map(r => r.seq);
    return seqs.map(seq => this.getDraft(appId, seq, author)!).filter(Boolean);
  }

  /** 空草稿（没选项、没文字、没图）等于删除。 */
  putDraft(appId: string, seq: number, author: string, input: { choice?: string; text?: string; fileIds?: string[]; baseRev: number },
    now = Date.now()): BoardDraft | undefined {
    const text = (input.text ?? '').replace(/\r\n/g, '\n');
    checkLen('决定', text, BOARD_LIMITS.longText);
    const fileIds = [...new Set(input.fileIds ?? [])];
    if (fileIds.length > BOARD_LIMITS.filesPerDraft) throw new BoardError('too_many_files', `每项最多附 ${BOARD_LIMITS.filesPerDraft} 张图`);
    const item = this.getItem(appId, seq);
    if (!item) throw new BoardError('item_not_found', `没有 #${seq}`);
    const choice = input.choice?.trim() || undefined;
    if (choice && !item.options.some(o => o.key === choice)) throw new BoardError('unknown_choice', `没有选项 ${choice}`);
    for (const id of fileIds) {
      const f = this.getFile(appId, id);
      if (!f || f.file.by !== 'owner') throw new BoardError('unknown_file', '附图不存在');
    }
    if (!choice && !text.trim() && fileIds.length === 0) {
      this.clearDraft(appId, seq, author);
      return undefined;
    }
    this.stmt(`INSERT INTO board_drafts (app_id, seq, author, choice, text, file_ids_json, base_rev, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, seq, author) DO UPDATE SET choice = excluded.choice, text = excluded.text,
        file_ids_json = excluded.file_ids_json, base_rev = excluded.base_rev, updated_at = excluded.updated_at`)
      .run(appId, seq, author, choice ?? null, text, JSON.stringify(fileIds), input.baseRev, now);
    return this.getDraft(appId, seq, author);
  }

  clearDraft(appId: string, seq: number, author: string): void {
    this.stmt('DELETE FROM board_drafts WHERE app_id = ? AND seq = ? AND author = ?').run(appId, seq, author);
  }

  // ─── 提交批次 ───────────────────────────────────────────────────────────

  /**
   * 一个事务：核对草稿 → 建批次 → 写决定 → 历史记一笔 → 删草稿。同一个 nonce 重复提交
   * 返回已有批次（duplicate=true），不建第二个。
   */
  submit(appId: string, input: SubmitInput, now = Date.now()): { batch: BoardBatch; decisions: BoardDecision[]; duplicate: boolean } {
    if (!input.nonce || input.nonce.length > 100) throw new BoardError('invalid_nonce');
    if (!input.items.length) throw new BoardError('nothing_to_submit', '没有要提交的草稿');
    return this.tx(() => {
      const dup = this.stmt('SELECT id FROM board_batches WHERE app_id = ? AND nonce = ?').get(appId, input.nonce) as { id: number } | undefined;
      if (dup) {
        return { batch: this.getBatch(appId, dup.id)!, decisions: this.batchDecisions(appId, dup.id), duplicate: true };
      }
      const seen = new Set<number>();
      const drafts: Array<{ draft: BoardDraft; item: BoardItem }> = [];
      for (const it of input.items) {
        if (seen.has(it.seq)) continue;
        seen.add(it.seq);
        const draft = this.getDraft(appId, it.seq, input.author);
        if (!draft) throw new BoardError('draft_missing', `#${it.seq} 的草稿已经不在了，刷新后再提交`);
        if (draft.updatedAt !== it.draftUpdatedAt) throw new BoardError('draft_changed', `#${it.seq} 的草稿在别处改过，刷新后再提交`);
        const item = this.getItem(appId, it.seq);
        if (!item) throw new BoardError('item_not_found', `没有 #${it.seq}`);
        drafts.push({ draft, item });
      }
      const id = ((this.stmt('SELECT MAX(id) AS m FROM board_batches WHERE app_id = ?').get(appId) as { m: number | null }).m ?? 0) + 1;
      this.stmt(`INSERT INTO board_batches (app_id, id, author, author_name, nonce, created_at, delivery, attempts)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`).run(appId, id, input.submitter ?? input.author, input.authorName ?? null, input.nonce, now);
      const decisions: BoardDecision[] = [];
      for (const { draft, item } of drafts) {
        this.stmt(`INSERT INTO board_decisions (app_id, batch_id, seq, choice, text, file_ids_json, item_rev)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(appId, id, item.seq, draft.choice ?? null, draft.text,
          JSON.stringify(draft.fileIds), item.rev);
        for (const fid of draft.fileIds) {
          this.stmt('UPDATE board_files SET seq = ? WHERE app_id = ? AND id = ? AND seq IS NULL').run(item.seq, appId, fid);
        }
        const summary = [draft.choice ? `选 ${draft.choice}` : '', draft.text.trim()].filter(Boolean).join('：') || '（附图）';
        this.insertEvent(appId, item.seq, now, 'owner', input.submitter ?? input.author, 'decision', summary, draft.fileIds, id);
        this.clearDraft(appId, item.seq, input.author);
        decisions.push({ batchId: id, seq: item.seq, ...(draft.choice ? { choice: draft.choice } : {}), text: draft.text,
          fileIds: draft.fileIds, itemRev: item.rev });
      }
      return { batch: this.getBatch(appId, id)!, decisions, duplicate: false };
    });
  }

  getBatch(appId: string, id: number): BoardBatch | undefined {
    const r = this.stmt('SELECT * FROM board_batches WHERE app_id = ? AND id = ?').get(appId, id) as BatchRow | undefined;
    return r ? rowToBatch(r) : undefined;
  }

  listBatches(appId: string, limit = 20): BoardBatch[] {
    return (this.stmt('SELECT * FROM board_batches WHERE app_id = ? ORDER BY id DESC LIMIT ?').all(appId, limit) as BatchRow[]).map(rowToBatch);
  }

  /** 还没送达的批次（pending / failed），daemon 起来后补投。 */
  undeliveredBatches(appId: string): BoardBatch[] {
    return (this.stmt(`SELECT * FROM board_batches WHERE app_id = ? AND delivery != 'delivered' ORDER BY id`).all(appId) as BatchRow[]).map(rowToBatch);
  }

  batchDecisions(appId: string, batchId: number): BoardDecision[] {
    return (this.stmt('SELECT * FROM board_decisions WHERE app_id = ? AND batch_id = ? ORDER BY seq').all(appId, batchId) as DecisionRow[]).map(rowToDecision);
  }

  decisionsFor(appId: string, seq: number, onlyPending: boolean): BoardDecision[] {
    const sql = onlyPending
      ? 'SELECT * FROM board_decisions WHERE app_id = ? AND seq = ? AND handled_at IS NULL ORDER BY batch_id'
      : 'SELECT * FROM board_decisions WHERE app_id = ? AND seq = ? ORDER BY batch_id';
    return (this.stmt(sql).all(appId, seq) as DecisionRow[]).map(rowToDecision);
  }

  pendingDecisions(appId: string): BoardDecision[] {
    return (this.stmt('SELECT * FROM board_decisions WHERE app_id = ? AND handled_at IS NULL ORDER BY batch_id, seq').all(appId) as DecisionRow[]).map(rowToDecision);
  }

  markBatchAttempt(appId: string, id: number): void {
    this.stmt('UPDATE board_batches SET attempts = attempts + 1 WHERE app_id = ? AND id = ?').run(appId, id);
  }

  /**
   * 投递动作开始前把本批次置为 dispatched 并落下稳定回合 id（pending/failed → dispatched，
   * delivered 终态不倒退）。进程死在 deliver() 内部时，重启补投看到的是【结果未知】：
   * 横幅可能已发、回合也可能已经进过 CLI，无法确认——一律转 failed(delivery_interrupted)
   * 让 owner 重投（同 turnId，存活 worker 内存去重挡二次执行），绝不假设成功补登 delivered。
   * deliver() 抛错时由 markBatchFailed 退回 failed，批次可以重投。
   */
  markBatchDispatched(appId: string, id: number, turnId: string): void {
    // 只写状态与回合 id；dispatched 不代表已送达，delivered_at 留给 markBatchDelivered。
    this.stmt(`UPDATE board_batches SET delivery = 'dispatched', turn_id = ?, error = NULL
      WHERE app_id = ? AND id = ? AND delivery != 'delivered'`)
      .run(turnId, appId, id);
  }

  /**
   * deliver() 成功返回后落终态。返回 false 表示落库前批次已被异步失败回执标成 failed
   *（回执先于 deliver 的 resolve 到达，worker 判定权威）：不覆盖它，批次留 failed 可重投。
   */
  markBatchDelivered(appId: string, id: number, info: { sessionId?: string; turnId: string }, now = Date.now()): boolean {
    const result = this.stmt(`UPDATE board_batches SET delivery = 'delivered', session_id = ?, turn_id = ?, delivered_at = ?, error = NULL
      WHERE app_id = ? AND id = ? AND delivery != 'failed'`)
      .run(info.sessionId ?? null, info.turnId, now, appId, id);
    return result.changes > 0;
  }

  /** delivered 之后迟到的失败不改状态；dispatched/pending 期间收到失败回执回退 failed（结果未知，留给重投）。 */
  markBatchFailed(appId: string, id: number, error: string): void {
    // 顺带清掉 delivered_at：dispatched/failed 都不代表已送达，留着旧时间戳会误导报表与清理。
    this.stmt(`UPDATE board_batches SET delivery = 'failed', error = ?, delivered_at = NULL
      WHERE app_id = ? AND id = ? AND delivery != 'delivered'`)
      .run(error.slice(0, 500), appId, id);
  }
}

interface FileRow { id: string; seq: number | null; sha256: string; mime: string; bytes: number; name: string; uploader: string; created_at: number }
function rowToFile(r: FileRow): BoardFile {
  return { id: r.id, ...(r.seq !== null ? { seq: r.seq } : {}), sha256: r.sha256, mime: r.mime, bytes: r.bytes, name: r.name,
    by: r.uploader === 'steward' ? 'steward' : 'owner', createdAt: r.created_at };
}

interface BatchRow {
  id: number; author: string; author_name: string | null; created_at: number; delivery: string; attempts: number;
  session_id: string | null; turn_id: string | null; delivered_at: number | null; error: string | null;
}
function rowToBatch(r: BatchRow): BoardBatch {
  return {
    id: r.id, author: r.author, ...(r.author_name ? { authorName: r.author_name } : {}), createdAt: r.created_at,
    delivery: r.delivery === 'delivered' || r.delivery === 'failed' || r.delivery === 'dispatched' ? r.delivery : 'pending', attempts: r.attempts,
    ...(r.session_id ? { sessionId: r.session_id } : {}), ...(r.turn_id ? { turnId: r.turn_id } : {}),
    ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}), ...(r.error ? { error: r.error } : {}),
  };
}

interface DecisionRow { batch_id: number; seq: number; choice: string | null; text: string; file_ids_json: string; item_rev: number; handled_at: number | null }
function rowToDecision(r: DecisionRow): BoardDecision {
  return { batchId: r.batch_id, seq: r.seq, ...(r.choice ? { choice: r.choice } : {}), text: r.text, fileIds: parseIds(r.file_ids_json),
    itemRev: r.item_rev, ...(r.handled_at ? { handledAt: r.handled_at } : {}) };
}
