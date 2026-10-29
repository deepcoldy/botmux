/**
 * Revoking one member's trigger-user credentials.
 *
 * The properties pinned here:
 *   1. one person's CLI homes and per-app user token go away; another person's
 *      do not, and neither do unattributed legacy token files or issuer homes;
 *   2. server-side logout runs only when a HOME already exists, and a failed
 *      logout still deletes the local state;
 *   3. a revoked HOME is not treated as logged-in just because the CLI says so;
 *   4. an in-flight refresh or OAuth callback cannot write the token back;
 *   5. published per-turn identities for that person are dropped;
 *   6. the dashboard IPC route is bound-bot scoped and does not echo secrets.
 *
 * Run: bun run vitest run --project unit test/revoke-trigger-user-auth.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const spawns: Array<{ cmd: string; args: string[]; home?: string; homeExisted: boolean }> = [];
let failSpawn = false;
/** When set, replaces the default authenticated-status stdout for that spawn. */
let scriptSpawn: ((args: string[], home: string | undefined) => { stdout: string; code?: number } | undefined) | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const { existsSync: homeExists } = await import('node:fs');
  return {
    ...orig,
    spawn: vi.fn((cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      const home = opts?.env?.HOME;
      spawns.push({ cmd, args: [...args], home, homeExisted: !!home && homeExists(home) });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        const scripted = scriptSpawn?.([...args], home);
        child.stdout.emit('data', scripted?.stdout
          ?? '{"ok":true,"status":"success","data":{"authenticated":true}}\n');
        child.emit('close', scripted?.code ?? (failSpawn ? 1 : 0));
      });
      return child;
    }),
  };
});

let homeDir = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => homeDir };
});

const APP = 'cli_revokeapp0001';
const ALICE = 'ou_aliceauth000000000001';
const BOB = 'ou_bobauth000000000002';
const ALICE_SECRET = 'SECRET_ALICE_TOKEN';
const BOB_SECRET = 'SECRET_BOB_TOKEN';

function token(openId: string, access: string, expired = false) {
  return JSON.stringify({
    access_token: access,
    refresh_token: `rt-${access}`,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + (expired ? -120_000 : 3_600_000)).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    scope: 'offline_access',
    appId: APP,
    brand: 'feishu',
    openId,
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'botmux-revoke-'));
  spawns.length = 0;
  failSpawn = false;
  scriptSpawn = null;
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(homeDir, { recursive: true, force: true });
});

async function loadRevoke() {
  const revoke = await import('../src/services/revoke-trigger-user-auth.js');
  const byted = await import('../src/services/bytedcli-auth.js');
  const tokens = await import('../src/utils/user-token.js');
  const identity = await import('../src/core/cli-identity.js');
  const lark = await import('../src/services/lark-cli-auth.js');
  const epoch = await import('../src/services/cli-auth-epoch.js');
  return { revoke, byted, tokens, identity, lark, epoch };
}

function dataDir() {
  return join(homeDir, '.botmux', 'data');
}

