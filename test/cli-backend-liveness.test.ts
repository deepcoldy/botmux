/**
 * cliProcessAliveFromBackend 单测：worker 注入给适配器 isSessionBusy 的
 * 「CLI 宿主进程是否存活」探针。
 *
 * Run: npx vitest run --project unit test/cli-backend-liveness.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnTsEval } from './helpers/ts-runner.js';
import { cliProcessAliveFromBackend } from '../src/adapters/cli/backend-liveness.js';

function startSleep(ms: number) {
  // 自包含片段（无仓库 import），用 runtime 感知的 spawnTsEval（见
  // test/helpers/ts-runner.ts：Bun 下 `bun -e`，Node 下 `node --input-type=module -e`）。
  return spawnTsEval(`setTimeout(()=>{},${ms})`, {
    stdio: 'ignore',
  });
}

describe('cliProcessAliveFromBackend', () => {
  it('returns undefined when the backend or any pid source is missing', () => {
    expect(cliProcessAliveFromBackend(undefined)).toBeUndefined();
    expect(cliProcessAliveFromBackend(null)).toBeUndefined();
    expect(cliProcessAliveFromBackend({})).toBeUndefined();
    expect(cliProcessAliveFromBackend({ getChildPid: () => undefined })).toBeUndefined();
  });

  it('rejects non-process pid values (0 / negative / fractional / NaN)', () => {
    expect(cliProcessAliveFromBackend({ cliPid: 0 })).toBeUndefined();
    expect(cliProcessAliveFromBackend({ cliPid: -1 })).toBeUndefined();
    expect(cliProcessAliveFromBackend({ cliPid: 1.5 })).toBeUndefined();
    expect(cliProcessAliveFromBackend({ cliPid: Number.NaN })).toBeUndefined();
    expect(cliProcessAliveFromBackend({ getChildPid: () => -100 })).toBeUndefined();
  });

  it('returns false for a pid that does not exist (ESRCH)', () => {
    // 2^22 附近的 pid 在本机命名空间内几乎必然空闲
    expect(cliProcessAliveFromBackend({ cliPid: 4_194_300 })).toBe(false);
  });

  it('tracks a real child process: true while alive, false after exit', async () => {
    const child = startSleep(30_000);
    await new Promise<void>((res) => child.on('spawn', () => res()));
    const pid = child.pid!;
    expect(cliProcessAliveFromBackend({ cliPid: pid })).toBe(true);

    child.kill('SIGKILL');
    await new Promise<void>((res) => child.on('exit', () => res()));
    expect(cliProcessAliveFromBackend({ cliPid: pid })).toBe(false);
  });

  it('uses getChildPid() when cliPid is not bound (tmux pane path)', async () => {
    const child = startSleep(30_000);
    await new Promise<void>((res) => child.on('spawn', () => res()));
    expect(cliProcessAliveFromBackend({ getChildPid: () => child.pid })).toBe(true);
    child.kill('SIGKILL');
    await new Promise<void>((res) => child.on('exit', () => res()));
    expect(cliProcessAliveFromBackend({ getChildPid: () => child.pid })).toBe(false);
  });

  it('prefers the explicitly bound cliPid over getChildPid()', () => {
    // 绑定了一个死 pid，getChildPid 给出生存 pid 时仍以绑定值为准
    expect(cliProcessAliveFromBackend({
      cliPid: 4_194_301,
      getChildPid: () => process.ppid,
    })).toBe(false);
  });
});
