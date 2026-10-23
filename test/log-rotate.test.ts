import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLogIfNeeded, openRotatedAppendLog, DEFAULT_LOG_MAX_BYTES } from '../src/utils/log-rotate.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-logrotate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateLogIfNeeded', () => {
  it('does nothing when the file is below the limit', () => {
    const p = join(dir, 'daemon-0-err.log');
    writeFileSync(p, 'small');
    expect(rotateLogIfNeeded(p, 100)).toBe(false);
    expect(existsSync(p)).toBe(true);
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  it('rolls a file at/over the limit to .1 and lets a fresh file be created', () => {
    const p = join(dir, 'daemon-0-err.log');
    writeFileSync(p, 'x'.repeat(100));
    expect(rotateLogIfNeeded(p, 50)).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(statSync(`${p}.1`).size).toBe(100);
    // 调用方随后 append：openRotatedAppendLog 建新文件并可写。
    const fd = openRotatedAppendLog(p, 50);
    try {
      writeFileSync(fd, 'fresh');
    } finally {
      closeSync(fd);
    }
    expect(statSync(p).size).toBe(5);
  });

  it('overwrites a previous .1 archive instead of accumulating history', () => {
    const p = join(dir, 'err.log');
    writeFileSync(`${p}.1`, 'OLD-ARCHIVE');
    writeFileSync(p, 'y'.repeat(10));
    rotateLogIfNeeded(p, 5);
    expect(statSync(`${p}.1`).size).toBe(10); // 旧归档被覆盖，无 .2/.3
    expect(existsSync(`${p}.2`)).toBe(false);
  });

  it('fails open (returns false) for a missing file', () => {
    const p = join(dir, 'never.log');
    expect(rotateLogIfNeeded(p)).toBe(false);
  });

  it('default limit is a finite positive size', () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBeGreaterThan(0);
  });
});
