import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  TraeLoginManager, parseTraeLoginChallenge, validateTraeLoginCallback,
  redactTraeLoginCommand, type TraeLoginTarget,
} from '../src/services/trae-login.js';

const owner = { appId: 'cli_test', openId: 'ou_admin' };
const callback = 'http://127.0.0.1:43210/authorize';
const loginUrl = 'https://console.enterprise.trae.cn/authorization?auth_callback_url=' + encodeURIComponent(callback);
const prompt = loginUrl + '\nAfter signing in on another machine, copy the final 127.0.0.1 callback URL, paste it here to verify automatically.\n';
const roots: string[] = [];
const managers: TraeLoginManager[] = [];
function target(): TraeLoginTarget {
  const root = mkdtempSync(join(tmpdir(), 'trae-login-test-')); roots.push(root);
  return { bin: '/native/traecli', root, env: { TRAE_HOME: root } };
}
function native() {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', null)); return true; });
  return child;
}
function manager(child = native(), ttlMs?: number) {
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.stdout!.emit('data', prompt));
    return child;
  });
  const m = new TraeLoginManager({ spawn, ttlMs }); managers.push(m);
  return { m, child, spawn };
}
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('native login protocol boundaries', () => {
  it('requires the remote callback contract and the official enterprise endpoint', () => {
    expect(parseTraeLoginChallenge(prompt)?.callback.href).toBe(callback);
    expect(parseTraeLoginChallenge(loginUrl)).toBeUndefined();
    expect(parseTraeLoginChallenge(prompt.replace('console.enterprise.trae.cn', 'attacker.test'))).toBeUndefined();
    expect(parseTraeLoginChallenge(prompt.replace(encodeURIComponent(callback), encodeURIComponent('https://other.test/authorize')))).toBeUndefined();
  });
  it.each([
    'http://10.1.2.3:43210/authorize?token=x',
    'http://127.0.0.1:43211/authorize?token=x',
    'http://127.0.0.1:43210/other?token=x',
    'http://user:pass@127.0.0.1:43210/authorize?token=x',
    callback + '?token=x#secret', callback, callback + '?token=x\nsecond',
  ])('rejects callback endpoint substitution: %s', raw => {
    expect(validateTraeLoginCallback(raw, new URL(callback))).toBe(false);
  });
  it('accepts the browser callback only for the expected native server', () => {
    expect(validateTraeLoginCallback(callback + '?token=synthetic&state=s', new URL(callback))).toBe(true);
    expect(redactTraeLoginCommand('/dashboard trae-login complete request ' + callback + '?token=synthetic')).not.toContain('synthetic');
    expect(redactTraeLoginCommand('/dashboard sessions')).toBe('/dashboard sessions');
    expect(redactTraeLoginCommand('请解释 /dashboard trae-login complete 命令')).toBe('请解释 /dashboard trae-login complete 命令');
    expect(redactTraeLoginCommand('@Claude Code /dashboard trae-login complete request http://127.0.0.1:43210/authorize?token=x',
      '/dashboard trae-login complete request http://127.0.0.1:43210/authorize?token=x')).not.toContain('token=x');
  });
});

