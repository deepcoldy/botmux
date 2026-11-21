import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects with a clear error when the file never appears', async () => {
    await expect(waitForJsonFile(join(tmp(), 'missing.json'), { timeoutMs: 40 }))
      .rejects.toThrow(/读到完整 JSON/);
  });

  it('stops early once shouldStop signals the producer exited', async () => {
    const f = join(tmp(), 'stopped.json');
    writeFileSync(f, ''); // 一直空，靠 shouldStop 提前结束而不是空转到超时
    await expect(waitForJsonFile(f, { timeoutMs: 5_000, shouldStop: () => true }))
      .rejects.toThrow(/读到完整 JSON/);
  });
});
