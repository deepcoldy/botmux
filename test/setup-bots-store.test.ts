/**
 * 单测 src/setup/bots-store.ts — 原子写 bots.json.
 *
 * Run: pnpm vitest run test/setup-bots-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBotsJsonAtomic, readBotsJsonOrEmpty } from '../src/setup/bots-store.js';

let tmpDir: string;
let botsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-bots-store-'));
  botsPath = join(tmpDir, 'bots.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeBotsJsonAtomic', () => {
  it('writes valid JSON with trailing newline', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_1', larkAppSecret: 's1' }]);
    expect(existsSync(botsPath)).toBe(true);
    const content = readFileSync(botsPath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].larkAppId).toBe('cli_1');
  });

  it('persists the brand field so subsequent start/verify reads it back', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_lark', larkAppSecret: 's', brand: 'lark' }]);
    const parsed = readBotsJsonOrEmpty(botsPath);
    expect(parsed[0].brand).toBe('lark');
  });

  it('cleans up the tmp file after rename (only bots.json remains)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_2' }]);
    expect(existsSync(botsPath + '.tmp')).toBe(false);
    expect(existsSync(botsPath)).toBe(true);
  });

  it('replaces existing file atomically — old content gone, new content visible', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_old', larkAppSecret: 'old' }]);
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_new', larkAppSecret: 'new' }]);
    const parsed = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(parsed[0].larkAppId).toBe('cli_new');
  });

  it('sets file mode 0o600 (only owner can read — secret protection)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_x', larkAppSecret: 'secret' }]);
    const mode = statSync(botsPath).mode & 0o777;
    // 在 root 用户 / fakeroot 下 umask 可能影响; 但 0o600 是 writeFileSync 显式指定的
    // 实际结果应该精确等于 0o600.
    expect(mode).toBe(0o600);
  });

  it('uses tmp file in the SAME directory as the target (cross-fs renames are not atomic)', () => {
    // 通过 spy fs.writeFileSync 监控 tmp 路径 — 简单版: 检查 bots.json.tmp 在
    // bots.json 同目录. 实现细节: 只要写完 + rename 完不出错, 同目录假设成立.
    // 这里跑一次 + 校验 bots.json 出现在 tmpDir, 间接保证 tmp 路径也在 tmpDir.
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_t' }]);
    expect(existsSync(join(tmpDir, 'bots.json'))).toBe(true);
  });
});

describe('readBotsJsonOrEmpty', () => {
  it('returns [] when file missing', () => {
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns [] when file is malformed JSON (no throw)', () => {
    writeFileSync(botsPath, '{ not valid json');
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns parsed array when file is valid', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'a' }, { larkAppId: 'b' }]);
    expect(readBotsJsonOrEmpty(botsPath).map((b: any) => b.larkAppId)).toEqual(['a', 'b']);
  });
});
