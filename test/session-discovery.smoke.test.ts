/**
 * 跨平台冒烟测试：`readComm` / `readCwd` / `getChildPids` 必须在 Linux 和
 * macOS 上都能正确识别一个真实的子进程。
 *
 * 这里**不 mock**任何东西 —— 直接 spawn 一个 Node 子进程当 target，跑实际
 * 命令验证返回值。和 session-discovery.test.ts 的 mock-based 单测互补：
 * - mock-based 单测覆盖 discovery 的组合逻辑、tmux 输出解析、边界 case
 * - smoke 测试切实抓平台命令兼容性（macOS BSD ps 不支持 GNU 长选项 `--ppid`
 *   等历史回归，纯 mock 测不到）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  __testOnly_readComm,
  __testOnly_readCwd,
  __testOnly_getChildPids,
} from '../src/core/session-discovery.js';

let child: ChildProcessWithoutNullStreams;
let childCwd: string;

beforeAll(async () => {
  // macOS 的 tmpdir 通常是 /var/folders/.. 的软链，真实路径在 /private/var/...
  // lsof 返回 resolve 后的路径，提前 realpath 一下让断言里两边形态一致。
  childCwd = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-sd-')));
  // 用一个会保持运行 60s 的 Node 子进程当 target。stdout 输出 "ready" 后
  // 才认为 cwd / pid 都已稳定。
  child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready\\n"); setTimeout(() => {}, 60000);'],
    { cwd: childCwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child not ready in 5s')), 5000);
    child.stdout.once('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
});

afterAll(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (childCwd) rmSync(childCwd, { recursive: true, force: true });
});

describe('readComm', () => {
  it('返回子进程的 comm 名 (basename, 不含路径)', () => {
    const comm = __testOnly_readComm(child.pid!);
    expect(comm).toBeDefined();
    // Linux /proc/<pid>/comm 给短名 "node"；BSD ps 给完整路径，readComm
    // 已统一 basename，所以这里都不应包含 "/"。
    expect(comm).not.toContain('/');
    expect(comm).toMatch(/^node/i);
  });

  it('对不存在的 PID 返回 undefined', () => {
    // 取一个明显不存在的大 PID。ps / /proc 都读不到。
    expect(__testOnly_readComm(2_000_000)).toBeUndefined();
  });
});

describe('readCwd', () => {
  it('返回子进程的工作目录', () => {
    const cwd = __testOnly_readCwd(child.pid!);
    expect(cwd).toBeDefined();
    expect(cwd).toBe(childCwd);
  });

  it('对不存在的 PID 返回 undefined', () => {
    expect(__testOnly_readCwd(2_000_000)).toBeUndefined();
  });
});

describe('getChildPids', () => {
  it('能在当前进程的子进程列表里找到 spawn 出来的 child', () => {
    const children = __testOnly_getChildPids(process.pid);
    expect(children).toContain(child.pid);
  });

  it('对不存在的 PID 返回空数组', () => {
    expect(__testOnly_getChildPids(2_000_000)).toEqual([]);
  });
});
