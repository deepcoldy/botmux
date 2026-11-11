import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@larksuiteoapi/node-sdk';
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: { brand: 'feishu', oncallGroup: { identitySource: 'shared' } } }) }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: vi.fn() }));
import { resolveOncallUsername } from '../src/im/lark/oncall-identity.js';
const target = { endpoint: 'https://example.test/chat/', tenantId: 1, emailDomain: 'example.test' };
const operator = { open_id: 'ou_real', user_id: 'real', tenant_key: 'same_tenant' };
const tokens: string[] = [];
let tokenPost: any;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); tokens.length = 0;
  tokenPost = vi.spyOn(sdk.defaultHttpInstance, 'post').mockImplementation(async (_url: any, body: any) => ({ tenant_access_token: `token-${body.app_secret}`, expire: 7200 }) as any);
  vi.spyOn(sdk.defaultHttpInstance, 'request').mockImplementation(async (request: any) => {
    tokens.push(request.headers.Authorization);
    return request.url.includes('/tenant/') ? { code: 0, data: { tenant: { tenant_key: 'same_tenant' } } }
      : { code: 0, data: { user: { user_id: 'real', email: 'real@example.test' } } };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Oncall identity SDK credential cache', () => {
  it('rejects an incomplete credential tuple before exchanging any token', async () => {
    await expect(resolveOncallUsername('app', operator, target, { ONCALL_IDENTITY_APP_ID: 'cli_half' })).rejects.toThrow('尚未配置');
    expect(tokenPost).not.toHaveBeenCalled();
  });
  it('keeps a late old token exchange from replacing the current credential generation cache', async () => {
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    tokenPost.mockImplementation(async (_url: any, body: any) => {
      if (body.app_secret === 'pending_old') { entered(); await gate; }
      return { tenant_access_token: `token-${body.app_secret}`, expire: 7200 };
    });
    const oldEnv = { ONCALL_IDENTITY_APP_ID: 'cli_identity_overlap_test', ONCALL_IDENTITY_APP_SECRET: 'pending_old' };
    const old = resolveOncallUsername('app', operator, target, oldEnv);
    await waiting;
    const nextEnv = { ...oldEnv, ONCALL_IDENTITY_APP_SECRET: 'current_new' };
    expect(await resolveOncallUsername('app', operator, target, nextEnv)).toBe('real');
    release(); expect(await old).toBe('real');
    expect(await resolveOncallUsername('app', operator, target, nextEnv)).toBe('real');
    expect(tokens.at(-1)).toBe('Bearer token-current_new');
    expect(tokenPost.mock.calls.map(([, body]: any) => body.app_secret)).toEqual(['pending_old', 'current_new']);
  });

  it('uses the replacement secret immediately while old tenant token remains valid', async () => {
    const env = { ONCALL_IDENTITY_APP_ID: 'cli_identity_rotation_test', ONCALL_IDENTITY_APP_SECRET: 'old_secret' };
    expect(await resolveOncallUsername('app', operator, target, env)).toBe('real');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await resolveOncallUsername('app', operator, target, { ...env, ONCALL_IDENTITY_APP_SECRET: 'new_secret' })).toBe('real');
    expect(tokenPost.mock.calls.map(([, body]: any) => body.app_secret)).toEqual(['old_secret', 'new_secret']);
    expect(tokens.at(-1)).toBe('Bearer token-new_secret');
  });
});
