import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const appId = 'cli_feed_owner';
const ownerId = 'ou_feed_owner';
const secondAppId = 'cli_other_feed_owner';
const secondOwnerId = 'ou_other_app_owner';
const preferredAppId = 'cli_preferred_feed_owner';
const preferredOwnerId = 'ou_preferred_owner';
const unresolvedAppId = 'cli_unresolved_feed_owner';
const fallbackOwnerId = 'ou_fallback_owner';
const fallbackCases = [
  { appId: 'cli_offline_feed_owner', scenario: 'the daemon descriptor is missing', allowedUsers: ['on_shared_union'] },
  { appId: 'cli_empty_feed_owner', scenario: 'the daemon could not resolve any administrators', allowedUsers: ['on_shared_union'], resolvedAllowedUsers: [] },
  { appId: 'cli_no_allowlist_feed_owner', scenario: 'no allowlist is configured', resolvedAllowedUsers: [] },
  { appId: 'cli_stale_feed_owner', scenario: 'the daemon heartbeat has expired', allowedUsers: ['on_shared_union'], resolvedAllowedUsers: ['ou_stale_owner'], lastHeartbeat: 1 },
];
const managementToken = 'feed-owner-test-management-token';
const botmuxDir = join(homedir(), '.botmux');
const dataDir = join(botmuxDir, 'data');
let child: ChildProcess;
let base = '';
let logs = '';

function writeToken(id: string, owner: string | undefined, token: string): void {
  const filename = owner ? `user-token-${id}-${owner}.json` : `user-token-${id}.json`;
  writeFileSync(join(dataDir, filename), JSON.stringify({
    appId: id, brand: 'feishu', openId: owner, access_token: token,
    refresh_token: 'test-refresh', token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    scope: 'im:feed_group_v1:read im:feed_group_v1:write',
  }), { mode: 0o600 });
}

function request(path: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { cookie: `botmux_dashboard_token=${managementToken}` },
    signal: AbortSignal.timeout(5_000),
  });
}

