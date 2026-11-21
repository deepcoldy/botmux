import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForJsonFile } from './helpers/wait-for-json-file.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wait-json-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('waitForJsonFile', () => {
  it('returns parsed JSON from an already-complete file', async () => {
    const f = join(tmp(), 'ready.json');
    const payload = { ok: true, n: 1 };
    writeFileSync(f, JSON.stringify(payload));
    await expect(waitForJsonFile<typeof payload>(f, { timeoutMs: 200 })).resolves.toEqual(payload);
  });

  // 回归 #3692：文件被 create/truncate 后 existsSync 立即为真，但内容尚未写完。
  // 直接 read/parse 会在这一刻读到空文件抛 EOF；helper 必须重试到内容完整。
  it('retries through the create→write window when the file exists empty first', async () => {
    const f = join(tmp(), 'empty-first.json');
    writeFileSync(f, '');
    const payload = { prompt: '<botmux_routing>', snapshot: 'send' };
    setTimeout(() => writeFileSync(f, JSON.stringify(payload)), 60);
    await expect(waitForJsonFile<typeof payload>(f, { timeoutMs: 2_000 })).resolves.toEqual(payload);
  });

  it('retries when the file briefly holds truncated (unclosed) JSON', async () => {
    const f = join(tmp(), 'truncated.json');
    const full = JSON.stringify({ a: 1, b: 2 });
    writeFileSync(f, full.slice(0, 5));
    setTimeout(() => writeFileSync(f, full), 60);
    await expect(waitForJsonFile<{ a: number; b: number }>(f, { timeoutMs: 2_000 }))
      .resolves.toEqual({ a: 1, b: 2 });
  });

  // read/parse 必须先于 shouldStop：生产方已退出但完整结果已落盘时仍要成功，不能丢结果。
  it('returns the complete file even when the producer already exited (shouldStop=true)', async () => {
    const f = join(tmp(), 'complete-then-stop.json');
    const payload = { prompt: '<botmux_routing>', snapshot: 'transcript' };
    writeFileSync(f, JSON.stringify(payload));
    await expect(
      waitForJsonFile<typeof payload>(f, { timeoutMs: 1_000, shouldStop: () => true }),
    ).resolves.toEqual(payload);
  });

  // P2 回归（#3693 二轮）：writer 在 deadline 临近时写完，循环因到期退出后补读一次，
  // 不能出现「抛超时但文件其实已完整」的漏读。用真实 timer 验证功能，不卡墙钟余量。
  it('still returns the result when the writer finishes just before the deadline', async () => {
    const f = join(tmp(), 'deadline-edge.json');
    const payload = { ok: 1 };
    setTimeout(() => writeFileSync(f, JSON.stringify(payload)), 45);
    await expect(waitForJsonFile<typeof payload>(f, { timeoutMs: 55 })).resolves.toEqual(payload);
  });

  it('rejects when the file never appears, distinguishing "never created" in the message', async () => {
    await expect(waitForJsonFile(join(tmp(), 'missing.json'), { timeoutMs: 40 }))
      .rejects.toThrow(/文件始终未创建/);
  });

  it('distinguishes "appeared but never parseable" from "never created"', async () => {
    const f = join(tmp(), 'never-complete.json');
    writeFileSync(f, '');
    await expect(waitForJsonFile(f, { timeoutMs: 60, shouldStop: () => true }))
      .rejects.toThrow(/文件已出现但内容始终无法完整解析/);
  });

  // P3 回归（#3693 一轮）：用可控 timer 钉住「提前停止」。shouldStop 立即为真时 helper
  // 在第一轮 read 后就 break、根本不该安排轮询 setTimeout——断言 spy 零调用，不依赖
  // 墙钟，CI 调度停顿也不会让它 flake。删掉 shouldStop 守卫后 helper 会走到 sleep，
  // setTimeout 被调用，本用例即咬红。
  it('stops early on shouldStop without scheduling any poll timer (fake timers)', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const f = join(tmp(), 'stopped.json');
    writeFileSync(f, '');
    await expect(waitForJsonFile(f, { timeoutMs: 3_000, shouldStop: () => true }))
      .rejects.toThrow(/读到完整 JSON/);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  // shouldStop 每轮最多调一次，提前停止的失败诊断复用记录值，不重复回调。
  it('invokes shouldStop at most once on the early-stop path', async () => {
    const f = join(tmp(), 'once.json');
    writeFileSync(f, '');
    let calls = 0;
    await expect(waitForJsonFile(f, { timeoutMs: 100, shouldStop: () => { calls++; return true; } }))
      .rejects.toThrow(/读到完整 JSON/);
    expect(calls).toBe(1);
  });

  // 永久错误（路径是目录/中间组件非目录等）立即抛出，不空转到 deadline。
  it('throws immediately on a permanent read error (EISDIR) instead of retrying', async () => {
    const dir = join(tmp(), 'actually-a-directory');
    mkdirSync(dir);
    const start = Date.now();
    await expect(waitForJsonFile(dir, { timeoutMs: 2_000 })).rejects.toThrow(/EISDIR|目录|directory/i);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  // ENOTDIR 不经 existsSync 预检（已移除），直接 read 就能暴露并立即失败。
  it('throws immediately on ENOTDIR instead of waiting out the timeout', async () => {
    const blocker = join(tmp(), 'regular-file');
    writeFileSync(blocker, 'x');
    const enotdir = join(blocker, 'child.json');
    const start = Date.now();
    await expect(waitForJsonFile(enotdir, { timeoutMs: 2_000 })).rejects.toThrow(/ENOTDIR/);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