function plantStores() {
  const data = dataDir();
  for (const dir of [
    join(data, 'bytedcli-home', ALICE),
    join(data, 'lark-cli-home', ALICE),
    join(data, 'bytedcli-home', BOB),
    join(data, 'lark-cli-home', BOB),
    join(data, `lark-cli-issuer-${ALICE}`),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker'), 'keep-or-drop');
  }
  writeFileSync(join(data, `user-token-${APP}-${ALICE}.json`), token(ALICE, ALICE_SECRET));
  writeFileSync(join(data, `user-token-${APP}-${BOB}.json`), token(BOB, BOB_SECRET));
  writeFileSync(join(data, `user-token-${APP}.json`), JSON.stringify({ access_token: 'LEGACY_APP' }));
  writeFileSync(join(data, 'user-token.json'), JSON.stringify({ access_token: 'LEGACY_SINGLE' }));
}

describe('revokeTriggerUserAuth', () => {
  it('logs out then deletes only that person, and a second call is a no-op success', async () => {
    plantStores();
    const { revoke } = await loadRevoke();
    const sessionDataDir = join(homeDir, 'sessions');
    mkdirSync(sessionDataDir);
    const first = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.removed).toEqual({ larkCli: true, bytedcli: true, userToken: true });
    expect(first.remoteLogout).toEqual({ larkCli: 'ok', bytedcli: 'ok' });
    expect(spawns.map(s => s.cmd)).toEqual(['lark-cli', 'bytedcli']);
    expect(spawns.every(s => s.homeExisted && s.args.join(' ') === 'auth logout --json')).toBe(true);

    const data = dataDir();
    expect(existsSync(join(data, 'bytedcli-home', ALICE))).toBe(false);
    expect(existsSync(join(data, 'lark-cli-home', ALICE))).toBe(false);
    expect(existsSync(join(data, 'bytedcli-home', BOB))).toBe(true);
    expect(existsSync(join(data, 'lark-cli-home', BOB))).toBe(true);
    expect(existsSync(join(data, `lark-cli-issuer-${ALICE}`, 'marker'))).toBe(true);
    expect(existsSync(join(data, `user-token-${APP}-${ALICE}.json`))).toBe(false);
    expect(readFileSync(join(data, `user-token-${APP}-${BOB}.json`), 'utf8')).toContain(BOB_SECRET);
    expect(readFileSync(join(data, `user-token-${APP}.json`), 'utf8')).toContain('LEGACY_APP');
    expect(readFileSync(join(data, 'user-token.json'), 'utf8')).toContain('LEGACY_SINGLE');

    const second = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.removed).toEqual({ larkCli: false, bytedcli: false, userToken: false });
    expect(existsSync(join(data, 'bytedcli-home', BOB))).toBe(true);
  });

  it('still deletes local state when the CLI logout fails', async () => {
    plantStores();
    failSpawn = true;
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remoteLogout).toEqual({ larkCli: 'failed', bytedcli: 'failed' });
    expect(result.removed.larkCli).toBe(true);
    expect(result.removed.bytedcli).toBe(true);
    expect(existsSync(join(dataDir(), 'lark-cli-home', ALICE))).toBe(false);
  });

  it('does not create a HOME just to log out', async () => {
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remoteLogout).toEqual({ larkCli: 'skipped', bytedcli: 'skipped' });
    expect(spawns).toEqual([]);
    expect(existsSync(join(dataDir(), 'bytedcli-home', ALICE))).toBe(false);
    expect(existsSync(join(dataDir(), 'lark-cli-home', ALICE))).toBe(false);
  });

  it('rejects a path-shaped open id without touching storage', async () => {
    plantStores();
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: '../x', appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result).toEqual({ ok: false, error: 'invalid_open_id' });
    expect(spawns).toEqual([]);
    expect(existsSync(join(dataDir(), 'bytedcli-home', ALICE))).toBe(true);
    expect(existsSync(join(dataDir(), `user-token-${APP}-${ALICE}.json`))).toBe(true);
  });

  it('ignores a HOME recreated after revoke even when the CLI reports authenticated', async () => {
    plantStores();
    const { revoke, byted } = await loadRevoke();
    await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    const home = byted.bytedcliHomeFor(ALICE);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'session'), 'rewritten-by-cli');
    spawns.length = 0;
    expect(await byted.hasBytedcliHome(ALICE)).toBe(false);
    expect(existsSync(join(home, 'session'))).toBe(true);
    expect(spawns).toEqual([]);
  });
});

