import { describe, it, expect, vi } from 'vitest';

/**
 * PtyBackend 必须把 bin/args 原样交给 pty.spawn，忽略 launchShell（那是
 * tmux/zellij/zmx 的壳包装）。用 mock 抓 spawn 参数，不走真 PTY：bun 进程内
 * node-pty 对短命 sh -c 经常丢 onData（CI tmux-backend-env 收到空串）。
 *
 * 工厂体内建 calls 数组，禁止顶层 vi.fn 被 hoist 到 mock 之前。
 */
vi.mock('node-pty', () => {
  const spawn = Object.assign(
    (bin: string, args: string[], opts: Record<string, unknown>) => {
      spawn.calls.push({ bin, args, opts });
      return {
        pid: 1,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
    },
    { calls: [] as Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> },
  );
  return { spawn };
});

import * as nodePty from 'node-pty';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';

function spawnCalls(): Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> {
  return (nodePty.spawn as typeof nodePty.spawn & {
    calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }>;
  }).calls;
}

describe('PtyBackend launchShell boundary', () => {
  it('passes bin/args through and does not wrap in launchShell', () => {
    spawnCalls().length = 0;
    const backend = new PtyBackend();
    backend.spawn('/bin/sh', ['-c', 'printf "DIRECT:%s:%s\\n" "$0" "$1"', 'cli-zero', 'arg-one'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { PATH: '/usr/bin:/bin' },
      injectEnv: { BOTMUX: '1' },
      launchShell: '/bin/fish',
    });
    expect(spawnCalls()).toHaveLength(1);
    const call = spawnCalls()[0];
    expect(call.bin).toBe('/bin/sh');
    expect(call.args).toEqual(['-c', 'printf "DIRECT:%s:%s\\n" "$0" "$1"', 'cli-zero', 'arg-one']);
    expect(call.opts).toMatchObject({
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { PATH: '/usr/bin:/bin', BOTMUX: '1' },
    });
    expect(JSON.stringify(call)).not.toMatch(/fish/i);
  });
});
