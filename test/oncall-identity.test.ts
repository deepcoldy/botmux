import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bot: { brand: 'feishu', oncallGroup: { identitySource: 'bot' } }, sender: vi.fn(), request: vi.fn(), clients: vi.fn(),
}));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: mocks.bot }) }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ DefaultCache: class {}, Client: class {
  request = mocks.request;
  constructor(settings: unknown) { mocks.clients(settings); }
} }));
import { resolveOncallUsername } from '../src/im/lark/oncall-identity.js';
import { normalizeOncallGroupPolicy } from '../src/services/oncall-group-policy.js';

const target = { endpoint: 'https://example.test/chat/', tenantId: 1, emailDomain: 'example.test' };
const operator = { open_id: 'ou_business_app', user_id: 'tenant_user', tenant_key: 'tenant_a' };
let generation = 0;
let deployment: NodeJS.ProcessEnv;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.bot.brand = 'feishu'; mocks.bot.oncallGroup.identitySource = 'shared';
  deployment = { ONCALL_IDENTITY_APP_ID: 'cli_directory', ONCALL_IDENTITY_APP_SECRET: `secret-${++generation}` };
  mocks.sender.mockResolvedValue({ email: 'own@example.test' });
  mocks.request.mockImplementation(async ({ url }) => url.includes('/tenant/')
    ? { code: 0, data: { tenant: { tenant_key: 'tenant_a' } } }
    : { code: 0, data: { user: { user_id: 'tenant_user', email: 'employee@example.test' } } });
});

describe('Oncall identity sources', () => {
  it('retains the current-bot path for existing policies and accepts both configured modes', async () => {
    mocks.bot.oncallGroup = {} as any;
    expect(await resolveOncallUsername('app', operator, target, deployment)).toBe('own');
    expect(mocks.sender).toHaveBeenCalledWith('app', operator.open_id, 'user');
    expect(mocks.clients).not.toHaveBeenCalled();
    for (const identitySource of ['bot', 'shared']) expect(normalizeOncallGroupPolicy({ identitySource })).toMatchObject({ identitySource });
    expect(() => normalizeOncallGroupPolicy({ identitySource: 'unknown' })).toThrow();
  });
  it('uses only the callback tenant user ID with the shared app, retaining its token client until credentials rotate', async () => {
    expect(await resolveOncallUsername('app', operator, target, deployment)).toBe('employee');
    expect(await resolveOncallUsername('app', operator, target, deployment)).toBe('employee');
    expect(mocks.clients).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.filter(([request]) => request.url.includes('/tenant/'))).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET',
      url: '/open-apis/contact/v3/users/tenant_user', params: { user_id_type: 'user_id' } }));
    expect(mocks.sender).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain('ou_business_app');
    await resolveOncallUsername('app', operator, target, { ...deployment, ONCALL_IDENTITY_APP_SECRET: 'rotated' });
    expect(mocks.clients).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls.filter(([request]) => request.url.includes('/tenant/'))).toHaveLength(2);
  });
  it('rejects missing callback identity and platform mismatch before contacting the directory', async () => {
    for (const actor of [{ open_id: operator.open_id }, { ...operator, user_id: 'ou_foreign' }, { ...operator, tenant_key: '' }]) {
      await expect(resolveOncallUsername('app', actor, target, deployment)).rejects.toThrow('回调');
    }
    await expect(resolveOncallUsername('app', operator, target, {})).rejects.toThrow('尚未配置');
    await expect(resolveOncallUsername('app', operator, target, { ...deployment, ONCALL_IDENTITY_BRAND: 'lark' })).rejects.toThrow('平台不一致');
    expect(mocks.clients).not.toHaveBeenCalled();
  });
  it('does not query a user or fall back to a display identity when the shared app belongs to another tenant', async () => {
    await expect(resolveOncallUsername('app', { ...operator, tenant_key: 'tenant_b' }, target, deployment)).rejects.toThrow('不在同一租户');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.sender).not.toHaveBeenCalled();
  });
  it('does not leak SDK errors or cache failed profiles, so a corrected grant can be retried immediately', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Axios private-secret user@example.test'));
    await expect(resolveOncallUsername('app', operator, target, deployment)).rejects.toThrow('统一身份查询失败');
    expect(await resolveOncallUsername('app', operator, target, deployment)).toBe('employee');
    mocks.request.mockResolvedValueOnce({ code: 41050, msg: 'private-directory-detail' });
    const error = await resolveOncallUsername('app', operator, target, deployment).catch(error => error);
    expect(error.message).toContain('全员通讯录');
    expect(error.message).not.toContain('private');
    expect(await resolveOncallUsername('app', operator, target, deployment)).toBe('employee');
  });
  it('rejects a mismatched user response, missing email and an email outside the configured domain', async () => {
    await resolveOncallUsername('app', operator, target, deployment);
    for (const user of [{ user_id: 'another_user', email: 'employee@example.test' }, { user_id: operator.user_id }, { user_id: operator.user_id, email: 'employee@other.test' }]) {
      mocks.request.mockResolvedValueOnce({ code: 0, data: { user } });
      await expect(resolveOncallUsername('app', operator, target, deployment)).rejects.toThrow();
    }
  });
});
