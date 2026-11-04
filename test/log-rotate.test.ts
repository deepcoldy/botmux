import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, closeSync } from 'node:fs';
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

describe('openRotatedAppendLog', () => {
  it('rolls an over-limit file to .1 and (re)opens a fresh writable file', () => {
    const p = join(dir, 'daemon-0-out.log');
    writeFileSync(p, 'x'.repeat(100));
    const fd = openRotatedAppendLog(p, 50);
    try {
      // 旧内容已在 .1 归档里；新打开的 fd 写到轮转后新建的空文件。
      expect(statSync(`${p}.1`).size).toBe(100);
      writeFileSync(fd, 'fresh');
    } finally {
      closeSync(fd);
    }
    expect(statSync(p).size).toBe(5);
  });

  it('keeps rotating on every restart even when .1 already exists', () => {
    // 归档 .1 已存在时再次轮转必须仍成功（rename 覆盖旧归档），
    // 否则大小上限只在第一次启动生效，之后一直 append 超限文件。
    const p = join(dir, 'daemon-1-err.log');
    const fd1 = openRotatedAppendLog(p, 10);
    closeSync(fd1);
    writeFileSync(p, 'x'.repeat(40));
    const fd2 = openRotatedAppendLog(p, 10);
    closeSync(fd2);
    expect(statSync(`${p}.1`).size).toBe(40);
    expect(statSync(p).size).toBe(0); // 轮转后新建的空文件
  });

  it('appends to the existing file when below the limit', () => {
    const nested = join(dir, 'daemon-0-out.log');
    writeFileSync(nested, 'old');
    const fd = openRotatedAppendLog(nested, 100);
    try { writeFileSync(fd, '+new'); } finally { closeSync(fd); }
    expect(readFileSync(nested, 'utf-8')).toBe('old+new');
    expect(existsSync(`${nested}.1`)).toBe(false);
  });
});
