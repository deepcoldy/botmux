import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  RiffBackend,
  findBytedcliBinary,
  resolveJwtRefreshCmd,
  refreshBytecloudJwt,
  JWT_REFRESH_DEBOUNCE_MS,
  __resetJwtRefreshDebounceForTest,
} from '../src/adapters/backend/riff-backend.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The refresh helpers are pure + injectable (runner / now / env / platform), so
// none of these tests spawn a real process. findBytedcliBinary is probed against
// a real temp PATH dir (no mocking of node:fs).

describe('findBytedcliBinary — PATH probe', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bytedcli-path-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns "bytedcli" when a matching binary exists on a PATH segment', () => {
    const bin = join(dir, 'bytedcli');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    const env = { PATH: ['/nope/a', dir, '/nope/b'].join(delimiter) } as NodeJS.ProcessEnv;
    expect(findBytedcliBinary(env, 'linux')).toBe('bytedcli');
  });

  it('returns null with an empty or missing PATH', () => {
    expect(findBytedcliBinary({ PATH: '' }, 'linux')).toBeNull();
    expect(findBytedcliBinary({} as NodeJS.ProcessEnv, 'linux')).toBeNull();
  });

  it('returns null when no PATH segment contains the binary', () => {
    const env = { PATH: ['/nope/a', dir].join(delimiter) } as NodeJS.ProcessEnv;
    expect(findBytedcliBinary(env, 'linux')).toBeNull();
  });
});

describe('resolveJwtRefreshCmd — precedence', () => {
  it('explicit config command wins over everything', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: 'other cmd' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(['my', 'cmd', '--x'], env, 'linux')).toEqual(['my', 'cmd', '--x']);
  });

  it('falls back to the env var (space-split, blanks dropped)', () => {
    const env = {
      BOTMUX_RIFF_JWT_REFRESH_CMD: '  bytedcli auth get-bytecloud-jwt-token --force-refresh  ',
    } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toEqual([
      'bytedcli', 'auth', 'get-bytecloud-jwt-token', '--force-refresh',
    ]);
  });

  it('empty env var is ignored (no phantom command)', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: '   ', PATH: '/nope' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toBeNull();
  });

  it('returns null when nothing is configured and bytedcli is not on PATH', () => {
    const env = { PATH: '/nope/bin' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toBeNull();
  });

  it('empty config array is treated as unset (does not shadow env/PATH resolution)', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: 'bytedcli auth x' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd([], env, 'linux')).toEqual(['bytedcli', 'auth', 'x']);
  });
});

