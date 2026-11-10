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

it('uses the sender token and sends page_token on the first directory page, as the live API requires', async () => {
  root = mkdtempSync(join(tmpdir(), 'chat-label-live-'));
  const data = join(homedir(), '.botmux', 'data');
  mkdirSync(data, { recursive: true });
  const bots = join(root, 'bots.json');
  vi.stubEnv('BOTS_CONFIG', bots);
  writeFileSync(bots, JSON.stringify([{
    larkAppId: 'cli_live', larkAppSecret: 'test-only', cliId: 'antigravity', allowedUsers: ['ou_operator'],
  }]));
  writeFileSync(join(data, 'user-token-cli_live-ou_operator.json'), JSON.stringify({
    access_token: 'operator-test-token', token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    scope: 'im:feed_group_v1:read im:feed_group_v1:write', appId: 'cli_live', brand: 'feishu', openId: 'ou_operator',
  }));
  loadBotConfigs().forEach(registerBot);
  const calls: Array<{ method: string; path: string; query: URLSearchParams; authorization: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, authorization: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    if (call.method === 'GET') {
      // Live behavior (docs/plans/2026-09-29-session-close-tag.md): the first page still needs an empty page_token.
      if (!call.query.has('page_token')) return Response.json({ code: 9499, msg: 'Missing required parameter: PageToken' }, { status: 400 });
      return Response.json({ code: 0, data: { groups: [{ group_id: 'ofg_old', name: 'pending', type: 'normal' }], has_more: false } });
    }
    if (call.path === '/open-apis/im/v1/groups') return Response.json({ code: 0, data: { group_id: 'ofg_p1' } });
    return Response.json({ code: 0, data: {} });
  }));
  await expect(setChatFeedGroup('cli_live', 'oc_current', 'ou_operator', 'p1'))
    .resolves.toEqual({ ok: true, chatId: 'oc_current', label: 'p1' });
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
    'GET /open-apis/im/v1/groups',
    'POST /open-apis/im/v1/groups',
    'POST /open-apis/im/v1/groups/ofg_p1/batch_add_item',
    'POST /open-apis/im/v1/groups/ofg_old/batch_remove_item',
  ]);
  expect(calls[0]!.query.get('page_token')).toBe('');
  expect(calls.every(call => call.authorization === 'Bearer operator-test-token')).toBe(true);
});
