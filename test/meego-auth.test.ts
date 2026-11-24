/**
 * The daemon side of the shared Meego login: botmux starts the device flow in
 * the person's own store and completes it there, whichever session asks.
 *
 * `bytedcli` is a stub on PATH that keeps its login where meegle does
 * (`$HOME/.meegle`) and completes a challenge only once the test "approves" it
 * for that person.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const COMPLETE_TOKEN = 'stub-complete-token-secret';

const realSetTimeout = globalThis.setTimeout;
let dir: string;
const saved: Record<string, string | undefined> = {};
const loadedModules: Array<{ stopAllMeegoPollers: () => void }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-meego-auth-'));
  for (const key of ['HOME', 'PATH', 'STUB_DIR', 'STUB_FAIL', 'STUB_COMPLETE_FAIL', 'STUB_EXPIRED', 'STUB_SWAP_TOKEN', 'STUB_RACE_BEGIN', 'BYTEDCLI_MEEGO_TENANT']) saved[key] = process.env[key];
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bytedcli'), [
    '#!/bin/sh',
    'printf "%s\\t%s\\t%s\\n" "$HOME" "$*" "${BYTEDCLI_MEEGO_TENANT-unset}" >> "$STUB_DIR/cli.log"',
    'store="$HOME/.meegle"',
    'who=$(basename "$(dirname "$HOME")")',
    '[ "$1" = -j ] && shift; shift',
    // Lets a test act while a login call is in flight.
    'if [ "$1" = login ] && [ -f "$STUB_DIR/hold" ]; then',
    '  printf "x\\n" >> "$STUB_DIR/held"; i=0',
    '  while [ ! -f "$STUB_DIR/go" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done',
    'fi',
    'case "$1 $2" in',
    '  "status ")',
    '    if [ -s "$store/credentials-bytedcli.enc" ]; then a=true; else a=false; fi',
    '    printf \'{"status":"success","data":{"official_meegle_cli_authenticated":%s}}\\n\' "$a" ;;',
    '  "login --begin")',
    '    [ -z "$STUB_FAIL" ] || { echo \'{"status":"error","error":{"code":"NETWORK"}}\'; exit 1; }',
    '    n=$(( $(cat "$STUB_DIR/begins" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/begins"',
    '    if [ -n "$STUB_RACE_BEGIN" ]; then',
    '      printf "x\\n" >> "$STUB_DIR/held"; i=0',
    '      while [ ! -f "$STUB_DIR/go" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done',
    '    fi',
    '    code="$who-$n"; [ -z "$STUB_RACE_BEGIN" ] || code="race-$$"',
    '    mkdir -p "$store" "$TMPDIR/bytedcli/meego-login-$n"; : > "$TMPDIR/bytedcli/meego-login-$n/qr.png"',
    `    printf '{"status":"success","data":{"verification_uri_complete":"https://meego.example/device?code=%s","complete_token":"${COMPLETE_TOKEN}","qr_image_path":"%s"}}\\n' "$code" "$TMPDIR/bytedcli/meego-login-$n/qr.png" ;;`,
    '  "login --complete")',
    '    [ -z "$STUB_COMPLETE_FAIL" ] || { echo \'{"status":"error","error":{"code":"NETWORK"}}\'; exit 1; }',
    '    if [ -n "$STUB_SWAP_TOKEN" ]; then cp "$STUB_DIR/c2-challenge" "$HOME/.botmux-meego-challenge"; fi',
    '    [ -z "$STUB_EXPIRED" ] || { echo \'{"status":"success","data":{"login_status":"expired"}}\'; exit 0; }',
    `    [ "$3" = ${COMPLETE_TOKEN} ] || { echo '{"status":"error","error":{"code":"MEEGO_LOGIN_CHALLENGE_INVALID"}}'; exit 1; }`,
    '    if [ -f "$STUB_DIR/approved-$who" ]; then',
    '      mkdir -p "$store" && cp "$STUB_DIR/approved-$who" "$store/credentials-bytedcli.enc"',
    '      echo \'{"status":"success","data":{"login_status":"success"}}\'',
    '      : > "$STUB_DIR/complete-finished"',
    '    else echo \'{"status":"error","error":{"code":"MEEGO_LOGIN_TIMEOUT"}}\'; exit 1; fi ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'bytedcli'), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.STUB_DIR = dir;
  delete process.env.STUB_FAIL;
  delete process.env.STUB_COMPLETE_FAIL;
  delete process.env.STUB_EXPIRED;
  delete process.env.STUB_SWAP_TOKEN;
  delete process.env.STUB_RACE_BEGIN;
});
afterEach(() => {
  for (const mod of loadedModules.splice(0)) mod.stopAllMeegoPollers();
  vi.useRealTimers();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Fresh modules, so every HOME-derived root lands under this test's HOME. */
