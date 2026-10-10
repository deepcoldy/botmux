/** Regression tests for explicit-close personal feed-group migration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionGroupConfig } from '../src/bot-registry.js';

const APP = 'cli_close_test';
const CHAT = 'oc_session_group';
const OWNER = 'ou_birth_owner';
const SESSION = 'session-test';
let tempDir: string;
const h = vi.hoisted(() => ({
  tag: {} as NonNullable<SessionGroupConfig['tag']>,
  token: vi.fn(async (): Promise<string | null> => 'owner-token'),
}));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return tempDir; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/utils/user-token.js', () => ({
  resolveOwnerUserToken: h.token,
  generateAuthUrl: vi.fn(() => ({ authUrl: 'https://auth.example/test' })),
  FEED_GROUP_OAUTH_SCOPES: [],
}));
vi.mock('../src/im/lark/client.js', () => ({ sendUserMessage: vi.fn() }));
vi.mock('../src/i18n/index.js', () => ({ t: (key: string) => key, localeForBot: () => 'zh' }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { larkAppId: 'cli_close_test', larkAppSecret: 'test-secret', sessionGroup: { tag: h.tag } } }),
  effectiveBotDisplayName: () => 'Test bot',
  getBotClient: vi.fn(),
}));
import { tagClosedSessionGroup, tagSessionGroup } from '../src/services/feed-group-tagger.js';
import { initSessionGroups, registerSessionGroup, getSessionGroup, setSessionGroupFeedGroup } from '../src/services/session-groups-store.js';
import { logger } from '../src/utils/logger.js';

interface Call { path: string; query: URLSearchParams; method: string; body: unknown; authorization: string | null }
/** Record real wire requests; create/list reuse reflects the server's state. */
function mockApi(override?: (call: Call) => Response | Promise<Response> | undefined): Call[] {
  const calls: Call[] = [];
  const groups = [{ name: 'Active', group_id: 'ofg_active' }];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      path: new URL(String(input)).pathname,
      query: new URL(String(input)).searchParams,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const response = override?.(call);
    if (response) return response;
    if (call.method === 'GET') {
      // The live API requires page_token even on the first page (empty string).
      if (!call.query.has('page_token')) {
        return Response.json({ code: 9499, msg: 'Missing required parameter: PageToken' }, { status: 400 });
      }
      return Response.json({ code: 0, data: { groups, has_more: false } });
    }
    if (call.path === '/open-apis/im/v1/groups') {
      groups.push({ name: 'Closed', group_id: 'ofg_closed' });
      return Response.json({ code: 0, data: { group_id: 'ofg_closed' } });
    }
    return Response.json({ code: 0, data: { failed_items: [] } });
  }));
  return calls;
}