describe('in-flight credential writes after revoke', () => {
  it('does not resurrect a user token when refresh finishes after clear', async () => {
    const { tokens } = await loadRevoke();
    const path = join(dataDir(), `user-token-${APP}-${ALICE}.json`);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, token(ALICE, ALICE_SECRET, true));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      entered = true;
      await gate;
      return {
        ok: true,
        json: async () => ({
          access_token: 'SHOULD_NOT_LAND',
          refresh_token: 'RT_NEW',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: 'offline_access',
        }),
      };
    }));

    const pending = tokens.resolveUserToken(APP, 'sec', 'feishu', ALICE);
    for (let i = 0; i < 50 && !entered; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(entered).toBe(true);
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(true);
    release();
    expect(await pending).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(dataDir(), `user-token-epoch-${APP}-${ALICE}`), 'utf8').trim()).not.toBe('0');
  });

  it('drops an in-flight OAuth callback, then accepts a login started after revoke', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const oldState = new URL(first.authUrl).searchParams.get('state');
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: ALICE_SECRET,
            refresh_token: 'RT_NEW',
            token_type: 'Bearer',
            expires_in: 7200,
            refresh_token_expires_in: 604800,
            scope: 'im:message:readonly im:resource offline_access',
          }),
        };
      }
      return { ok: true, json: async () => ({ code: 0, data: { open_id: ALICE } }) };
    }));

    const path = join(dataDir(), `user-token-${APP}-${ALICE}.json`);
    await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=old&state=${oldState}`);
    expect(existsSync(path)).toBe(false);

    const second = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const newState = new URL(second.authUrl).searchParams.get('state');
    const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=new&state=${newState}`);
    expect(saved?.startsWith('✅')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(ALICE_SECRET);
  });

  const TOKEN_SCOPE = 'im:message:readonly im:resource offline_access';

  function stubCallbackFetch(openId: string, access = 'NEW_CLICKER_TOKEN') {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: access,
            refresh_token: 'RT_NEW',
            token_type: 'Bearer',
            expires_in: 7200,
            refresh_token_expires_in: 604800,
            scope: TOKEN_SCOPE,
          }),
        };
      }
      return { ok: true, json: async () => ({ code: 0, data: { open_id: openId, name: 'Clicker' } }) };
    }));
  }

  function tokenPath(openId: string) {
    return join(dataDir(), `user-token-${APP}-${openId}.json`);
  }

  function epochPath(openId: string) {
    return join(dataDir(), `user-token-epoch-${APP}-${openId}`);
  }

  it('saves a forwarded callback for the clicker when only the initiator has revoked', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    // Initiator epoch is already 1 when the link is created, which is the
    // snapshot the old callback compared against the clicker.
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const state = new URL(first.authUrl).searchParams.get('state');
    stubCallbackFetch(BOB);
    const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=fwd&state=${state}`);
    expect(saved?.startsWith('✅')).toBe(true);
    expect(readFileSync(tokenPath(BOB), 'utf8')).toContain('NEW_CLICKER_TOKEN');
    expect(existsSync(tokenPath(ALICE))).toBe(false);
  });

  it('still saves a forwarded callback when the initiator revoked that pending state', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const state = new URL(first.authUrl).searchParams.get('state');
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);
    stubCallbackFetch(BOB);
    const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=fwd&state=${state}`);
    expect(saved?.startsWith('✅')).toBe(true);
    expect(readFileSync(tokenPath(BOB), 'utf8')).toContain('NEW_CLICKER_TOKEN');
    expect(existsSync(tokenPath(ALICE))).toBe(false);
  });

  it('refuses a clicker whose epoch advances after user_info and before the write, even when that epoch equals the initiator snapshot', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const state = new URL(first.authUrl).searchParams.get('state');
    writeFileSync(tokenPath(BOB), token(BOB, 'OLD_BOB', false).replace('offline_access', TOKEN_SCOPE));
    tokens.__setAfterCallbackOwnerEpochReadForTest(() => {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(epochPath(BOB), '1');
    });
    stubCallbackFetch(BOB);
    try {
      const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=fwd&state=${state}`);
      expect(saved).toContain('授权已撤销');
      expect(readFileSync(tokenPath(BOB), 'utf8')).toContain('OLD_BOB');
      expect(readFileSync(tokenPath(BOB), 'utf8')).not.toContain('NEW_CLICKER_TOKEN');
    } finally {
      tokens.__setAfterCallbackOwnerEpochReadForTest(null);
    }
  });

  function runIsolated(source: string) {
    const child = spawnSyncTsEvalWithRepoImports(source, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      timeout: 30_000,
    });
    const line = String(child.stdout).split('\n').findLast(row => row.trim().startsWith('{'));
    return { status: child.status, stderr: String(child.stderr), line };
  }

  it('refuses the initiator across processes and still saves a forwarded clicker', () => {
    const moduleUrl = join(process.cwd(), 'src/utils/user-token.ts');
    const issue = () => {
      const started = runIsolated(`
        const { generateAuthUrl, clearUserToken } = await import(${JSON.stringify(moduleUrl)});
        const first = generateAuthUrl(${JSON.stringify(APP)}, 'sec', 'feishu', [], ${JSON.stringify(ALICE)});
        clearUserToken(${JSON.stringify(APP)}, 'feishu', ${JSON.stringify(ALICE)});
        process.stdout.write(JSON.stringify({ url: first.authUrl }));
      `);
      expect(started.status, started.stderr).toBe(0);
      return new URL(JSON.parse(started.line!).url).searchParams.get('state');
    };
    const finish = (openId: string, state: string | null) => {
      const child = runIsolated(`
        const fs = await import('node:fs');
        const { handleCallbackUrl } = await import(${JSON.stringify(moduleUrl)});
        globalThis.fetch = async (url) => {
          if (String(url).includes('/oauth/token')) {
            return { ok: true, json: async () => ({
              access_token: 'CROSS_PROC_TOKEN', refresh_token: 'RT', token_type: 'Bearer',
              expires_in: 7200, refresh_token_expires_in: 604800,
              scope: ${JSON.stringify(TOKEN_SCOPE)},
            }) };
          }
          return { ok: true, json: async () => ({ code: 0, data: { open_id: ${JSON.stringify(openId)}, name: 'Clicker' } }) };
        };
        const msg = await handleCallbackUrl(${JSON.stringify(`http://127.0.0.1:9768/callback?code=cross&state=${state}`)});
        const path = ${JSON.stringify(join(homeDir, '.botmux', 'data', `user-token-${APP}-${openId}.json`))};
        const landed = fs.existsSync(path);
        process.stdout.write(JSON.stringify({ msg, landed, body: landed ? fs.readFileSync(path, 'utf8') : '' }));
      `);
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.line!) as { msg: string; landed: boolean; body: string };
    };

    const self = finish(ALICE, issue());
    expect(self.landed).toBe(false);
    expect(self.body).not.toContain('CROSS_PROC_TOKEN');
    expect(self.msg).toContain('授权已撤销');

    const forwarded = finish(BOB, issue());
    expect(forwarded.landed).toBe(true);
    expect(forwarded.body).toContain('CROSS_PROC_TOKEN');
    expect(forwarded.body).toContain(BOB);
    expect(forwarded.msg.startsWith('✅')).toBe(true);
  });

  it('saves a new link issued after revoke when another process completes it', () => {
    const moduleUrl = join(process.cwd(), 'src/utils/user-token.ts');
    const setup = `
      const { generateAuthUrl, clearUserToken } = await import(${JSON.stringify(moduleUrl)});
      clearUserToken(${JSON.stringify(APP)}, 'feishu', ${JSON.stringify(ALICE)});
      const first = generateAuthUrl(${JSON.stringify(APP)}, 'sec', 'feishu', [], ${JSON.stringify(ALICE)});
      process.stdout.write(JSON.stringify({ url: first.authUrl }));
    `;
    const started = runIsolated(setup);
    expect(started.status, started.stderr).toBe(0);
    const state = new URL(JSON.parse(started.line!).url).searchParams.get('state');
    const finish = `
      const fs = await import('node:fs');
      const { handleCallbackUrl } = await import(${JSON.stringify(moduleUrl)});
      globalThis.fetch = async (url) => {
        if (String(url).includes('/oauth/token')) {
          return { ok: true, json: async () => ({
            access_token: 'FRESH_AFTER_REVOKE', refresh_token: 'RT', token_type: 'Bearer',
            expires_in: 7200, refresh_token_expires_in: 604800,
            scope: ${JSON.stringify(TOKEN_SCOPE)},
          }) };
        }
        return { ok: true, json: async () => ({ code: 0, data: { open_id: ${JSON.stringify(ALICE)}, name: 'Alice' } }) };
      };
      const msg = await handleCallbackUrl(${JSON.stringify(`http://127.0.0.1:9768/callback?code=fresh&state=${state}`)});
      const path = ${JSON.stringify(join(homeDir, '.botmux', 'data', `user-token-${APP}-${ALICE}.json`))};
      const landed = fs.existsSync(path);
      process.stdout.write(JSON.stringify({ msg, landed, body: landed ? fs.readFileSync(path, 'utf8') : '' }));
    `;
    const saved = runIsolated(finish);
    expect(saved.status, saved.stderr).toBe(0);
    const body = JSON.parse(saved.line!) as { landed: boolean; body: string };
    expect(body.landed).toBe(true);
    expect(body.body).toContain('FRESH_AFTER_REVOKE');
  });

  it('known residual: a clicker revoke that lands before user_info returns still saves', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const state = new URL(first.authUrl).searchParams.get('state');
    // Before user_info the owner is unknowable, so the snapshot is already the
    // post-revoke epoch. This is the agree → user_info window, and also a
    // consent that happened after the clicker's own /logout.
    expect(tokens.clearUserToken(APP, 'feishu', BOB)).toBe(false);
    stubCallbackFetch(BOB);
    const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=fwd&state=${state}`);
    expect(saved?.startsWith('✅')).toBe(true);
    expect(readFileSync(tokenPath(BOB), 'utf8')).toContain('NEW_CLICKER_TOKEN');
  });

  it('does not recreate a token when the file disappeared but the epoch did not move', async () => {
    const { tokens } = await loadRevoke();
    const path = tokenPath(ALICE);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, token(ALICE, ALICE_SECRET, true));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          access_token: 'SHOULD_NOT_LAND',
          refresh_token: 'RT_NEW',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: 'offline_access',
        }),
      };
    }));
    const pending = tokens.resolveUserToken(APP, 'sec', 'feishu', ALICE);
    for (let i = 0; i < 50 && vi.mocked(fetch).mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    rmSync(path);
    release();
    expect(await pending).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(epochPath(ALICE))).toBe(false);
  });

  it('does not replace a token when the epoch advanced and the file is still there', async () => {
    const { tokens } = await loadRevoke();
    const path = tokenPath(ALICE);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, token(ALICE, ALICE_SECRET, true));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          access_token: 'SHOULD_NOT_LAND',
          refresh_token: 'RT_NEW',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: 'offline_access',
        }),
      };
    }));
    const pending = tokens.resolveUserToken(APP, 'sec', 'feishu', ALICE);
    for (let i = 0; i < 50 && vi.mocked(fetch).mock.calls.length === 0; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    writeFileSync(epochPath(ALICE), '1');
    release();
    expect(await pending).toBeNull();
    expect(readFileSync(path, 'utf8')).toContain(ALICE_SECRET);
    expect(readFileSync(path, 'utf8')).not.toContain('SHOULD_NOT_LAND');
  });

  it('does not save a device-code poll that becomes ready after revoke', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let tokenFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/v1/device_authorization')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'device-1',
            verification_uri_complete: 'https://example.test/device',
            expires_in: 300,
            interval: 1,
          }),
        };
      }
      if (String(url).includes('/user_info')) {
        return { ok: true, json: async () => ({ code: 0, data: { open_id: ALICE, name: 'Alice' } }) };
      }
      tokenFetches += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({
          access_token: 'SHOULD_NOT_LAND',
          refresh_token: 'RT_NEW',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: TOKEN_SCOPE,
        }),
      };
    }));
    const started = await tokens.requestUserAuthorization(APP, 'sec', 'feishu', [], ALICE, () => true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const pending = started.poll();
    for (let i = 0; i < 50 && tokenFetches === 0; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(tokenFetches).toBe(1);
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);
    release();
    const result = await pending;
    expect(result).toEqual({ status: 'failed', error: 'authorization_revoked' });
    expect(existsSync(tokenPath(ALICE))).toBe(false);
  });
});

