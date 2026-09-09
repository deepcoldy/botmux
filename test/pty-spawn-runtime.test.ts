import { describe, expect, it } from 'vitest';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';
import { ptyRuntime } from '../src/adapters/backend/pty-spawn.js';

/**
 * PtyBackend 在**当前运行时**下必须真的能养活一个交互子进程。
 *
 * 这条测试故意走真 PTY、两种 runner 都跑：vitest（Node → node-pty）和
 * `bun test`（Bun → 原生 PTY）。改造前它在 Bun 下必红：node-pty 把 master fd
 * 包成 Bun 的 tty.ReadStream，第一次读到 EAGAIN 就自毁关 fd，子进程 ~10ms 内
 * 被内核 SIGHUP——正是 canary 里 flow agent worker「spawn_failed: exited before
 * its prompt was ready、屏幕空白」的根因。用 `sleep` 制造空闲间隙就是为了逼出
 * 那次 EAGAIN。
 */

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

function collect(backend: PtyBackend): { out: () => string; exit: Promise<{ code: number | null; signal: string | null }> } {
  let out = '';
  backend.onData((d) => { out += d; });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    backend.onExit((code, signal) => resolve({ code, signal }));
  });
  return { out: () => out, exit };
}

describe('pty-spawn runtime', () => {
  it('picks the implementation for the runtime it is running on', () => {
    expect(ptyRuntime()).toBe(isBun ? 'bun-native' : 'node-pty');
  });

  it('child survives an idle gap and late output + exit code arrive', async () => {
    const backend = new PtyBackend();
    backend.spawn('bash', ['-c', 'echo first; sleep 1; echo second; exit 3'], { cwd: '/tmp', cols: 80, rows: 24, env });
    const { out, exit } = collect(backend);
    const result = await exit;
    expect(out()).toContain('first');
    expect(out()).toContain('second');
    expect(result.code).toBe(3);
  }, 15_000);

  it('write reaches the child and resize is visible to it', async () => {
    const backend = new PtyBackend();
    backend.spawn('bash', ['-c', 'stty -echo; read -r line; stty size; echo "got:$line"'], { cwd: '/tmp', cols: 80, rows: 24, env });
    const { out, exit } = collect(backend);
    backend.resize(100, 40);
    await new Promise((r) => setTimeout(r, 300));
    backend.write('hello\r');
    const result = await exit;
    expect(result.code).toBe(0);
    expect(out()).toContain('40 100');
    expect(out()).toContain('got:hello');
  }, 15_000);

  it('kill() ends a sleeping child and reports a signal', async () => {
    const backend = new PtyBackend();
    backend.spawn('sleep', ['30'], { cwd: '/tmp', cols: 80, rows: 24, env });
    const { exit } = collect(backend);
    const pid = backend.getChildPid();
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    backend.kill();
    const result = await exit;
    // node-pty 报信号编号（SIGHUP → "1"），Bun 报信号名；都不是「正常退出」。
    expect(result.signal).not.toBeNull();
    expect(result.signal).not.toBe('0');
  }, 15_000);
});
