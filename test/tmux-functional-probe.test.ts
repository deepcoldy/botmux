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
  tmuxSupportsRemainOnExitFailed,
  resolveTmuxVersionAtSessionBoundary,
  serverTmuxVersion,
  getTmuxVersionCached,
  resetTmuxVersionCacheForTests,
  TMUX_REMAIN_ON_EXIT_FAILED,
  TMUX_VERSION_PROBE_TIMEOUT_MS,
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

// #2164 v3.53.0 regression gate: `remain-on-exit failed` only exists on
// tmux >= 3.2 (CHANGES, 3.1c -> 3.2). Sending it to 3.1c fails new-session
// with "bad value: failed" and blocks every new session.
describe('tmuxSupportsRemainOnExitFailed', () => {
  it('is supported starting at the documented floor (3.2)', () => {
    expect(TMUX_REMAIN_ON_EXIT_FAILED).toEqual({ major: 3, minor: 2 });
  });

  it.each([
    ['tmux 3.3a', true],  // local dev box
    ['tmux 3.2a', true],  // Ubuntu 22.04 shipped
    ['tmux 3.2', true],
    ['tmux 3.1c', false], // affected user machine — the regression
    ['tmux 3.1a', false],
    ['tmux 3.0', false],
    ['tmux 2.9', false],
  ])('tmux %j -> %s', (raw, expected) => {
    expect(tmuxSupportsRemainOnExitFailed(parseTmuxVersion(raw))).toBe(expected);
  });

  it('treats an unknown/unreadable version as unsupported (never block session creation)', () => {
    expect(tmuxSupportsRemainOnExitFailed(null)).toBe(false);
    expect(tmuxSupportsRemainOnExitFailed(parseTmuxVersion('nonsense'))).toBe(false);
  });
});

// Once-per-session boundary resolution shared by new-session argv, the
// reattached-session option reapply and the worker self-check: a recent null
// cache triggers exactly one fresh probe, so a transient `tmux -V` timeout
// neither downgrades the session nor makes the startup log lie; a version that
// stays unreadable is still null and every caller fails closed.
describe('resolveTmuxVersionAtSessionBoundary', () => {
  const versionProbeCount = () => mockedExecFileSync.mock.calls
    .filter(([, args]) => Array.isArray(args) && args[0] === '-V').length;

  beforeEach(() => resetTmuxVersionCacheForTests());

  it('serves a known cached version and never re-probes', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.3a\n' as any);
    expect(resolveTmuxVersionAtSessionBoundary()).toEqual({ major: 3, minor: 3 });
    expect(resolveTmuxVersionAtSessionBoundary()).toEqual({ major: 3, minor: 3 });
    expect(versionProbeCount()).toBe(1);
  });

  it('re-probes once when the cache holds a recent null, then uses the fresh answer', () => {
    let attempts = 0;
    mockedExecFileSync.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return 'tmux 3.3a\n' as any;
    });
    // Prime the short-lived null cache (the shape left by a failed gate probe).
    expect(getTmuxVersionCached()).toBeNull();
    expect(attempts).toBe(1);
    expect(resolveTmuxVersionAtSessionBoundary()).toEqual({ major: 3, minor: 3 });
    expect(attempts).toBe(2);
  });

  it('stays null when the boundary re-probe is also unreadable', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    expect(getTmuxVersionCached()).toBeNull();
    expect(resolveTmuxVersionAtSessionBoundary()).toBeNull();
  });
});

