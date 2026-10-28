import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let defaultDelayMs = 1;
let active = 0;
let maxActive = 0;
let cloudNumber = 0;
const calls: string[][] = [];
vi.mock('node:os', async importOriginal => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => home, default: { ...orig, homedir: () => home } };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push([...args]);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { destroy(): void }; stderr: EventEmitter & { destroy(): void }; kill(): void };
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.kill = () => {};
    const authorized = existsSync(join(options.env.HOME, 'authorized'));
    const isDefault = args[0] === 'auth' && args[1] === 'get-bytecloud-jwt-token';
    const isStatus = args[0] === 'auth' && args[1] === 'status';
    // A provider request already accepted before a local logout can still
    // finish successfully; later requests observe the deleted authorization.
    const reply = isStatus ? JSON.stringify({ status: 'success', data: { authenticated: authorized } })
      : isDefault && authorized ? jwt(7200, `mint-${++cloudNumber}`) : '';
    setTimeout(() => {
      active -= 1;
      if (reply) child.stdout.emit('data', reply);
      child.emit('close', isStatus || reply ? 0 : 1);
    }, isDefault ? defaultDelayMs : 1);
    return child;
  }),
}));

let auth: typeof import('../src/services/bytedcli-auth.js');
let identity: typeof import('../src/core/cli-identity.js');
let renewal: typeof import('../src/core/bytedcli-identity-renewal.js');
const SESSION = 'adversarial-session';
const TURN = 'adversarial-turn';
const ALICE = 'ou_alice';
const jwt = (seconds: number, tag: string) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, region: 'cn', tag })).toString('base64url')}.sig`;
function publish(seconds = 1200, tag = 'original', turnId = TURN) {
  const grant = { tool: 'bytedcli' as const, cloudJwt: jwt(seconds, tag), codeJwt: 'code', openId: ALICE, turnId };
  identity.writeSessionIdentity(home, SESSION, grant, 'proven');
  renewal.trackBytedcliIdentityRenewal({ sessionDataDir: home, sessionId: SESSION, credentialOpenId: ALICE, identity: grant });
  return grant;
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jwt-adversarial-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  vi.resetModules();
  auth = await import('../src/services/bytedcli-auth.js');
  identity = await import('../src/core/cli-identity.js');
  renewal = await import('../src/core/bytedcli-identity-renewal.js');
  mkdirSync(auth.bytedcliHomeFor(ALICE), { recursive: true });
  writeFileSync(join(auth.bytedcliHomeFor(ALICE), 'authorized'), '{}');
  calls.length = 0; active = 0; maxActive = 0; cloudNumber = 0; defaultDelayMs = 1;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  identity.forgetProvenIdentityContent(home, SESSION);
  renewal.forgetBytedcliIdentityRenewals();
  rmSync(home, { recursive: true, force: true });
});

describe('JWT lifecycle adversarial timing probes', () => {
  it('never republishes a revoked local login when its accepted provider request completes late', async () => {
    const original = publish();
    defaultDelayMs = 10_000;
    const pending = renewal.renewExpiringBytedcliIdentities();
    await vi.advanceTimersByTimeAsync(5000);
    auth.clearBytedcliAuth(ALICE);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe(0);
    expect(identity.recallProvenIdentityContent(home, SESSION, TURN, 'bytedcli')).toBe(identity.renderIdentityEnv(original));
  });

  it('retains a replacement tracking entry when an older renewal lands for that same turn', async () => {
    publish();
    defaultDelayMs = 10_000;
    const pending = renewal.renewExpiringBytedcliIdentities();
    await vi.advanceTimersByTimeAsync(5000);
    const replacement = publish(1200, 'replacement');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe(0);
    expect(identity.recallProvenIdentityContent(home, SESSION, TURN, 'bytedcli')).toBe(identity.renderIdentityEnv(replacement));
    expect(renewal.trackedBytedcliRenewalCount()).toBe(1);
    defaultDelayMs = 1;
    const retry = renewal.renewExpiringBytedcliIdentities();
    await vi.advanceTimersByTimeAsync(100);
    expect(await retry).toBe(1);
  });

  it('does not delete a later turn replacement from a stale multi-entry sweep snapshot', async () => {
    publish(1200, 'first', 'turn-a');
    publish(1200, 'second', 'turn-b');
    defaultDelayMs = 10_000;
    const pending = renewal.renewExpiringBytedcliIdentities();
    await vi.advanceTimersByTimeAsync(5000);
    const replacement = publish(1200, 'replacement', 'turn-b');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe(1);
    expect(identity.recallProvenIdentityContent(home, SESSION, 'turn-b', 'bytedcli')).toBe(identity.renderIdentityEnv(replacement));
    expect(renewal.trackedBytedcliRenewalCount()).toBe(2);
    defaultDelayMs = 1;
    const retry = renewal.renewExpiringBytedcliIdentities();
    await vi.advanceTimersByTimeAsync(100);
    expect(await retry).toBe(1);
  });

  it('does not resurrect a cancelled turn across overlapping periodic sweeps', async () => {
    publish();
    defaultDelayMs = 10_000;
    const counts: Array<Promise<number>> = [];
    const timer = setInterval(() => { counts.push(renewal.renewExpiringBytedcliIdentities()); }, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    identity.forgetProvenIdentityContent(home, SESSION, TURN);
    await vi.advanceTimersByTimeAsync(7000);
    clearInterval(timer);
    await Promise.all(counts);
    expect(calls.filter(a => a[1] === 'get-bytecloud-jwt-token')).toHaveLength(1);
    expect(identity.recallProvenIdentityContent(home, SESSION, TURN, 'bytedcli')).toBeUndefined();
    expect(renewal.trackedBytedcliRenewalCount()).toBe(0);
  });

  it('keeps a renewed active turn tracked when periodic sweeps overlap a long provider request', async () => {
    publish();
    defaultDelayMs = 10_000;
    const counts: Array<Promise<number>> = [];
    const timer = setInterval(() => { counts.push(renewal.renewExpiringBytedcliIdentities()); }, 1000);
    await vi.advanceTimersByTimeAsync(12_000);
    clearInterval(timer);
    expect((await Promise.all(counts)).reduce((a, b) => a + b, 0)).toBe(1);
    expect(calls.filter(a => a[1] === 'get-bytecloud-jwt-token')).toHaveLength(1);
    expect(renewal.trackedBytedcliRenewalCount()).toBe(1);
    expect(await renewal.renewExpiringBytedcliIdentities()).toBe(0);
  });

  it('serializes a mint that arrives while a renewal is pending', async () => {
    defaultDelayMs = 10_000;
    const renewing = auth.renewBytedcliJwts(ALICE);
    await vi.advanceTimersByTimeAsync(5000);
    const minting = auth.mintBytedcliJwts(ALICE);
    await vi.advanceTimersByTimeAsync(16000);
    expect(await renewing).not.toBeNull();
    expect(await minting).not.toBeNull();
    expect(maxActive).toBe(1);
  });

  it('keeps old and newly authorized generations from running against the same HOME concurrently', async () => {
    defaultDelayMs = 10_000;
    const old = auth.renewBytedcliJwts(ALICE);
    await vi.advanceTimersByTimeAsync(5000);
    auth.clearBytedcliAuth(ALICE);
    mkdirSync(auth.bytedcliHomeFor(ALICE), { recursive: true });
    writeFileSync(join(auth.bytedcliHomeFor(ALICE), 'authorized'), '{}');
    const fresh = auth.renewBytedcliJwts(ALICE);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await old).toBeNull();
    expect(await fresh).not.toBeNull();
    expect(maxActive).toBe(1);
  });

  it('fails closed when the single-model companion publication fails and can republish after a module restart', async () => {
    const grant = publish();
    const codebase = identity.sessionIdentityPath(home, SESSION, 'codebase');
    mkdirSync(codebase, { recursive: true });
    expect(() => identity.writeSessionIdentity(home, SESSION, grant, 'single')).toThrow();
    const byted = identity.sessionIdentityPath(home, SESSION, 'bytedcli');
    expect(existsSync(byted)).toBe(false);
    rmSync(codebase, { recursive: true, force: true });
    vi.resetModules();
    const restarted = await import('../src/core/cli-identity.js');
    expect(restarted.recallProvenIdentityContent(home, SESSION, TURN, 'bytedcli')).toBeUndefined();
    restarted.writeSessionIdentity(home, SESSION, grant, 'single');
    expect(existsSync(byted)).toBe(true);
    expect(existsSync(codebase)).toBe(true);
  });
});
