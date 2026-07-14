import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeLogRotation,
  inspectLogDirectory,
  listLogFiles,
  planLogRotation,
  resolveLogRotationConfig,
  rotateBotmuxLogs,
  type LogRotationIo,
} from '../src/core/log-rotation.js';

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-log-rotation-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('log rotation planner', () => {
  it('plans deterministic keep=3 history shifts only for oversized base logs', () => {
    expect(planLogRotation([
      { path: '/logs/small.log', size: 9 },
      { path: '/logs/daemon.log.1', size: 99 },
      { path: '/logs/large.log', size: 10 },
    ], { maxSizeBytes: 10, keep: 3 })).toEqual([{
      path: '/logs/large.log',
      size: 10,
      actions: [
        { kind: 'remove', path: '/logs/large.log.3' },
        { kind: 'rename', from: '/logs/large.log.2', to: '/logs/large.log.3', active: false },
        { kind: 'rename', from: '/logs/large.log.1', to: '/logs/large.log.2', active: false },
        { kind: 'rename', from: '/logs/large.log', to: '/logs/large.log.1', active: true },
      ],
    }]);
  });

  it('uses safe defaults and accepts operator overrides', () => {
    expect(resolveLogRotationConfig({})).toMatchObject({ enabled: true, maxSizeBytes: 100 * 1024 * 1024, keep: 3 });
    expect(resolveLogRotationConfig({
      BOTMUX_LOG_ROTATE_ENABLED: 'false',
      BOTMUX_LOG_ROTATE_MAX_SIZE_MB: '12.5',
      BOTMUX_LOG_ROTATE_KEEP: '5',
    })).toEqual({ enabled: false, maxSizeBytes: Math.floor(12.5 * 1024 * 1024), keep: 5 });
  });
});

describe('log rotation execution', () => {
  it('rotates every oversized log and reloads PM2 once', async () => {
    const dir = tempDir();
    const first = join(dir, 'daemon-0-error.log');
    const second = join(dir, 'dashboard-out.log');
    writeFileSync(first, 'new-first');
    writeFileSync(`${first}.1`, 'old-first');
    writeFileSync(`${first}.2`, 'older-first');
    writeFileSync(second, 'new-second');
    const reloadLogs = vi.fn(async () => undefined);

    const result = await rotateBotmuxLogs({
      logDir: dir,
      config: { enabled: true, maxSizeBytes: 1, keep: 3 },
      reloadLogs,
    });

    expect(result).toMatchObject({ oversized: 2, rotated: [first, second], copyTruncated: [], pendingReloads: [], errors: [], reloaded: true });
    expect(reloadLogs).toHaveBeenCalledTimes(1);
    expect(readFileSync(`${first}.1`, 'utf8')).toBe('new-first');
    expect(readFileSync(`${first}.2`, 'utf8')).toBe('old-first');
    expect(readFileSync(`${first}.3`, 'utf8')).toBe('older-first');
    expect(readFileSync(`${second}.1`, 'utf8')).toBe('new-second');
    expect(readFileSync(first, 'utf8')).toBe('');
    expect(readFileSync(second, 'utf8')).toBe('');
  });

  it('does nothing below the threshold', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'daemon-0-out.log'), 'small');
    const reloadLogs = vi.fn(async () => undefined);
    const result = await rotateBotmuxLogs({
      logDir: dir,
      config: { enabled: true, maxSizeBytes: 100, keep: 3 },
      reloadLogs,
    });
    expect(result).toEqual({ oversized: 0, rotated: [], copyTruncated: [], pendingReloads: [], errors: [], reloaded: false });
    expect(reloadLogs).not.toHaveBeenCalled();
  });

  it('falls back to copytruncate when the active file is busy', async () => {
    const path = '/logs/daemon-0-error.log';
    const contents = new Map<string, string>([[path, 'current']]);
    const io: LogRotationIo = {
      remove: vi.fn(async (file) => { contents.delete(file); }),
      rename: vi.fn(async (from, to) => {
        if (from === path) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        const value = contents.get(from);
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        contents.delete(from);
        contents.set(to, value);
      }),
      copyFile: vi.fn(async (from, to) => { contents.set(to, contents.get(from) ?? ''); }),
      truncate: vi.fn(async (file) => { contents.set(file, ''); }),
      touch: vi.fn(async (file) => { if (!contents.has(file)) contents.set(file, ''); }),
    };
    const reloadLogs = vi.fn(async () => undefined);

    const result = await executeLogRotation(planLogRotation([
      { path, size: 200 },
    ], { maxSizeBytes: 100, keep: 3 }), { io, reloadLogs });

    expect(result).toMatchObject({ rotated: [path], copyTruncated: [path], errors: [], reloaded: true });
    expect(contents.get(path)).toBe('');
    expect(contents.get(`${path}.1`)).toBe('current');
    expect(reloadLogs).toHaveBeenCalledTimes(1);
  });

  it('keeps per-file failures isolated and still reloads successful rotations', async () => {
    const io: LogRotationIo = {
      remove: vi.fn(async () => undefined),
      rename: vi.fn(async (from) => {
        if (from === '/logs/daemon-0-error.log') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
      copyFile: vi.fn(async () => undefined),
      truncate: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
    };
    const reloadLogs = vi.fn(async () => undefined);
    const plans = planLogRotation([
      { path: '/logs/daemon-0-error.log', size: 200 },
      { path: '/logs/dashboard-out.log', size: 200 },
    ], { maxSizeBytes: 100, keep: 1 });

    const result = await executeLogRotation(plans, { io, reloadLogs });
    expect(result.rotated).toEqual(['/logs/dashboard-out.log']);
    expect(result.errors).toEqual([{ path: '/logs/daemon-0-error.log', message: 'denied' }]);
    expect(reloadLogs).toHaveBeenCalledTimes(1);
  });

  it('discovers only base .log files', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'daemon.log'), 'abc');
    writeFileSync(join(dir, 'daemon.log.1'), 'history');
    writeFileSync(join(dir, 'notes.txt'), 'ignore');
    expect(await listLogFiles(dir)).toEqual([{ path: join(dir, 'daemon.log'), size: statSync(join(dir, 'daemon.log')).size }]);
  });

  it('retries a failed PM2 reload on the next tick and recreates the base path', async () => {
    const dir = tempDir();
    const base = join(dir, 'daemon-0-error.log');
    writeFileSync(`${base}.1`, 'still receiving old-fd writes');
    expect(await inspectLogDirectory(dir)).toMatchObject({ files: [], pendingReloads: [base] });

    const failed = await rotateBotmuxLogs({
      logDir: dir,
      config: { enabled: true, maxSizeBytes: 100, keep: 3 },
      reloadLogs: vi.fn(async () => { throw new Error('PM2 unavailable'); }),
    });
    expect(failed).toMatchObject({ reloaded: false, pendingReloads: [base] });
    expect(failed.errors).toEqual([{ path: 'pm2:reloadLogs', message: 'PM2 unavailable' }]);
    expect(() => statSync(base)).toThrow();

    const recovered = await rotateBotmuxLogs({
      logDir: dir,
      config: { enabled: true, maxSizeBytes: 100, keep: 3 },
      reloadLogs: vi.fn(async () => undefined),
    });
    expect(recovered).toMatchObject({ reloaded: true, pendingReloads: [], errors: [] });
    expect(readFileSync(base, 'utf8')).toBe('');
  });
});
