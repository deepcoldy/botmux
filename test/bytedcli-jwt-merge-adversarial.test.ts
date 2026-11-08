import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let defaultDelay = 1, regionalDelay = 1, loginDelay = 1, completeDelay = 1;
let active = 0, maximumActive = 0;
let rewriteOldHome = false, completeSuccess = false, blockChallengeWrite = false;
let beginCount = 0;
const calls: Array<{ args: string[]; at: number }> = [];
const token = (region: string, tag = 'current') => `e30.${Buffer.from(JSON.stringify({ region, tag,
  exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url')}.sig`;

vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => root, default: { ...os, homedir: () => root } };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], options: { env: Record<string, string> }) => {
    const home = options.env.HOME;
    calls.push({ args: [...args], at: Date.now() });
    active++; maximumActive = Math.max(maximumActive, active);
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { destroy() {} }),
      stderr: Object.assign(new EventEmitter(), { destroy() {} }), kill: vi.fn() });
    const wasAuthorized = existsSync(join(home, 'authorized'));
    const isStatus = args.includes('status');
    const isBegin = args.includes('--begin');
    const isComplete = args.includes('--complete');
    const isRegional = args[0] === '--site';
    const isDefault = args[0] === 'auth' && args[1] === 'get-bytecloud-jwt-token';
    const region = args[1] === 'i18n-tt' ? 'i18n' : args[1] === 'i18n-bd' ? 'i18nbd' : 'tx';
    const output = isStatus ? JSON.stringify({ status: 'success', data: { authenticated: wasAuthorized } })
      : isBegin ? JSON.stringify({ status: 'success', data: { verification_uri_complete: 'https://example.test/login', complete_token: `challenge-${++beginCount}` } })
      : isComplete ? JSON.stringify({ status: 'success', data: { login_status: completeSuccess ? 'success' : 'pending' } })
      : isDefault ? token('cn', 'accepted-before-revoke') : isRegional ? token(region) : 'code-token';
    const oldWrite = (isDefault && rewriteOldHome) || (isComplete && completeSuccess);
    setTimeout(() => {
      active--;
      if (oldWrite) { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'authorized'), 'old-sdk-refresh-session'); }
      if (isBegin && blockChallengeWrite) mkdirSync(join(home, '.botmux-login-challenge'), { recursive: true });
      child.stdout.emit('data', output); child.emit('close', 0);
    }, isDefault ? defaultDelay : isRegional ? regionalDelay : isBegin ? loginDelay : isComplete ? completeDelay : 1);
    return child;
  }),
}));

