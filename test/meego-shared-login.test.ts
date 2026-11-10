/**
 * One Meego login per person, used by every session of that person.
 *
 * `bytedcli meego` keeps its login in `$HOME/.meegle`, and a trigger-user
 * bytedcli exec runs with a per-session scratch HOME. A login finished in the
 * DM therefore stayed in the DM session: the group topic that asked for it kept
 * reporting `no local token`, and a new session started over.
 *
 * These run the real wrapper under /bin/sh against a stub CLI that keeps its
 * login exactly where meegle does (`$HOME/.meegle/credentials-bytedcli.enc`), and a stub
 * `botmux` that records what the wrapper asked of the daemon.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytedcliTurnHome, renderIdentityWrapper, writeSessionIdentity } from '../src/core/cli-identity.js';
import { ensureSessionTempDir } from '../src/core/session-temp.js';

// Where the daemon keeps each person's login: fixed under the machine HOME,
// outside every session (captured before the tests move HOME).
const STORE_ROOT = join(homedir(), '.botmux', 'data', 'meego-home');
const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const storeHome = (openId: string) => join(STORE_ROOT, openId, 'epoch-0');

let dir: string;
let previousHome: string | undefined;
let realCli: string;
let stubBin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-meego-shared-'));
  previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'machine-home');
  mkdirSync(process.env.HOME, { recursive: true });
  stubBin = join(dir, 'bin');
  mkdirSync(stubBin);
  realCli = join(dir, 'real-bytedcli.sh');
  writeFileSync(realCli, [
    '#!/bin/sh',
    'printf "%s\\t%s\\n" "$HOME" "$*" >> "$STUB_LOG"',
    'printf "%s|%s|%s\\n" "$MEEGLE_USER_ACCESS_TOKEN" "$BYTEDCLI_MEEGO_ACCESS_TOKEN" "$BYTEDCLI_MEEGO_COOKIE" >> "$STUB_LOG.env"',
    'store="$HOME/.meegle"',
    '[ "$1" = -j ] && shift',
    '[ "$1" = meego ] || { echo \'{"status":"success","data":{}}\'; exit 0; }',
    'shift',
    'case "$1" in',
    '  status)',
    '    if [ -s "$store/credentials-bytedcli.enc" ]; then a=true; else a=false; fi',
    '    printf \'{"status":"success","data":{"official_meegle_cli_authenticated":%s}}\\n\' "$a" ;;',
    '  login)',
    '    mkdir -p "$store"',
    '    if [ "$2" = --complete ]; then',
    '      cat "$STUB_APPROVED" > "$store/credentials-bytedcli.enc"',
    '      echo \'{"status":"success","data":{"login_status":"success"}}\'',
    '    else',
    '      echo \'{"status":"success","data":{"verification_uri_complete":"https://meego.example/device?code=STUBCODE","complete_token":"stub-complete"}}\'',
    '    fi ;;',
    '  *)',
    '    if [ ! -s "$store/credentials-bytedcli.enc" ]; then',
    '      echo \'{"status":"error","error":{"code":"MEEGLE_AUTH_REQUIRED","details":"no local token"}}\'; exit 1',
    '    fi',
    // A refresh rewrites the file the way meegle does: temp file, then rename.
    '    if [ -n "$STUB_ROTATE" ]; then',
    '      printf "%s-refreshed" "$(cat "$store/credentials-bytedcli.enc")" > "$store/.cred.tmp" && mv "$store/.cred.tmp" "$store/credentials-bytedcli.enc"',
    '    fi',
    '    printf \'{"status":"success","data":{"login":"%s"}}\\n\' "$(cat "$store/credentials-bytedcli.enc")" ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(realCli, 0o755);
  writeFileSync(join(stubBin, 'botmux'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$BOTMUX_STUB_LOG"',
    'printf "%s" "$BOTMUX_STUB_MSG"',
    'exit "${BOTMUX_STUB_EXIT:-3}"',
    '',
  ].join('\n'));
  chmodSync(join(stubBin, 'botmux'), 0o755);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(STORE_ROOT, { recursive: true, force: true });
});

const dataDir = () => join(dir, 'data');
const cliLog = () => join(dir, 'cli.log');
const botmuxLog = () => join(dir, 'botmux.log');
const cliCalls = () => existsSync(cliLog())
  ? readFileSync(cliLog(), 'utf8').trim().split('\n').map(line => { const [home, args] = line.split('\t'); return { home, args }; })
  : [];
const botmuxCalls = () => existsSync(botmuxLog()) ? readFileSync(botmuxLog(), 'utf8').trim().split('\n') : [];

/** A session whose current turn acts for `openId` (single storage model). */
function session(id: string, openId: string | undefined): string {
  ensureSessionTempDir(dataDir(), id);
  const wrapper = join(dir, `wrapper-${id}`);
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realCli, 'single'));
  writeSessionIdentity(dataDir(), id, { tool: 'bytedcli', cloudJwt: 'jwt', ...(openId ? { openId } : {}) }, 'single');
  return wrapper;
}

