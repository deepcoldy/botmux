/**
 * Per-person lark-cli HOME + device-code flow.
 *
 * These pin the decisions the redesign rests on:
 *   1. Identity is a HOME directory keyed by open_id, never a borrowed token.
 *   2. A HOME counts as "authorized" only once a per-person token file exists —
 *      a seeded-but-not-scanned HOME is still unauthorized.
 *   3. begin issues a device-code challenge with the right argv and stores a
 *      resume token; complete is a non-blocking poll (pending is normal).
 *   4. No machine credential is ever needed to begin: app material is seeded
 *      from the operator's install into the person's HOME.
 *
 * lark-cli itself is replaced by a scripted runner, so nothing here hits the
 * network or the real data dir.
 *
 * Run: npx vitest run --project unit test/lark-cli-auth.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginLarkCliLogin,
  completeLarkCliLogin,
  larkCliHomeFor,
  hasLarkCliHome,
  pendingLarkCliChallenge,
  resolveLarkCliHomeForTurn,
  LARK_CLI_DEVICE_SCOPES,
  __setLarkCliHomeRootForTest,
  __setMachineHomeForTest,
  __setLarkCliRunnerForTest,
  type LarkCliRunner,
} from '../src/services/lark-cli-auth.js';

const APP_ID = 'cli_aa8021c36af9dcde';
// Realistic open ids: `ou_` followed by alphanumerics (the token-file name is
// `<appId>_<openId>.enc`, and the post-`ou_` part carries no underscore).
const OPEN = 'ou_larkauth00000000000001';
const OPEN_B = 'ou_larkauth00000000000002';

let homeRoot: string;
let machineHome: string;

/** Build a fake operator lark-cli install that ensureBootstrapped seeds from. */
function seedMachine() {
  mkdirSync(join(machineHome, '.lark-cli'), { recursive: true });
  mkdirSync(join(machineHome, '.local', 'share', 'lark-cli'), { recursive: true });
  writeFileSync(join(machineHome, '.lark-cli', 'config.json'), JSON.stringify({
    apps: [{
      name: APP_ID, appId: APP_ID, brand: 'feishu', lang: 'zh',
      appSecret: { source: 'keychain', id: 'appsecret:' + APP_ID },
      users: [],
    }],
  }, null, 2));
  writeFileSync(join(machineHome, '.local', 'share', 'lark-cli', 'master.key'), 'machine-master-key');
  writeFileSync(join(machineHome, '.local', 'share', 'lark-cli', `appsecret_${APP_ID}.enc`), 'machine-app-secret');
}

beforeEach(() => {
  homeRoot = mkdtempSync(join(tmpdir(), 'larkauth-homes-'));
  machineHome = mkdtempSync(join(tmpdir(), 'larkauth-machine-'));
  __setLarkCliHomeRootForTest(homeRoot);
  __setMachineHomeForTest(machineHome);
  __setLarkCliRunnerForTest(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  __setLarkCliHomeRootForTest(null);
  __setMachineHomeForTest(null);
  __setLarkCliRunnerForTest(null);
});

/** Simulate the token file lark-cli writes after a successful device scan.
 *  Also lays down the bootstrapped config — in reality begin() seeds the HOME
 *  before a scan can ever drop a token into it. */
function simulateUserToken(openId = OPEN) {
  const home = larkCliHomeFor(openId);
  const dataDir = join(home, '.local', 'share', 'lark-cli');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, '.lark-cli'), { recursive: true });
  if (!existsSync(join(home, '.lark-cli', 'config.json'))) {
    writeFileSync(join(home, '.lark-cli', 'config.json'), JSON.stringify({
      apps: [{ appId: APP_ID, appSecret: { source: 'keychain' }, brand: 'feishu', users: [] }],
    }));
  }
  writeFileSync(join(dataDir, `${APP_ID}_${openId}.enc`), 'their-user-token');
}

