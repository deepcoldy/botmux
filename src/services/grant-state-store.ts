/**
 * per-user talk 授权状态的持久层与后端选择。
 *
 * 两种后端，共用同一组 {@link GrantTx} 原语（业务逻辑在 grant-store.ts，与后端无关）：
 *   • SQLite（daemon 默认）：`<dataDir>/grants.sqlite`，按 app_id 分区。一条授权就是一行，
 *     写入只动相关行，与存量多少无关；跨进程并发由 SQLite 事务 + busy_timeout 串行化。
 *     这些字段曾经都放在 bots.json 里：多 bot 建群的全互授让单个配置文件涨到数 MB，
 *     每次授权都要在全局文件锁里重写整份配置。
 *   • bots.json（`BOTMUX_COORDINATION_MODE=primary`，以及未初始化时的默认）：多副本的本地
 *     dataDir 互不共享，授权必须继续随 bots.json 走 durable config CAS，行为与迁移前一致。
 *
 * 内存里的 `bot.config.chatGrants` 等字段是读路径（canTalk / 额度判定）的缓存：daemon 启动时
 * 从后端灌入，此后每次写事务提交，按同一份操作日志回放到内存（{@link replayGrantOps}），
 * 二者不会分叉。
 */
import { constants as fsConstants, mkdirSync, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBot } from '../bot-registry.js';
import { requireConfigPath, rmwBotEntry } from './config-store.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike, type StatementLike } from './sqlite-compat.js';
import {
  GRANT_STATE_KEYS,
  journalGrantTx,
  objectGrantTx,
  parseGrantStateFields,
  replayGrantOps,
  type DispatchReceipt,
  type GrantOp,
  type GrantStateFields,
  type GrantTx,
  type QuotaRec,
} from './grant-state.js';
import { logger } from '../utils/logger.js';

export const grantStateDbPath = (dataDir: string): string => join(dataDir, 'grants.sqlite');

const SCHEMA_VERSION = 1;

type Fail = { ok: false; reason: string };

export class SqliteGrantStateStore {
  private readonly statements = new Map<string, StatementLike>();

  private constructor(private readonly db: DatabaseSyncLike) {}

  static open(dataDir: string): SqliteGrantStateStore {
    const path = grantStateDbPath(dataDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = openDatabaseSyncOrThrow(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      // 建表与版本判定在同一把写锁内，避免多个 daemon 同时冷启动时各自判定、各自改版本。
      db.exec('BEGIN IMMEDIATE;');
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
      if (version > SCHEMA_VERSION) {
        throw new Error(`grant state store ${path} has schema v${version}, newer than this botmux (v${SCHEMA_VERSION})`);
      }
      // 全部按自然主键建 WITHOUT ROWID 表：表即索引，不再为唯一约束另存一份三列文本
      // （全互授的成员表是大头，这样体积约减半）。成员因此按主键序读出，不保留写入顺序。
      db.exec(`
        CREATE TABLE IF NOT EXISTS grant_chat_members (
          app_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          open_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, chat_id, open_id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS grant_global_members (
          app_id TEXT NOT NULL,
          open_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, open_id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS grant_quota (
          app_id TEXT NOT NULL,
          grant_key TEXT NOT NULL,
          quota_limit INTEGER NOT NULL CHECK (quota_limit > 0),
          quota_used INTEGER NOT NULL CHECK (quota_used >= 0),
          PRIMARY KEY (app_id, grant_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS grant_expiry (
          app_id TEXT NOT NULL,
          grant_key TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, grant_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS grant_dispatch_receipts (
          app_id TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          allow INTEGER NOT NULL CHECK (allow IN (0, 1)),
          charged_at TEXT NOT NULL,
          PRIMARY KEY (app_id, receipt_id)
        ) WITHOUT ROWID;
      `);
      if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      db.exec('COMMIT;');
      return new SqliteGrantStateStore(db);
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no transaction or already rolled back */ }
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

  private run(sql: string, ...params: unknown[]): boolean {
    return Number(this.stmt(sql).run(...params).changes) > 0;
  }

  /** 在一个写事务里执行 mutate；`write:false` 回滚（mutate 内的写一并作废）。 */
  transact<T>(appId: string, mutate: (tx: GrantTx) => { write: boolean; result: T }): { write: boolean; result: T } {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const out = mutate(this.txFor(appId));
      this.db.exec(out.write ? 'COMMIT;' : 'ROLLBACK;');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* preserve the mutation error */ }
      throw error;
    }
  }

