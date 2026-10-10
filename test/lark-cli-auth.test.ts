/**
 * Per-person lark-cli HOME + device-code flow.
 *
 * These pin the minimal change to the original design:
 *   1. The public key remains the sender open_id and the original HOME path.
 *   2. First use starts from an empty HOME; no machine/Bot app is copied.
 *   3. Later turns reuse that HOME without setup or user interaction.
 *   4. Missing state still yields links through the existing automatic denial.
 *
 * lark-cli itself is replaced by a scripted runner, so nothing here hits the
 * network or the real data dir.
 *
 * Run: npx vitest run --project unit test/lark-cli-auth.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginLarkCliLogin,
  completeLarkCliLogin,
  larkCliHomeFor,
  hasLarkCliHome,
  clearLarkCliAuth,
  pendingLarkCliChallenge,
  larkCliHomeForTurn,
  resolveLarkCliHomeForTurn,
  materializeLarkCliHomeForSession,
  LARK_CLI_DEVICE_SCOPES,
  hasPersonalLarkCliApp,
  __setLarkCliHomeRootForTest,
  __setLarkCliRunnerForTest,
  __setLarkCliAppSetupRunnerForTest,
  __isolatedLarkCliEnvForTest,
  type LarkCliRunner,
} from '../src/services/lark-cli-auth.js';
import { sessionTempDir } from '../src/core/session-temp.js';

const APP_ID = 'cli_aa8021c36af9dcde';
const ALICE = 'ou_larkauth00000000000001';
const BOB = 'ou_larkauth00000000000002';
// Token filenames contain the personal app's app-scoped open_id, which is
// deliberately different from the receiving Bot's sender open_id.
const PERSONAL_OPEN = 'ou_personalapp000000000001';
const PERSONAL_OPEN_B = 'ou_personalapp000000000002';

let homeRoot: string;
const sessionTempRoots: string[] = [];

/** Model the result of THIS sender selecting an app through config init. */
function provisionPersonalApp(openId = ALICE, appId = APP_ID, trusted = true) {
  const home = larkCliHomeFor(openId);
  mkdirSync(join(home, '.lark-cli'), { recursive: true });
  writeFileSync(join(home, '.lark-cli', 'config.json'), JSON.stringify({
    apps: [{
      name: appId, appId, brand: 'feishu', lang: 'zh',
      appSecret: { source: 'keychain', id: 'appsecret:' + appId },
      users: [],
    }],
  }, null, 2));
  if (trusted) writeFileSync(join(home, '.botmux-personal-app'), 'v1\n');
}

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), 'larkauth-homes-'));
  __setLarkCliHomeRootForTest(homeRoot);
  __setLarkCliRunnerForTest(null);
  __setLarkCliAppSetupRunnerForTest(null);
});
afterEach(() => {
  __setLarkCliHomeRootForTest(null);
  __setLarkCliRunnerForTest(null);
  __setLarkCliAppSetupRunnerForTest(null);
  rmSync(homeRoot, { recursive: true, force: true });
  for (const root of sessionTempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Simulate the token file lark-cli writes after a successful device scan.
 *  Also lays down the bootstrapped config — in reality begin() seeds the HOME
 *  before a scan can ever drop a token into it. */
function simulateUserToken(
  openId = ALICE,
  opts: { personalOpenId?: string } = {},
) {
  provisionPersonalApp(openId);
  const home = larkCliHomeFor(openId);
  const dataDir = join(home, '.local', 'share', 'lark-cli');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, `${APP_ID}_${opts.personalOpenId ?? PERSONAL_OPEN}.enc`), 'their-user-token');
}

describe('lark-cli per-person HOME layout', () => {
  it('keeps the original open_id HOME contract and rejects other/path ids', () => {
    expect(larkCliHomeFor(ALICE)).toBe(join(homeRoot, ALICE));
    expect(() => larkCliHomeFor('../etc/passwd')).toThrow(/unusable open_id/);
    expect(() => larkCliHomeFor('a/b')).toThrow(/unusable open_id/);
    expect(() => larkCliHomeFor('..')).toThrow(/unusable open_id/);
  });

  it('starts app selection before it ever starts user authorization', async () => {
    const authRunner = vi.fn<LarkCliRunner>(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: 'https://v/x', device_code: 'dc-seeded' }),
      stderr: '',
    }));
    __setLarkCliRunnerForTest(authRunner);
    __setLarkCliAppSetupRunnerForTest(async () => ({
      ok: true,
      stdout: '打开链接 https://open.feishu.cn/page/cli?user_code=PERSONAL',
      stderr: '',
    }));
    const started = await beginLarkCliLogin(ALICE);
    expect(started).toMatchObject({
      stage: 'app-setup',
      authUrl: 'https://open.feishu.cn/page/cli?user_code=PERSONAL',
    });
    expect(authRunner).not.toHaveBeenCalled();
    expect(hasPersonalLarkCliApp(ALICE)).toBe(false);
    expect(hasLarkCliHome(ALICE)).toBe(false);
    expect(larkCliHomeForTurn(ALICE)).toBeNull();
  });

  it('selects an app only once, then uses the same HOME for user login', async () => {
    const setup = vi.fn(async (_home: string, args: readonly string[]) => {
      // Model lark-cli writing the app selected in the browser into this HOME.
      expect(args).toEqual(['config', 'init', '--force-init']);
      expect(args).not.toContain('--new');
      provisionPersonalApp(ALICE, APP_ID, false);
      return {
        ok: true,
        stdout: 'https://open.feishu.cn/page/cli?user_code=PERSONAL',
        stderr: '',
      };
    });
    const login = vi.fn<LarkCliRunner>(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: 'https://v/user', device_code: 'dc-user' }),
      stderr: '',
    }));
    __setLarkCliAppSetupRunnerForTest(setup);
    __setLarkCliRunnerForTest(login);

    expect((await beginLarkCliLogin(ALICE))?.stage).toBe('app-setup');
    expect(hasPersonalLarkCliApp(ALICE)).toBe(true);
    expect((await beginLarkCliLogin(ALICE))?.stage).toBe('user-login');
    expect(setup).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(
      ['auth', 'login', '--no-wait', '--json', '--scope', LARK_CLI_DEVICE_SCOPES.join(' ')],
      larkCliHomeFor(ALICE),
    );
  });

  it('reuses an already initialized personal app and token without any runner call', async () => {
    simulateUserToken();
    const runner = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'must not run' }));
    __setLarkCliRunnerForTest(runner);
    expect(hasLarkCliHome(ALICE)).toBe(true);
    expect(larkCliHomeForTurn(ALICE)).toBe(larkCliHomeFor(ALICE));
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBe(larkCliHomeFor(ALICE));
    expect(runner).not.toHaveBeenCalled();
  });

  it('atomically replaces a sandbox session copy when the sender changes', async () => {
    simulateUserToken(ALICE, { personalOpenId: PERSONAL_OPEN });
    simulateUserToken(BOB, { personalOpenId: PERSONAL_OPEN_B });
    const dataDir = join(homeRoot, 'session-data');
    const sessionId = 'sess-sandbox-copy';
    const tempRoot = sessionTempDir(dataDir, sessionId);
    sessionTempRoots.push(tempRoot);
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: '{"ok":true}', stderr: '' }));

    const aliceCopy = await materializeLarkCliHomeForSession(ALICE, dataDir, sessionId);
    expect(aliceCopy).toBe(join(tempRoot, 'lark-cli-home'));
    expect(readFileSync(join(aliceCopy!, '.local', 'share', 'lark-cli', `${APP_ID}_${PERSONAL_OPEN}.enc`), 'utf8'))
      .toBe('their-user-token');

    const bobCopy = await materializeLarkCliHomeForSession(BOB, dataDir, sessionId);
    expect(bobCopy).toBe(aliceCopy);
    expect(existsSync(join(bobCopy!, '.local', 'share', 'lark-cli', `${APP_ID}_${PERSONAL_OPEN}.enc`)))
      .toBe(false);
    expect(readFileSync(join(bobCopy!, '.local', 'share', 'lark-cli', `${APP_ID}_${PERSONAL_OPEN_B}.enc`), 'utf8'))
      .toBe('their-user-token');
    // Durable per-person homes remain independent and are never merged back
    // from the sandbox's writable working copy.
    expect(hasLarkCliHome(ALICE)).toBe(true);
    expect(hasLarkCliHome(BOB)).toBe(true);
  });

  it('isolates two people: B has no token while A does', () => {
    simulateUserToken(ALICE);
    expect(hasLarkCliHome(ALICE)).toBe(true);
    expect(hasLarkCliHome(BOB)).toBe(false);
    // No shared token leaks across: B's turn gets nothing.
    expect(larkCliHomeForTurn(BOB)).toBeNull();
  });

  it('does not accept a legacy HOME seeded from a shared machine app', async () => {
    provisionPersonalApp(ALICE, APP_ID, false);
    const dataDir = join(larkCliHomeFor(ALICE), '.local', 'share', 'lark-cli');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, `${APP_ID}_${PERSONAL_OPEN_B}.enc`), 'legacy-shared-app-token');
    expect(hasLarkCliHome(ALICE)).toBe(false);
    expect(larkCliHomeForTurn(ALICE)).toBeNull();
    __setLarkCliAppSetupRunnerForTest(async home => {
      expect(existsSync(join(home, '.lark-cli', 'config.json'))).toBe(false);
      expect(existsSync(join(home, '.local', 'share', 'lark-cli'))).toBe(false);
      return {
        ok: true,
        stdout: 'https://open.feishu.cn/page/cli?user_code=FRESH',
        stderr: '',
      };
    });
    expect((await beginLarkCliLogin(ALICE))?.stage).toBe('app-setup');
  });

  it('pins XDG roots and removes every inherited identity/config override', () => {
    const previous = new Map<string, string | undefined>();
    const poisoned = {
      LARKSUITE_CLI_CONFIG_DIR: '/shared/config',
      LARKSUITE_CLI_DATA_DIR: '/shared/data',
      LARKSUITE_CLI_APP_ID: 'cli_shared',
      LARKSUITE_CLI_APP_SECRET: 'shared-secret',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: 'shared-user-token',
      FEISHU_USER_ACCESS_TOKEN: 'shared-feishu-token',
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: 'shared-tenant-token',
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE: 'env',
      LARKSUITE_CLI_TOKEN_ONLY__: '1',
      LARKSUITE_CLI_PROFILE: 'operator',
      LARKSUITE_CLI_DEFAULT_AS: 'bot',
      LARKSUITE_CLI_LOG_DIR: '/shared/logs',
      XDG_CONFIG_HOME: '/shared/xdg-config',
      XDG_DATA_HOME: '/shared/xdg-data',
      XDG_STATE_HOME: '/shared/xdg-state',
      XDG_CACHE_HOME: '/shared/xdg-cache',
    } as const;
    for (const [key, value] of Object.entries(poisoned)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const home = larkCliHomeFor(ALICE);
      const env = __isolatedLarkCliEnvForTest(home);
      for (const key of Object.keys(poisoned).filter(key =>
        (key.startsWith('LARKSUITE_') && key !== 'LARKSUITE_CLI_LOG_DIR')
        || key === 'FEISHU_USER_ACCESS_TOKEN')) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.HOME).toBe(home);
      expect(env.XDG_CONFIG_HOME).toBe(join(home, '.config'));
      expect(env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'));
      expect(env.XDG_STATE_HOME).toBe(join(home, '.local', 'state'));
      expect(env.XDG_CACHE_HOME).toBe(join(home, '.cache'));
      expect(env.LARKSUITE_CLI_LOG_DIR).toBe(join(home, '.local', 'state', 'lark-cli', 'logs'));
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('begin / complete device flow', () => {
  it('begins with the --no-wait device-code argv and the scoped set', async () => {
    provisionPersonalApp();
    const seen: Array<{ args: string[]; home: string }> = [];
    const runner: LarkCliRunner = async (args, home) => {
      seen.push({ args, home });
      return { ok: true, stdout: JSON.stringify({ verification_url: 'https://v/verify', device_code: 'dc-1' }), stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);
    const challenge = await beginLarkCliLogin(ALICE);

    expect(challenge?.authUrl).toBe('https://v/verify');
    expect(challenge?.stage).toBe('user-login');
    expect(seen[0].args).toEqual(['auth', 'login', '--no-wait', '--json', '--scope', LARK_CLI_DEVICE_SCOPES.join(' ')]);
    // The call already ran inside this person's HOME.
    expect(seen[0].home).toBe(larkCliHomeFor(ALICE));
  });

  it('never copies or uses another sender’s configured app', async () => {
    provisionPersonalApp(ALICE, 'cli_alice_personal');
    const authRunner = vi.fn(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'wrong', device_code: 'wrong' }), stderr: '',
    }));
    __setLarkCliRunnerForTest(authRunner);
    __setLarkCliAppSetupRunnerForTest(async home => ({
      ok: true,
      stdout: `setup-home=${home}\nhttps://open.feishu.cn/page/cli?user_code=BOB`,
      stderr: '',
    }));

    const challenge = await beginLarkCliLogin(BOB);
    expect(challenge).toMatchObject({
      stage: 'app-setup',
      authUrl: 'https://open.feishu.cn/page/cli?user_code=BOB',
    });
    expect(authRunner).not.toHaveBeenCalled();
    expect(hasPersonalLarkCliApp(BOB)).toBe(false);
  });

  it('reuses a fresh pending challenge instead of minting a new code', async () => {
    provisionPersonalApp();
    const calls: string[][] = [];
    __setLarkCliRunnerForTest(async (args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ verification_url: 'https://v/first', device_code: 'dc-first' }), stderr: '' };
    });
    const first = await beginLarkCliLogin(ALICE);
    const second = await beginLarkCliLogin(ALICE);
    expect(first?.authUrl).toBe('https://v/first');
    // Second call returns the SAME url and did NOT re-invoke lark-cli.
    expect(second?.authUrl).toBe('https://v/first');
    expect(calls).toHaveLength(1);
  });

  it('mints a new code after the person authorizes (challenge cleared)', async () => {
    provisionPersonalApp();
    let n = 0;
    __setLarkCliRunnerForTest(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: `https://v/${++n}`, device_code: `dc-${n}` }),
      stderr: '',
    }));
    expect((await beginLarkCliLogin(ALICE))?.authUrl).toBe('https://v/1');
    // They scan → token file appears, challenge cleared by complete.
    simulateUserToken(ALICE);
    __setLarkCliRunnerForTest(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: 'https://v/2', device_code: 'dc-2', status: 'ok' }),
      stderr: '',
    }));
    await completeLarkCliLogin(ALICE, 'dc-1');
    // A later re-login (e.g. expired) mints fresh because the old challenge is gone.
    expect((await beginLarkCliLogin(ALICE))?.authUrl).toBe('https://v/2');
  });

  it('returns null when personal app setup produces no trusted setup URL', async () => {
    __setLarkCliAppSetupRunnerForTest(async () => ({
      ok: false, stdout: '', stderr: 'setup failed',
    }));
    expect(await beginLarkCliLogin(ALICE)).toBeNull();
  });

  it('returns null when lark-cli reports failure / no url', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: 'client secret invalid' }));
    expect(await beginLarkCliLogin(ALICE)).toBeNull();
  });

  it('complete reports pending before a scan, authorized after the token lands', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-poll' }), stderr: '',
    }));
    await beginLarkCliLogin(ALICE);

    // First poll: CLI says pending and no token yet.
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: JSON.stringify({ status: 'pending' }), stderr: '' }));
    expect((await completeLarkCliLogin(ALICE)).state).toBe('pending');
    expect(pendingLarkCliChallenge(ALICE)?.deviceCode).toBe('dc-poll'); // still resumeable

    // User scans: CLI ok AND a token file is now present.
    simulateUserToken(ALICE);
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ status: 'ok' }), stderr: '',
    }));
    const done = await completeLarkCliLogin(ALICE);
    expect(done.state).toBe('authorized');
    expect(pendingLarkCliChallenge(ALICE)).toBeNull(); // cleared on success
    expect(hasLarkCliHome(ALICE)).toBe(true);
  });

  it('complete treats a pending-word error as pending, anything else as failed', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-x' }), stderr: '',
    }));
    await beginLarkCliLogin(ALICE);
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'authorization_pending: keep polling' } }), stderr: '',
    }));
    expect((await completeLarkCliLogin(ALICE)).state).toBe('pending');
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'device_code expired' } }), stderr: '',
    }));
    const failed = await completeLarkCliLogin(ALICE);
    expect(failed.state).toBe('failed');
    expect(failed.detail).toMatch(/expired/);
    // A terminal failure drops the challenge so the next begin mints a fresh
    // link instead of reusing the dead code until the TTL expires.
    expect(pendingLarkCliChallenge(ALICE)).toBeNull();
  });

  it('fails without an in-progress challenge', async () => {
    provisionPersonalApp();
    const r = await completeLarkCliLogin(ALICE);
    expect(r.state).toBe('failed');
    expect(r.detail).toMatch(/start again/i);
  });
});