async function load() {
  vi.resetModules();
  const auth = await import('../src/services/meego-auth.js');
  const home = await import('../src/services/bytedcli-home.js');
  const epoch = await import('../src/services/cli-auth-epoch.js');
  loadedModules.push(auth);
  return { ...auth, ...home, ...epoch };
}

const approve = (openId: string, credential: string) => writeFileSync(join(dir, `approved-${openId}`), credential);
const begins = () => existsSync(join(dir, 'begins')) ? Number(readFileSync(join(dir, 'begins'), 'utf8')) : 0;
const cliCalls = () => readFileSync(join(dir, 'cli.log'), 'utf8').replace(/\n+$/, '').split('\n').filter(Boolean).map(l => {
  const [home, args, tenant] = l.split('\t');
  return { home, args, tenant };
});

/** Run `act` while the next login call is in flight, then let it finish. */
async function whileLoginRuns<T>(request: Promise<T>, act: () => void): Promise<T> {
  for (let i = 0; i < 200 && !existsSync(join(dir, 'held')); i++) await new Promise(r => setTimeout(r, 25));
  act();
  writeFileSync(join(dir, 'go'), '');
  return await request;
}

describe('requestMeegoLogin', () => {
  it('starts the login in the person\'s own store and returns the link, never the token', async () => {
    const m = await load();
    const result = await m.requestMeegoLogin(ALICE);
    expect(result).toEqual({ state: 'link', authUrl: 'https://meego.example/device?code=ou_alice-1' });
    expect(JSON.stringify(result)).not.toContain(COMPLETE_TOKEN);

    const home = m.meegoHomeFor(ALICE);
    expect(home.startsWith(join(process.env.HOME!, '.botmux', 'data', 'meego-home', ALICE) + '/')).toBe(true);
    expect(new Set(cliCalls().map(c => c.home))).toEqual(new Set([home]));
    const challenge = join(home, '.botmux-meego-challenge');
    expect(statSync(challenge).mode & 0o777).toBe(0o600);
    // The QR image of the same link is not left behind.
    expect(existsSync(join(home, '.tmp', 'bytedcli', 'meego-login-1'))).toBe(false);
  });

  it('asking again before approval returns the same link without a second login', async () => {
    const m = await load();
    const first = await m.requestMeegoLogin(ALICE);
    expect(await m.requestMeegoLogin(ALICE)).toEqual(first);
    expect(begins()).toBe(1);
  });

  it('two sessions asking at once share one challenge', async () => {
    const m = await load();
    const [a, b] = await Promise.all([m.requestMeegoLogin(ALICE), m.requestMeegoLogin(ALICE)]);
    expect(a).toEqual(b);
    expect(begins()).toBe(1);
  });

  it('two independent daemon modules racing --begin share the first live challenge instead of overwriting it', async () => {
    const a = await load();
    const b = await load();
    process.env.STUB_RACE_BEGIN = '1';
    const requestA = a.requestMeegoLogin(ALICE);
    const requestB = b.requestMeegoLogin(ALICE);
    await waitUntil(() => existsSync(join(dir, 'held'))
      && readFileSync(join(dir, 'held'), 'utf8').trim().split('\n').length === 2);
    writeFileSync(join(dir, 'go'), '');

    const [resultA, resultB] = await Promise.all([requestA, requestB]);
    expect(resultA).toEqual(resultB);
    if (resultA.state !== 'link') throw new Error('expected a live challenge link');
    expect(cliCalls().filter(c => c.args === '-j meego login --begin')).toHaveLength(2);
    const onDisk = JSON.parse(readFileSync(join(a.meegoHomeFor(ALICE), '.botmux-meego-challenge'), 'utf8'));
    expect(onDisk.authUrl).toBe(resultA.authUrl);
  });

  it('after approval the next request, from any session, completes it into the store', async () => {
    const m = await load();
    await m.requestMeegoLogin(ALICE);
    approve(ALICE, 'alice-login');
    expect(await m.requestMeegoLogin(ALICE)).toEqual({ state: 'ready' });
    const home = m.meegoHomeFor(ALICE);
    expect(readFileSync(join(home, '.meegle', 'credentials-bytedcli.enc'), 'utf8')).toBe('alice-login');
    expect(existsSync(join(home, '.botmux-meego-challenge'))).toBe(false);

    // Logged in: reported ready by the provider, nothing new started.
    expect(await m.requestMeegoLogin(ALICE)).toEqual({ state: 'ready' });
    expect(begins()).toBe(1);
  });

  it('keeps people apart: Bob gets his own challenge and store', async () => {
    const m = await load();
    await m.requestMeegoLogin(ALICE);
    approve(ALICE, 'alice-login');
    await m.requestMeegoLogin(ALICE);

    const bob = await m.requestMeegoLogin(BOB);
    expect(bob).toEqual({ state: 'link', authUrl: 'https://meego.example/device?code=ou_bob-2' });
    expect(cliCalls().at(-1)?.home).toBe(m.meegoHomeFor(BOB));
    expect(existsSync(join(m.meegoHomeFor(BOB), '.meegle', 'credentials-bytedcli.enc'))).toBe(false);
    expect(readFileSync(join(m.meegoHomeFor(ALICE), '.meegle', 'credentials-bytedcli.enc'), 'utf8')).toBe('alice-login');
  });

  it('an expired challenge is replaced by a new login', async () => {
    const m = await load();
    await m.requestMeegoLogin(ALICE);
    const challenge = join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge');
    const saved = JSON.parse(readFileSync(challenge, 'utf8'));
    writeFileSync(challenge, JSON.stringify({ ...saved, createdAt: Date.now() - 26 * 60_000 }));
    expect(await m.requestMeegoLogin(ALICE)).toEqual({ state: 'link', authUrl: 'https://meego.example/device?code=ou_alice-2' });
  });

  it('provider down: unavailable, and nothing is saved', async () => {
    const m = await load();
    process.env.STUB_FAIL = '1';
    expect((await m.requestMeegoLogin(ALICE)).state).toBe('unavailable');
    expect(existsSync(join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge'))).toBe(false);
  });

  it('refuses an open_id that could escape the store root', async () => {
    const m = await load();
    for (const bad of ['../x', 'a/b', '', '.']) await expect(m.requestMeegoLogin(bad)).rejects.toThrow(/open_id/);
  });
});

describe('revocation', () => {
  it('a bumped epoch starts over in a fresh store; clearMeegoAuth removes only that person', async () => {
    const m = await load();
    await m.requestMeegoLogin(ALICE);
    approve(ALICE, 'alice-login');
    await m.requestMeegoLogin(ALICE);
    await m.requestMeegoLogin(BOB);
    const before = m.meegoHomeFor(ALICE);

    m.bumpCliAuthEpoch(ALICE);
    expect(m.meegoHomeFor(ALICE)).not.toBe(before);
    expect(basename(dirname(m.meegoHomeFor(ALICE)))).toBe(ALICE);
    rmSync(join(dir, `approved-${ALICE}`));
    expect((await m.requestMeegoLogin(ALICE)).state).toBe('link');

    expect(m.clearMeegoAuth(ALICE)).toBe(true);
    expect(existsSync(m.meegoPersonRoot(ALICE))).toBe(false);
    expect(existsSync(m.meegoHomeFor(BOB))).toBe(true);
    expect(m.clearMeegoAuth(ALICE)).toBe(false);
  });

  it('a revoke while the person\'s approval is being completed leaves no login behind', async () => {
    const m = await load();
    await m.requestMeegoLogin(ALICE);
    approve(ALICE, 'alice-login');
    const revokedHome = m.meegoHomeFor(ALICE);
    writeFileSync(join(dir, 'hold'), '');
    const result = await whileLoginRuns(m.requestMeegoLogin(ALICE), () => {
      m.bumpCliAuthEpoch(ALICE);
      m.clearMeegoAuth(ALICE);
    });
    expect(result.state).toBe('unavailable');
    expect(existsSync(revokedHome)).toBe(false);
  });

  it('a revoke while a login is being started leaves no challenge or store behind', async () => {
    const m = await load();
    const revokedHome = m.meegoHomeFor(ALICE);
    writeFileSync(join(dir, 'hold'), '');
    const result = await whileLoginRuns(m.requestMeegoLogin(ALICE), () => {
      m.bumpCliAuthEpoch(ALICE);
      m.clearMeegoAuth(ALICE);
    });
    expect(result.state).toBe('unavailable');
    expect(existsSync(revokedHome)).toBe(false);
  });
  it('does not recreate a HOME for a request that was queued before revocation', async () => {
    const m = await load();
    writeFileSync(join(dir, 'hold'), '');
    const first = m.requestMeegoLogin(ALICE);
    await waitUntil(() => existsSync(join(dir, 'held')));
    const queuedBeforeRevoke = m.requestMeegoLogin(ALICE);

    m.bumpCliAuthEpoch(ALICE);
    m.clearMeegoAuth(ALICE);
    writeFileSync(join(dir, 'go'), '');
    const [firstResult, queuedResult] = await Promise.all([first, queuedBeforeRevoke]);

    expect(firstResult.state).toBe('unavailable');
    expect(queuedResult.state).toBe('unavailable');
    expect(begins()).toBe(1);
    // The first in-flight request may leave an empty person-root after removing
    // its old epoch; the queued request must not create the current epoch HOME.
    expect(existsSync(m.meegoHomeFor(ALICE))).toBe(false);
  });
});

describe('tenant', () => {
  it('runs bytedcli under the tenant asked for, and the default one under no tenant at all', async () => {
    const m = await load();
    process.env.BYTEDCLI_MEEGO_TENANT = 'dcar';
    await m.requestMeegoLogin(ALICE);
    await m.requestMeegoLogin(ALICE, 'dcar');
    expect(new Set(cliCalls().filter(c => c.tenant === '').map(c => c.args))).toEqual(new Set(['-j meego status', '-j meego login --begin']));
    expect(new Set(cliCalls().filter(c => c.tenant === 'dcar').map(c => c.args))).toEqual(new Set(['-j meego status', '-j meego login --begin']));
  });

  it('keeps one pending challenge per tenant', async () => {
    const m = await load();
    const plain = await m.requestMeegoLogin(ALICE);
    const dcar = await m.requestMeegoLogin(ALICE, 'dcar');
    expect(dcar).not.toEqual(plain);
    expect(await m.requestMeegoLogin(ALICE)).toEqual(plain);
    expect(await m.requestMeegoLogin(ALICE, 'dcar')).toEqual(dcar);
    expect(begins()).toBe(2);
    expect(existsSync(join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge-dcar'))).toBe(true);
  });

  it('refuses a tenant bytedcli does not know', async () => {
    const m = await load();
    await expect(m.requestMeegoLogin(ALICE, 'other' as never)).rejects.toThrow(/tenant/);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise<void>(resolve => realSetTimeout(resolve, 15));
  }
}

async function settleRealIo(ms = 60): Promise<void> {
  await new Promise<void>(resolve => realSetTimeout(resolve, ms));
}

const completeCalls = (tenant?: string) => existsSync(join(dir, 'cli.log'))
  ? cliCalls().filter(c => c.args.startsWith('-j meego login --complete') && (tenant === undefined || c.tenant === tenant))
  : [];

describe('background completion poller', () => {
  it('completes an approved challenge in the background without a second requestMeegoLogin call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    const completedUsers: string[] = [];
    const unsubscribe = m.onMeegoLoginCompleted(openId => completedUsers.push(openId));
    try {
      expect((await m.requestMeegoLogin(ALICE)).state).toBe('link');
      const home = m.meegoHomeFor(ALICE);
      expect(existsSync(join(home, '.botmux-meego-challenge'))).toBe(true);

      // First two background polls see MEEGO_LOGIN_TIMEOUT (pending).
      vi.advanceTimersByTime(3_000);
      await waitUntil(() => completeCalls('').length === 1);
      await settleRealIo();
      vi.advanceTimersByTime(3_000);
      await waitUntil(() => completeCalls('').length === 2);
      await settleRealIo();
      expect(existsSync(join(home, '.botmux-meego-challenge'))).toBe(true);
      expect(completedUsers).toEqual([]);

      // User approves in browser; next poll persists credentials, clears the challenge, and notifies listeners.
      approve(ALICE, 'alice-bg-login');
      vi.advanceTimersByTime(3_000);
      await waitUntil(() => completedUsers.length === 1
        && existsSync(join(home, '.meegle', 'credentials-bytedcli.enc'))
        && !existsSync(join(home, '.botmux-meego-challenge')));
      await settleRealIo();
      expect(completedUsers).toEqual([ALICE]);
      expect(readFileSync(join(home, '.meegle', 'credentials-bytedcli.enc'), 'utf8')).toBe('alice-bg-login');

      // Poller has stopped: advancing further fires zero additional --complete calls.
      const callsAfterComplete = completeCalls('').length;
      vi.advanceTimersByTime(60_000);
      await settleRealIo();
      expect(completeCalls('').length).toBe(callsAfterComplete);

      // Even after the original 25m challenge TTL has elapsed, the login is ready with no second --begin.
      vi.setSystemTime(Date.now() + 45 * 60_000);
      expect(await m.requestMeegoLogin(ALICE)).toEqual({ state: 'ready' });
      expect(begins()).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('emits a tenant-scoped completion when a foreground /login finishes the challenge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    const events: Array<[string, string | undefined]> = [];
    const unsubscribe = m.onMeegoLoginCompleted((openId, tenant) => events.push([openId, tenant]));
    try {
      expect((await m.requestMeegoLogin(ALICE, 'dcar')).state).toBe('link');
      approve(ALICE, 'alice-foreground-login');
      expect(await m.requestMeegoLogin(ALICE, 'dcar')).toEqual({ state: 'ready' });
      expect(events).toEqual([[ALICE, 'dcar']]);
      expect(readFileSync(join(m.meegoHomeFor(ALICE), '.meegle', 'credentials-bytedcli.enc'), 'utf8')).toBe('alice-foreground-login');
    } finally {
      unsubscribe();
    }
  });

  it('deduplicates pollers for repeated requests sharing the same challenge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    const first = await m.requestMeegoLogin(ALICE);
    expect(await m.requestMeegoLogin(ALICE)).toEqual(first);
    // Second requestMeegoLogin did one direct --complete probe.
    const baseline = completeCalls('').length;
    expect(baseline).toBe(1);

    // One timer tick triggers exactly one background poll, not two.
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === baseline + 1);
    await settleRealIo();
    expect(completeCalls('').length).toBe(baseline + 1);
  });

  it('removes the challenge and stops polling when the provider reports it expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    const challenge = join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge');
    expect(existsSync(challenge)).toBe(true);

    process.env.STUB_EXPIRED = '1';
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => !existsSync(challenge));
    await settleRealIo();
    const afterExpired = completeCalls('').length;
    vi.advanceTimersByTime(60_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(afterExpired);
  });

  it('reports provider-side expiry with the tenant so creation cooldowns can be invalidated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    const events: Array<[string, string | undefined]> = [];
    const unsubscribe = m.onMeegoChallengeGone((openId, tenant) => events.push([openId, tenant]));
    try {
      await m.requestMeegoLogin(ALICE);
      process.env.STUB_EXPIRED = '1';
      vi.advanceTimersByTime(3_000);
      await waitUntil(() => events.length === 1);
      expect(events).toEqual([[ALICE, undefined]]);
    } finally {
      unsubscribe();
    }
  });

  it('reports provider-side expiry discovered by a foreground request before minting its replacement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    const events: Array<[string, string | undefined]> = [];
    const unsubscribe = m.onMeegoChallengeGone((openId, tenant) => events.push([openId, tenant]));
    try {
      await m.requestMeegoLogin(ALICE);
      m.stopAllMeegoPollers();
      process.env.STUB_EXPIRED = '1';
      const replacement = await m.requestMeegoLogin(ALICE);
      expect(replacement).toEqual({ state: 'link', authUrl: 'https://meego.example/device?code=ou_alice-2' });
      if (replacement.state !== 'link') throw new Error('expected a replacement link');
      expect(events).toEqual([[ALICE, undefined]]);
      const onDisk = JSON.parse(readFileSync(join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge'), 'utf8'));
      expect(onDisk.authUrl).toBe(replacement.authUrl);
    } finally {
      unsubscribe();
    }
  });

  it('never erases a newer challenge another daemon minted while a background poll was in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    const home = m.meegoHomeFor(ALICE);
    const challengePath = join(home, '.botmux-meego-challenge');
    const first = JSON.parse(readFileSync(challengePath, 'utf8'));

    // Another daemon mints a second challenge into the same per-user home while
    // our --complete is in flight; the stub swaps the file before reporting expiry.
    writeFileSync(join(dir, 'c2-challenge'), JSON.stringify({
      token: 'c2-token', authUrl: 'https://meego.example/device-c2', createdAt: Date.now(),
    }), { mode: 0o600 });
    process.env.STUB_SWAP_TOKEN = '1';
    process.env.STUB_EXPIRED = '1';
    vi.advanceTimersByTime(3_000);
    await settleRealIo(120);

    const onDisk = JSON.parse(readFileSync(challengePath, 'utf8'));
    expect(onDisk.token).toBe('c2-token');
    expect(onDisk.token).not.toBe(first.token);
  });

  it('backs off polling cadence across 2m / 5m windows and stops before the 25m TTL boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = new Date('2026-11-24T01:00:00Z').getTime();
    vi.setSystemTime(t0);
    const m = await load();

    await m.requestMeegoLogin(ALICE);

    // Move past 2m and fire the pending initial timer so scheduleNext computes the 6s cadence.
    vi.setSystemTime(t0 + 2 * 60_000);
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === 1);
    await settleRealIo();

    // Inside 2m..5m window: 3s is too early, 6s triggers poll #2.
    vi.advanceTimersByTime(3_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(1);
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === 2);
    await settleRealIo();

    // Move past 5m and trigger the armed 6s timer so scheduleNext switches to 15s cadence.
    vi.setSystemTime(t0 + 5 * 60_000);
    vi.advanceTimersByTime(6_000);
    await waitUntil(() => completeCalls('').length === 3);
    await settleRealIo();

    // Inside >=5m window: 6s is too early, +9s (15s total) triggers poll #4.
    vi.advanceTimersByTime(6_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(3);
    vi.advanceTimersByTime(9_000);
    await waitUntil(() => completeCalls('').length === 4);
    await settleRealIo();

    // At 24m50s (remaining = 10s < 15s next delay), firing the armed timer completes poll #5
    // and scheduleNext stops cleanly without arming a doomed post-TTL timer.
    vi.setSystemTime(t0 + 24 * 60_000 + 35_000);
    vi.advanceTimersByTime(15_000);
    await waitUntil(() => completeCalls('').length === 5);
    await settleRealIo();

    vi.advanceTimersByTime(60_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(5);
  });

  it('cancels polling on cross-daemon epoch revocation even while the old challenge file still exists on disk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    const oldHome = m.meegoHomeFor(ALICE);
    // Bump durable epoch WITHOUT deleting oldHome yet (mirrors the window while remote logout runs).
    m.bumpCliAuthEpoch(ALICE);
    expect(existsSync(join(oldHome, '.botmux-meego-challenge'))).toBe(true);

    vi.advanceTimersByTime(3_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(0);

    // Also verify deleting oldHome afterwards never gets recreated on further timer ticks.
    rmSync(oldHome, { recursive: true, force: true });
    vi.advanceTimersByTime(60_000);
    await settleRealIo();
    expect(existsSync(oldHome)).toBe(false);
  });

  it('cleans up the revoked HOME if revocation happens while a background poll is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    const revokedHome = m.meegoHomeFor(ALICE);
    approve(ALICE, 'alice-race-login');
    writeFileSync(join(dir, 'hold'), '');

    // Trigger the background poll and wait until the stub CLI is blocked inside --complete.
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => existsSync(join(dir, 'held')));

    // Revoke while the child process is mid-flight, then release it.
    m.bumpCliAuthEpoch(ALICE);
    m.clearMeegoAuth(ALICE);
    writeFileSync(join(dir, 'go'), '');

    // Wait until the stub CLI actually wrote credentials into revokedHome and exited,
    // THEN verify the post-completeOnce epoch guard deleted the recreated directory.
    await waitUntil(() => existsSync(join(dir, 'complete-finished')));
    await waitUntil(() => !existsSync(revokedHome));
    await settleRealIo(80);
    expect(existsSync(revokedHome)).toBe(false);
  });

  it('fences an in-flight requestMeegoLogin from arming a poller after stopAllMeegoPollers()', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    writeFileSync(join(dir, 'hold'), '');
    const pendingLogin = m.requestMeegoLogin(ALICE);
    await waitUntil(() => existsSync(join(dir, 'held')));

    // Daemon shuts down while --begin is still in flight.
    m.stopAllMeegoPollers();
    writeFileSync(join(dir, 'go'), '');
    expect((await pendingLogin).state).toBe('link');

    vi.advanceTimersByTime(60_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(0);
  });

  it('rearms a restored challenge when its first foreground completion hits a transient error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    m.stopAllMeegoPollers(); // persisted challenge after restart, no in-memory poller
    process.env.STUB_COMPLETE_FAIL = '1';
    expect((await m.requestMeegoLogin(ALICE)).state).toBe('unavailable');
    delete process.env.STUB_COMPLETE_FAIL;
    const callsAfterError = completeCalls('').length;

    approve(ALICE, 'alice-restored-login');
    vi.advanceTimersByTime(60_000);
    await waitUntil(() => completeCalls('').length > callsAfterError
      && existsSync(join(m.meegoHomeFor(ALICE), '.meegle', 'credentials-bytedcli.enc')));

    expect(readFileSync(join(m.meegoHomeFor(ALICE), '.meegle', 'credentials-bytedcli.enc'), 'utf8')).toBe('alice-restored-login');
  });

  it('applies exponential error backoff and stops after consecutive provider errors while keeping the challenge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    const challenge = join(m.meegoHomeFor(ALICE), '.botmux-meego-challenge');
    process.env.STUB_COMPLETE_FAIL = '1';

    // Poll #1 fails at 3s; next poll backs off to 6s (3s is too early).
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === 1);
    await settleRealIo();
    vi.advanceTimersByTime(3_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(1);
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === 2);
    await settleRealIo();

    // Remaining 8 errors (up to cap of 10) with backoff intervals.
    for (let i = 3; i <= 10; i++) {
      vi.advanceTimersByTime(60_000);
      await waitUntil(() => completeCalls('').length === i);
      await settleRealIo();
    }
    // Further advances trigger no more calls, and the challenge file remains intact.
    vi.advanceTimersByTime(120_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(10);
    expect(existsSync(challenge)).toBe(true);
  });

  it('isolates pollers by tenant and clears all timers on stopAllMeegoPollers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-24T01:00:00Z'));
    const m = await load();

    await m.requestMeegoLogin(ALICE);
    await m.requestMeegoLogin(ALICE, 'dcar');
    vi.advanceTimersByTime(3_000);
    await waitUntil(() => completeCalls('').length === 1 && completeCalls('dcar').length === 1);
    await settleRealIo();

    m.stopAllMeegoPollers();
    vi.advanceTimersByTime(60_000);
    await settleRealIo();
    expect(completeCalls('').length).toBe(1);
    expect(completeCalls('dcar').length).toBe(1);
  });
});
