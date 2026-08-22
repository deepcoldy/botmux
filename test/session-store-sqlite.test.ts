/**
 * SQLite 引擎替换（Step 3 第一个 PR）的专项回归：
 *  - 首启确定性自动导入（含 closed 行、legacy sessions.json、幂等/重启不重复导入）
 *  - .db.tmp 原子出现（读者绝不见半成品；残留 tmp 被清理）
 *  - JSON 原地冻结（导入后 daemon 写不再碰 JSON —— 回滚方案的前提）
 *  - 混合窗口 db-else-json（跨进程读 + CLI 离线写，含「冻结 JSON 不算第二份拷贝」）
 *  - Node 能力探测报错路径（daemon 硬门；CLI 有 .db 硬报错 / 无 .db 走 JSON）
 *  - worker（owner:false）不触发导入
 *
 * Run:  pnpm vitest run test/session-store-sqlite.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { spawn } from 'node:child_process';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const mockDeleteFrozenCards = vi.fn();
vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: (...args: any[]) => mockDeleteFrozenCards(...args),
}));

import {
  __testOnly_setSqliteUnavailable,
  assertSqliteSupported,
  init,
  createSession,
  getSession,
  getSessionFresh,
  listSessions,
  closeSession,
  updateSession,
  findActiveSessionsByRoot,
  countActiveSessionsOnDisk,
  collectBotmuxSessionIdentities,
  loadAllSessionsSnapshot,
  mutateSessionRowOffline,
  readSessionRowFromDisk,
  readSessionRowCopiesAcrossStores,
  SessionStoreSqliteUnavailableError,
} from '../src/services/session-store.js';
import { readPersistedSessionRows, mutatePersistedSessionRow } from './helpers/session-store-disk.js';

function seedJson(name: string, rows: Record<string, unknown>): string {
  mkdirSync(tempDir, { recursive: true });
  const fp = join(tempDir, name);
  writeFileSync(fp, JSON.stringify(rows, null, 2));
  return fp;
}

function row(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, chatId: 'oc_chat', rootMessageId: `om_${sessionId}`, title: sessionId,
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-store-sqlite-test-'));
  __testOnly_setSqliteUnavailable(false);
  mockDeleteFrozenCards.mockReset();
  init();
});

afterEach(() => {
  __testOnly_setSqliteUnavailable(false);
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 首启确定性自动导入 ──────────────────────────────────────────────────────

describe('first-start JSON import', () => {
  it('imports per-bot JSON rows — closed rows included — and freezes the JSON in place', () => {
    const jsonFp = seedJson('sessions-appA.json', {
      live: row('live'),
      done: row('done', { status: 'closed', closedAt: '2026-02-01T00:00:00.000Z' }),
      legacyCard: row('legacyCard', { pendingResponseCardId: 'om_old', pendingResponseCardState: 'open' }),
      broken: { ...row('broken'), chatId: 'oc_x', rootMessageId: 'oc_x' },
    });
    const jsonBefore = readFileSync(jsonFp, 'utf-8');

    init('appA');
    expect(getSession('live')?.status).toBe('active');
    // closed 行全量导入
    expect(getSession('done')?.status).toBe('closed');
    expect(getSession('done')?.closedAt).toBe('2026-02-01T00:00:00.000Z');
    // strip legacy 字段发生在导入期
    const imported = readPersistedSessionRows(tempDir, 'appA');
    expect(imported.legacyCard).not.toHaveProperty('pendingResponseCardId');
    expect(imported.legacyCard).not.toHaveProperty('pendingResponseCardState');
    // repairMissingChatScope 发生在导入期
    expect(imported.broken.scope).toBe('chat');
    // .db 落位，JSON 原地冻结（一个字节都不动）
    expect(existsSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'))).toBe(true);
    expect(readFileSync(jsonFp, 'utf-8')).toBe(jsonBefore);
  });

  it('imports only this bot\'s rows from legacy sessions.json and leaves it frozen', () => {
    const legacyFp = seedJson('sessions.json', {
      a1: row('a1', { larkAppId: 'app-A' }),
      b1: row('b1', { larkAppId: 'app-B' }),
    });
    const legacyBefore = readFileSync(legacyFp, 'utf-8');

    init('app-A');
    expect(listSessions().map(s => s.sessionId)).toEqual(['a1']);
    expect(existsSync(join(tempDir, 'session-stores', 'app-A', 'sessions.db'))).toBe(true);
    // 旧行为会把行迁移写进 sessions-app-A.json；现在 JSON 全部冻结
    expect(existsSync(join(tempDir, 'sessions-app-A.json'))).toBe(false);
    expect(readFileSync(legacyFp, 'utf-8')).toBe(legacyBefore);
  });

  it('is idempotent: a restart with the frozen JSON still present must not re-import', () => {
    const jsonFp = seedJson('sessions-appA.json', { s1: row('s1') });
    init('appA');
    closeSession('s1');
    expect(getSession('s1')?.status).toBe('closed');

    // daemon 重启：.db 已存在，冻结 JSON 里的旧 active 行不得覆盖回来
    init('appA');
    expect(getSession('s1')?.status).toBe('closed');
    expect(JSON.parse(readFileSync(jsonFp, 'utf-8')).s1.status).toBe('active');
  });

  it('publishes the store atomically: no .db.tmp survives, and stale tmp leftovers are replaced', () => {
    // 上次导入中途崩溃的残留 tmp（垃圾内容）不得阻塞、也不得泄漏进结果
    const storeDir = join(tempDir, 'session-stores', 'appA');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'sessions.db.tmp'), 'garbage from a crashed import');
    seedJson('sessions-appA.json', { s1: row('s1') });

    init('appA');
    expect(getSession('s1')?.title).toBe('s1');
    expect(existsSync(join(storeDir, 'sessions.db'))).toBe(true);
    expect(existsSync(join(storeDir, 'sessions.db.tmp'))).toBe(false);
  });

  it('daemon writes after import go to the .db only — the frozen JSON never changes again', () => {
    const jsonFp = seedJson('sessions-appA.json', { s1: row('s1') });
    const jsonBefore = readFileSync(jsonFp, 'utf-8');
    init('appA');

    const s1 = getSession('s1')!;
    s1.title = 'renamed';
    updateSession(s1);
    createSession('oc_new', 'om_new', 'brand new');

    expect(readFileSync(jsonFp, 'utf-8')).toBe(jsonBefore);
    const rows = readPersistedSessionRows(tempDir, 'appA');
    expect(rows.s1.title).toBe('renamed');
    expect(Object.keys(rows)).toHaveLength(2);
  });

  it('a non-owning process (worker under an old daemon) never bootstraps the .db', () => {
    seedJson('sessions-appA.json', { s1: row('s1') });

    init('appA', { owner: false });
    expect(getSession('s1')?.title).toBe('s1'); // 读 JSON 照常
    expect(existsSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'))).toBe(false);

    // daemon（owner）随后启动才导入
    init('appA');
    expect(getSession('s1')?.title).toBe('s1');
    expect(existsSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'))).toBe(true);
  });
});

// ─── 混合窗口 db-else-json ───────────────────────────────────────────────────

describe('mixed-window db-else-json resolution', () => {
  it('readers prefer the .db and treat the frozen JSON as superseded, not a second copy', () => {
    // appA 已切 SQLite（daemon 已重启），冻结 JSON 里留着一份陈旧拷贝
    const jsonFp = seedJson('sessions-appA.json', {
      s1: row('s1', { title: 'stale json copy', larkAppId: 'appA' }),
    });
    init('appA');
    const fresh = getSession('s1')!;
    fresh.title = 'live db copy';
    updateSession(fresh);
    // 冻结 JSON 又多出一行只存在于 JSON 的行（导入后读者不再看 JSON）
    writeFileSync(jsonFp, JSON.stringify({
      s1: row('s1', { title: 'stale json copy', larkAppId: 'appA' }),
      ghost: row('ghost', { larkAppId: 'appA' }),
    }, null, 2));

    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.title).toBe('live db copy');
    expect(loadAllSessionsSnapshot({ dataDir: tempDir }).get('s1')?.title).toBe('live db copy');
    // 身份扫描：同一 store 的冻结 JSON 不算第二份拷贝（exactly-once 证明不被打破）
    expect(readSessionRowCopiesAcrossStores('s1', tempDir)).toHaveLength(1);
    // 冻结 JSON 独有的行不可见——读者一律以 .db 为准
    expect(loadAllSessionsSnapshot({ dataDir: tempDir }).has('ghost')).toBe(false);
    expect(countActiveSessionsOnDisk(tempDir)).toBe(1);
  });

  it('stores still on JSON keep full read behaviour, and mixed stores compose', () => {
    // appOld 还没重启（只有 JSON）；appNew 已切 SQLite
    seedJson('sessions-appOld.json', { o1: row('o1', { larkAppId: 'appOld' }) });
    init('appNew');
    const n1 = createSession('oc_chat', 'om_shared_root', 'new bot session');
    n1.larkAppId = 'appNew';
    updateSession(n1);
    mutatePersistedSessionRow(tempDir, 'appNew', n1.sessionId, (r) => { r.rootMessageId = 'om_o1'; });

    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect(snapshot.get('o1')?.larkAppId).toBe('appOld');
    expect(snapshot.get(n1.sessionId)?.larkAppId).toBe('appNew');

    // 跨 bot 发现类读者对两种引擎同时可见（sibling json + sibling db）
    init('appThird');
    const found = findActiveSessionsByRoot('om_o1');
    expect(found.map(s => s.sessionId).sort()).toEqual(['o1', n1.sessionId].sort());
    expect(countActiveSessionsOnDisk(tempDir)).toBe(2);
    const ids = collectBotmuxSessionIdentities(tempDir);
    expect(ids.has('o1')).toBe(true);
    expect(ids.has(n1.sessionId)).toBe(true);
  });

  it('getSessionFresh reads the committed .db state, not the process cache', () => {
    init('appA');
    const s = createSession('oc_chat', 'om_root', 'fresh probe');
    mutatePersistedSessionRow(tempDir, 'appA', s.sessionId, (r) => { r.title = 'external change'; });
    expect(getSessionFresh(s.sessionId)?.title).toBe('external change');
    expect(getSession(s.sessionId)?.title).toBe('fresh probe'); // 缓存语义不变
  });

  it('offline mutation targets the .db when it exists and leaves the frozen JSON untouched', () => {
    const jsonFp = seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    expect(getSession('s1')?.status).toBe('active'); // 首次访问触发导入 → .db
    const jsonAfterImport = readFileSync(jsonFp, 'utf-8');

    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      (current) => { current.status = 'closed'; current.closedAt = '2026-08-13T00:00:00.000Z'; return true; },
      { dataDir: tempDir },
    );
    expect(published?.status).toBe('closed');
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('closed');
    expect(readFileSync(jsonFp, 'utf-8')).toBe(jsonAfterImport);
    expect(JSON.parse(jsonAfterImport).s1.status).toBe('active');
  });

  it('offline mutation on the .db keeps the abortIf entry + pre-publication probes', () => {
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    const before = readPersistedSessionRows(tempDir, 'appA');

    let probes = 0;
    const aborted = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      (current) => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => ++probes > 1 },
    );
    expect(aborted).toBeUndefined();
    expect(probes).toBe(2);
    expect(readPersistedSessionRows(tempDir, 'appA')).toEqual(before);

    const abortedAtEntry = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      (current) => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => true },
    );
    expect(abortedAtEntry).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA')).toEqual(before);
  });

  it('offline mutation hands mutate the FRESH .db row, never the caller snapshot', () => {
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    mutatePersistedSessionRow(tempDir, 'appA', 's1', (r) => { r.workerGeneration = 7; });

    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      (current) => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );
    expect(published?.status).toBe('closed');
    expect(published?.workerGeneration).toBe(7);
  });
});

// ─── cutover 竞态：daemon 首次 load × 在途离线写者 ───────────────────────────

describe('first-load serialization against an in-flight offline writer', () => {
  it('load blocks on a held BEGIN IMMEDIATE and reads the post-commit row (lost-update regression)', async () => {
    // 复现评审时序：离线 CLI 已通过双 abortIf 探测、持有 BEGIN IMMEDIATE 且改了
    // 行但未 commit；daemon 此刻首次 load。纯 SELECT 不被写事务排斥——若 load
    // 不进排他事务，会把 commit 前的旧行读进终身缓存，稍后的行写回覆盖 CLI 的
    // 提交。修复后 load 的排他读必须等 CLI commit，读到新值。
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions(); // 触发导入 → .db
    init();         // 释放连接，模拟 daemon 尚未启动
    const dbPath = join(tempDir, 'session-stores', 'appA', 'sessions.db');

    // 握手协议保证确定性：子进程持锁改行后发 HELD；父进程落下 loading 标记后
    // 立刻进入 load；子进程看到标记再等 300ms 才 COMMIT——父进程无论多慢都
    // 一定在锁被持有期间发起排他读。
    const loadingMarker = join(tempDir, 'race-parent-loading');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec('BEGIN IMMEDIATE');
      const current = JSON.parse(db.prepare('SELECT row FROM sessions WHERE session_id = ?').get('s1').row);
      current.title = 'offline-cli-write';
      db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?').run(JSON.stringify(current), 's1');
      process.stdout.write('HELD\\n'); // 已持写锁 + 已过双探测的时刻
      const tick = () => {
        if (!fs.existsSync(${JSON.stringify(loadingMarker)})) return setTimeout(tick, 50);
        setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
      };
      tick();
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('offline writer never signalled HELD')), 5000);
        child.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('HELD')) { clearTimeout(timer); resolve(); }
        });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`writer exited early (${code})`)); });
      });

      init('appA');
      writeFileSync(loadingMarker, '1');
      const t0 = Date.now();
      const loaded = getSession('s1'); // 首次 load：排他读必须等 COMMIT
      expect(loaded?.title).toBe('offline-cli-write');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(200); // 确实等待了，而非读旧行
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('load does not swallow SQLITE_BUSY into an empty cache', async () => {
    // busy_timeout 耗尽后若收成 loadFailure + 空 Map，daemon 启动会走
    // listSessions() 把「锁等待超时」当成「没有会话」并跳过 restore。
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA', title: 'must-survive-busy' }) });
    init('appA');
    listSessions();
    init();
    const dbPath = join(tempDir, 'session-stores', 'appA', 'sessions.db');
    const releaseMarker = join(tempDir, 'busy-release');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('HELD\\n');
      const tick = () => {
        if (!fs.existsSync(${JSON.stringify(releaseMarker)})) return setTimeout(tick, 50);
        db.exec('COMMIT');
        db.close();
      };
      tick();
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('writer never signalled HELD')), 5000);
        child.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('HELD')) { clearTimeout(timer); resolve(); }
        });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`writer exited early (${code})`)); });
      });

      init('appA');
      const t0 = Date.now();
      expect(() => listSessions()).toThrow(/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);

      writeFileSync(releaseMarker, '1');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('writer did not exit after release')), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });

      const loaded = listSessions();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe('must-survive-busy');
    } finally {
      try { writeFileSync(releaseMarker, '1'); } catch { /* already written */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);
});

