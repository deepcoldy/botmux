/**
 * 2026-11-06：fleet 的 tmux server 丢失后，全部 pane 一起消失；server 重建期间
 * 刚 resume 起来的 pane 又被波及一次，worker 把这两次都算作「CLI 连续重启」，
 * 71 个会话被 tier-2 强制成 FRESH，丢了上下文。
 *
 * 这里用真 tmux（私有 socket）+ 真 TmuxPipeBackend 钉住两件事：
 *  - server 被换掉（同一 socket 上换了一个 pid 不同的 server）→ 退出被标成
 *    exitedBecauseServerReplaced，restart 不消耗 FRESH 预算；
 *  - CLI 自己退出（server 仍是同一个）→ 不标，崩溃的 resume 仍会回落 FRESH。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxPipeBackend, paneLossWasServerReplacement } from '../src/adapters/backend/tmux-pipe-backend.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

const EXIT_TIMEOUT_MS = 60_000;

describe('paneLossWasServerReplacement', () => {
  it('is true only when both pids are known and differ', () => {
    expect(paneLossWasServerReplacement(100, 200)).toBe(true);
    expect(paneLossWasServerReplacement(100, 100)).toBe(false);
    expect(paneLossWasServerReplacement(undefined, 200)).toBe(false);
    expect(paneLossWasServerReplacement(100, undefined)).toBe(false);
  });
});

describe.skipIf(!realTmux)('TmuxPipeBackend tells a lost tmux server apart from a CLI exit', () => {
  let dir: string;
  const socket = 'bmxrep';
  const saved: Record<string, string | undefined> = {};
  let seq = 0;
  // Private: TMUX_TMPDIR points at this test's own EXISTING temp dir.
  const tmux = (...args: string[]) =>
    spawnSync(realTmux!, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5_000, env: { ...process.env } });

  const launch = (script: string) => {
    const name = `bmx-replaced${++seq}`;
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true, socketName: socket });
    const workdir = mkdtempSync(join(dir, 'cwd-'));
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} never reported an exit`)), EXIT_TIMEOUT_MS);
      backend.onExit(() => { clearTimeout(timer); resolve(); });
    });
    backend.spawn('/bin/sh', ['-c', script], {
      cwd: workdir, cols: 100, rows: 30,
      env: { ...process.env } as Record<string, string>,
      paneLaunchDir: workdir,
    });
    return { backend, exited };
  };

  /** Wait until the backend's own liveness probe has seen the pane alive. */
  const waitSeenAlive = async (backend: TmuxPipeBackend) => {
    const deadline = Date.now() + 20_000;
    while ((backend as unknown as { lastLiveServerPid?: number }).lastLiveServerPid === undefined) {
      if (Date.now() > deadline) throw new Error('liveness probe never saw the pane alive');
      await new Promise(r => setTimeout(r, 100));
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-replaced-'));
    for (const key of ['TMUX_TMPDIR', 'SHELL', 'TMUX', 'TMUX_PANE']) saved[key] = process.env[key];
    process.env.TMUX_TMPDIR = dir;
    process.env.SHELL = '/bin/sh';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterEach(() => {
    // Kill this test's private server while TMUX_TMPDIR still points at it.
    tmux('kill-server');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSandboxScratch(dir);
  });

  it('marks the exit when a different server took over the socket', async () => {
    const { backend, exited } = launch('exec sleep 600');
    await waitSeenAlive(backend);
    // Only this test's own private server (-S inside its temp dir) is killed.
    tmux('kill-server');
    expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'replacement', 'sleep 600').status).toBe(0);
    await exited;
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
  }, EXIT_TIMEOUT_MS + 30_000);

  it('does not mark a CLI that exits on its own while the server stays', async () => {
    expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', 'sleep 600').status).toBe(0);
    const { backend, exited } = launch('sleep 4; exit 0');
    await waitSeenAlive(backend);
    await exited;
    expect(backend.exitedBecauseServerReplaced()).toBe(false);
  }, EXIT_TIMEOUT_MS + 30_000);
});