describe('cli epoch gates', () => {
  const BYTED_LOGIN = JSON.stringify({
    status: 'success',
    data: { verification_uri_complete: 'https://example.test/byted', complete_token: 'ctok' },
  });
  const LARK_LOGIN = JSON.stringify({ verification_url: 'https://example.test/lark', device_code: 'dc' });

  function plantIssuer(openId: string) {
    const root = join(dataDir(), `lark-cli-issuer-${openId}`);
    mkdirSync(join(root, '.lark-cli'), { recursive: true });
    mkdirSync(join(root, '.local', 'share', 'lark-cli'), { recursive: true });
    writeFileSync(join(root, '.lark-cli', 'config.json'), JSON.stringify({
      apps: [{ appId: APP, brand: 'feishu', lang: 'zh', users: [] }],
    }));
    writeFileSync(join(root, '.local', 'share', 'lark-cli', 'master.key'), 'k');
    writeFileSync(join(root, '.local', 'share', 'lark-cli', `appsecret_${APP}.enc`), 's');
  }

  function writeLarkToken(home: string, openId: string) {
    const dir = join(home, '.local', 'share', 'lark-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${APP}_${openId}.enc`), 'tok');
  }

  it('does not treat a lark HOME rewritten after revoke as logged in', async () => {
    const { epoch, lark } = await loadRevoke();
    epoch.bumpCliAuthEpoch(ALICE);
    const home = lark.larkCliHomeFor(ALICE);
    mkdirSync(join(home, '.lark-cli'), { recursive: true });
    writeFileSync(join(home, '.lark-cli', 'config.json'), '{}');
    writeLarkToken(home, ALICE);
    expect(lark.hasLarkCliHome(ALICE)).toBe(false);
  });

  it('drops a bytedcli login whose CLI returns after revoke, and a later login stamps the new epoch', async () => {
    const { byted, epoch } = await loadRevoke();
    scriptSpawn = (args) => {
      if (args.includes('--begin')) {
        epoch.bumpCliAuthEpoch(ALICE);
        return { stdout: BYTED_LOGIN };
      }
      return undefined;
    };
    expect(await byted.beginBytedcliLogin(ALICE)).toBeNull();
    expect(await byted.hasBytedcliHome(ALICE)).toBe(false);

    scriptSpawn = (args) => args.includes('--begin') ? { stdout: BYTED_LOGIN } : undefined;
    const again = await byted.beginBytedcliLogin(ALICE);
    expect(again?.authUrl).toBe('https://example.test/byted');
    const home = byted.bytedcliHomeFor(ALICE);
    expect(readFileSync(join(home, '.botmux-auth-epoch'), 'utf8').trim()).toBe('1');
    expect(await byted.hasBytedcliHome(ALICE)).toBe(true);
  });

  it('drops a lark-cli login whose CLI returns after revoke, and a later login stamps the new epoch', async () => {
    const { lark, epoch } = await loadRevoke();
    plantIssuer(ALICE);
    scriptSpawn = (args, home) => {
      if (!args.includes('--no-wait') || !home) return undefined;
      writeLarkToken(home, ALICE);
      epoch.bumpCliAuthEpoch(ALICE);
      return { stdout: LARK_LOGIN };
    };
    expect(await lark.beginLarkCliLogin(ALICE)).toBeNull();
    expect(lark.hasLarkCliHome(ALICE)).toBe(false);

    scriptSpawn = (args, home) => {
      if (!args.includes('--no-wait') || !home) return undefined;
      writeLarkToken(home, ALICE);
      return { stdout: LARK_LOGIN };
    };
    const again = await lark.beginLarkCliLogin(ALICE);
    expect(again?.authUrl).toBe('https://example.test/lark');
    const home = lark.larkCliHomeFor(ALICE);
    expect(readFileSync(join(home, '.botmux-auth-epoch'), 'utf8').trim()).toBe('1');
    expect(lark.hasLarkCliHome(ALICE)).toBe(true);
  });

  it('does not publish a bytedcli JWT minted after the epoch moved', async () => {
    const { byted, epoch } = await loadRevoke();
    mkdirSync(byted.bytedcliHomeFor(ALICE), { recursive: true });
    scriptSpawn = (args) => {
      if (args.includes('get-bytecloud-jwt-token')) {
        epoch.bumpCliAuthEpoch(ALICE);
        return { stdout: 'cloud-jwt\n' };
      }
      if (args.includes('get-codebase-jwt-token')) return { stdout: 'code-jwt\n' };
      return undefined;
    };
    expect(await byted.mintBytedcliJwts(ALICE)).toBeNull();
  });
});

describe('published identities', () => {
  it('drops the revoked person from proven memory and single-snapshot files', async () => {
    const { identity, revoke } = await loadRevoke();
    const sessionDataDir = join(homeDir, 'sessions');
    mkdirSync(sessionDataDir, { recursive: true });

    identity.writeSessionIdentity(sessionDataDir, 'sess-proven', {
      tool: 'bytedcli', cloudJwt: 'alice-cloud', codeJwt: 'alice-code', openId: ALICE, turnId: 'turn-p',
    }, 'proven');
    identity.writeSessionIdentity(sessionDataDir, 'sess-proven', {
      tool: 'codebase', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-p',
    }, 'proven');
    identity.writeSessionIdentity(sessionDataDir, 'sess-bob', {
      tool: 'bytedcli', cloudJwt: 'bob-cloud', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-b',
    }, 'proven');

    identity.writeSessionIdentity(sessionDataDir, 'sess-single', {
      tool: 'bytedcli', cloudJwt: 'alice-cloud', codeJwt: 'alice-code', openId: ALICE, turnId: 'turn-s',
    }, 'single');
    identity.writeSessionIdentity(sessionDataDir, 'sess-single', {
      tool: 'codebase', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-s',
    }, 'single');
    identity.writeSessionIdentity(sessionDataDir, 'sess-deny', {
      tool: 'lark-cli', mode: 'denied', message: 'need login', turnId: 'turn-d',
    }, 'single');

    const outside = join(homeDir, 'outside.env');
    writeFileSync(outside, `BOTMUX_IDENTITY_OPEN_ID='${ALICE}'\n`);
    const link = join(identity.sessionIdentityDir(sessionDataDir), 'linked.env');
    symlinkSync(outside, link);

    const dropped = identity.dropPublishedIdentitiesForOpenId(sessionDataDir, ALICE);
    expect(dropped).toBeGreaterThan(0);
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-proven', 'turn-p', 'bytedcli')).toBeUndefined();
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-proven', 'turn-p', 'codebase')).toContain(BOB);
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-bob', 'turn-b', 'bytedcli')).toContain(BOB);

    const singleDir = identity.sessionIdentityDataDir(sessionDataDir, 'sess-single');
    expect(existsSync(join(singleDir, 'bytedcli.env'))).toBe(false);
    expect(readFileSync(join(singleDir, 'codebase.env'), 'utf8')).toContain(BOB);
    expect(existsSync(join(identity.sessionIdentityDataDir(sessionDataDir, 'sess-deny'), 'lark-cli.env'))).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(outside)).toBe(true);

    const again = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-bob', 'turn-b', 'bytedcli')).toContain(BOB);
  });
});

