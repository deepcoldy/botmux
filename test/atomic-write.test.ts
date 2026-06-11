/**
 * atomic-write.test.ts — utils/atomic-write 的单元测试。
 *
 * 覆盖：基本写入/覆盖、Buffer、mode 透传、写失败不破坏旧文件、tmp 清理、
 * 并发写同一目标时读者永远看到完整内容（同进程并发近似模拟多进程场景）、
 * symlink 目标穿透写真实文件不替换链接本体。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync, existsSync, symlinkSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync, atomicWriteFile } from '../src/utils/atomic-write.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('写入新文件', () => {
    const fp = join(dir, 'a.json');
    atomicWriteFileSync(fp, '{"x":1}');
    expect(readFileSync(fp, 'utf-8')).toBe('{"x":1}');
  });

  it('覆盖已有文件', () => {
    const fp = join(dir, 'a.json');
    writeFileSync(fp, 'old');
    atomicWriteFileSync(fp, 'new');
    expect(readFileSync(fp, 'utf-8')).toBe('new');
  });

  it('支持 Buffer', () => {
    const fp = join(dir, 'b.bin');
    const buf = Buffer.from([0, 1, 2, 255]);
    atomicWriteFileSync(fp, buf);
    expect(readFileSync(fp)).toEqual(buf);
  });

  it('mode 透传（0600 密钥 / 0755 可执行）', () => {
    const secret = join(dir, 'secret');
    atomicWriteFileSync(secret, 's3cret', { mode: 0o600 });
    expect(statSync(secret).mode & 0o777).toBe(0o600);

    const script = join(dir, 'wrapper');
    atomicWriteFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    expect(statSync(script).mode & 0o777).toBe(0o755);
  });

  it('mode 不被 umask 截断（umask 077 下 0755 仍精确生效）', () => {
    const prev = process.umask(0o077);
    try {
      const fp = join(dir, 'wrapper-strict');
      atomicWriteFileSync(fp, '#!/bin/sh\n', { mode: 0o755 });
      expect(statSync(fp).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prev);
    }
  });

  it('不留 tmp 残骸', () => {
    const fp = join(dir, 'a.json');
    atomicWriteFileSync(fp, 'data');
    atomicWriteFileSync(fp, 'data2');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('写失败（目录不存在）不破坏目标、抛错、不留 tmp', () => {
    const fp = join(dir, 'no-such-dir', 'a.json');
    expect(() => atomicWriteFileSync(fp, 'data')).toThrow();
    expect(existsSync(join(dir, 'no-such-dir'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('目标是 symlink 时穿透写真实文件，不替换链接本体（dotfiles 场景）', () => {
    // 模拟 dotfiles：~/.claude/settings.json -> ~/dotfiles/claude-settings.json
    const real = join(dir, 'real-settings.json');
    writeFileSync(real, '{"old":true}');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);

    atomicWriteFileSync(link, '{"new":true}');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);   // 链接本体还在
    expect(readFileSync(real, 'utf-8')).toBe('{"new":true}'); // 真实目标被更新
    expect(readFileSync(link, 'utf-8')).toBe('{"new":true}');
  });

  it('父目录是 symlink、目标尚不存在时，新文件落在真实目录', () => {
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    const linkDir = join(dir, 'link-dir');
    symlinkSync(realDir, linkDir);

    atomicWriteFileSync(join(linkDir, 'new.json'), '{"x":1}');

    expect(readFileSync(join(realDir, 'new.json'), 'utf-8')).toBe('{"x":1}');
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
  });

  it('并发写者各用唯一 tmp，互不相撕', () => {
    // 同一目标连续/交错写多次后内容必须是某一次写入的完整值，
    // 且目录里没有 tmp 残留（唯一名保证两次写不会共用 tmp）。
    const fp = join(dir, 'shared.json');
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ writer: i, data: 'x'.repeat(1000) }));
    for (const p of payloads) atomicWriteFileSync(fp, p);
    expect(payloads).toContain(readFileSync(fp, 'utf-8'));
    expect(readdirSync(dir)).toEqual(['shared.json']);
  });
});

describe('atomicWriteFile (async)', () => {
  it('写入与覆盖', async () => {
    const fp = join(dir, 'a.json');
    await atomicWriteFile(fp, 'v1');
    await atomicWriteFile(fp, 'v2');
    expect(readFileSync(fp, 'utf-8')).toBe('v2');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('并发 async 写同一目标，结果是某一次的完整内容', async () => {
    const fp = join(dir, 'c.json');
    const payloads = Array.from({ length: 10 }, (_, i) => JSON.stringify({ writer: i, pad: 'y'.repeat(5000) }));
    await Promise.all(payloads.map((p) => atomicWriteFile(fp, p)));
    expect(payloads).toContain(readFileSync(fp, 'utf-8'));
    expect(readdirSync(dir)).toEqual(['c.json']);
  });

  it('写失败不破坏旧文件', async () => {
    const fp = join(dir, 'no-such-dir', 'a.json');
    await expect(atomicWriteFile(fp, 'data')).rejects.toThrow();
  });

  it('Buffer 内容往返一致（content-addressed blob 场景）', async () => {
    const fp = join(dir, 'blob');
    const buf = Buffer.from('blob-content-'.repeat(100));
    await atomicWriteFile(fp, buf);
    expect(readFileSync(fp)).toEqual(buf);
  });

  it('目标是 symlink 时穿透写真实文件，不替换链接本体', async () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, 'old');
    const link = join(dir, 'link.json');
    symlinkSync(real, link);

    await atomicWriteFile(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf-8')).toBe('new');
  });

  it('mode 不被 umask 截断（async 版）', async () => {
    const prev = process.umask(0o077);
    try {
      const fp = join(dir, 'strict');
      await atomicWriteFile(fp, 'x', { mode: 0o755 });
      expect(statSync(fp).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prev);
    }
  });
});