describe('lark-cli per-person HOME layout', () => {
  it('keys each HOME by open_id and rejects path-traversing ids', () => {
    expect(larkCliHomeFor(OPEN)).toBe(join(homeRoot, OPEN));
    // The guard's job is path safety: a segment with `/` or `.` must not be able
    // to escape the HOME root. (The open_id charset is [A-Za-z0-9_-], so it does
    // not mandate an `ou_` prefix — what matters is no traversal character.)
    expect(() => larkCliHomeFor('../etc/passwd')).toThrow(/unusable open_id/);
    expect(() => larkCliHomeFor('a/b')).toThrow(/unusable open_id/);
    expect(() => larkCliHomeFor('..')).toThrow(/unusable open_id/);
  });

  it('is unauthorized before a scan even after the HOME was seeded', async () => {
    seedMachine();
    const runner: LarkCliRunner = async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: 'https://v/x', device_code: 'dc-seeded' }),
      stderr: '',
    });
    __setLarkCliRunnerForTest(runner);
    await beginLarkCliLogin(OPEN);
    // begin seeded the HOME and stored a challenge, but no token file yet.
    expect(hasLarkCliHome(OPEN)).toBe(false);
  });

  it('becomes authorized only once a per-person token file exists', () => {
    seedMachine();
    simulateUserToken();
    expect(hasLarkCliHome(OPEN)).toBe(true);
  });

  it('isolates two people: B has no token while A does', () => {
    seedMachine();
    simulateUserToken(OPEN);
    expect(hasLarkCliHome(OPEN)).toBe(true);
    expect(hasLarkCliHome(OPEN_B)).toBe(false);
  });
});