  private txFor(appId: string): GrantTx {
    const has = (sql: string, ...params: unknown[]) => this.stmt(sql).get(appId, ...params) != null;
    return {
      chatHas: (chatId, openId) =>
        has('SELECT 1 FROM grant_chat_members WHERE app_id = ? AND chat_id = ? AND open_id = ?', chatId, openId),
      chatAdd: (chatId, openId) => this.run(
        'INSERT OR IGNORE INTO grant_chat_members (app_id, chat_id, open_id, created_at) VALUES (?, ?, ?, ?)',
        appId, chatId, openId, Date.now(),
      ),
      chatRemove: (chatId, openId) => this.run(
        'DELETE FROM grant_chat_members WHERE app_id = ? AND chat_id = ? AND open_id = ?',
        appId, chatId, openId,
      ),
      globalHas: openId => has('SELECT 1 FROM grant_global_members WHERE app_id = ? AND open_id = ?', openId),
      globalAdd: openId => this.run(
        'INSERT OR IGNORE INTO grant_global_members (app_id, open_id, created_at) VALUES (?, ?, ?)',
        appId, openId, Date.now(),
      ),
      globalRemove: openId => this.run('DELETE FROM grant_global_members WHERE app_id = ? AND open_id = ?', appId, openId),
      quotaGet: key => {
        const row = this.stmt('SELECT quota_limit, quota_used FROM grant_quota WHERE app_id = ? AND grant_key = ?')
          .get(appId, key) as { quota_limit: unknown; quota_used: unknown } | null | undefined;
        return row ? { limit: Number(row.quota_limit), used: Number(row.quota_used) } : undefined;
      },
      quotaSet: (key, rec) => {
        if (!rec) return this.run('DELETE FROM grant_quota WHERE app_id = ? AND grant_key = ?', appId, key);
        this.run(
          `INSERT INTO grant_quota (app_id, grant_key, quota_limit, quota_used) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, grant_key) DO UPDATE SET quota_limit = excluded.quota_limit, quota_used = excluded.quota_used`,
          appId, key, rec.limit, rec.used,
        );
        return true;
      },
      expiryGet: key => {
        const row = this.stmt('SELECT expires_at FROM grant_expiry WHERE app_id = ? AND grant_key = ?')
          .get(appId, key) as { expires_at: unknown } | null | undefined;
        return row ? Number(row.expires_at) : undefined;
      },
      expirySet: (key, expiresAt) => {
        if (expiresAt === null) return this.run('DELETE FROM grant_expiry WHERE app_id = ? AND grant_key = ?', appId, key);
        this.run(
          `INSERT INTO grant_expiry (app_id, grant_key, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (app_id, grant_key) DO UPDATE SET expires_at = excluded.expires_at`,
          appId, key, expiresAt,
        );
        return true;
      },
      receiptGet: id => {
        const row = this.stmt('SELECT allow, charged_at FROM grant_dispatch_receipts WHERE app_id = ? AND receipt_id = ?')
          .get(appId, id) as { allow: unknown; charged_at: unknown } | null | undefined;
        return row ? { allow: Number(row.allow) === 1, chargedAt: String(row.charged_at) } : undefined;
      },
      receiptSet: (id, rec) => {
        this.run(
          `INSERT INTO grant_dispatch_receipts (app_id, receipt_id, allow, charged_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, receipt_id) DO UPDATE SET allow = excluded.allow, charged_at = excluded.charged_at`,
          appId, id, rec.allow ? 1 : 0, rec.chargedAt,
        );
      },
    };
  }