// ─── Node 能力探测 ───────────────────────────────────────────────────────────

describe('node:sqlite capability gate', () => {
  it('daemon startup probe fails with an actionable upgrade message', () => {
    __testOnly_setSqliteUnavailable(true);
    expect(() => assertSqliteSupported()).toThrow(SessionStoreSqliteUnavailableError);
    expect(() => assertSqliteSupported()).toThrow(/22\.13/);
  });

  it('CLI paths fail hard when a .db exists but node:sqlite is missing', () => {
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions(); // 首次访问触发导入 → .db
    init(); // 释放已 attach 的连接，模拟独立 CLI 进程
    __testOnly_setSqliteUnavailable(true);

    expect(() => readSessionRowFromDisk('s1', 'appA', tempDir)).toThrow(SessionStoreSqliteUnavailableError);
    expect(() => loadAllSessionsSnapshot({ dataDir: tempDir })).toThrow(SessionStoreSqliteUnavailableError);
    expect(() => readSessionRowCopiesAcrossStores('s1', tempDir)).toThrow(SessionStoreSqliteUnavailableError);
    expect(() => mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      () => true,
      { dataDir: tempDir },
    )).toThrow(SessionStoreSqliteUnavailableError);
  });

  it('CLI paths keep working on plain JSON stores when node:sqlite is missing (no .db yet)', () => {
    seedJson('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    __testOnly_setSqliteUnavailable(true);

    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.sessionId).toBe('s1');
    expect(loadAllSessionsSnapshot({ dataDir: tempDir }).get('s1')?.larkAppId).toBe('appA');
    expect(readSessionRowCopiesAcrossStores('s1', tempDir)).toHaveLength(1);
    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      (current) => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );
    expect(published?.status).toBe('closed');
  });
});
