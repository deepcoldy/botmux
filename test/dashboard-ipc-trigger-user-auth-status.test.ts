/**
 * GET /api/bot-trigger-user-auth-status
 *
 * Without openId the aggregate stays what existing dashboard clients read.
 * With a usable openId the same aggregate is returned plus that person's
 * per-tool state. The route keeps the bound-bot gate and the trusted-host
 * gate; it never echoes token contents.
 *
 * Run: bun run test test/dashboard-ipc-trigger-user-auth-status.test.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __setLarkCliHomeRootForTest, larkCliHomeFor } from '../src/services/lark-cli-auth.js';

const APP = `cli_tua${randomBytes(4).toString('hex')}`;
const OPEN = `ou_tua${randomBytes(4).toString('hex')}`;
const OTHER = `ou_tua${randomBytes(4).toString('hex')}`;
const ACCESS = 'probe-access-token-do-not-leak';
const REFRESH = 'probe-refresh-token-do-not-leak';
const ENC = 'enc-secret-bytes-do-not-leak';
const SECRET = 'must-not-leak';

let handle: IpcServerHandle | null = null;
let dir = '';
let tokenPath = '';
let prevBotsConfig: string | undefined;
let larkRoot = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-tua-status-'));
  larkRoot = mkdtempSync(join(tmpdir(), 'dashboard-ipc-tua-lark-'));
  __setLarkCliHomeRootForTest(larkRoot);
  const configPath = join(dir, 'bots.json');
  prevBotsConfig = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: APP,
    larkAppSecret: SECRET,
    cliId: 'codex',
  }], null, 2));
  __testOnly_resetBotRegistry();
  loadBotConfigs().forEach((c: { larkAppId: string }) => registerBot(c as never));
  setLarkAppId(APP);

  const tokenDir = join(homedir(), '.botmux', 'data');
  mkdirSync(tokenDir, { recursive: true });
  tokenPath = join(tokenDir, `user-token-${APP}-${OPEN}.json`);
  writeFileSync(tokenPath, JSON.stringify({
    access_token: ACCESS,
    refresh_token: REFRESH,
    token_type: 'Bearer',
    expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-06-01T00:00:00.000Z',
    scope: 'im:message:readonly',
    appId: APP,
    brand: 'feishu',
    openId: OPEN,
  }));

  const home = larkCliHomeFor(OPEN);
  const dataDir = join(home, '.local', 'share', 'lark-cli');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, '.lark-cli'), { recursive: true });
  writeFileSync(join(home, '.lark-cli', 'config.json'), JSON.stringify({ apps: [] }));
  writeFileSync(join(dataDir, `${APP}_${OPEN}.enc`), ENC);

  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  if (handle) await handle.close();
  handle = null;
  __setLarkCliHomeRootForTest(null);
  if (tokenPath) rmSync(tokenPath, { force: true });
  if (larkRoot) rmSync(larkRoot, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = prevBotsConfig;
  setLarkAppId('');
  __testOnly_resetBotRegistry();
});

function base(): string {
  return `http://127.0.0.1:${handle!.port}/api/bot-trigger-user-auth-status`;
}

describe('GET /api/bot-trigger-user-auth-status', () => {
  it('keeps the aggregate when openId is absent or blank, and adds one person when it is set', async () => {
    const bare = await (await fetch(base())).json();
    const blank = await (await fetch(`${base()}?openId=%20`)).json();
    const queried = await (await fetch(`${base()}?openId=${OPEN}`)).json();

    expect(bare.ok).toBe(true);
    expect(bare.user).toBeUndefined();
    expect(typeof bare.authorizedCount).toBe('number');
    expect(bare.authorizedCount).toBeGreaterThanOrEqual(1);
    expect(blank).toEqual(bare);

    const { user, ...rest } = queried;
    expect(rest).toEqual(bare);
    expect(user).toEqual({
      openId: OPEN,
      coverage: 'local-stores',
      tools: {
        bytedcli: { state: 'needs-login', basis: 'provider-probe' },
        'lark-cli': { state: 'authorized', basis: 'file-present' },
        'user-token': {
          state: 'authorized',
          basis: 'expiry-check',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshExpiresAt: '2099-06-01T00:00:00.000Z',
        },
      },
    });
    const packed = JSON.stringify(queried);
    expect(packed).not.toContain(ACCESS);
    expect(packed).not.toContain(REFRESH);
    expect(packed).not.toContain(ENC);
    expect(packed).not.toContain(SECRET);
  });

  it('reports the token store as protected only under the allowlist sandbox, not scratch', async () => {
    const cfg = getBot(APP).config as { sandbox?: unknown; readIsolation?: unknown };
    const prevSandbox = cfg.sandbox;
    const prevEnv = process.env.BOTMUX_SANDBOX;
    delete process.env.BOTMUX_SANDBOX;
    const enforcedFor = async (sandbox: unknown) => {
      cfg.sandbox = sandbox;
      const body = await (await fetch(base())).json();
      return { enforced: body.tokenStoreEnforced, advised: typeof body.tokenStoreAdvisory === 'string' };
    };
    try {
      expect(await enforcedFor('oncall')).toEqual({ enforced: true, advised: false });
      expect(await enforcedFor(true)).toEqual({ enforced: true, advised: false });
      expect(await enforcedFor('scratch')).toEqual({ enforced: false, advised: true });
      expect(await enforcedFor(undefined)).toEqual({ enforced: false, advised: true });
    } finally {
      cfg.sandbox = prevSandbox;
      if (prevEnv === undefined) delete process.env.BOTMUX_SANDBOX;
      else process.env.BOTMUX_SANDBOX = prevEnv;
    }
  });

  it('does not borrow another person\'s authorization', async () => {
    const bare = await (await fetch(base())).json();
    const body = await (await fetch(`${base()}?openId=${OTHER}`)).json();
    const { user, ...rest } = body;
    expect(rest).toEqual(bare);
    expect(user).toEqual({
      openId: OTHER,
      coverage: 'local-stores',
      tools: {
        bytedcli: { state: 'needs-login', basis: 'provider-probe' },
        'lark-cli': { state: 'needs-login', basis: 'file-present' },
        'user-token': { state: 'needs-login', basis: 'expiry-check' },
      },
    });
  });

  it('rejects an open_id that could escape the token directory', async () => {
    const res = await fetch(`${base()}?openId=${encodeURIComponent('../x')}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_open_id' });
    const again = await (await fetch(base())).json();
    expect(again.ok).toBe(true);
    expect(again.user).toBeUndefined();
  });

  it('still requires the trusted-host gate when auth is on', async () => {
    const locked = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    try {
      const res = await fetch(`http://127.0.0.1:${locked.port}/api/bot-trigger-user-auth-status?openId=${OPEN}`);
      expect(res.status).toBe(401);
    } finally {
      await locked.close();
    }
  });
});