beforeAll(async () => {
  const registryDir = join(dataDir, 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  const entries = [[appId, ownerId, 'first'], [secondAppId, secondOwnerId, 'second']];
  const bots = entries.map(([id], index) => ({
    larkAppId: id, larkAppSecret: 'test-secret', cliId: 'codex',
    allowedUsers: ['on_shared_union'],
    ...(index === 1 ? { ownerOpenId: 'ou_removed_owner' } : {}),
  }));
  bots.push({
    larkAppId: preferredAppId, larkAppSecret: 'test-secret', cliId: 'claude-code',
    allowedUsers: ['ou_first_candidate', preferredOwnerId], ownerOpenId: preferredOwnerId,
  }, {
    larkAppId: unresolvedAppId, larkAppSecret: 'test-secret', cliId: 'codex',
    allowedUsers: ['on_shared_union'],
  });
  const fallbackBots = fallbackCases.map(fixture => ({
    larkAppId: fixture.appId, larkAppSecret: 'test-secret', cliId: 'claude-code',
    allowedUsers: fixture.allowedUsers, ownerOpenId: fallbackOwnerId,
  }));
  writeFileSync(join(botmuxDir, 'bots.json'), JSON.stringify([...bots, ...fallbackBots]));
  writeFileSync(join(botmuxDir, '.dashboard-token'), managementToken, { mode: 0o600 });
  writeFileSync(join(botmuxDir, '.dashboard-secret'), 'feed-owner-test-secret', { mode: 0o600 });
  writeFileSync(join(botmuxDir, '.data-dir'), dataDir);
  for (const [index, [id, owner, token]] of entries.entries()) {
    writeFileSync(join(registryDir, `${id}.json`), JSON.stringify({
      larkAppId: id, botName: id, botIndex: index, ipcPort: 9, pid: process.pid,
      startedAt: Date.now(), lastHeartbeat: Date.now(), resolvedAllowedUsers: [owner],
    }));
    writeToken(id, owner, token);
  }
  writeFileSync(join(registryDir, `${preferredAppId}.json`), JSON.stringify({
    larkAppId: preferredAppId, botName: preferredAppId, botIndex: 2, ipcPort: 9, pid: process.pid,
    startedAt: Date.now(), lastHeartbeat: Date.now(), resolvedAllowedUsers: ['ou_first_candidate', preferredOwnerId],
  }));
  writeToken(preferredAppId, 'ou_first_candidate', 'first');
  writeToken(preferredAppId, preferredOwnerId, 'preferred');
  writeToken(secondAppId, 'ou_removed_owner', 'removed');
  // A valid legacy token must not let an unidentified owner bypass the guard.
  writeToken(unresolvedAppId, undefined, 'legacy');
  for (const [index, fixture] of fallbackCases.entries()) {
    if (fixture.resolvedAllowedUsers) {
      writeFileSync(join(registryDir, `${fixture.appId}.json`), JSON.stringify({
        larkAppId: fixture.appId, botName: fixture.appId, botIndex: index + bots.length,
        ipcPort: 9, pid: process.pid, startedAt: Date.now(),
        lastHeartbeat: fixture.lastHeartbeat ?? Date.now(), resolvedAllowedUsers: fixture.resolvedAllowedUsers,
      }));
    }
    writeToken(fixture.appId, fallbackOwnerId, 'fallback');
  }

  child = spawnTsEvalWithRepoImports(`
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.hostname === 'open.feishu.cn' && url.pathname === '/open-apis/im/v1/groups') {
        const auth = new Headers(init?.headers).get('authorization');
        const name = {
          'Bearer first': 'first-owner-label', 'Bearer second': 'second-owner-label',
          'Bearer preferred': 'preferred-owner-label', 'Bearer fallback': 'fallback-owner-label',
          'Bearer removed': 'removed-owner-label', 'Bearer legacy': 'legacy-owner-label',
        }[auth] ?? '';
        return new Response(JSON.stringify(name
          ? { code: 0, data: { groups: [{ group_id: 'ofg_' + name, name, type: 'normal' }], has_more: false } }
          : { code: 99991663, msg: 'unexpected owner token' }), { status: name ? 200 : 403 });
      }
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
      throw new Error('External network disabled in feed-owner regression');
    };
    await import('./src/index-dashboard.js');
  `, {
    cwd: resolve('.'),
    env: {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(botmuxDir, 'bots.json'),
      BOTMUX_DASHBOARD_PORT: '17991',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { logs += String(chunk); });
  child.stderr?.on('data', chunk => { logs += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(logs);
    try {
      const port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8'));
      base = `http://127.0.0.1:${port}`;
      if ((await request('/__health')).ok) return;
    } catch { /* wait for the isolated dashboard */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Dashboard startup timeout: ${logs}`);
}, 25_000);

afterAll(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await closed; } finally { clearTimeout(force); }
});

describe('Dashboard feed groups with per-person OAuth tokens', () => {
  it('reads labels after authorization when only the daemon has the resolved owner', async () => {
    const response = await request('/api/feed-groups');
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200, body: { ok: true, larkAppId: appId, groups: [{ name: 'first-owner-label' }] },
    });
  });

  it('binds the OAuth callback to the owner resolved by that app daemon', async () => {
    const response = await request(`/api/feed-groups/auth-url?larkAppId=${appId}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    const state = new URL(body.authUrl).searchParams.get('state')!;
    const pending = JSON.parse(readFileSync(join(dataDir, 'oauth-pending', `${state}.json`), 'utf8'));
    expect({ appId: pending.appId, openId: pending.openId }).toEqual({ appId, openId: ownerId });
  });

  it('keeps app-scoped owners separate and ignores a removed configured owner', async () => {
    const response = await request(`/api/feed-groups?larkAppId=${secondAppId}`);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200, body: { ok: true, larkAppId: secondAppId, groups: [{ name: 'second-owner-label' }] },
    });
  });

  it('prefers the configured owner when they are the second resolved administrator', async () => {
    const response = await request(`/api/feed-groups?larkAppId=${preferredAppId}`);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200, body: { ok: true, larkAppId: preferredAppId, groups: [{ name: 'preferred-owner-label' }] },
    });
  });

  it.each(fallbackCases)('uses the configured owner when $scenario', async fixture => {
    const response = await request(`/api/feed-groups?larkAppId=${fixture.appId}`);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200, body: { ok: true, larkAppId: fixture.appId, groups: [{ name: 'fallback-owner-label' }] },
    });
  });

  it.each([
    { appId: preferredAppId, owner: preferredOwnerId },
    { appId: fallbackCases[0].appId, owner: fallbackOwnerId },
  ])('binds OAuth to the configured owner for $appId', async fixture => {
    const response = await request(`/api/feed-groups/auth-url?larkAppId=${fixture.appId}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    const state = new URL(body.authUrl).searchParams.get('state')!;
    const pending = JSON.parse(readFileSync(join(dataDir, 'oauth-pending', `${state}.json`), 'utf8'));
    expect({ appId: pending.appId, openId: pending.openId }).toEqual({ appId: fixture.appId, openId: fixture.owner });
  });

  it.each(['/api/feed-groups', '/api/feed-groups/auth-url'])('rejects %s without a descriptor or configured owner', async path => {
    const response = await request(`${path}?larkAppId=${unresolvedAppId}`);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 409, body: { ok: false, error: 'feed_group_owner_unresolved' },
    });
  });
});
