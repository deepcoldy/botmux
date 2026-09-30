import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from 'node:child_process';
import {
  probeTmuxFunctional,
  probeTmuxFunctionalWithRetry,
  classifyTmuxProbeFailure,
  parseTmuxVersion,
} from '../src/setup/ensure-tmux.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  mockedExecFileSync.mockReset();
  mockedSpawnSync.mockReset();
});

describe('tmux functional probe diagnostics', () => {
  it('reports ENOENT as an authoritative missing binary', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    });

    const result = probeTmuxFunctional();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.binaryPresent).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain('ENOENT');
  });

  it('preserves timeout details instead of claiming tmux is missing from PATH', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('timed out'), {
        code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true,
      });
    });

    const result = probeTmuxFunctional();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.binaryPresent).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('超时');
    expect(result.reason).not.toContain('不在 PATH');
  });

  it('surfaces functional-probe stderr', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.3a\n' as any);
    mockedSpawnSync.mockImplementation((_bin: any, args: any) =>
      (args as string[]).includes('new-session')
        ? ({ status: 1, signal: null, stderr: Buffer.from('server temporarily busy') } as any)
        : ({ status: 0 } as any));

    const result = probeTmuxFunctional();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.version).toBe('tmux 3.3a');
    expect(result.reason).toContain('server temporarily busy');
  });

  it('reports clone3 EPERM (container seccomp) as an environment denial, not a missing binary', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.3a\n' as any);
    mockedSpawnSync.mockImplementation((_bin: any, args: any) =>
      (args as string[]).includes('new-session')
        ? ({
            status: null,
            signal: null,
            error: Object.assign(new Error('clone3 failed: Operation not permitted'), { code: 'EPERM' }),
            stderr: Buffer.from('clone3 failed: Operation not permitted'),
          } as any)
        : ({ status: 0 } as any));

    const result = probeTmuxFunctional();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('clone3');
    expect(result.reason).toContain('EPERM');
    expect(result.reason).toContain('seccomp');
    // Must not read as "go install tmux".
    expect(result.reason).not.toContain('ENOENT');
    expect(classifyTmuxProbeFailure(result.reason)).toBe('env-denied');
  });

  it('backs off and retries transient EMFILE failures before gating', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.3a\n' as any);
    let newSessionAttempts = 0;
    mockedSpawnSync.mockImplementation((_bin: any, args: any) => {
      if (!(args as string[]).includes('new-session')) return { status: 0 } as any;
      newSessionAttempts += 1;
      if (newSessionAttempts < 3) {
        return { status: null, signal: null, error: Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) } as any;
      }
      return { status: 0, signal: null, stderr: Buffer.alloc(0) } as any;
    });

    const result = probeTmuxFunctionalWithRetry({ attempts: 3, baseDelayMs: 0 });
    expect(result).toEqual({ ok: true, version: 'tmux 3.3a' });
    expect(newSessionAttempts).toBe(3);
  });
});

describe('classifyTmuxProbeFailure', () => {
  it('classifies the ENOENT wording as missing', () => {
    expect(classifyTmuxProbeFailure('tmux -V 启动失败：找不到 tmux 可执行文件（ENOENT）')).toBe('missing');
  });

  it('classifies clone3 / operation-not-permitted text as env-denied', () => {
    expect(classifyTmuxProbeFailure('tmux new-session 失败：fatal: clone3: Operation not permitted')).toBe('env-denied');
    expect(classifyTmuxProbeFailure('spawn tmux EPERM')).toBe('env-denied');
  });

  it('classifies unrelated text conservatively as generic', () => {
    expect(classifyTmuxProbeFailure('tmux new-session 失败：server temporarily busy')).toBe('generic');
    expect(classifyTmuxProbeFailure('tmux 二进制不在 PATH 上')).toBe('generic');
  });
});

describe('parseTmuxVersion', () => {
  it.each([
    ['tmux 3.3a', { major: 3, minor: 3 }],
    ['tmux 2.8', { major: 2, minor: 8 }],
    ['tmux 3.0', { major: 3, minor: 0 }],
    ['tmux 3.4\n', { major: 3, minor: 4 }],
  ])('parses %j', (raw, expected) => {
    expect(parseTmuxVersion(raw)).toEqual(expected);
  });

  it('returns null for unparseable output', () => {
    expect(parseTmuxVersion('garbage')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});
