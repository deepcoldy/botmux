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

  const realTmuxEnv = () => {
    const env = {
      ...process.env,
      PATH: savedPath,
      TMUX_TMPDIR: workDir,
    } as NodeJS.ProcessEnv;
    // If the suite itself runs inside a tmux pane, the inherited $TMUX makes
    // every tmux client ignore TMUX_TMPDIR and target the USER'S shared server
    // — kill-server would nuke their sessions. Strip it so the private-socket
    // isolation actually holds.
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
  };

  // bun's execFileSync timeout defaults to SIGTERM. A wedged `tmux kill-server`
  // (or kill-session) that ignores TERM is the same shape as the storm itself
  // and held this file until the 720s per-file wall after both cases passed.
  const forceKillTmux = (args: string[], env: NodeJS.ProcessEnv, timeout = 2_000): void => {
    try {
      execFileSync(REAL_TMUX!, args, {
        stdio: 'ignore',
        env,
        timeout,
        killSignal: 'SIGKILL',
      });
    } catch { /* already gone or deadline */ }
  };

  const disposeBackend = (backend: TmuxPipeBackend, sessionName: string): void => {
    try { backend.destroySession(); } catch { try { backend.kill(); } catch { /* already torn down */ } }
    forceKillTmux(['kill-session', '-t', sessionName], realTmuxEnv());
  };

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
      // The holder MUST NOT inherit the caller's stderr pipe. `spawnSync` kills
      // this shim at its 5s deadline, but the backgrounded child survives that
      // (the TERM trap fires in the SHELL, not in the child), reparents to init
      // and keeps the inherited fd open. MEASURED: without the redirect the
      // orphan holds `fd 2 -> socket:[...]`; with it, `fd 2 -> /dev/null`.
      //
      // This is HYGIENE, not a fix for CI run 34570428914. That run was
      // originally read here as "both cases passed, then an orphan fd held the
      // process open" — the log says otherwise: exactly ONE `(pass)` line, so
      // the SECOND case never completed. A `sleep 30` also cannot hold a 180s
      // idle timer open. Measured under the runner's own spawn shape
      // (`stdio: ['ignore','pipe','pipe']`, waiting on 'close'), with and
      // without the redirect: exit→close delta is 1ms either way. So the
      // orphan is real and worth not leaking, but the wedge's cause is still
      // open — see that run's log before blaming this shim.
      '    sleep 30 >/dev/null 2>&1 &',
      '    SLEEP_PID=$!',
      // Reap the holder on the deadline kill so no stray `sleep` outlives the
      // run at all. The redirect above still covers the window before this trap
      // is installed (and a SIGKILL, which runs no trap).
      '    trap "kill $SLEEP_PID 2>/dev/null; exit 0" TERM',
      '    wait $SLEEP_PID',
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
    const killEnv = { ...process.env, TMUX_TMPDIR: workDir };
    // Same $TMUX hazard as realTmuxEnv (which is unusable here: workDir state
    // is being torn down and PATH is already restored) — strip before killing.
    delete killEnv.TMUX;
    delete killEnv.TMUX_PANE;
    forceKillTmux(['kill-server'], killEnv);
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
      // kill() only detaches the fifo observer; the pane's `sleep 60` would
      // otherwise keep the private server busy. destroySession also drops the
      // session. Under bun test a leftover fifo handle after the first case
      // wedged the whole file until the 720s per-file wall.
      disposeBackend(backend, SESSION_NAME);
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
      disposeBackend(backend, 'bmx-stormrep2');
    }
  }, 15_000);
});
