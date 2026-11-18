import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({
  config: { larkAppId: 'cli_follow_auth', larkAppSecret: 'secret', brand: 'feishu',
    triggerUserAuth: { enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }, ownerGroupFollow: { enabled: true } },
  owner: 'ou_owner',
  notify: vi.fn(async (_app: string, _owner: string, _content: string) => {}),
  grant: vi.fn(), request: vi.fn(),
}));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: mocks.config }), getOwnerOpenId: () => mocks.owner, getBotClient: () => ({}) }));
vi.mock('../src/im/lark/client.js', () => ({ sendUserMessage: mocks.notify, resolveUnionIdFromOpenId: async () => 'on_owner' }));
vi.mock('../src/platform/credential-request-client.js', () => ({ requestCredentialAuthorization: mocks.request }));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: async () => { throw new Error('platform-only must not consult local'); } }));
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';
import { __resetPlatformAuthorizationRequestForTest } from '../src/core/platform-authorization-request.js';
import { startOwnerGroupFollow } from '../src/services/owner-group-follow-runtime.js';
import { notifyOwnerGroupFollowChanged } from '../src/services/owner-group-follow-policy.js';

let dir: string, stop: (() => void) | undefined;
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'owner-follow-platform-'));
  mocks.owner = 'ou_owner'; mocks.config.brand = 'feishu'; mocks.config.ownerGroupFollow.enabled = true;
  mocks.notify.mockClear(); mocks.request.mockReset().mockResolvedValue({ ok: true, status: 'sent', deduped: false });
  mocks.grant.mockReset().mockResolvedValue({ ok: false, reason: 'not_authorized', error: 'grant missing', authorizeUrl: 'https://platform.example/credentials' });
  __resetPlatformAuthorizationRequestForTest();
  __setPlatformCredentialDepsForTest({
    readBinding: () => ({ platformUrl: 'https://platform.example', machineToken: 'test-machine', machineId: 'machine-test' }),
    resolveUnionId: async () => 'on_owner', requestGrant: mocks.grant,
  });
});
afterEach(() => {
  stop?.(); stop = undefined; __setPlatformCredentialDepsForTest(null); __resetPlatformAuthorizationRequestForTest();
  vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
});
async function start() { stop = startOwnerGroupFollow('cli_follow_auth', dir).stop; await settle(); }

describe('owner follow with the real platform resolver and authorization request', () => {
  it('sends a private authorization card for the configured owner and exact required scopes', async () => {
    await start(); await vi.advanceTimersByTimeAsync(65_000); await settle();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith({ unionId: 'on_owner', appId: 'cli_follow_auth', tools: ['lark-cli'],
      scopes: ['im:chat.members:write_only', 'im:chat:read', 'offline_access'] });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2]).not.toContain('https://');
  });
  it.each(['ready', 'undeliverable'] as const)('reports the actual platform outcome %s without relaying a link', async status => {
    mocks.request.mockResolvedValue({ ok: true, status, deduped: false }); await start();
    expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2]).not.toContain('https://');
  });
  it.each(['request_cap', 'failed'] as const)('does not claim a card was delivered for %s', async reason => {
    mocks.request.mockResolvedValue({ ok: false, reason, detail: 'not delivered' }); await start();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2]).not.toContain('https://');
  });
  it('uses an incremental authorization link only for the legacy platform endpoint', async () => {
    mocks.request.mockResolvedValue({ ok: false, reason: 'not_deployed' }); await start();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const text = mocks.notify.mock.calls[0][2];
    const link = /(https:\/\/\S+)/.exec(text)![1];
    expect(new URL(link).origin).toBe('https://platform.example');
    expect(new URL(link).searchParams.get('scope')?.split(' ')).toEqual(['im:chat:read', 'im:chat.members:write_only', 'offline_access']);
  });
  it('does not ask for an authorization card when the platform is unavailable', async () => {
    mocks.grant.mockResolvedValue({ ok: false, reason: 'failed', detail: 'network unavailable' }); await start();
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2]).not.toContain('https://');
  });
  it('stops the notice when the feature is disabled while card delivery awaits', async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await start(); expect(mocks.request).toHaveBeenCalledTimes(1);
    mocks.config.ownerGroupFollow.enabled = false; finish({ ok: true, status: 'sent', deduped: false }); await settle();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('drops a late authorization notice after the daemon service stops', async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await start(); expect(mocks.request).toHaveBeenCalledTimes(1); stop!();
    finish({ ok: true, status: 'sent', deduped: false }); await settle();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('drops an old authorization notice after the setting is switched off and on', async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await start();
    mocks.config.ownerGroupFollow.enabled = false; notifyOwnerGroupFollowChanged('cli_follow_auth');
    mocks.config.ownerGroupFollow.enabled = true; notifyOwnerGroupFollowChanged('cli_follow_auth');
    finish({ ok: true, status: 'sent', deduped: false }); await settle();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('drops an old-brand authorization notice after the brand changes', async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await start(); mocks.config.brand = 'lark'; notifyOwnerGroupFollowChanged('cli_follow_auth');
    finish({ ok: true, status: 'sent', deduped: false }); await settle();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