describe('daemon-owned login', () => {
  it('reuses the same pending challenge and reports success only after native exit', async () => {
    const { m, child, spawn } = manager(); const t = target();
    const first = await m.begin(t, owner);
    expect(first).toMatchObject({ state: 'pending', url: loginUrl });
    expect((await m.begin(t, owner)).id).toBe(first.id); expect(spawn).toHaveBeenCalledOnce();
    const inputs: string[] = []; child.stdin!.on('data', b => inputs.push(String(b)));
    expect((await m.complete(t, owner, first.id, callback + '?token=synthetic')).state).toBe('verifying');
    expect(inputs).toEqual([callback + '?token=synthetic\n']);
    expect(m.status(t, owner)?.state).toBe('verifying');
    child.emit('exit', 0);
    await Promise.resolve();
    expect(m.status(t, owner)).toMatchObject({ state: 'succeeded' });
    expect(m.status(t, owner)?.url).toBeUndefined();
  });
  it('does not expose or submit another administrator or application\'s challenge', async () => {
    const { m, child } = manager(); const t = target(); const a = await m.begin(t, owner);
    const other = { ...owner, openId: 'ou_other' };
    expect(m.status(t, other)).toBeUndefined();
    await expect(m.begin(t, other)).rejects.toThrow('login_busy');
    await expect(m.complete(t, other, a.id, callback + '?token=x')).rejects.toThrow('login_missing');
    await expect(m.cancel(t, { ...owner, appId: 'cli_other' })).rejects.toThrow('login_missing');
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('serializes the complete login across independent daemon instances', async () => {
    const a = manager(); const b = manager(); const t = target();
    await a.m.begin(t, owner);
    expect((await b.m.begin(t, owner)).state).toBe('failed');
    expect(b.spawn).not.toHaveBeenCalled();
    await a.m.cancel(t, owner);
    expect((await b.m.begin(t, owner)).state).toBe('pending');
  });
  it('rejects stale request IDs and keeps malformed callbacks retryable', async () => {
    const { m } = manager(); const t = target(); const a = await m.begin(t, owner);
    await expect(m.complete(t, owner, 'old-request', callback + '?token=x')).rejects.toThrow('login_missing');
    await expect(m.complete(t, owner, a.id, callback.replace('43210', '43211') + '?token=x')).rejects.toThrow('login_bad_callback');
    expect(m.status(t, owner)?.state).toBe('pending');
  });
  it('timeout cancels the native process and prevents later callback submission', async () => {
    const { m, child } = manager(undefined, 500); const t = target(); const a = await m.begin(t, owner);
    vi.useFakeTimers();
    // The manager also checks its wall deadline at submission, even when its
    // timeout callback has not been scheduled yet.
    vi.setSystemTime(a.expiresAt + 1);
    await expect(m.complete(t, owner, a.id, callback + '?token=x')).rejects.toThrow('login_not_pending');
    vi.useRealTimers();
    await m.cancel(t, owner); expect(child.kill).toHaveBeenCalled();
    expect(m.status(t, owner)?.state).toBe('cancelled');
  });
  it('never treats an early zero exit or native rejection as login success', async () => {
    const child = native();
    const m = new TraeLoginManager({ spawn: () => { queueMicrotask(() => child.emit('exit', 0)); return child; } });
    managers.push(m); expect((await m.begin(target(), owner)).state).toBe('failed');
    const second = manager(); const t = target(); await second.m.begin(t, owner);
    second.child.emit('exit', 1); await Promise.resolve(); expect(second.m.status(t, owner)?.state).toBe('failed');
  });
  it('checks the deadline again when native exit wins a race with the timeout callback', async () => {
    let now = 100;
    const child = native();
    const m = new TraeLoginManager({ now: () => now, ttlMs: 1000, spawn: () => {
      queueMicrotask(() => child.stdout!.emit('data', prompt)); return child;
    } }); managers.push(m);
    const t = target(); await m.begin(t, owner);
    now = 1200; child.emit('exit', 0); await Promise.resolve();
    expect(m.status(t, owner)?.state).toBe('cancelled');
  });
  it('precise cancellation cannot cancel a replacement request', async () => {
    const { m, child } = manager(); const t = target(); const first = await m.begin(t, owner);
    await m.cancelRequest(owner, first.id);
    const replacement = await m.begin(t, owner);
    expect(replacement.id).not.toBe(first.id);
    await m.cancelRequest(owner, first.id);
    expect(m.status(t, owner)?.state).toBe('pending');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it('revalidates authority before publishing a challenge', async () => {
    const child = native(); let allowed = true;
    const m = new TraeLoginManager({ spawn: () => {
      allowed = false; queueMicrotask(() => child.stdout!.emit('data', prompt)); return child;
    } }); managers.push(m);
    expect((await m.begin(target(), owner, async () => allowed)).state).toBe('cancelled');
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('can cancel an immutable request after the configured target changes', async () => {
    const { m, child } = manager(); const oldTarget = target(); const otherTarget = target();
    await m.begin(oldTarget, owner); expect(m.status(otherTarget, owner)).toBeUndefined();
    await m.cancelRequest(owner); expect(m.status(oldTarget, owner)?.state).toBe('cancelled');
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
