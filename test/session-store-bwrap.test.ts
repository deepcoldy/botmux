/**
 * 真实 bubblewrap 回归：persistent pane（长命 mount 命名空间）必须在会话存储
 * 「关闭 → 重开」（daemon 重启）之后读到新 commit。
 *
 * 背景：SQLite 最后一个连接关闭时删除 -wal/-shm，重开时重建为新 inode。旧方案
 * 对 .db/-wal/-shm 做单文件 ro-bind——bind 钉住的是 spawn 时刻的 inode，重启后
 * 旧 pane 永久读死 WAL（甚至在 checkpoint 复用后读出错乱视图）。修复为绑定
 * per-bot store 目录（fs-policy 授 `session-stores/<appId>`），目录 bind 按名字
 * 解析，重启后的新 sidecar 自动可见。本测试用与生产 compileToBwrap 相同形状的
 * 参数（tmpfs 根 + 逐条 ro-bind + 目录级 store 授权）复现「writer 关闭重开写
 * v2 → 既有 sandbox 查询」时序，断言读到 v2。
 *
 * 仅在 linux 且 bwrap 可用（含 unprivileged userns）时运行，否则 skip。
 */
import { describe, it, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function bwrapUsable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const probe = spawnSync('bwrap', [
      '--unshare-user', '--die-with-parent',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '/usr/bin/true',
    ], { timeout: 10_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

async function pollFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe.skipIf(!bwrapUsable())('bwrap persistent pane × SQLite store reopen', () => {
  it('a dir-bound sandbox that outlives the writer reads commits made by the REOPENED store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bwrap-session-store-'));
    const ctlDir = mkdtempSync(join(tmpdir(), 'bwrap-session-ctl-'));
    const storeDir = join(dataDir, 'session-stores', 'appA');
    mkdirSync(storeDir, { recursive: true });
    const dbPath = join(storeDir, 'sessions.db');
    const openStore = () => {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, status TEXT NOT NULL, row TEXT NOT NULL)');
      return db;
    };

    // writer-1 = 升级前的 daemon：写入 v1，保持连接（-wal/-shm 存活）。
    const writer1 = openStore();
    writer1.prepare('INSERT OR REPLACE INTO sessions (session_id, status, row) VALUES (?, ?, ?)')
      .run('s1', 'active', JSON.stringify({ v: 'v1' }));

    // persistent pane：长命 bwrap，目录级 store 授权（与生产 fs-policy 同形）。
    // 内部脚本等 go 信号后才查询——模拟 pane 存活跨越 daemon 重启的真实时序。
    const readerScript = `
      const fs = require('node:fs');
      const ctl = ${JSON.stringify(ctlDir)};
      fs.writeFileSync(ctl + '/ready', '1');
      const tick = () => {
        if (!fs.existsSync(ctl + '/go')) return setTimeout(tick, 100);
        try {
          const { DatabaseSync } = require('node:sqlite');
          let db;
          try { db = new DatabaseSync(${JSON.stringify(dbPath)}); }
          catch { db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true }); }
          db.exec('PRAGMA busy_timeout = 3000');
          const hit = db.prepare("SELECT row FROM sessions WHERE session_id = 's1'").get();
          fs.writeFileSync(ctl + '/out', JSON.parse(hit.row).v);
        } catch (err) {
          fs.writeFileSync(ctl + '/out', 'ERR:' + (err && err.message));
        }
      };
      tick();
    `;
    const nodeDir = dirname(process.execPath);
    const pane = spawn('bwrap', [
      '--unshare-user', '--die-with-parent',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc', '/etc',
      '--ro-bind', nodeDir, nodeDir,
      '--ro-bind', storeDir, storeDir, // ← 被测形状：目录级只读授权
      '--bind', ctlDir, ctlDir,
      process.execPath, '-e', readerScript,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    try {
      await pollFor(() => existsSync(join(ctlDir, 'ready')), 'sandbox reader ready');

      // daemon 重启：关闭 writer-1（SQLite 删除 -wal/-shm）……
      writer1.close();
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      // ……新 daemon 重开 store 并提交 v2（sidecar 为全新 inode，且 v2 只在 WAL 里）。
      const writer2 = openStore();
      writer2.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
        .run(JSON.stringify({ v: 'v2' }), 's1');
      try {
        writeFileSync(join(ctlDir, 'go'), '1');
        await pollFor(() => existsSync(join(ctlDir, 'out')), 'sandbox query result');
        // 单文件 bind 的旧形状在这里永远读到 v1（钉死的旧 WAL inode）。
        expect(readFileSync(join(ctlDir, 'out'), 'utf-8')).toBe('v2');
      } finally {
        writer2.close();
      }
    } finally {
      try { pane.kill('SIGKILL'); } catch { /* already gone */ }
      for (const dir of [dataDir, ctlDir]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }, 30_000);
});