describe('begin / complete device flow', () => {
  it('begins with the --no-wait device-code argv and the scoped set', async () => {
    seedMachine();
    const seen: Array<{ args: string[]; home: string }> = [];
    const runner: LarkCliRunner = async (args, home) => {
      seen.push({ args, home });
      return { ok: true, stdout: JSON.stringify({ verification_url: 'https://v/verify', device_code: 'dc-1' }), stderr: '' };
    };
    __setLarkCliRunnerForTest(runner);
    const challenge = await beginLarkCliLogin(OPEN);

    expect(challenge?.authUrl).toBe('https://v/verify');
    expect(seen[0].args).toEqual(['auth', 'login', '--no-wait', '--json', '--scope', LARK_CLI_DEVICE_SCOPES.join(' ')]);
    const scopes = seen[0].args[seen[0].args.indexOf('--scope') + 1].split(' ');
    // Task-specific permissions belong to incremental authorization, not login.
    expect(scopes.some(scope => scope.startsWith('base:'))).toBe(false);
    // The call already ran inside this person's HOME.
    expect(seen[0].home).toBe(larkCliHomeFor(OPEN));
  });

  it('seeds machine-level app material into the person HOME (not a user token)', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'd' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    const home = larkCliHomeFor(OPEN);
    expect(existsSync(join(home, '.local', 'share', 'lark-cli', 'master.key'))).toBe(true);
    expect(existsSync(join(home, '.local', 'share', 'lark-cli', `appsecret_${APP_ID}.enc`))).toBe(true);
    expect(readFileSync(join(home, '.local', 'share', 'lark-cli', 'master.key'), 'utf8')).toBe('machine-master-key');
    // App material is copied, but no user token pre-exists.
    expect(hasLarkCliHome(OPEN)).toBe(false);
  });

  it('issues from BOTMUX_LARK_CLI_ISSUER_HOME instead of the operator HOME', async () => {
    // The operator HOME deliberately points at a DIFFERENT app; an explicit issuer
    // HOME must win so the device code is minted by the chosen all-staff app.
    const issuer = mkdtempSync(join(tmpdir(), 'larkauth-issuer-'));
    const ISSUER_APP = 'cli_issuer_allstaff_1';
    mkdirSync(join(issuer, '.lark-cli'), { recursive: true });
    mkdirSync(join(issuer, '.local', 'share', 'lark-cli'), { recursive: true });
    writeFileSync(join(issuer, '.lark-cli', 'config.json'), JSON.stringify({
      apps: [{ appId: ISSUER_APP, appSecret: { source: 'keychain' }, brand: 'feishu', users: [] }],
    }));
    writeFileSync(join(issuer, '.local', 'share', 'lark-cli', 'master.key'), 'issuer-key');
    writeFileSync(join(issuer, '.local', 'share', 'lark-cli', `appsecret_${ISSUER_APP}.enc`), 'issuer-secret');

    const prev = process.env.BOTMUX_LARK_CLI_ISSUER_HOME;
    process.env.BOTMUX_LARK_CLI_ISSUER_HOME = issuer;
    // beforeEach pins a machine-home override that wins over env; in production
    // only env is set. Clear the override here so the env path is exercised.
    __setMachineHomeForTest(null);
    try {
      __setLarkCliRunnerForTest(async () => ({
        ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'd' }), stderr: '',
      }));
      await beginLarkCliLogin(OPEN);
      const dataDir = join(larkCliHomeFor(OPEN), '.local', 'share', 'lark-cli');
      // Seeded from the ISSUER, not from the operator machine HOME.
      expect(readFileSync(join(dataDir, 'master.key'), 'utf8')).toBe('issuer-key');
      expect(existsSync(join(dataDir, `appsecret_${ISSUER_APP}.enc`))).toBe(true);
      expect(existsSync(join(dataDir, `appsecret_${APP_ID}.enc`))).toBe(false);
    } finally {
      __setMachineHomeForTest(machineHome);
      if (prev === undefined) delete process.env.BOTMUX_LARK_CLI_ISSUER_HOME;
      else process.env.BOTMUX_LARK_CLI_ISSUER_HOME = prev;
    }
  });

  it('reuses a fresh pending challenge instead of minting a new code', async () => {
    seedMachine();
    const calls: string[][] = [];
    __setLarkCliRunnerForTest(async (args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ verification_url: 'https://v/first', device_code: 'dc-first' }), stderr: '' };
    });
    const first = await beginLarkCliLogin(OPEN);
    const second = await beginLarkCliLogin(OPEN);
    expect(first?.authUrl).toBe('https://v/first');
    // Second call returns the SAME url and did NOT re-invoke lark-cli.
    expect(second?.authUrl).toBe('https://v/first');
    expect(calls).toHaveLength(1);
  });

  it('mints a new code after the person authorizes (challenge cleared)', async () => {
    seedMachine();
    let n = 0;
    __setLarkCliRunnerForTest(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: `https://v/${++n}`, device_code: `dc-${n}` }),
      stderr: '',
    }));
    expect((await beginLarkCliLogin(OPEN))?.authUrl).toBe('https://v/1');
    // They scan → token file appears, challenge cleared by complete.
    simulateUserToken();
    __setLarkCliRunnerForTest(async () => ({
      ok: true,
      stdout: JSON.stringify({ verification_url: 'https://v/2', device_code: 'dc-2', status: 'ok' }),
      stderr: ''
    }));
    await completeLarkCliLogin(OPEN, 'dc-1');
    // A later re-login (e.g. expired) mints fresh because the old challenge is gone.
    rmSync(larkCliHomeFor(OPEN), { recursive: true, force: true });
    expect((await beginLarkCliLogin(OPEN))?.authUrl).toBeDefined();
  });

  it('returns null when the operator has no lark-cli app to seed from', async () => {
    // No seedMachine() ⇒ operator install absent.
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'd' }), stderr: '',
    }));
    expect(await beginLarkCliLogin(OPEN)).toBeNull();
  });

  it('returns null when lark-cli reports failure / no url', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: 'client secret invalid' }));
    expect(await beginLarkCliLogin(OPEN)).toBeNull();
  });

  it('complete reports pending before a scan, authorized after the token lands', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-poll' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);

    // First poll: CLI says pending and no token yet.
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: JSON.stringify({ status: 'pending' }), stderr: '' }));
    expect((await completeLarkCliLogin(OPEN)).state).toBe('pending');
    expect(pendingLarkCliChallenge(OPEN)?.deviceCode).toBe('dc-poll'); // still resumeable

    // User scans: CLI ok AND a token file is now present.
    simulateUserToken();
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: JSON.stringify({ status: 'ok' }), stderr: '' }));
    const done = await completeLarkCliLogin(OPEN);
    expect(done.state).toBe('authorized');
    expect(pendingLarkCliChallenge(OPEN)).toBeNull(); // cleared on success
  });

  it('complete treats a pending-word error as pending, anything else as failed', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-x' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'authorization_pending: keep polling' } }), stderr: '',
    }));
    expect((await completeLarkCliLogin(OPEN)).state).toBe('pending');
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'device_code expired' } }), stderr: '',
    }));
    const failed = await completeLarkCliLogin(OPEN);
    expect(failed.state).toBe('failed');
    expect(failed.detail).toMatch(/expired/);
    // A terminal failure drops the challenge so the next begin mints a fresh
    // link instead of reusing the dead code until the TTL expires.
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
  });

  it.each(['[lark-cli-auth] timed out', 'connect ETIMEDOUT', 'upstream HTTP 503', ''])(
    'retains the same link after %s and completes a later approval', async (error) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      seedMachine();
      const runner = vi.fn(async () => ({
        ok: true, stdout: JSON.stringify({ verification_url: 'https://v/stable', device_code: 'dc-stable' }), stderr: '',
      }));
      __setLarkCliRunnerForTest(runner);
      await beginLarkCliLogin(OPEN);
      __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: error }));
      expect(await completeLarkCliLogin(OPEN)).toEqual({ state: 'failed', detail: error || undefined });
      expect(pendingLarkCliChallenge(OPEN)?.deviceCode).toBe('dc-stable');
      __setLarkCliRunnerForTest(runner);
      expect((await beginLarkCliLogin(OPEN))?.authUrl).toBe('https://v/stable');
      expect(runner).toHaveBeenCalledTimes(1);
      __setLarkCliRunnerForTest(async () => {
        simulateUserToken();
        return { ok: true, stdout: '{}', stderr: '' };
      });
      clock.mockReturnValue(1_800_000_060_000);
      expect(await resolveLarkCliHomeForTurn(OPEN)).toBe(larkCliHomeFor(OPEN));
      expect(pendingLarkCliChallenge(OPEN)).toBeNull();
      expect(hasLarkCliHome(OPEN_B)).toBe(false);
    },
  );

  it('reads a terminal device-code failure from the stderr JSON envelope', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-invalid' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    const message = 'authorization failed: The device_code is invalid. Please restart the device authorization flow.';
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: '', stderr: JSON.stringify({ ok: false, error: { type: 'authentication', message } }),
    }));
    expect(await completeLarkCliLogin(OPEN)).toEqual({ state: 'failed', detail: message });
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
  });

  it.each([
    ['unknown', 'Authorization denied by user', 'failed', true],
    ['unknown', 'access_denied', 'failed', true],
    ['unknown', 'authorization_declined', 'failed', true],
    ['unknown', 'The device_code has expired', 'failed', true],
    ['unknown', 'expired_token', 'failed', true],
    ['unknown', 'An unrecognized upstream error', 'failed', false],
    ['unknown', 'network request expired', 'failed', false],
    ['unknown', 'authorization_pending', 'pending', false],
    ['unknown', 'Authorization not yet completed', 'pending', false],
    ['unknown', 'waiting for approval', 'pending', false],
  ] as const)('classifies stderr %s / %s without guessing from unknown subtype', async (subtype, message, state, cleared) => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-envelope' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: '', stderr: JSON.stringify({ ok: false, error: { type: 'authentication', subtype, message } }),
    }));
    expect((await completeLarkCliLogin(OPEN)).state).toBe(state);
    expect(pendingLarkCliChallenge(OPEN) === null).toBe(cleared);
    expect(hasLarkCliHome(OPEN)).toBe(false);
  });

  it('fails without an in-progress challenge', async () => {
    seedMachine();
    const r = await completeLarkCliLogin(OPEN);
    expect(r.state).toBe('failed');
    expect(r.detail).toMatch(/start again/i);
  });
});