describe('DELETE /api/bot-trigger-user-auth/users/:openId', () => {
  it('revokes the bound bot\'s user and does not echo secrets', async () => {
    plantStores();
    const prevBots = process.env.BOTS_CONFIG;
    const prevSession = process.env.SESSION_DATA_DIR;
    const configPath = join(homeDir, 'bots.json');
    const sessionDataDir = join(homeDir, 'sessions');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = sessionDataDir;
    mkdirSync(sessionDataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: APP,
      larkAppSecret: 'secret-must-not-leak',
      cliId: 'codex',
      brand: 'feishu',
    }]));
    let handle: { close: () => Promise<void>; port: number } | null = null;
    try {
      const ipc = await import('../src/core/dashboard-ipc-server.js');
      const registry = await import('../src/bot-registry.js');
      registry.loadBotConfigs().forEach(cfg => registry.registerBot(cfg));
      ipc.setLarkAppId(APP);
      handle = await ipc.startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const ok = await fetch(`${base}/api/bot-trigger-user-auth/users/${ALICE}`, { method: 'DELETE' });
      const body = await ok.json() as { ok?: boolean; removed?: { userToken?: boolean } };
      expect(ok.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.removed?.userToken).toBe(true);
      const encoded = JSON.stringify(body);
      expect(encoded).not.toContain(ALICE_SECRET);
      expect(encoded).not.toContain('secret-must-not-leak');
      expect(existsSync(join(dataDir(), `user-token-${APP}-${ALICE}.json`))).toBe(false);
      expect(existsSync(join(dataDir(), `user-token-${APP}-${BOB}.json`))).toBe(true);

      const again = await fetch(`${base}/api/bot-trigger-user-auth/users/${ALICE}`, { method: 'DELETE' });
      expect(again.status).toBe(200);
      expect((await again.json() as { ok?: boolean }).ok).toBe(true);

      const bad = await fetch(`${base}/api/bot-trigger-user-auth/users/${encodeURIComponent('bad id')}`, { method: 'DELETE' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_open_id' });
    } finally {
      if (handle) await handle.close();
      if (prevBots === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBots;
      if (prevSession === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevSession;
    }
  });
});
