/**
 * readJsonFileSoft: 损坏 / 形状不符的 JSON 被隔离为 .corrupt-*，而不是被后续写入覆盖。
 * Run: npx vitest run --project unit test/json-file.test.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../src/utils/json-file.js';
import { logger } from '../src/utils/logger.js';

type Shape = Record<string, { n: number }>;
const isShape = (v: unknown): v is Shape => isJsonObject(v);
const opts = { fallback: (): Shape => ({}), validate: isShape, label: 'test-store' };

let dir: string;
let fp: string;
let warn: ReturnType<typeof vi.spyOn>;

const corruptFiles = () => readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-json-file-'));
  fp = join(dir, 'state.json');
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { chmodSync(dir, 0o700); } catch { /* */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('readJsonFileSoft', () => {
  it('missing file → fallback(), silently, nothing created', () => {
    expect(readJsonFileSoft(fp, opts)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns a fresh fallback object per call', () => {
    const a = readJsonFileSoft(fp, opts);
    a.x = { n: 1 };
    expect(readJsonFileSoft(fp, opts)).toEqual({});
  });

  it('valid JSON that passes validate → parsed value, untouched on disk', () => {
    writeFileSync(fp, '{"a":{"n":1}}\n');
    expect(readJsonFileSoft(fp, opts)).toEqual({ a: { n: 1 } });
    expect(corruptFiles()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(fp, 'utf-8')).toBe('{"a":{"n":1}}\n');
  });

  it('no validate → any parseable JSON is returned as-is', () => {
    writeFileSync(fp, '[1,2,3]');
    expect(readJsonFileSoft<unknown>(fp, { fallback: () => null, label: 'x' })).toEqual([1, 2, 3]);
    expect(corruptFiles()).toEqual([]);
  });

  it('unparseable JSON → original quarantined as .corrupt-<ms>, fallback returned, warn names label + path', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    writeFileSync(fp, '{"a":{"n":1},  <<<truncated');
    expect(readJsonFileSoft(fp, opts)).toEqual({});
    expect(existsSync(fp)).toBe(false);
    expect(corruptFiles()).toEqual(['state.json.corrupt-1700000000000']);
    expect(readFileSync(join(dir, 'state.json.corrupt-1700000000000'), 'utf-8')).toBe('{"a":{"n":1},  <<<truncated');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('test-store');
    expect(msg).toContain(join(dir, 'state.json.corrupt-1700000000000'));
  });

  it('empty file counts as corrupt', () => {
    writeFileSync(fp, '');
    expect(readJsonFileSoft(fp, opts)).toEqual({});
    expect(corruptFiles()).toHaveLength(1);
  });

  it('valid JSON but validate() false → quarantined too', () => {
    writeFileSync(fp, '[{"n":1}]');
    expect(readJsonFileSoft(fp, opts)).toEqual({});
    expect(existsSync(fp)).toBe(false);
    const [name] = corruptFiles();
    expect(readFileSync(join(dir, name), 'utf-8')).toBe('[{"n":1}]');
    expect(String(warn.mock.calls[0][0])).toContain('test-store');
  });

  it('a validate() that throws is treated as invalid (quarantined), not propagated', () => {
    writeFileSync(fp, '{"a":1}');
    const out = readJsonFileSoft<Shape>(fp, {
      fallback: () => ({}),
      validate: (() => { throw new Error('boom'); }) as unknown as (v: unknown) => v is Shape,
      label: 'test-store',
    });
    expect(out).toEqual({});
    expect(corruptFiles()).toHaveLength(1);
  });

  it('a write after quarantine lands on a clean path and never touches the quarantined bytes', () => {
    writeFileSync(fp, 'not json at all');
    const data = readJsonFileSoft(fp, opts);
    data.fresh = { n: 2 };
    atomicWriteFileSync(fp, JSON.stringify(data, null, 2) + '\n');

    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({ fresh: { n: 2 } });
    const [name] = corruptFiles();
    expect(readFileSync(join(dir, name), 'utf-8')).toBe('not json at all');
    // reading again is clean: no further quarantine, no warning beyond the first
    expect(readJsonFileSoft(fp, opts)).toEqual({ fresh: { n: 2 } });
    expect(corruptFiles()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('two corruptions within the same millisecond never overwrite the earlier quarantine file', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    writeFileSync(fp, 'first-bad');
    readJsonFileSoft(fp, opts);
    writeFileSync(fp, 'second-bad');
    readJsonFileSoft(fp, opts);
    const names = corruptFiles();
    expect(names).toHaveLength(2);
    expect(names.map((n) => readFileSync(join(dir, n), 'utf-8')).sort()).toEqual(['first-bad', 'second-bad']);
  });

  it('does not move a file that was replaced (by a concurrent writer) between read and quarantine', () => {
    // Simulate "reader B saw the corrupt bytes, but reader A already quarantined and
    // wrote a good file": B's validate() runs after its read, and replaces the file.
    writeFileSync(fp, '{"stale":{"n":1}}');
    const out = readJsonFileSoft<Shape>(fp, {
      fallback: () => ({}),
      validate: ((v: unknown) => {
        atomicWriteFileSync(fp, '{"good":{"n":9}}\n'); // new inode at the same path
        return Array.isArray(v); // → false: invalid, wants to quarantine
      }) as unknown as (v: unknown) => v is Shape,
      label: 'test-store',
    });
    expect(out).toEqual({});
    expect(corruptFiles()).toEqual([]); // good file not swept away
    expect(readFileSync(fp, 'utf-8')).toBe('{"good":{"n":9}}\n');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('quarantine rename failure is logged, not thrown, and still returns fallback', () => {
    writeFileSync(fp, 'garbage');
    // A read-only parent dir lets us read the file but not rename it (skipped when root ignores perms).
    chmodSync(dir, 0o500);
    let canRename = true;
    try { writeFileSync(join(dir, 'probe'), 'x'); rmSync(join(dir, 'probe')); } catch { canRename = false; }
    const out = readJsonFileSoft(fp, opts);
    expect(out).toEqual({});
    expect(warn).toHaveBeenCalled();
    if (!canRename) {
      expect(String(warn.mock.calls.at(-1)![0])).toMatch(/failed to quarantine/);
      expect(existsSync(fp)).toBe(true);
    }
  });

  it('non-parse read errors (path is a directory) → fallback + warn, and nothing is renamed', () => {
    mkdirSync(fp); // reading a directory as a file → EISDIR, not "corrupt JSON"
    expect(readJsonFileSoft(fp, opts)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('cannot read');
    expect(corruptFiles()).toEqual([]);
    expect(existsSync(fp)).toBe(true);
  });

  it('unreadable file (EACCES) → fallback + warn, file NOT quarantined', () => {
    writeFileSync(fp, '{"a":{"n":1}}');
    chmodSync(fp, 0o000);
    let readable = true;
    try { readFileSync(fp); } catch { readable = false; }
    const out = readJsonFileSoft(fp, opts);
    chmodSync(fp, 0o600);
    if (readable) return; // running as root: perms are not enforced, nothing to assert
    expect(out).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/cannot read.*EACCES/);
    expect(corruptFiles()).toEqual([]);
    expect(readFileSync(fp, 'utf-8')).toBe('{"a":{"n":1}}');
  });
});

describe('isJsonObject', () => {
  it('accepts plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('s')).toBe(false);
    expect(isJsonObject(1)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});
