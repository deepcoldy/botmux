/**
 * scripts/test-concurrency.mjs：本机测试的整机并发闸 + 默认 worker 数。
 *   - 并发参数：CI 交回各工具默认值；本机按核数算名额与 worker 数，环境变量可覆盖；
 *   - 名额：真实 flock，满了就排队，持有者释放或进程被杀后下一个拿到；
 *   - flock 不可用时放行，不挡测试；vitest 小批量（定向测试）不排队。
 */
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  acquireTestSlot,
  gateVitestRun,
  resolveTestConcurrency,
} from '../scripts/test-concurrency.mjs';

const MODULE_URL = pathToFileURL(join(__dirname, '..', 'scripts', 'test-concurrency.mjs')).href;
const hasFlock = process.platform === 'linux' && ['/usr/bin/flock', '/bin/flock'].some(p => existsSync(p));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch { /* best-effort */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-test-gate-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const quietLog = () => {};

describe('resolveTestConcurrency', () => {
  it('CI 上不排队、不改 worker 数（交回 vitest / runner 默认值）', () => {
    for (const CI of ['true', '1']) {
      const r = resolveTestConcurrency({ env: { CI }, cpus: 64, platform: 'linux' });
      expect(r).toMatchObject({ ci: true, gated: false, maxWorkers: undefined });
    }
  });

  it('CI=false / 0 / 空串按本机处理', () => {
    for (const CI of ['false', '0', '']) {
      expect(resolveTestConcurrency({ env: { CI }, cpus: 64, platform: 'linux' }).gated).toBe(true);
    }
  });

  it('本机默认：名额 = 核数 / 16（至少 1），worker = 核数 / 名额（封顶 16），合计不超过核数', () => {
    for (const cpus of [1, 4, 8, 16, 24, 64, 128, 192]) {
      const r = resolveTestConcurrency({ env: {}, cpus, platform: 'linux' });
      expect(r.slots).toBe(Math.max(1, Math.floor(cpus / 16)));
      expect(r.maxWorkers).toBeGreaterThanOrEqual(1);
      expect(r.maxWorkers).toBeLessThanOrEqual(16);
      expect(r.slots! * r.maxWorkers!).toBeLessThanOrEqual(Math.max(cpus, 1));
    }
    expect(resolveTestConcurrency({ env: {}, cpus: 64, platform: 'linux' })).toMatchObject({ slots: 4, maxWorkers: 16 });
  });

  it('环境变量覆盖；非法值回落默认', () => {
    const r = resolveTestConcurrency({
      env: { BOTMUX_TEST_SLOTS: '2', BOTMUX_TEST_MAX_WORKERS: '3', BOTMUX_TEST_GATE_MIN_FILES: '7', BOTMUX_TEST_SLOT_DIR: '/x/y' },
      cpus: 64,
      platform: 'linux',
    });
    expect(r).toMatchObject({ gated: true, slots: 2, maxWorkers: 3, minFiles: 7, slotDir: '/x/y' });
    const bad = resolveTestConcurrency({ env: { BOTMUX_TEST_SLOTS: '-1', BOTMUX_TEST_MAX_WORKERS: 'abc' }, cpus: 64, platform: 'linux' });
    expect(bad).toMatchObject({ slots: 4, maxWorkers: 16 });
    // 只改名额时 worker 数跟着名额算
    expect(resolveTestConcurrency({ env: { BOTMUX_TEST_SLOTS: '8' }, cpus: 64, platform: 'linux' }).maxWorkers).toBe(8);
  });

  it('BOTMUX_TEST_GATE=0 只关闸，worker 数照算；非 Linux 不开闸', () => {
    expect(resolveTestConcurrency({ env: { BOTMUX_TEST_GATE: '0' }, cpus: 64, platform: 'linux' }))
      .toMatchObject({ gated: false, maxWorkers: 16 });
    expect(resolveTestConcurrency({ env: {}, cpus: 64, platform: 'darwin' })).toMatchObject({ gated: false, maxWorkers: 16 });
  });
});

describe.skipIf(!hasFlock)('acquireTestSlot（真实 flock）', () => {
  it('名额满时排队，持有者释放后拿到', async () => {
    const slotDir = tempDir();
    const a = await acquireTestSlot({ slots: 2, slotDir, log: quietLog });
    const b = await acquireTestSlot({ slots: 2, slotDir, log: quietLog });
    cleanups.push(a.release, b.release);
    expect([a.slot, b.slot].sort()).toEqual([0, 1]);

    const logs: string[] = [];
    let waits = 0;
    const c = await acquireTestSlot({
      slots: 2,
      slotDir,
      log: m => logs.push(m),
      sleep: async () => {
        waits += 1;
        if (waits === 1) b.release();
        await new Promise(r => setTimeout(r, 50));
      },
    });
    cleanups.push(c.release);
    expect(waits).toBeGreaterThanOrEqual(1);
    // 释放要立刻生效（每轮 50ms，≤ 5s），而不是等某个残留子进程自己退出。
    expect(waits).toBeLessThan(100);
    expect(c.slot).toBe(b.slot);
    expect(logs.some(m => m.includes('名额已满'))).toBe(true);
  }, 30_000);

  it('持有名额的进程被 SIGKILL 后，名额自动释放', async () => {
    const slotDir = tempDir();
    const script = join(tempDir(), 'holder.mjs');
    writeFileSync(script, [
      `const { acquireTestSlot } = await import(${JSON.stringify(MODULE_URL)});`,
      `await acquireTestSlot({ slots: 1, slotDir: ${JSON.stringify(slotDir)}, log: () => {} });`,
      `process.stdout.write('acquired\\n');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'));
    const holder = spawnTsScript(script, [], { stdio: ['ignore', 'pipe', 'inherit'] }) as ChildProcess;
    cleanups.push(() => { try { holder.kill('SIGKILL'); } catch { /* */ } });
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.setEncoding('utf8');
      holder.stdout!.on('data', (d: string) => { if (d.includes('acquired')) resolve(); });
      holder.once('exit', code => reject(new Error(`holder exited early: ${code}`)));
    });

    let waits = 0;
    const got = await acquireTestSlot({
      slots: 1,
      slotDir,
      log: quietLog,
      sleep: async () => {
        waits += 1;
        if (waits === 1) holder.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 50));
      },
    });
    cleanups.push(got.release);
    expect(waits).toBeGreaterThanOrEqual(1);
    expect(waits).toBeLessThan(100);
    expect(got.slot).toBe(0);
  }, 30_000);
});

describe('acquireTestSlot 降级', () => {
  it('flock 起不来时放行（slot=-1）并提示', async () => {
    const logs: string[] = [];
    const r = await acquireTestSlot({
      slots: 1,
      slotDir: tempDir(),
      log: m => logs.push(m),
      spawnImpl: (() => { throw Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT' }); }) as never,
    });
    expect(r.slot).toBe(-1);
    expect(logs.join('\n')).toContain('flock');
  });
});

describe('gateVitestRun', () => {
  it('选中文件数低于门槛（定向测试）不排队、不建名额目录', async () => {
    const slotDir = join(tempDir(), 'slots');
    await gateVitestRun(3, { ci: false, gated: true, slots: 1, maxWorkers: 4, minFiles: 50, slotDir });
    expect(existsSync(slotDir)).toBe(false);
  });

  it('关闸时大批量也不排队', async () => {
    const slotDir = join(tempDir(), 'slots');
    await gateVitestRun(5000, { ci: false, gated: false, slots: 1, maxWorkers: 4, minFiles: 50, slotDir });
    expect(existsSync(slotDir)).toBe(false);
  });
});