let auth: typeof import('../src/services/bytedcli-auth.js');
let epoch: typeof import('../src/services/cli-auth-epoch.js');
const USER = 'ou_merge_review';
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jwt-merge-review-'));
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); vi.resetModules();
  auth = await import('../src/services/bytedcli-auth.js'); epoch = await import('../src/services/cli-auth-epoch.js');
  mkdirSync(auth.bytedcliHomeFor(USER), { recursive: true });
  writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'initial-session');
  defaultDelay = regionalDelay = loginDelay = completeDelay = 1; active = maximumActive = beginCount = 0;
  rewriteOldHome = completeSuccess = blockChallengeWrite = false; calls.length = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('merged JWT lifecycle durable epoch timing', () => {
  it.each(['mint', 'renew'] as const)('drops %s after another process revokes during the last regional child', async mode => {
    regionalDelay = 1000;
    const result = mode === 'mint' ? auth.mintBytedcliJwts(USER) : auth.renewBytedcliJwts(USER);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls.at(-1)?.args).toContain('us-ttp');
    epoch.bumpCliAuthEpoch(USER);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeNull();
    expect(await auth.describeBytedcliAuth(USER)).toEqual({ state: 'needs-login' });
  });

  it('does not reuse a regional cache after revoke, restart, and a new login', async () => {
    const initial = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(100); await initial;
    epoch.bumpCliAuthEpoch(USER); auth.clearBytedcliAuth(USER);
    vi.resetModules(); auth = await import('../src/services/bytedcli-auth.js');
    const begin = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10); expect(await begin).not.toBeNull();
    writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'fresh-session');
    calls.length = 0;
    const next = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(100);
    expect(await next).not.toBeNull();
    expect(calls.filter(c => c.args[0] === '--site')).toHaveLength(3);
  });

  it('does not reuse another durable epoch regional cache in a daemon that did not perform the revoke', async () => {
    const first = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(100); await first;
    epoch.bumpCliAuthEpoch(USER);
    vi.resetModules(); const otherDaemon = await import('../src/services/bytedcli-auth.js');
    const begin = otherDaemon.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10); await begin;
    writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'new-session');
    calls.length = 0;
    const next = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(100);
    expect(await next).not.toBeNull();
    expect(calls.filter(c => c.args[0] === '--site')).toHaveLength(3);
  });

  it('keeps the durable epoch fence closed after only epoch persistence succeeds', async () => {
    epoch.bumpCliAuthEpoch(USER);
    vi.resetModules(); auth = await import('../src/services/bytedcli-auth.js');
    const next = auth.renewBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(100);
    expect(await next).toBeNull(); expect(calls).toEqual([]);
  });

  it('recovers after the epoch stamp persists but challenge publication fails and the module restarts', async () => {
    epoch.bumpCliAuthEpoch(USER); auth.clearBytedcliAuth(USER); blockChallengeWrite = true;
    const first = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBeNull();
    expect(readFileSync(join(auth.bytedcliHomeFor(USER), '.botmux-auth-epoch'), 'utf8').trim()).toBe(String(epoch.readCliAuthEpoch(USER)));
    expect(auth.pendingBytedcliChallenge(USER)).toBeNull();
    blockChallengeWrite = false;
    rmSync(join(auth.bytedcliHomeFor(USER), '.botmux-login-challenge'), { recursive: true, force: true });
    vi.resetModules(); auth = await import('../src/services/bytedcli-auth.js');
    const again = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await again).not.toBeNull();
    const status = auth.describeBytedcliAuth(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await status).toEqual({ state: 'needs-login' });
  });

  it('serializes overlapping periodic renewals and ordinary mints against the same HOME', async () => {
    defaultDelay = 5000;
    const runs: Array<Promise<unknown>> = [];
    const timer = setInterval(() => { runs.push(auth.renewBytedcliJwts(USER)); runs.push(auth.mintBytedcliJwts(USER)); }, 1000);
    await vi.advanceTimersByTimeAsync(16000); clearInterval(timer);
    await vi.advanceTimersByTimeAsync(15000); await Promise.all(runs);
    expect(maximumActive).toBe(1);
  });

  it('fences recreated SDK files after the required durable-bump-before-clear revocation sequence', async () => {
    defaultDelay = 10_000;
    const old = auth.renewBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(1000);
    epoch.bumpCliAuthEpoch(USER); auth.clearBytedcliAuth(USER);
    mkdirSync(auth.bytedcliHomeFor(USER), { recursive: true });
    writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'replacement-session');
    const current = auth.mintBytedcliJwts(USER);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await old).toBeNull(); expect(await current).toBeNull();
    expect(maximumActive).toBe(1);
    const begin = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await begin).not.toBeNull();
    writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'actually-new-login');
    const fresh = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(11_000);
    expect(await fresh).not.toBeNull();
  });

  it('does not accept an old in-flight mint after another process revokes and stamps a newer login', async () => {
    defaultDelay = 10_000;
    const old = auth.mintBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(1000);
    epoch.bumpCliAuthEpoch(USER);
    // Another daemon owns this new login: it has its own process-local epoch
    // maps, but shares the durable epoch and HOME with the old daemon.
    vi.resetModules(); const otherDaemon = await import('../src/services/bytedcli-auth.js');
    const login = otherDaemon.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await login).not.toBeNull();
    expect(readFileSync(join(auth.bytedcliHomeFor(USER), '.botmux-auth-epoch'), 'utf8').trim()).toBe(String(epoch.readCliAuthEpoch(USER)));
    writeFileSync(join(auth.bytedcliHomeFor(USER), 'authorized'), 'new-session');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await old).toBeNull();
  });

  it.each(['durable-bump-and-clear', 'durable-bump-only'])('keeps a post-revoke login begin behind an old SDK writer with durable bump before clear: %s', async revokeMode => {
    defaultDelay = 10_000; rewriteOldHome = true;
    const old = auth.renewBytedcliJwts(USER); await vi.advanceTimersByTimeAsync(1000);
    // Production revocation persists the epoch before clearing the HOME.
    epoch.bumpCliAuthEpoch(USER);
    if (revokeMode === 'durable-bump-and-clear') auth.clearBytedcliAuth(USER);
    const login = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(20);
    const overlapped = maximumActive;
    await vi.advanceTimersByTimeAsync(10_000); expect(await old).toBeNull(); await login;
    expect.soft(overlapped).toBe(1);
    // Before the new challenge is authorized, stale SDK files may not inherit
    // its fresh epoch stamp and masquerade as a usable new login.
    const status = auth.describeBytedcliAuth(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await status).toEqual({ state: 'needs-login' });
  });

  it('accepts another daemon\'s completed post-revoke login and preserves its valid shared HOME on begin', async () => {
    epoch.bumpCliAuthEpoch(USER); auth.clearBytedcliAuth(USER);
    vi.resetModules(); const otherDaemon = await import('../src/services/bytedcli-auth.js');
    const begin = otherDaemon.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    const challenge = await begin;
    expect(challenge).not.toBeNull();
    completeSuccess = true;
    const complete = otherDaemon.completeBytedcliLogin(USER, challenge!.completeToken);
    await vi.advanceTimersByTimeAsync(10);
    expect(await complete).toEqual({ state: 'authorized' });
    const home = auth.bytedcliHomeFor(USER);
    expect(epoch.cliAuthEpochAllows(USER, home)).toBe(true);
    const otherStatus = otherDaemon.hasBytedcliHome(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await otherStatus).toBe(true);
    const originalStatus = auth.hasBytedcliHome(USER); await vi.advanceTimersByTimeAsync(10);
    expect.soft(await originalStatus).toBe(true);
    const authorized = readFileSync(join(home, 'authorized'), 'utf8');
    const nextBegin = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await nextBegin).not.toBeNull();
    expect(existsSync(join(home, 'authorized'))).toBe(true);
    expect(readFileSync(join(home, 'authorized'), 'utf8')).toBe(authorized);
    const after = auth.hasBytedcliHome(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await after).toBe(true);
  });

  it('preserves an unstamped legacy HOME at durable epoch zero when beginning a login', async () => {
    const home = auth.bytedcliHomeFor(USER);
    expect(epoch.readCliAuthEpoch(USER)).toBe(0);
    expect(existsSync(join(home, '.botmux-auth-epoch'))).toBe(false);
    const authorized = readFileSync(join(home, 'authorized'), 'utf8');
    const status = auth.hasBytedcliHome(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await status).toBe(true);
    const begin = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await begin).not.toBeNull();
    expect(existsSync(join(home, 'authorized'))).toBe(true);
    expect(readFileSync(join(home, 'authorized'), 'utf8')).toBe(authorized);
    const after = auth.hasBytedcliHome(USER); await vi.advanceTimersByTimeAsync(10);
    expect(await after).toBe(true);
  });

  it.each(['same-daemon', 'other-daemon'])('does not let a late old login completion consume the new challenge: %s', async where => {
    const first = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    const original = await first;
    completeDelay = 10_000; completeSuccess = true;
    const old = auth.completeBytedcliLogin(USER, original!.completeToken);
    await vi.advanceTimersByTimeAsync(1000);
    epoch.bumpCliAuthEpoch(USER);
    let nextAuth = auth;
    if (where === 'same-daemon') auth.clearBytedcliAuth(USER);
    else { vi.resetModules(); nextAuth = await import('../src/services/bytedcli-auth.js'); }
    const next = nextAuth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10_000);
    const replacement = await next;
    expect(replacement?.completeToken).not.toBe(original?.completeToken);
    expect.soft((await old).state).not.toBe('authorized');
    expect(auth.pendingBytedcliChallenge(USER)).toBe(replacement!.completeToken);
    if (where === 'same-daemon') {
      expect(maximumActive).toBe(1);
      const status = auth.describeBytedcliAuth(USER); await vi.advanceTimersByTimeAsync(10);
      expect(await status).toEqual({ state: 'needs-login' });
    }
  });

  it.each(['local-revoke', 'durable-revoke-only'])('does not coalesce a newly admitted login with the revoked generation pending begin: %s', async revokeMode => {
    loginDelay = 10_000;
    const old = auth.beginBytedcliLogin(USER); await vi.advanceTimersByTimeAsync(1000);
    epoch.bumpCliAuthEpoch(USER);
    if (revokeMode === 'local-revoke') auth.clearBytedcliAuth(USER);
    const next = auth.beginBytedcliLogin(USER);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await old).toBeNull();
    expect(await next).not.toBeNull();
    expect(maximumActive).toBe(1);
  });
});