  /** 读出某个 app 的完整授权状态（与 bots.json 字段同形；空表 → undefined；按主键序）。 */
  loadState(appId: string): GrantStateFields {
    const out: GrantStateFields = {};
    const chatRows = this.stmt('SELECT chat_id, open_id FROM grant_chat_members WHERE app_id = ? ORDER BY 1, 2')
      .all(appId) as Array<{ chat_id: string; open_id: string }>;
    if (chatRows.length > 0) {
      const map: { [chatId: string]: string[] } = {};
      for (const row of chatRows) (map[row.chat_id] ??= []).push(row.open_id);
      out.chatGrants = map;
    }
    const globalRows = this.stmt('SELECT open_id FROM grant_global_members WHERE app_id = ? ORDER BY 1')
      .all(appId) as Array<{ open_id: string }>;
    if (globalRows.length > 0) out.globalGrants = globalRows.map(row => row.open_id);
    const quotaRows = this.stmt('SELECT grant_key, quota_limit, quota_used FROM grant_quota WHERE app_id = ? ORDER BY 1')
      .all(appId) as Array<{ grant_key: string; quota_limit: unknown; quota_used: unknown }>;
    if (quotaRows.length > 0) {
      out.quotaState = Object.fromEntries(quotaRows.map(row =>
        [row.grant_key, { limit: Number(row.quota_limit), used: Number(row.quota_used) } satisfies QuotaRec]));
    }
    const expiryRows = this.stmt('SELECT grant_key, expires_at FROM grant_expiry WHERE app_id = ? ORDER BY 1')
      .all(appId) as Array<{ grant_key: string; expires_at: unknown }>;
    if (expiryRows.length > 0) {
      out.grantExpiryState = Object.fromEntries(expiryRows.map(row => [row.grant_key, { expiresAt: Number(row.expires_at) }]));
    }
    const receiptRows = this.stmt('SELECT receipt_id, allow, charged_at FROM grant_dispatch_receipts WHERE app_id = ? ORDER BY 1')
      .all(appId) as Array<{ receipt_id: string; allow: unknown; charged_at: unknown }>;
    if (receiptRows.length > 0) {
      out.dispatchLaunchQuotaReceipts = Object.fromEntries(receiptRows.map(row =>
        [row.receipt_id, { allow: Number(row.allow) === 1, chargedAt: String(row.charged_at) } satisfies DispatchReceipt]));
    }
    return out;
  }

  /**
   * 把 bots.json 上的授权字段并入授权库：只补缺，不覆盖库里已有的同键记录（库是权威）。
   * 首次迁移、降级后又升级留下的字段、手工写进 bots.json 的授权都走这一条。返回新增行数。
   */
  importFields(appId: string, fields: GrantStateFields): number {
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const tx = this.txFor(appId);
      for (const [chatId, ids] of Object.entries(fields.chatGrants ?? {})) {
        for (const openId of ids) if (tx.chatAdd(chatId, openId)) added++;
      }
      for (const openId of fields.globalGrants ?? []) if (tx.globalAdd(openId)) added++;
      for (const [key, rec] of Object.entries(fields.quotaState ?? {})) {
        if (this.run(
          'INSERT OR IGNORE INTO grant_quota (app_id, grant_key, quota_limit, quota_used) VALUES (?, ?, ?, ?)',
          appId, key, rec.limit, rec.used,
        )) added++;
      }
      for (const [key, rec] of Object.entries(fields.grantExpiryState ?? {})) {
        if (this.run(
          'INSERT OR IGNORE INTO grant_expiry (app_id, grant_key, expires_at) VALUES (?, ?, ?)',
          appId, key, rec.expiresAt,
        )) added++;
      }
      for (const [id, rec] of Object.entries(fields.dispatchLaunchQuotaReceipts ?? {})) {
        if (this.run(
          'INSERT OR IGNORE INTO grant_dispatch_receipts (app_id, receipt_id, allow, charged_at) VALUES (?, ?, ?, ?)',
          appId, id, rec.allow ? 1 : 0, rec.chargedAt,
        )) added++;
      }
      this.db.exec('COMMIT;');
      return added;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* preserve the import error */ }
      throw error;
    }
  }
}