describe('resolveLarkCliHomeForTurn — the turn-path poll (F-A)', () => {
  it('returns an existing HOME without polling anything', async () => {
    simulateUserToken();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBe(larkCliHomeFor(ALICE));
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null for no HOME and no challenge without spawning', async () => {
    provisionPersonalApp();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('polls a pending challenge once and resolves once the token lands', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-turn' }), stderr: '',
    }));
    await beginLarkCliLogin(ALICE);
    expect(pendingLarkCliChallenge(ALICE)?.deviceCode).toBe('dc-turn');

    // The person approved in the browser; the poll is what lands the token —
    // model that by having the runner itself write the per-person token file.
    expect(hasLarkCliHome(ALICE)).toBe(false);
    const runner = vi.fn(async (args: string[]) => {
      simulateUserToken(ALICE);
      return { ok: true, stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
    });
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBe(larkCliHomeFor(ALICE));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(pendingLarkCliChallenge(ALICE)).toBeNull();
  });

  it('stays null (refusal) when the poll still says pending', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-wait' }), stderr: '',
    }));
    await beginLarkCliLogin(ALICE);
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: JSON.stringify({ status: 'pending' }), stderr: '' }));
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBeNull();
    // Challenge survives a pending poll so the shown link stays usable.
    expect(pendingLarkCliChallenge(ALICE)?.deviceCode).toBe('dc-wait');
  });

  it('stays null after a terminal failure and clears the dead challenge', async () => {
    provisionPersonalApp();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-dead' }), stderr: '',
    }));
    await beginLarkCliLogin(ALICE);
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'expired token' } }), stderr: '',
    }));
    expect(await resolveLarkCliHomeForTurn(ALICE)).toBeNull();
    expect(pendingLarkCliChallenge(ALICE)).toBeNull();
  });

  it('returns null for an absent sender without spawning', async () => {
    provisionPersonalApp();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(undefined)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('clear', () => {
  it('removes only that person’s HOME', () => {
    simulateUserToken(ALICE);
    simulateUserToken(BOB, { personalOpenId: PERSONAL_OPEN_B });
    expect(hasLarkCliHome(ALICE)).toBe(true);
    clearLarkCliAuth(ALICE);
    expect(hasLarkCliHome(ALICE)).toBe(false);
    expect(hasLarkCliHome(BOB)).toBe(true); // B untouched
  });
});
