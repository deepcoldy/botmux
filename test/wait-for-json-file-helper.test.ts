import { describe, it, expect, afterEach } from 'vitest';
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
  // 旧写法「existsSync 一真就 readFileSync+JSON.parse、不重试」会在这一刻读到空
  // 文件并抛 Unexpected EOF；helper 必须重试到内容完整。
  it('retries through the create→write window when the file exists empty first', async () => {
    const f = join(tmp(), 'empty-first.json');
    writeFileSync(f, ''); // existsSync 此刻已为真，但 JSON.parse('') 会 EOF
    const payload = { prompt: '<botmux_routing>', snapshot: 'send' };
    setTimeout(() => writeFileSync(f, JSON.stringify(payload)), 60);
    await expect(waitForJsonFile<typeof payload>(f, { timeoutMs: 2_000 })).resolves.toEqual(payload);
  });

  it('retries when the file briefly holds truncated (unclosed) JSON', async () => {
    const f = join(tmp(), 'truncated.json');
    const full = JSON.stringify({ a: 1, b: 2 });
    writeFileSync(f, full.slice(0, 5)); // 半截、无法解析
    setTimeout(() => writeFileSync(f, full), 60);
    await expect(waitForJsonFile<{ a: number; b: number }>(f, { timeoutMs: 2_000 }))
      .resolves.toEqual({ a: 1, b: 2 });
  });

  // P2 回归（#3693 复审）：read/parse 必须先于 shouldStop 判断。生产方已退出但完整
  // 结果已经落盘时，helper 仍要成功返回，不能因为 shouldStop=true 就把结果丢掉。
  it('returns the complete file even when the producer already exited (shouldStop=true)', async () => {
    const f = join(tmp(), 'complete-then-stop.json');
    const payload = { prompt: '<botmux_routing>', snapshot: 'transcript' };
    writeFileSync(f, JSON.stringify(payload));
    await expect(
      waitForJsonFile<typeof payload>(f, { timeoutMs: 1_000, shouldStop: () => true }),
    ).resolves.toEqual(payload);
  });

  it('rejects when the file never appears, distinguishing "never created" in the message', async () => {
    await expect(waitForJsonFile(join(tmp(), 'missing.json'), { timeoutMs: 40 }))
      .rejects.toThrow(/文件始终未创建/);
  });

  it('distinguishes "appeared but never parseable" from "never created"', async () => {
    const f = join(tmp(), 'never-complete.json');
    writeFileSync(f, ''); // 文件出现了但一直是空的
    await expect(waitForJsonFile(f, { timeoutMs: 60, shouldStop: () => true }))
      .rejects.toThrow(/文件已出现但内容始终无法完整解析/);
  });

  // P3 回归（#3693 复审）：钉住 shouldStop 的「提前停止」而不只是「最终会 reject」。
  // timeout 给 3s，但 shouldStop 立即为真、文件又一直空时，必须在头一两个轮询
  // （20ms/次）就停止；断言耗时远小于 timeout。删掉 shouldStop 守卫后 helper 会空转
  // 满 3s 才因超时 reject，本用例即变红。
  it('stops early on shouldStop instead of waiting out the full timeout', async () => {
    const f = join(tmp(), 'stopped.json');
    writeFileSync(f, '');
    const start = Date.now();
    await expect(waitForJsonFile(f, { timeoutMs: 3_000, shouldStop: () => true }))
      .rejects.toThrow(/读到完整 JSON/);
    const elapsed = Date.now() - start;
    expect(elapsed, `expected early stop, but waited ${elapsed}ms`).toBeLessThan(1_000);
  });

  // 永久错误（路径是目录等）立即抛出，不空转到 deadline。
  it('throws immediately on a permanent read error (EISDIR) instead of retrying', async () => {
    const dir = join(tmp(), 'actually-a-directory');
    mkdirSync(dir);
    const start = Date.now();
    await expect(waitForJsonFile(dir, { timeoutMs: 2_000 })).rejects.toThrow(/EISDIR|目录|directory/i);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