describe('refreshBytecloudJwt — async debounce + coalesce + fail-closed', () => {
  beforeEach(() => { __resetJwtRefreshDebounceForTest(); });
  afterEach(() => { __resetJwtRefreshDebounceForTest(); });

  // An async no-op runner (the production runner is now async execFile).
  const okRunner = () => vi.fn(async () => {});

  it('returns false immediately when no command resolves (fail-closed, no run)', async () => {
    const runner = okRunner();
    expect(await refreshBytecloudJwt(null, { runner, nowMs: 1_000 })).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs the command and returns true on success', async () => {
    const runner = okRunner();
    const ok = await refreshBytecloudJwt(['bytedcli', 'auth', 'x', '--force-refresh'], { runner, nowMs: 1_000 });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledWith('bytedcli', ['auth', 'x', '--force-refresh']);
  });

  it('swallows a throwing runner (non-fatal) and returns false', async () => {
    const runner = vi.fn(async () => { throw new Error('bytedcli not logged in'); });
    expect(await refreshBytecloudJwt(['bytedcli', 'auth', 'x'], { runner, nowMs: 1_000 })).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('debounces: a second call within the window does not run again', async () => {
    const runner = okRunner();
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 })).toBe(true);
    // 1s later — still inside the 60s window
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 2_000 })).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('allows another run once the debounce window has fully elapsed', async () => {
    const runner = okRunner();
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 })).toBe(true);
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 + JWT_REFRESH_DEBOUNCE_MS })).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('a FAILED attempt still consumes the debounce window (caps flapping refresh cost)', async () => {
    const runner = vi.fn(async () => { throw new Error('boom'); });
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 })).toBe(false);
    // even though it failed, we don't hammer the command within the window
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 2_000 })).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('an empty command array resolves to false without touching the debounce clock', async () => {
    const runner = okRunner();
    expect(await refreshBytecloudJwt([], { runner, nowMs: 1_000 })).toBe(false);
    // clock untouched → a real command right after still runs
    expect(await refreshBytecloudJwt(['bytedcli', 'x'], { runner, nowMs: 1_500 })).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('force=true bypasses the debounce window (a 401 proved the token bad)', async () => {
    const runner = okRunner();
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 })).toBe(true);
    // Inside the window a speculative refresh is skipped…
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 2_000 })).toBe(false);
    // …but a forced (post-401) refresh runs anyway.
    expect(await refreshBytecloudJwt(cmd, { runner, nowMs: 3_000, force: true })).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('COALESCE: concurrent callers share ONE in-flight refresh (no double spawn)', async () => {
    // A runner that stays pending until we release it, so both calls overlap.
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const runner = vi.fn(async () => { await gate; });
    const cmd = ['bytedcli', 'auth', 'x'];
    const a = refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 });
    // Second caller arrives while the first is still running → rides the same promise.
    const b = refreshBytecloudJwt(cmd, { runner, nowMs: 1_010 });
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1); // coalesced — only one child spawned
  });

  it('COALESCE: even a forced caller rides an in-flight refresh instead of racing a 2nd child', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const runner = vi.fn(async () => { await gate; });
    const cmd = ['bytedcli', 'auth', 'x'];
    const a = refreshBytecloudJwt(cmd, { runner, nowMs: 1_000 });
    const forced = refreshBytecloudJwt(cmd, { runner, nowMs: 1_010, force: true });
    release();
    expect(await a).toBe(true);
    expect(await forced).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

// Integration coverage for resolveJwt's new branch (the AIME-skip gate +
// refresh→re-read + allowRefresh/forceRefresh options), which the pure-function
// tests above do not exercise. We drive the REAL resolveJwt and prove whether
// the refresh branch fired by pointing the refresh command at a `touch` that
// writes a marker file, and by scripting the keychain read via a spy.
describe('resolveJwt — refresh branch integration (AIME gate + allowRefresh + force)', () => {
  let dir: string;
  let marker: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    __resetJwtRefreshDebounceForTest();
    dir = mkdtempSync(join(tmpdir(), 'riff-resolvejwt-'));
    marker = join(dir, 'refreshed');
    // A real, harmless refresh command whose SIDE EFFECT (creating `marker`) lets
    // us assert the refresh actually ran. `node -e` avoids depending on coreutils.
    process.env.BOTMUX_RIFF_JWT_REFRESH_CMD = `${process.execPath} -e require('fs').writeFileSync(${JSON.stringify(marker)},'x')`;
    delete process.env.AIME_WORKSPACE_PATH;
    delete process.env.AIME_CURRENT_USER;
    delete process.env.RIFF_JWT;
  });
  afterEach(() => {
    __resetJwtRefreshDebounceForTest();
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  /** A backend with no static jwt/env, so resolveJwt falls through to keychain. */
  function backend(): RiffBackend {
    return new RiffBackend({ baseUrl: 'https://riff.example.com' } as any, 'sess-resolvejwt');
  }

  it('non-AIME + no live keychain token → triggers refresh, then re-reads the fresh token', async () => {
    const be = backend();
    // First read (pre-refresh) misses; second read (post-refresh) hits.
    const spy = vi.spyOn(be as any, 'readJwtFromBytecloudKeychain')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('FRESH-JWT');
    const jwt = await (be as any).resolveJwt();
    expect(jwt).toBe('FRESH-JWT');
    expect(existsSync(marker)).toBe(true);       // refresh command actually ran
    expect(spy).toHaveBeenCalledTimes(2);         // miss → refresh → re-read
  });

  it('full AIME runtime → NEVER triggers a host refresh (fail-closed identity boundary)', async () => {
    process.env.AIME_WORKSPACE_PATH = join(dir, 'ws');
    process.env.AIME_CURRENT_USER = 'alice';
    const be = backend();
    const spy = vi.spyOn(be as any, 'readJwtFromBytecloudKeychain').mockReturnValue(null);
    const jwt = await (be as any).resolveJwt();
    expect(jwt).toBeNull();
    expect(existsSync(marker)).toBe(false);       // refresh must NOT have run
    expect(spy).toHaveBeenCalledTimes(1);         // single miss, no re-read
  });

  it('allowRefresh:false (orphan-cancel path) → never refreshes even when keychain is empty', async () => {
    const be = backend();
    const spy = vi.spyOn(be as any, 'readJwtFromBytecloudKeychain').mockReturnValue(null);
    const jwt = await (be as any).resolveJwt({ allowRefresh: false });
    expect(jwt).toBeNull();
    expect(existsSync(marker)).toBe(false);       // daemon-side teardown must not spawn bytedcli
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a live keychain token short-circuits before any refresh', async () => {
    const be = backend();
    const spy = vi.spyOn(be as any, 'readJwtFromBytecloudKeychain').mockReturnValue('LIVE-JWT');
    const jwt = await (be as any).resolveJwt();
    expect(jwt).toBe('LIVE-JWT');
    expect(existsSync(marker)).toBe(false);       // no refresh when we already have a token
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh:true ignores an existing keychain token and refreshes first', async () => {
    const be = backend();
    // With force, the first (pre-refresh) read is bypassed; we refresh, then read fresh.
    const spy = vi.spyOn(be as any, 'readJwtFromBytecloudKeychain')
      .mockReturnValueOnce('STALE-JWT')  // would be returned WITHOUT force
      .mockReturnValueOnce('FRESH-JWT'); // post-refresh re-read
    const jwt = await (be as any).resolveJwt({ forceRefresh: true });
    expect(jwt).toBe('FRESH-JWT');
    expect(existsSync(marker)).toBe(true);
  });
});