/** Seed one real, owner-scoped registry entry, as the birth path does. */
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-close-tag-'));
  initSessionGroups(APP);
  registerSessionGroup(CHAT, { ownerOpenId: OWNER, lastSessionId: SESSION });
  setSessionGroupFeedGroup(CHAT, OWNER, 'ofg_active');
  h.tag = { mode: 'feed-group', name: 'Active', closedName: 'Closed' };
  h.token.mockReset().mockResolvedValue('owner-token');
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('tagClosedSessionGroup', () => {
  it.each([false, true])('sends an explicit empty first-page token for lookups (legacy=%s)', async legacy => {
    if (legacy) registerSessionGroup(CHAT, { ownerOpenId: OWNER, lastSessionId: SESSION });
    const calls = mockApi();
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('updated');
    const lookups = calls.filter(c => c.method === 'GET');
    expect(lookups).toHaveLength(legacy ? 2 : 1);
    for (const lookup of lookups) {
      expect(lookup.query.get('page_token')).toBe('');
      expect(lookup.query.get('page_size')).toBe('50');
    }
  });

  it('passes the returned continuation token and reuses the target on the next page', async () => {
    const calls = mockApi(call => {
      if (call.method !== 'GET') return undefined;
      return Response.json({ code: 0, data: call.query.get('page_token') === 'next+page/='
        ? { groups: [{ name: 'Closed', group_id: 'ofg_closed' }], has_more: false, page_token: '' }
        : { groups: [], has_more: true, page_token: 'next+page/=' } });
    });
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('updated');
    expect(calls.filter(c => c.method === 'GET').map(c => c.query.get('page_token'))).toEqual(['', 'next+page/=']);
    expect(calls.some(c => c.method === 'POST' && c.path === '/open-apis/im/v1/groups')).toBe(false);
  });

  it('logs the API error details and does not mutate groups after a failed lookup', async () => {
    const calls = mockApi(call => call.method === 'GET' ? Response.json({
      code: 9499,
      msg: 'Missing required parameter: PageToken',
      error: { log_id: 'test-request-id' },
    }, { status: 400 }) : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    const warning = vi.mocked(logger.warn).mock.calls.flat().join(' ');
    expect(warning).toContain('status=400');
    expect(warning).toContain('code=9499');
    expect(warning).toContain('Missing required parameter: PageToken');
    expect(warning).toContain('log_id=test-request-id');
    expect(warning).not.toContain('owner-token');
    expect(warning).not.toContain('test-secret');
  });

  it('adds the chat to the configured target before removing only its original association', async () => {
    const calls = mockApi();
    expect(await tagClosedSessionGroup(APP, CHAT, SESSION)).toEqual({ status: 'updated', name: 'Closed' });
    expect(h.token).toHaveBeenCalledWith(APP, 'test-secret', 'feishu', OWNER);
    expect(calls.every(c => c.authorization === 'Bearer owner-token')).toBe(true);
    const mutations = calls.filter(c => c.method !== 'GET');
    expect(mutations.map(c => c.path)).toEqual([
      '/open-apis/im/v1/groups',
      '/open-apis/im/v1/groups/ofg_closed/batch_add_item',
      '/open-apis/im/v1/groups/ofg_active/batch_remove_item',
    ]);
    expect(mutations[0].body).toEqual({ feed_group_creator: { type: 'normal', name: 'Closed' } });
    expect(mutations.slice(1).every(c => JSON.stringify(c.body) === JSON.stringify({ items: [{ feed_id: CHAT, feed_type: 'chat' }] }))).toBe(true);
    expect(getSessionGroup(CHAT)?.feedGroupId).toBe('ofg_active');
  });

  it('reuses the same target on repeated close without creating or renaming groups', async () => {
    const calls = mockApi();
    await tagClosedSessionGroup(APP, CHAT, SESSION);
    await tagClosedSessionGroup(APP, CHAT, SESSION);
    expect(calls.filter(c => c.path === '/open-apis/im/v1/groups' && c.method === 'POST')).toHaveLength(1);
    expect(calls.some(c => c.method === 'PUT' || c.method === 'DELETE')).toBe(false);
  });

  it.each([
    { closedName: undefined }, { closedName: '   ' }, { mode: 'off' as const }, { mode: 'chat-tag' as const },
  ])('skips disabled/unsupported config %j', async patch => {
    Object.assign(h.tag, patch);
    const calls = mockApi();
    expect(await tagClosedSessionGroup(APP, CHAT, SESSION)).toEqual({ status: 'skipped' });
    expect(calls).toHaveLength(0);
    expect(h.token).not.toHaveBeenCalled();
  });

  it('ignores ordinary groups and stale sessions', async () => {
    const calls = mockApi();
    expect(await tagClosedSessionGroup(APP, 'oc_ordinary', SESSION)).toEqual({ status: 'skipped' });
    expect(await tagClosedSessionGroup(APP, CHAT, 'stale-session')).toEqual({ status: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('does not remove when active and closed target are the same group', async () => {
    h.tag.closedName = 'Active';
    const calls = mockApi();
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('updated');
    expect(calls.some(c => c.path.includes('batch_remove_item'))).toBe(false);
  });

  it.each([
    { code: 99991672, msg: 'unauthorized' },
    { code: 0, data: { failed_items: [{ error_message: 'rejected' }] } },
  ])('preserves the active association when adding fails: %j', async result => {
    const calls = mockApi(call => call.path.endsWith('batch_add_item') ? Response.json(result) : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(calls.some(c => c.path.includes('batch_remove_item'))).toBe(false);
  });

  it('does not treat a 200 response without an API success code as a successful add', async () => {
    const calls = mockApi(call => call.path.endsWith('batch_add_item') ? new Response('not-json') : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(calls.some(c => c.path.includes('batch_remove_item'))).toBe(false);
  });

  it('reports removal failure separately from the already-completed close', async () => {
    mockApi(call => call.path.endsWith('batch_remove_item') ? Response.json({ code: 230001, msg: 'denied' }) : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(getSessionGroup(CHAT)?.lastSessionId).toBe(SESSION);
  });

  it('a deleted active group is already removed', async () => {
    mockApi(call => call.path.endsWith('batch_remove_item') ? Response.json({ code: 230004 }) : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('updated');
  });

  it('missing owner authorization does not mutate any tag', async () => {
    h.token.mockResolvedValue(null);
    const calls = mockApi();
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('legacy groups resolve their source by name under the birth owner token, not a foreign cached ID', async () => {
    registerSessionGroup(CHAT, { ownerOpenId: OWNER, lastSessionId: SESSION });
    writeFileSync(join(tempDir, `feed-group-cache-${APP}.json`), JSON.stringify({ name: 'Active', groupId: 'ofg_foreign' }));
    const calls = mockApi();
    await tagClosedSessionGroup(APP, CHAT, SESSION);
    expect(calls.some(c => c.path.includes('ofg_foreign'))).toBe(false);
    expect(calls.at(-1)?.path).toContain('/ofg_active/batch_remove_item');
  });

  it('lookup errors fail closed rather than creating a duplicate target', async () => {
    const calls = mockApi(call => call.method === 'GET' ? Response.json({ code: 99991672 }) : undefined);
    expect((await tagClosedSessionGroup(APP, CHAT, SESSION)).status).toBe('failed');
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('waits for birth tagging and records its actual source before migration', async () => {
    registerSessionGroup(CHAT, { ownerOpenId: OWNER, lastSessionId: SESSION });
    let release!: (response: Response) => void;
    const pendingAdd = new Promise<Response>(resolve => { release = resolve; });
    const calls = mockApi(call => call.path === '/open-apis/im/v1/groups/ofg_active/batch_add_item' ? pendingAdd : undefined);
    const birth = tagSessionGroup(APP, CHAT, OWNER);
    await vi.waitFor(() => expect(calls.some(c => c.path.endsWith('batch_add_item'))).toBe(true));
    const before = calls.length;
    const close = tagClosedSessionGroup(APP, CHAT, SESSION);
    await Promise.resolve();
    expect(calls).toHaveLength(before);
    release(Response.json({ code: 0, data: { failed_items: [] } }));
    await birth;
    expect(getSessionGroup(CHAT)?.feedGroupId).toBe('ofg_active');
    expect((await close).status).toBe('updated');
    expect(calls.at(-1)?.path).toContain('/ofg_active/batch_remove_item');
  });
});