type Backend = { kind: 'bots-json' } | { kind: 'sqlite'; store: SqliteGrantStateStore };

// 未初始化时沿用 bots.json：只有 daemon 会写授权，它在注册 bot 后立刻 init。
let backend: Backend = { kind: 'bots-json' };

export function grantStateBackendKind(): Backend['kind'] {
  return backend.kind;
}

function replayIntoMemory(larkAppId: string, ops: readonly GrantOp[]): void {
  if (ops.length === 0) return;
  let config: unknown;
  try { config = getBot(larkAppId).config; } catch { return; }
  replayGrantOps(objectGrantTx(config), ops);
}

/**
 * 对某个 bot 的授权状态做一次原子读改写。`mutate` 必须同步；返回 `write:false` 表示不落盘。
 * 落盘成功后把同一份操作回放到内存缓存。
 */
export async function mutateGrantState<T>(
  larkAppId: string,
  mutate: (tx: GrantTx) => { write: boolean; result: T },
): Promise<{ ok: true; result: T } | Fail> {
  const ops: GrantOp[] = [];
  if (backend.kind === 'sqlite') {
    const out = backend.store.transact(larkAppId, tx => mutate(journalGrantTx(tx, ops)));
    if (out.write) replayIntoMemory(larkAppId, ops);
    return { ok: true, result: out.result };
  }
  let wrote = false;
  const r = await rmwBotEntry<T>(larkAppId, entry => {
    ops.length = 0;
    const out = mutate(journalGrantTx(objectGrantTx(entry), ops));
    wrote = out.write;
    return out;
  });
  if (r.ok && wrote) replayIntoMemory(larkAppId, ops);
  return r;
}

/**
 * 同时改 bots.json 条目（如 allowedUsers）与授权状态的读改写，供 /revoke 这种跨两类数据的操作用。
 * bots.json 后端下两者在同一次 RMW 里原子落盘；SQLite 后端下授权事务嵌在 bots.json 锁内、
 * 先于配置写入提交 —— 配置写入随后失败（返回失败或抛错）时授权侧已生效，只会少放权。
 */
export async function mutateBotEntryAndGrantState<T>(
  larkAppId: string,
  mutate: (entry: any, tx: GrantTx) => { entryChanged: boolean; grantsChanged: boolean; result: T },
): Promise<{ ok: true; result: T } | Fail> {
  // SQLite：授权事务一旦提交就以库为准，只回放真正提交了的操作。
  // bots.json：授权随整次 RMW 一起落盘，以最后一次执行的操作为准。
  const committed: GrantOp[] = [];
  const pending: GrantOp[] = [];
  let grantsInWrite = false;
  let r: { ok: true; result: T } | Fail;
  try {
    r = await rmwBotEntry<T>(larkAppId, entry => {
      if (backend.kind === 'sqlite') {
        const ops: GrantOp[] = [];
        let entryChanged = false;
        const out = backend.store.transact(larkAppId, tx => {
          const res = mutate(entry, journalGrantTx(tx, ops));
          entryChanged = res.entryChanged;
          return { write: res.grantsChanged, result: res.result };
        });
        if (out.write) committed.push(...ops);
        return { write: entryChanged, result: out.result };
      }
      pending.length = 0;
      const res = mutate(entry, journalGrantTx(objectGrantTx(entry), pending));
      grantsInWrite = res.grantsChanged;
      return { write: res.entryChanged || res.grantsChanged, result: res.result };
    });
  } finally {
    // 随后的 bots.json 写入抛错（磁盘满、只读、锁超时）也必须回放已提交的授权改动：
    // canTalk 只读内存缓存，漏掉回放会让库里已撤销的授权在本进程里继续放行。
    if (backend.kind === 'sqlite') replayIntoMemory(larkAppId, committed);
  }
  if (backend.kind === 'bots-json' && r.ok && grantsInWrite) replayIntoMemory(larkAppId, pending);
  return r;
}