// The running SERVER parses commands and option values; the client binary on
// PATH can be newer after an upgrade. serverTmuxVersion asks the server on the
// given socket and only falls back to the client when no server answers (a
// non-session command never starts one) or its answer is unparsable.
describe('serverTmuxVersion', () => {
  const emulate = (client: string | null, server: string | 'THROW' | 'GARBAGE') => {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') {
        if (client === null) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return `${client}\n` as any;
      }
      if (Array.isArray(args) && args.includes('display-message')) {
        if (server === 'THROW') throw Object.assign(new Error('no server'), { status: 1 });
        if (server === 'GARBAGE') return 'no version here\n' as any;
        return `${server}\n` as any;
      }
      return '' as any;
    }) as typeof execFileSync);
  };

  it('trusts the running server over a newer client binary', () => {
    emulate('tmux 3.5a', '3.1c');
    expect(serverTmuxVersion(['-L', 'botmux'], { major: 3, minor: 5 })).toEqual({ major: 3, minor: 1 });
  });

  it('falls back to the client version when no server is on the socket (cold start)', () => {
    emulate('tmux 3.3a', 'THROW');
    expect(serverTmuxVersion([], { major: 3, minor: 3 })).toEqual({ major: 3, minor: 3 });
  });

  it('falls back to the client version on an unparsable server answer', () => {
    emulate('tmux 3.4', 'GARBAGE');
    expect(serverTmuxVersion([], { major: 3, minor: 4 })).toEqual({ major: 3, minor: 4 });
  });

  it('keeps null when neither server nor client can give a version', () => {
    emulate(null, 'THROW');
    expect(serverTmuxVersion([], null)).toBeNull();
  });

  it('sends the probe to the given socket, never the default server', () => {
    emulate('tmux 3.5a', '3.5a');
    serverTmuxVersion(['-L', 'botmux'], { major: 3, minor: 5 });
    const probe = mockedExecFileSync.mock.calls.find(([, a]) => Array.isArray(a) && a.includes('#{version}'));
    expect(probe?.[1].slice(0, 2)).toEqual(['-L', 'botmux']);
  });

  // Real-binary failure (3.3a client vs a 3.1c server): the client prints the
  // version and exits 0, but an inherited stdout pipe stays open, so
  // execFileSync waits out the timeout and THROWS (code ETIMEDOUT, status 0)
  // while err.stdout already holds the server's answer. The probe must rescue
  // that stdout, not drop it and fail open onto the newer client.
  it('rescues the server version from a timed-out call whose stdout already holds it', () => {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a\n' as any;
      if (Array.isArray(args) && args.includes('display-message')) {
        throw Object.assign(new Error('ETIMEDOUT'), {
          code: 'ETIMEDOUT', status: 0, signal: null, stdout: Buffer.from('3.1c\n'),
        });
      }
      return '' as any;
    }) as typeof execFileSync);
    expect(serverTmuxVersion(['-L', 'botmux'], { major: 3, minor: 3 })).toEqual({ major: 3, minor: 1 });
  });

  // A timeout with NO readable answer is inconclusive about a possibly-old
  // server: it must fail CLOSED (null, gates omit `failed`/`-e`), never fall
  // back to a newer client that would re-send rejected values.
  it('returns null (not the client) when the probe times out without any answer', () => {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.5a\n' as any;
      if (Array.isArray(args) && args.includes('display-message')) {
        throw Object.assign(new Error('ETIMEDOUT'), {
          code: 'ETIMEDOUT', status: 0, signal: null, stdout: Buffer.alloc(0),
        });
      }
      return '' as any;
    }) as typeof execFileSync);
    expect(serverTmuxVersion(['-L', 'botmux'], { major: 3, minor: 5 })).toBeNull();
  });

  it('still falls back to the client on a FAST non-timeout failure (server not up yet)', () => {
    // Distinct from a timeout: status is set, there is no ETIMEDOUT code.
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a\n' as any;
      if (Array.isArray(args) && args.includes('display-message')) {
        throw Object.assign(new Error('error connecting'), { code: undefined, status: 1, stdout: '' });
      }
      return '' as any;
    }) as typeof execFileSync);
    expect(serverTmuxVersion([], { major: 3, minor: 3 })).toEqual({ major: 3, minor: 3 });
  });

  // The probe budget must be the same load-rated one the other version probes
  // use, not a short ceiling. Under host load a SAME-version server answers
  // slowly (0.93–4.45s measured at load ~4; a 3s budget blew at load ~70), so a
  // 2s ceiling made the fail-closed timeout branch return null on a modern busy
  // host and silently turned off the 77/127 crash-exit-code channel there.
  // Real-binary check (3.3a server, a client wrapper delaying the probe 2.5s):
  // a 2s budget read null (degraded); this budget reads {major:3,minor:3}.
  // A mocked delay would only exercise Node's own timeout, not this decision,
  // so the test pins the budget itself; shrinking it back below the load line
  // must go red.
  it('uses the load-rated version-probe budget, so a slow same-version server is not timed out to null', () => {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args.includes('display-message')) return '3.3a\n' as any;
      return 'tmux 3.3a\n' as any;
    }) as typeof execFileSync);
    serverTmuxVersion(['-L', 'botmux'], { major: 3, minor: 3 });
    const probe = mockedExecFileSync.mock.calls.find(([, a]) => Array.isArray(a) && a.includes('#{version}'));
    const options = probe?.[2] as { timeout: number };
    expect(options.timeout).toBe(TMUX_VERSION_PROBE_TIMEOUT_MS);
    // The load measurements this budget was chosen for exceed 3s; anything
    // shorter reintroduces the degradation on a busy modern host.
    expect(TMUX_VERSION_PROBE_TIMEOUT_MS).toBeGreaterThan(3000);
  });
});