describe('resolveLarkCliHomeForTurn — the turn-path poll (F-A)', () => {
  async function startChallenge(openId = OPEN) {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'https://v/stable', device_code: 'dc-' + openId }), stderr: '',
    }));
    await beginLarkCliLogin(openId);
  }

  it('skips automatic polls for 60 seconds after failure without extending the challenge TTL', async () => {
    const started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    await startChallenge();
    const runner = vi.fn(async () => ({ ok: false, stdout: '', stderr: '[lark-cli-auth] timed out' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    const saved = JSON.parse(readFileSync(join(larkCliHomeFor(OPEN), '.botmux-login-challenge'), 'utf8'));
    expect(saved).toMatchObject({ createdAt: started, autoPollAfter: started + 60_000 });
    clock.mockReturnValue(started + 59_999);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect((await beginLarkCliLogin(OPEN))?.authUrl).toBe('https://v/stable');
    expect(runner).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(started + 60_000);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(pendingLarkCliChallenge(OPEN)?.createdAt).toBe(started);
    clock.mockReturnValue(started + 9 * 60_000 + 1);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('allows explicit login completion during cooldown and clears the challenge on success', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await startChallenge();
    __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: 'connect ETIMEDOUT' }));
    await resolveLarkCliHomeForTurn(OPEN);
    const runner = vi.fn(async () => {
      simulateUserToken();
      return { ok: true, stdout: '{}', stderr: '' };
    });
    __setLarkCliRunnerForTest(runner);
    expect((await completeLarkCliLogin(OPEN)).state).toBe('authorized');
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBe(larkCliHomeFor(OPEN));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not apply one person’s cooldown to another person', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await startChallenge(OPEN);
    await startChallenge(OPEN_B);
    const runner = vi.fn(async (_args: string[], _home: string) => ({ ok: false, stdout: '', stderr: 'connect ETIMEDOUT' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(await resolveLarkCliHomeForTurn(OPEN_B)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map(call => call[1])).toEqual([larkCliHomeFor(OPEN), larkCliHomeFor(OPEN_B)]);
  });

  it('does not put a replacement challenge into cooldown for a stale poll', async () => {
    await startChallenge();
    __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: 'connect ETIMEDOUT' }));
    expect((await completeLarkCliLogin(OPEN, 'older-device-code')).state).toBe('failed');
    expect(pendingLarkCliChallenge(OPEN)?.deviceCode).toBe('dc-' + OPEN);
    expect(pendingLarkCliChallenge(OPEN)?.autoPollAfter).toBeUndefined();
  });

  it('does not delay a normal pending approval or an already available user token', async () => {
    await startChallenge();
    const runner = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'authorization_pending' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(pendingLarkCliChallenge(OPEN)?.autoPollAfter).toBeUndefined();
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
    __setLarkCliRunnerForTest(async () => ({ ok: false, stdout: '', stderr: 'connect ETIMEDOUT' }));
    await resolveLarkCliHomeForTurn(OPEN);
    simulateUserToken();
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBe(larkCliHomeFor(OPEN));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('returns an existing HOME without polling anything', async () => {
    seedMachine();
    simulateUserToken();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBe(larkCliHomeFor(OPEN));
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns null for no HOME and no challenge without spawning', async () => {
    seedMachine();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it('polls a pending challenge once and resolves once the token lands', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-turn' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    expect(pendingLarkCliChallenge(OPEN)?.deviceCode).toBe('dc-turn');

    // The person approved in the browser; the poll is what lands the token —
    // model that by having the runner itself write the per-person token file.
    expect(hasLarkCliHome(OPEN)).toBe(false);
    const runner = vi.fn(async () => {
      simulateUserToken();
      return { ok: true, stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
    });
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBe(larkCliHomeFor(OPEN));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
  });

  it('stays null (refusal) when the poll still says pending', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-wait' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    __setLarkCliRunnerForTest(async () => ({ ok: true, stdout: JSON.stringify({ status: 'pending' }), stderr: '' }));
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    // Challenge survives a pending poll so the shown link stays usable.
    expect(pendingLarkCliChallenge(OPEN)?.deviceCode).toBe('dc-wait');
  });

  it('stays null after a terminal failure and clears the dead challenge', async () => {
    seedMachine();
    __setLarkCliRunnerForTest(async () => ({
      ok: true, stdout: JSON.stringify({ verification_url: 'u', device_code: 'dc-dead' }), stderr: '',
    }));
    await beginLarkCliLogin(OPEN);
    __setLarkCliRunnerForTest(async () => ({
      ok: false, stdout: JSON.stringify({ error: { message: 'expired token' } }), stderr: '',
    }));
    expect(await resolveLarkCliHomeForTurn(OPEN)).toBeNull();
    expect(pendingLarkCliChallenge(OPEN)).toBeNull();
  });

  it('returns null for an absent sender without spawning', async () => {
    seedMachine();
    const runner = vi.fn(async () => ({ ok: true, stdout: '{}', stderr: '' }));
    __setLarkCliRunnerForTest(runner);
    expect(await resolveLarkCliHomeForTurn(undefined)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});