async function backupConfigOnce(configPath: string): Promise<string> {
  const bak = `${configPath}.bak-grants-v1`;
  try {
    await fsp.copyFile(configPath, bak, fsConstants.COPYFILE_EXCL);
    await fsp.chmod(bak, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return bak;
}

/**
 * daemon 启动、registerBot 之后、开始收消息之前调用（每个 daemon 只处理自己这一个 bot）：
 *   1. primary 多副本模式 → 维持 bots.json 后端，什么都不动。
 *   2. 否则打开授权库；在 bots.json 锁内把本 bot 条目上的授权字段并入库，再从条目上删掉
 *      （首次删之前整份 bots.json 备份为 `bots.json.bak-grants-v1`）。导入先于删除提交，
 *      中途崩溃只会留下「库里已有、bots.json 还没删」，下次启动并入是幂等的。
 *   3. 用库内状态覆盖内存缓存。
 * 授权库打不开即抛错、daemon 拒绝启动：带着空授权跑会把「只配了 globalGrants」的 bot
 * 误判成无白名单的开放模式。
 *
 * 只迁本 bot 而不是一次迁完整个 fleet：滚动重启期间旧版 daemon 仍按 bots.json 读写自己的
 * 授权，替它迁走会让它之后的撤销落空。
 */
export async function initGrantStateForDaemon(input: {
  larkAppId: string;
  dataDir: string;
}): Promise<{ backend: Backend['kind']; imported: number }> {
  if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary') {
    backend = { kind: 'bots-json' };
    return { backend: 'bots-json', imported: 0 };
  }
  const store = SqliteGrantStateStore.open(input.dataDir);
  try {
    const configPath = requireConfigPath();
    const r = await rmwBotEntry<{ imported: number; keys: string[]; backup?: string }>(input.larkAppId, async entry => {
      const keys = GRANT_STATE_KEYS.filter(k => Object.prototype.hasOwnProperty.call(entry, k));
      if (keys.length === 0) return { write: false, result: { imported: 0, keys } };
      const backup = await backupConfigOnce(configPath);
      const imported = store.importFields(input.larkAppId, parseGrantStateFields(entry));
      for (const k of keys) delete entry[k];
      return { write: true, result: { imported, keys, backup } };
    });
    if (!r.ok) throw new Error(`grant state import from bots.json failed: ${r.reason}`);
    backend = { kind: 'sqlite', store };
    const config = getBot(input.larkAppId).config as GrantStateFields;
    const state = store.loadState(input.larkAppId);
    for (const k of GRANT_STATE_KEYS) {
      if (state[k] === undefined) delete config[k];
      else (config as Record<string, unknown>)[k] = state[k];
    }
    if (r.result.keys.length > 0) {
      logger.info(
        `[grant-state:${input.larkAppId}] moved ${r.result.keys.join(', ')} from bots.json into `
        + `${grantStateDbPath(input.dataDir)} (+${r.result.imported} rows, backup: ${r.result.backup})`,
      );
    }
    return { backend: 'sqlite', imported: r.result.imported };
  } catch (error) {
    if (backend.kind === 'sqlite' && backend.store === store) backend = { kind: 'bots-json' };
    try { store.close(); } catch { /* preserve the init error */ }
    throw error;
  }
}
