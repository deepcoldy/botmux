import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneFilesByAge } from '../src/utils/prune-by-age.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bm-prune-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function touch(name: string, ageMs: number): void {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  const t = Date.now() - ageMs;
  utimesSync(p, t / 1000, t / 1000);
}

describe('pruneFilesByAge', () => {
  it('removes files older than maxAge but keeps recent ones', () => {
    touch('old1.json', 10_000);
    touch('old2.json', 8_000);
    touch('new.json', 1_000);
    const removed = pruneFilesByAge({ dir, maxAgeMs: 5_000, retainMin: 0 });
    expect(removed).toBe(2);
    expect(existsSync(join(dir, 'old1.json'))).toBe(false);
    expect(existsSync(join(dir, 'new.json'))).toBe(true);
  });

  it('keeps at least retainMin newest files even when all are expired', () => {
    touch('a.json', 100_000);
    touch('b.json', 90_000);
    touch('c.json', 80_000);
    const removed = pruneFilesByAge({ dir, maxAgeMs: 1_000, retainMin: 2 });
    expect(removed).toBe(1); // 只删最旧的 a
    expect(existsSync(join(dir, 'b.json'))).toBe(true);
    expect(existsSync(join(dir, 'c.json'))).toBe(true);
  });

  it('only touches files matching suffix', () => {
    touch('a.json', 9_000);
    touch('keep.txt', 9_000);
    const removed = pruneFilesByAge({ dir, maxAgeMs: 1_000, retainMin: 0, suffix: '.json' });
    expect(removed).toBe(1);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('returns 0 for a missing or empty directory', () => {
    expect(pruneFilesByAge({ dir: join(dir, 'nope'), maxAgeMs: 1000 })).toBe(0);
    expect(pruneFilesByAge({ dir, maxAgeMs: 1000 })).toBe(0);
  });

  it('does nothing when file count is at or below retainMin', () => {
    touch('a.json', 9_000);
    expect(pruneFilesByAge({ dir, maxAgeMs: 1, retainMin: 5 })).toBe(0);
    expect(existsSync(join(dir, 'a.json'))).toBe(true);
  });

  it('defaults retainMin to 1: all expired still keeps the newest file', () => {
    // 省略 retainMin 时的默认值是 1（工具的复用调用方可能不传）。
    touch('older.json', 100_000);
    touch('newer.json', 90_000);
    const removed = pruneFilesByAge({ dir, maxAgeMs: 1_000 });
    expect(removed).toBe(1);
    expect(existsSync(join(dir, 'older.json'))).toBe(false);
    expect(existsSync(join(dir, 'newer.json'))).toBe(true);
  });
});
