/** Real OAuth store regression: a command sender must never inherit a legacy owner's token. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setChatFeedGroup } from '../src/services/chat-feed-groups.js';
import { join } from 'node:path';

let root: string | undefined;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it('refuses a sender without personal authorization even when an old per-app token exists', async () => {
  root = mkdtempSync(join(tmpdir(), 'chat-label-actor-'));
  const data = join(homedir(), '.botmux', 'data');
  mkdirSync(data, { recursive: true });
  const bots = join(root, 'bots.json');
  vi.stubEnv('BOTS_CONFIG', bots);
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'cli_actor', larkAppSecret: 'test-only', cliId: 'antigravity' }]));
  writeFileSync(join(data, 'user-token-cli_actor.json'), JSON.stringify({
    access_token: 'legacy-owner-test-token', token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    scope: 'im:feed_group_v1:read im:feed_group_v1:write', appId: 'cli_actor', brand: 'feishu',
  }));
  loadBotConfigs().forEach(registerBot);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(setChatFeedGroup('cli_actor', 'oc_current', 'ou_operator', null))
    .resolves.toEqual({ ok: false, error: 'user_login_required' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a sender outside the bot allowlist and malformed open ids before any token lookup', async () => {
  root = mkdtempSync(join(tmpdir(), 'chat-label-deny-'));
  const bots = join(root, 'bots.json');
  vi.stubEnv('BOTS_CONFIG', bots);
  writeFileSync(bots, JSON.stringify([{
    larkAppId: 'cli_deny', larkAppSecret: 'test-only', cliId: 'antigravity',
    allowedUsers: ['ou_owner'],
  }]));
  loadBotConfigs().forEach(registerBot);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(setChatFeedGroup('cli_deny', 'oc_current', 'ou_operator', 'p0'))
    .resolves.toEqual({ ok: false, error: 'permission_denied' });
  await expect(setChatFeedGroup('cli_deny', 'oc_current', 'not-an-open-id', 'p0'))
    .resolves.toEqual({ ok: false, error: 'permission_denied' });
  expect(fetchMock).not.toHaveBeenCalled();
});
