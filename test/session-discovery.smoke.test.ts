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
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { copyFileSync, mkdtempSync, rmSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  __testOnly_readComm,
  __testOnly_readCwd,
  __testOnly_getChildPids,
  cliIdFromCommArgv,
} from '../src/core/session-discovery.js';

let child: ChildProcessWithoutNullStreams;
let childCwd: string;
let nativeDir: string;

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

  // A real native image whose process title differs from its loaded binary.
  // No installed CLI, credentials, daemon or network connection is used.
  nativeDir = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-sd-native-')));
  const source = join(nativeDir, 'title.c');
  writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
int main(void) {
#ifdef __linux__
  if (prctl(PR_SET_NAME, "traecli", 0, 0, 0) != 0) return 2;
#else
  setprogname("traecli");
#endif
  puts("ready"); fflush(stdout); sleep(60); return 0;
}
`);
  execFileSync('cc', [source, '-o', join(nativeDir, 'traex')], { timeout: 15_000 });
  copyFileSync(join(nativeDir, 'traex'), join(nativeDir, 'coco'));
});

afterAll(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (childCwd) rmSync(childCwd, { recursive: true, force: true });
  if (nativeDir) rmSync(nativeDir, { recursive: true, force: true });
});

async function withNativeAlias(binary: string, check: (pid: number) => void): Promise<void> {
  const process = spawn(binary, [], { argv0: 'traecli', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native fixture not ready in 5s')), 5_000);
      process.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      process.once('error', error => { clearTimeout(timer); reject(error); });
      process.once('exit', code => { clearTimeout(timer); reject(new Error(`native fixture exited: ${code}`)); });
    });
    check(process.pid!);
  } finally { process.kill('SIGKILL'); }
}

describe('native traecli alias', () => {
  it.each(['traex', 'coco'] as const)('recognizes the loaded %s image despite its traecli title', async cli => {
    await withNativeAlias(join(nativeDir, cli), pid => {
      const rawComm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      expect(basename(rawComm)).toBe('traecli');
      const comm = __testOnly_readComm(pid);
      expect(comm).toBe(cli);
      expect(cliIdFromCommArgv(comm, ['traecli'], cli)).toBe(cli);
      expect(cliIdFromCommArgv(comm, ['traecli'], cli === 'traex' ? 'coco' : 'traex')).toBeUndefined();
    });
  });

  it('does not relabel a running CoCo after its launch symlink is retargeted to TRAE', async () => {
    const alias = join(nativeDir, 'traecli');
    symlinkSync(join(nativeDir, 'coco'), alias);
    await withNativeAlias(alias, pid => {
      unlinkSync(alias);
      symlinkSync(join(nativeDir, 'traex'), alias);
      expect(__testOnly_readComm(pid)).toBe('coco');
    });
  });
});

describe('readComm', () => {
  it('返回子进程的 comm 名 (basename, 不含路径)', () => {
    const comm = __testOnly_readComm(child.pid!);
    expect(comm).toBeDefined();
    // Linux /proc/<pid>/comm 给短名 "node"；BSD ps 给完整路径，readComm
    // 已统一 basename，所以这里都不应包含 "/"。
    expect(comm).not.toContain('/');
    // The child is `process.execPath`: Node on vitest, bun on `bun test`.
    // Linux `/proc/<pid>/comm` is the short name of whichever runtime we spawned.
    expect(comm).toMatch(/^(node|bun)/i);
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
