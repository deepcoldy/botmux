import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ config: { larkAppId: 'cli_runtime_probe', larkAppSecret: 'secret', brand: 'feishu', ownerGroupFollow: { enabled: true } }, owner: 'ou_owner', token: vi.fn(async (_app: string, _secret: string, _brand: string, _owner: string, _signal?: AbortSignal) => 'owner-token'), bound: vi.fn(), ask: vi.fn(async (_args: unknown): Promise<any> => ({ kind: 'sent', deduped: false })), botList: vi.fn(), notify: vi.fn(async (..._args: any[]) => {}) }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: mocks.config }), getOwnerOpenId: () => mocks.owner, getBotClient: () => ({}) }));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: mocks.token }));
vi.mock('../src/core/lark-tool-platform-credential.js', () => ({ resolveBoundLarkUserCredential: mocks.bound, platformIncrementalAuthorizeUrl: (page: string) => page }));
vi.mock('../src/core/platform-authorization-request.js', () => ({ askPlatformToAuthorize: mocks.ask }));
vi.mock('../src/core/platform-credential-source.js', () => ({ platformAuthorizeUrl: () => 'https://platform.example/credentials' }));
vi.mock('../src/im/lark/lark-get.js', () => ({ larkGet: mocks.botList }));
vi.mock('../src/im/lark/client.js', () => ({ sendUserMessage: mocks.notify }));
import { startOwnerGroupFollow, callOwnerFollowApi } from '../src/services/owner-group-follow-runtime.js';
import { OwnerGroupFollowStore } from '../src/services/owner-group-follow-store.js';
import { notifyOwnerGroupFollowChanged } from '../src/services/owner-group-follow-policy.js';
let dir: string, stop: (() => void) | undefined, owners: string[], inviteBody: any;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); dir = mkdtempSync(join(tmpdir(), 'follow-runtime-test-'));
  mocks.config.ownerGroupFollow = { enabled: true };
  mocks.owner = 'ou_owner';
  owners = ['oc_old']; inviteBody = { code: 0, data: {} }; mocks.bound.mockReset(); mocks.ask.mockReset().mockResolvedValue({ kind: 'sent', deduped: false }); mocks.notify.mockClear(); mocks.token.mockClear();
  mocks.bound.mockImplementation(async input => ({ ok: true, credential: await input.botAppToken(input.openId), appId: input.bot.larkAppId }));
  mocks.botList.mockReset();
  mocks.botList.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { expect(JSON.parse(init.body as string)).toEqual({ id_list: ['cli_runtime_probe'] }); return new Response(JSON.stringify(inviteBody)); }
    expect(init.headers).toMatchObject({ Authorization: 'Bearer owner-token' });
    return new Response(JSON.stringify({ code: 0, data: { items: owners.map(chat_id => ({ chat_id })), has_more: false } }));
  }));
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const start = async () => { const f = startOwnerGroupFollow(mocks.config.larkAppId, dir); stop = f.stop; await settle(); };
const scan = async () => { await vi.advanceTimersByTimeAsync(65000); await settle(); };
const store = () => new OwnerGroupFollowStore(dir, mocks.config.larkAppId);
describe('owner follow runtime API boundaries', () => {
  it('makes no credential or group requests while the setting is off', async () => {
    mocks.config.ownerGroupFollow = { enabled: false };
    await start(); await scan();
    expect(mocks.bound).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.botList).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('points a platform-issued token permission failure back to the platform', async () => {
    mocks.bound.mockResolvedValue({ ok: true, credential: 'owner-token', appId: 'cli_platform', issuer: 'platform' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 99991672 }))));
    await start();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.ask).toHaveBeenCalledWith(expect.objectContaining({ openId: 'ou_owner', scopes: ['im:chat:read', 'im:chat.members:write_only', 'offline_access'] }));
    expect(mocks.notify.mock.calls[0]?.[2]).not.toContain('https://platform.example/credentials');
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('uses exactly the current owner with the managed resolver and fresh local user token', async () => {
    await start(); owners.push('oc_new'); await scan();
    expect(mocks.bound.mock.calls.every(([input]) => input.openId === 'ou_owner' && input.delegated === false && input.sessionId === 'owner-group-follow:cli_runtime_probe')).toBe(true);
    expect(mocks.token.mock.calls.every(call => call[3] === 'ou_owner' && call[0] === 'cli_runtime_probe')).toBe(true);
    expect(store().read()?.entries.oc_new.status).toBe('joined');
  });
  it.each(['envelope', 'sdk-exception'] as const)('does not request user authorization to repair a bot application permission failure (%s)', async shape => {
    mocks.bound.mockResolvedValue({ ok: true, credential: 'owner-token', appId: 'cli_platform', issuer: 'platform' });
    if (shape === 'envelope') mocks.botList.mockResolvedValue({ code: 99991672 });
    else mocks.botList.mockRejectedValue(Object.assign(new Error('HTTP 403'), { response: { status: 403, data: { code: 99991672 } } }));
    await start();
    expect(mocks.ask).not.toHaveBeenCalled(); expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(store().read()?.initialized).toBe(false);
  });
  it('successful HTTP envelope with nonexistent app IDs must stop and notify as permanent failure', async () => {
    inviteBody = { code: 0, data: { not_existed_id_list: ['cli_runtime_probe'] } };
    await start(); owners.push('oc_new'); await scan();
    expect(store().read()?.entries.oc_new.status).toBe('failed'); expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
  it('pending approval is not actual membership or a removal on the next scan', async () => {
    inviteBody = { code: 0, data: { pending_approval_id_list: ['cli_runtime_probe'] } };
    await start(); owners.push('oc_new'); await scan(); await scan();
    expect(store().read()?.entries.oc_new.status).toBe('approval');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]?.[2]).toContain('https://');
    expect(mocks.notify.mock.calls[0]?.[2]).not.toContain('](');
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    mocks.botList.mockResolvedValue({ code: 0, data: { items: [{ chat_id: 'oc_new' }], has_more: false } });
    await scan(); expect(store().read()?.entries.oc_new.status).toBe('joined');
  });
  it('platform-only refusal requests a private platform authorization card', async () => {
    mocks.bound.mockResolvedValue({ ok: false, reason: 'platform', error: 'This user has not authorized lark-cli on the botmux platform. Do not ask them to authorize the bot application. [reason=platform_not_authorized]', authorizeUrl: 'https://platform.example/credentials' });
    await start(); await scan(); expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]?.[2]).not.toContain('https://platform.example/credentials');
  });
  it('revalidates the owner through beforeWrite after a queued notification wait', async () => {
    mocks.bound.mockResolvedValue({ ok: false, reason: 'bot_app_missing' });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const delivered = vi.fn();
    mocks.notify.mockImplementationOnce(async (...args: any[]) => {
      started(); await gate;
      await args[6]?.beforeWrite?.();
      delivered(args[1]);
    });
    await start(); await entered;
    mocks.owner = 'ou_new_owner';
    notifyOwnerGroupFollowChanged(mocks.config.larkAppId);
    release(); await settle();
    expect(delivered).not.toHaveBeenCalled();
  });
  it.each([{ name: 'null', body: null }, { name: 'object without code', body: {} }])('keeps a malformed 2xx $name invitation response in the unknown-outcome claim window', async ({ body }) => {
    inviteBody = body;
    await start(); owners.push('oc_new'); await scan();
    expect(store().read()?.entries.oc_new).toMatchObject({ status: 'inviting', attempts: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
    await scan();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    await scan();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(store().read()?.entries.oc_new).toMatchObject({ status: 'inviting', attempts: 2 });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('documented same-chat concurrency error remains retryable', async () => {
    inviteBody = { code: 232019, data: {} };
    await expect(callOwnerFollowApi('https://open.feishu.cn', 'owner-token', '/open-apis/im/v1/chats/oc_new/members', new AbortController().signal, { id_list: ['cli_runtime_probe'] })).rejects.toMatchObject({ retryable: true });
  });
});
