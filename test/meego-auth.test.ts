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

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-meego-auth-'));
  for (const key of ['HOME', 'PATH', 'STUB_DIR', 'STUB_FAIL', 'BYTEDCLI_MEEGO_TENANT']) saved[key] = process.env[key];
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
    '  : > "$STUB_DIR/held"; i=0',
    '  while [ ! -f "$STUB_DIR/go" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done',
    'fi',
    'case "$1 $2" in',
    '  "status ")',
    '    if [ -s "$store/credentials-bytedcli.enc" ]; then a=true; else a=false; fi',
    '    printf \'{"status":"success","data":{"official_meegle_cli_authenticated":%s}}\\n\' "$a" ;;',
    '  "login --begin")',
    '    [ -z "$STUB_FAIL" ] || { echo \'{"status":"error","error":{"code":"NETWORK"}}\'; exit 1; }',
    '    n=$(( $(cat "$STUB_DIR/begins" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/begins"',
    '    mkdir -p "$store" "$TMPDIR/bytedcli/meego-login-$n"; : > "$TMPDIR/bytedcli/meego-login-$n/qr.png"',
    `    printf '{"status":"success","data":{"verification_uri_complete":"https://meego.example/device?code=%s-%s","complete_token":"${COMPLETE_TOKEN}","qr_image_path":"%s"}}\\n' "$who" "$n" "$TMPDIR/bytedcli/meego-login-$n/qr.png" ;;`,
    '  "login --complete")',
    `    [ "$3" = ${COMPLETE_TOKEN} ] || { echo '{"status":"error","error":{"code":"MEEGO_LOGIN_CHALLENGE_INVALID"}}'; exit 1; }`,
    '    if [ -f "$STUB_DIR/approved-$who" ]; then',
    '      mkdir -p "$store" && cp "$STUB_DIR/approved-$who" "$store/credentials-bytedcli.enc"',
    '      echo \'{"status":"success","data":{"login_status":"success"}}\'',
    '    else echo \'{"status":"error","error":{"code":"MEEGO_LOGIN_TIMEOUT"}}\'; exit 1; fi ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'bytedcli'), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.STUB_DIR = dir;
  delete process.env.STUB_FAIL;
});
afterEach(() => {
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
  return { ...auth, ...home, ...epoch };
}

const approve = (openId: string, credential: string) => writeFileSync(join(dir, `approved-${openId}`), credential);
const begins = () => existsSync(join(dir, 'begins')) ? Number(readFileSync(join(dir, 'begins'), 'utf8')) : 0;
const cliCalls = () => readFileSync(join(dir, 'cli.log'), 'utf8').trim().split('\n').map(l => {
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
