/**
 * 真实场景回归 — 2026-08-23 tmux 恢复风暴事故复现（真实 tmux，独立 socket）。
 *
 * 事故时序：共享 tmux server 意外退出 → 全部会话的 worker 同时冷重建（261 个
 * 会话 / ~40s，load ≈ 17）→ 个别 `tmux new-session` 在服务端**已成功建出会话**，
 * 但客户端压到 execFileSync 的 5s deadline —— 且客户端恰好在 kill 窗口内自己
 * 干净退出（numeric status + 无 signal + 空 stderr + ETIMEDOUT error 并存）。
 * 旧分类器把这读成「服务端确定性拒绝」→ 不重试 → worker fatal → 沉睡多日的
 * 会话收到「会话启动失败: spawnSync tmux ETIMEDOUT」。
 *
 * 本测试用 PATH shim 包住真实 tmux 精确复刻这一时序：
 *   - 第一次 `new-session` 先转发给真实 tmux（服务端真实建出 bmx-* 会话），
 *     然后 trap TERM 后台 sleep 顶住客户端直到 deadline，被 kill 时 `exit 0`
 *     —— 制造出与事故完全一致的「clean exit + ETIMEDOUT」错误形状；
 *   - 后续所有调用原样透传真实 tmux。
 * 断言 TmuxPipeBackend.spawn() 自愈成功：重试撞上 "duplicate session" 被识别为
 * 「上一次超时的尝试其实已建成」→ 收编该会话、pipe-pane 正常挂上，全程无异常。
 *
 * 全部 tmux 流量走本测试专属 TMUX_TMPDIR（私有 socket），绝不触碰共享 default
 * server 上的真实会话。
 *
 * Run:  pnpm vitest run test/tmux-startup-storm-recovery.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';

function realTmuxPath(): string | null {
  try {
    return execSync('command -v tmux', { encoding: 'utf-8', shell: '/bin/sh' }).trim() || null;
  } catch {
    return null;
  }
}

const REAL_TMUX = realTmuxPath();
const SESSION_NAME = 'bmx-stormrep';

describe.skipIf(!REAL_TMUX)('tmux startup storm recovery (real tmux, shimmed deadline)', () => {
  let workDir: string;
  let shimDir: string;
  let markerPath: string;
  let attemptLogPath: string;
  let savedPath: string | undefined;
  let savedTmuxTmpdir: string | undefined;

  const realTmuxEnv = () => ({
    ...process.env,
    PATH: savedPath,
    TMUX_TMPDIR: workDir,
  } as NodeJS.ProcessEnv);

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'bmx-storm-'));
    shimDir = join(workDir, 'shim');
    markerPath = join(workDir, 'first-new-session.marker');
    attemptLogPath = join(workDir, 'new-session-attempts.log');
    execSync(`mkdir -p ${shimDir}`);

    // The shim IS the storm: first new-session really creates the session on
    // the (private) server, then holds the client past the caller's 5s
    // deadline and converts the deadline kill into a CLEAN exit 0 — the exact
    // 08-23 error shape (numeric status + no signal + ETIMEDOUT attached).
    const shim = [
      '#!/bin/sh',
      `REAL='${REAL_TMUX}'`,
      `MARKER='${markerPath}'`,
      `ATTEMPTS='${attemptLogPath}'`,
      'if [ "$1" = "new-session" ]; then',
      '  echo attempt >> "$ATTEMPTS"',
      '  if [ ! -e "$MARKER" ]; then',
      '    : > "$MARKER"',
      '    "$REAL" "$@"',
      '    trap "exit 0" TERM',
      '    sleep 30 &',
      '    wait $!',
      '    exit 0',
      '  fi',
      'fi',
      'exec "$REAL" "$@"',
      '',
    ].join('\n');
    const shimPath = join(shimDir, 'tmux');
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);

    savedPath = process.env.PATH;
    savedTmuxTmpdir = process.env.TMUX_TMPDIR;
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
    // Private socket dir: the storm must never touch the shared default server.
    process.env.TMUX_TMPDIR = workDir;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = savedTmuxTmpdir;
    try {
      execFileSync(REAL_TMUX!, ['kill-server'], {
        stdio: 'ignore',
        env: { ...process.env, TMUX_TMPDIR: workDir },
        timeout: 5000,
      });
    } catch { /* server already gone */ }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('self-heals a new-session that succeeded server-side but hit the client deadline', () => {
    const backend = new TmuxPipeBackend(SESSION_NAME, { createSession: true, ownsSession: true });
    const startedAt = Date.now();
    expect(() => backend.spawn('sleep', ['60'], {
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    })).not.toThrow();
    const elapsedMs = Date.now() - startedAt;

    try {
      // The deadline genuinely fired (this was not a fast-path success) …
      expect(existsSync(markerPath)).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      // … the retry ran and adopted the already-created session ("duplicate
      // session" answered by the real server) instead of failing the launch.
      const attempts = readFileSync(attemptLogPath, 'utf-8').trim().split('\n').length;
      expect(attempts).toBe(2);
      // The session the timed-out first attempt created is alive and is the one
      // we attached to (authoritative check against the real server).
      expect(() => execFileSync(REAL_TMUX!, ['has-session', '-t', SESSION_NAME], {
        stdio: 'ignore',
        env: realTmuxEnv(),
        timeout: 5000,
      })).not.toThrow();
      // Live-pane plumbing works end to end after the recovery.
      expect(() => backend.sendText('storm-recovery-probe')).not.toThrow();
    } finally {
      backend.kill();
    }
  }, 25_000);

  it('subsequent launches on the recovered server take the fast path (no residual storm)', () => {
    const backend = new TmuxPipeBackend('bmx-stormrep2', { createSession: true, ownsSession: true });
    const startedAt = Date.now();
    expect(() => backend.spawn('sleep', ['60'], {
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    })).not.toThrow();
    try {
      expect(Date.now() - startedAt).toBeLessThan(4000);
    } finally {
      backend.kill();
      try {
        execFileSync(REAL_TMUX!, ['kill-session', '-t', 'bmx-stormrep2'], {
          stdio: 'ignore', env: realTmuxEnv(), timeout: 5000,
        });
      } catch { /* already gone */ }
    }
  }, 15_000);
});