function actAs(id: string, openId: string): void {
  writeSessionIdentity(dataDir(), id, { tool: 'bytedcli', cloudJwt: 'jwt', openId }, 'single');
}

interface RunOpts {
  chatType?: string;
  botmuxExit?: number;
  botmuxMsg?: string;
  noBotmux?: boolean;
  env?: Record<string, string>;
}

function run(wrapper: string, id: string, args: string[], opts: RunOpts = {}) {
  const r = spawnSync('/bin/sh', [wrapper, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${opts.noBotmux ? '' : `${stubBin}:`}/usr/bin:/bin`,
      HOME: process.env.HOME!,
      SESSION_DATA_DIR: dataDir(),
      BOTMUX_SESSION_ID: id,
      BOTMUX_CHAT_TYPE: opts.chatType ?? 'group',
      STUB_LOG: cliLog(),
      BOTMUX_STUB_LOG: botmuxLog(),
      BOTMUX_STUB_EXIT: String(opts.botmuxExit ?? 3),
      BOTMUX_STUB_MSG: opts.botmuxMsg ?? '已把授权链接私聊发给你',
      ...opts.env,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The person approves, and the daemon completes the login in their store
 *  (what meego-auth.ts does: the CLI with HOME = that store's home). */
function loginInStore(openId: string, credential: string): void {
  const approved = join(dir, `approved-${openId}`);
  writeFileSync(approved, credential);
  mkdirSync(storeHome(openId), { recursive: true });
  execFileSync(realCli, ['-j', 'meego', 'login', '--complete', 'stub-complete'], {
    env: { PATH: '/usr/bin:/bin', HOME: storeHome(openId), STUB_LOG: join(dir, 'daemon.log'), STUB_APPROVED: approved },
  });
}

const storedCredential = (openId: string) => readFileSync(join(storeHome(openId), '.meegle', 'credentials-bytedcli.enc'), 'utf8');

describe('one Meego login per person, shared by every session', () => {
  it('a login finished from the DM is what the group topic and a brand-new session use', () => {
    const groupTopic = session('sess-group-topic', ALICE);
    const dm = session('sess-dm', ALICE);

    // Group topic first: no login yet, so botmux is asked to send the link.
    const before = run(groupTopic, 'sess-group-topic', ['-j', 'meego', 'user', 'me']);
    expect(before.code).toBe(77);
    expect(before.stderr).toContain('已把授权链接私聊发给你');
    expect(botmuxCalls()).toEqual(['auth request --provider meego']);

    loginInStore(ALICE, 'alice-login');

    const retry = run(groupTopic, 'sess-group-topic', ['-j', 'meego', 'user', 'me']);
    expect(retry.code).toBe(0);
    expect(retry.stdout).toContain('alice-login');
    expect(run(dm, 'sess-dm', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-login');
    const later = session('sess-new', ALICE);
    expect(run(later, 'sess-new', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-login');

    // Each exec still runs with its own session-scoped HOME; only .meegle is shared.
    const groupHome = bytedcliTurnHome(dataDir(), 'sess-group-topic', { openId: ALICE });
    expect(cliCalls().at(-3)?.home).toBe(groupHome);
    expect(lstatSync(join(groupHome, '.meegle')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(groupHome, '.meegle'))).toBe(join(storeHome(ALICE), '.meegle'));
  });

  it('another person never gets that login, not even in the same session', () => {
    const topic = session('sess-topic', ALICE);
    loginInStore(ALICE, 'alice-login');
    expect(run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-login');

    actAs('sess-topic', BOB);
    const bob = run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me']);
    expect(bob.code).toBe(77);
    expect(bob.stdout).not.toContain('alice-login');
    expect(botmuxCalls()).toEqual(['auth request --provider meego']);
    const bobHome = bytedcliTurnHome(dataDir(), 'sess-topic', { openId: BOB });
    expect(readlinkSync(join(bobHome, '.meegle'))).toBe(join(storeHome(BOB), '.meegle'));
    // Even with the request refused, Bob's exec cannot read Alice's store.
    const bobRuns = run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me'], { botmuxExit: 4 });
    expect(bobRuns.stdout).toContain('MEEGLE_AUTH_REQUIRED');
    expect(bobRuns.stdout).not.toContain('alice-login');

    actAs('sess-topic', ALICE);
    expect(run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-login');
  });

  it('a token refresh in one session is written back to the one shared login', () => {
    const topic = session('sess-topic', ALICE);
    loginInStore(ALICE, 'alice-v1');

    const refreshed = run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me'], { env: { STUB_ROTATE: '1' } });
    expect(refreshed.stdout).toContain('alice-v1-refreshed');
    expect(storedCredential(ALICE)).toBe('alice-v1-refreshed');
    const topicHome = bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE });
    expect(lstatSync(join(topicHome, '.meegle')).isSymbolicLink()).toBe(true);

    const other = session('sess-other', ALICE);
    expect(run(other, 'sess-other', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-v1-refreshed');
  });

  it('a login left in a session HOME by an older botmux gives way to the shared one', () => {
    const topic = session('sess-topic', ALICE);
    const topicHome = bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE });
    mkdirSync(join(topicHome, '.meegle'), { recursive: true });
    writeFileSync(join(topicHome, '.meegle', 'credentials-bytedcli.enc'), 'session-local');
    loginInStore(ALICE, 'alice-login');

    expect(run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me']).stdout).toContain('alice-login');
    expect(readlinkSync(join(topicHome, '.meegle'))).toBe(join(storeHome(ALICE), '.meegle'));
  });

  it('two calls linking at once leave one link and nothing inside the person\'s store', () => {
    const topic = session('sess-topic', ALICE);
    loginInStore(ALICE, 'alice-login');
    const topicHome = bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE });
    const store = join(storeHome(ALICE), '.meegle');
    // The other call's link lands right after this one cleared the way.
    writeFileSync(join(stubBin, 'rm'), [
      '#!/bin/sh',
      '/bin/rm "$@"',
      'ln -s "$RACE_TARGET" "$RACE_LINK" 2>/dev/null',
      '',
    ].join('\n'));
    chmodSync(join(stubBin, 'rm'), 0o755);

    const r = run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me'], {
      env: { RACE_TARGET: store, RACE_LINK: join(topicHome, '.meegle') },
    });
    expect(r.stdout).toContain('alice-login');
    expect(readlinkSync(join(topicHome, '.meegle'))).toBe(store);
    expect(existsSync(join(store, '.meegle'))).toBe(false);
  });

  it('an inherited BOTMUX_MEEGO_HOME cannot hand an identity someone else\'s login', () => {
    loginInStore(ALICE, 'alice-login');
    const anonymous = session('sess-anon', undefined);
    const r = run(anonymous, 'sess-anon', ['-j', 'meego', 'user', 'me'], { env: { BOTMUX_MEEGO_HOME: storeHome(ALICE) } });
    expect(r.stdout).not.toContain('alice-login');
    expect(botmuxCalls()).toEqual([]);
  });
});

describe('logging in is botmux\'s job, never the agent\'s', () => {
  it('`meego login` in a session never runs the real login; botmux sends the link privately', () => {
    const topic = session('sess-topic', ALICE);
    for (const args of [
      ['meego', 'login'],
      ['-j', 'meego', 'login', '--begin'],
      ['--profile', 'p', 'meego', 'login', '--complete', 'tok'],
      ['meego', 'login', '--help-me'],
    ]) {
      const r = run(topic, 'sess-topic', args);
      expect(r.code).toBe(77);
      expect(r.stderr).toContain('已把授权链接私聊发给你');
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/https?:\/\//);
    }
    expect(cliCalls()).toEqual([]);
    expect(botmuxCalls()).toEqual(Array(4).fill('auth request --provider meego'));
  });

  it('already logged in: `meego login` reports it without running the real login', () => {
    const topic = session('sess-topic', ALICE);
    loginInStore(ALICE, 'alice-login');
    const r = run(topic, 'sess-topic', ['meego', 'login'], { botmuxExit: 0, botmuxMsg: 'Meego 已登录' });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Meego 已登录');
    expect(cliCalls()).toEqual([]);
  });

  it('botmux unreachable: the login is refused, not run in the session', () => {
    const topic = session('sess-topic', ALICE);
    const r = run(topic, 'sess-topic', ['meego', 'login'], { noBotmux: true });
    expect(r.code).toBe(77);
    expect(r.stderr).toContain('联系不上 botmux');
    expect(cliCalls()).toEqual([]);
  });

  it('commands that never need a login go straight to the CLI', () => {
    const topic = session('sess-topic', ALICE);
    const passThrough = [
      ['meego', 'status'], ['-j', 'meego', 'status'], ['--jq', '.data', 'meego', 'status'],
      ['meego', '--help'], ['meego', 'login', '-h'], ['meego', 'config'], ['meego'], ['auth', 'status'],
    ];
    for (const args of passThrough) run(topic, 'sess-topic', args);
    expect(botmuxCalls()).toEqual([]);
    expect(cliCalls().map(c => c.args)).toEqual(passThrough.map(a => a.join(' ')));
  });

  it('Meego credentials inherited from the host never stand in for the person\'s login', () => {
    const operator = { MEEGLE_USER_ACCESS_TOKEN: 'op', BYTEDCLI_MEEGO_ACCESS_TOKEN: 'op', BYTEDCLI_MEEGO_COOKIE: 'op' };
    const topic = session('sess-topic', ALICE);
    const before = run(topic, 'sess-topic', ['meego', 'user', 'me'], { env: operator });
    expect(before.code).toBe(77);
    expect(botmuxCalls()).toEqual(['auth request --provider meego']);

    loginInStore(ALICE, 'alice-login');
    const after = run(topic, 'sess-topic', ['meego', 'user', 'me'], { env: operator });
    expect(after.stdout).toContain('alice-login');
    expect(readFileSync(`${cliLog()}.env`, 'utf8').trim().split('\n')).toEqual(['||']);
  });

  it('provider unavailable or botmux unreachable: the command runs and fails as it did before', () => {
    const topic = session('sess-topic', ALICE);
    for (const opts of [{ botmuxExit: 4 }, { botmuxExit: 1 }, { noBotmux: true }]) {
      const r = run(topic, 'sess-topic', ['-j', 'meego', 'user', 'me'], opts);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('MEEGLE_AUTH_REQUIRED');
    }
  });

  it('sandboxed session (store not visible): login refused in a group, left to the CLI in the DM', () => {
    const topic = session('sess-topic', ALICE);
    rmSync(join(storeHome(ALICE), '.meegle'), { recursive: true });
    const group = run(topic, 'sess-topic', ['meego', 'login']);
    expect(group.code).toBe(77);
    expect(group.stderr).toContain('沙盒');
    expect(cliCalls()).toEqual([]);

    expect(run(topic, 'sess-topic', ['meego', 'login'], { chatType: 'p2p' }).code).toBe(0);
    expect(cliCalls().map(c => c.args)).toEqual(['meego login']);
    expect(botmuxCalls()).toEqual([]);
  });
});

describe('the Meego tenant the call runs under is the one botmux logs in', () => {
  const saveTenant = (home: string, body: string) => {
    mkdirSync(join(home, '.local', 'share', 'bytedcli', 'data'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'bytedcli', 'data', 'meego_config.json'), body);
  };

  it('from the tenant saved in the session, the variable, or the flag', () => {
    const topic = session('sess-topic', ALICE);
    run(topic, 'sess-topic', ['meego', 'user', 'me'], { env: { BYTEDCLI_MEEGO_TENANT: 'DCAR' } });
    run(topic, 'sess-topic', ['meego', 'login', '--tenant=dcar']);
    saveTenant(bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE }), '{\n  "tenant": "dcar"\n}');
    run(topic, 'sess-topic', ['meego', 'user', 'me']);
    run(topic, 'sess-topic', ['meego', 'login']);
    expect(botmuxCalls()).toEqual(Array(4).fill('auth request --provider meego --tenant dcar'));
  });

  it('no tenant anywhere is the default one', () => {
    const topic = session('sess-topic', ALICE);
    saveTenant(bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE }), '{"space": "dcar"}');
    run(topic, 'sess-topic', ['meego', 'user', 'me'], { env: { BYTEDCLI_MEEGO_TENANT: 'other' } });
    expect(botmuxCalls()).toEqual(['auth request --provider meego']);
  });

  it('`meego login --tenant dcar` keeps the choice in the session, as the real login would', () => {
    const topic = session('sess-topic', ALICE);
    run(topic, 'sess-topic', ['meego', 'login', '--tenant', 'dcar']);
    const topicHome = bytedcliTurnHome(dataDir(), 'sess-topic', { openId: ALICE });
    expect(cliCalls()).toEqual([{ home: topicHome, args: 'meego config --tenant dcar' }]);
    expect(botmuxCalls()).toEqual(['auth request --provider meego --tenant dcar']);
  });

  it('a tenant bytedcli would reject is refused before anything runs', () => {
    const topic = session('sess-topic', ALICE);
    const r = run(topic, 'sess-topic', ['meego', 'login', '--tenant', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('dcar');
    expect(cliCalls()).toEqual([]);
    expect(botmuxCalls()).toEqual([]);
  });

  it('a login for either tenant counts as a login on file', () => {
    const topic = session('sess-topic', ALICE);
    writeFileSync(join(storeHome(ALICE), '.meegle', 'credentials-bytedcli-dcar.enc'), 'x');
    run(topic, 'sess-topic', ['meego', 'user', 'me']);
    expect(botmuxCalls()).toEqual([]);
  });
});

describe('bytedcli not authorized', () => {
  function denied(id: string, message: string): string {
    ensureSessionTempDir(dataDir(), id);
    const wrapper = join(dir, `wrapper-${id}`);
    writeFileSync(wrapper, renderIdentityWrapper('bytedcli', realCli, 'single'));
    writeSessionIdentity(dataDir(), id, { tool: 'bytedcli', mode: 'denied', message }, 'single');
    return wrapper;
  }
  const NOT_AUTHORIZED = 'botmux: 你还没有授权 bytedcli，请私聊发送 /login bytedcli。 [reason=not_authorized]';

  it('botmux sends the link privately and the refusal says so', () => {
    const wrapper = denied('sess-topic', NOT_AUTHORIZED);
    const r = run(wrapper, 'sess-topic', ['auth', 'userinfo'], { botmuxMsg: '授权链接已私聊发给你，授权后重试' });
    expect(r.code).toBe(77);
    expect(r.stderr).toContain('授权链接已私聊发给你');
    expect(r.stderr).not.toContain('[reason=not_authorized]');
    expect(botmuxCalls()).toEqual(['auth request --provider bytedcli']);
    expect(cliCalls()).toEqual([]);
  });

  it('botmux unreachable: the published refusal is shown as before', () => {
    const wrapper = denied('sess-topic', NOT_AUTHORIZED);
    const r = run(wrapper, 'sess-topic', ['auth', 'userinfo'], { noBotmux: true });
    expect(r.code).toBe(77);
    expect(r.stderr).toContain(NOT_AUTHORIZED);
  });

  it('other refusals (platform, delegation) never ask for a login', () => {
    const wrapper = denied('sess-topic', 'botmux: 平台凭据不可用 [reason=platform_unavailable]');
    const r = run(wrapper, 'sess-topic', ['auth', 'userinfo']);
    expect(r.code).toBe(77);
    expect(r.stderr).toContain('platform_unavailable');
    expect(botmuxCalls()).toEqual([]);
  });
});
