/**
 * What botmux does when the bytedcli wrapper reports that a command needs the
 * person's own Meego / ByteCloud login: it delivers the link itself and tells
 * the agent only what happened. The agent's message never carries the link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthLinkDelivery } from '../src/core/auth-link-delivery.js';
import {
  __providerAuthTrackedForTest, __resetProviderAuthForTest, LINK_RESEND_MS, requestProviderAuth, type ProviderAuthDeps,
} from '../src/core/provider-auth-request.js';
import type { MeegoLoginRequest } from '../src/services/meego-auth.js';

const MEEGO_URL = 'https://meego.example/device?code=M1';
const BYTED_URL = 'https://sso.example/device?user_code=B1';

let clock: number;
let meego: MeegoLoginRequest;
let delivery: AuthLinkDelivery;
let deps: ProviderAuthDeps & { deliver: ReturnType<typeof vi.fn> };

beforeEach(() => {
  __resetProviderAuthForTest();
  clock = 1_000_000;
  meego = { state: 'link', authUrl: MEEGO_URL };
  delivery = 'dm';
  deps = {
    requestMeegoLogin: vi.fn(async () => meego),
    bytedcliAuthorized: vi.fn(async () => false as boolean | 'unknown'),
    beginBytedcliLogin: vi.fn(async () => ({ authUrl: BYTED_URL })),
    deliver: vi.fn(async () => delivery),
    now: () => clock,
  };
});

const ask = (provider: 'meego' | 'bytedcli', openId = 'ou_alice', more: { chatId?: string; tenant?: 'dcar' } = {}) =>
  requestProviderAuth({ provider, openId, locale: 'zh', chatId: 'oc_topic', ...more }, deps);

describe('requestProviderAuth — Meego', () => {
  it('logged in: ready, nothing sent', async () => {
    meego = { state: 'ready' };
    expect((await ask('meego')).status).toBe('ready');
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('needs a login: botmux delivers the link; the agent hears only that it went out', async () => {
    const r = await ask('meego');
    expect(r).toMatchObject({ status: 'delivered', delivery: 'dm' });
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    const [text, command] = deps.deliver.mock.calls[0];
    expect(text).toContain(MEEGO_URL);
    expect(command).toBe('/login meego');
    expect(r.message).not.toContain(MEEGO_URL);
    expect(r.message).not.toMatch(/https?:\/\//);
  });

  it('a burst of refused commands sends the link once; it goes again after a while', async () => {
    await ask('meego');
    const again = await ask('meego');
    expect(again.status).toBe('pending');
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    clock += LINK_RESEND_MS;
    expect((await ask('meego')).status).toBe('delivered');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
  });

  it('a new link (the old one expired) goes out at once', async () => {
    await ask('meego');
    meego = { state: 'link', authUrl: 'https://meego.example/device?code=M2' };
    expect((await ask('meego')).status).toBe('delivered');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
  });

  it('DM and private card both fail: undeliverable, and the group is not told again on every retry', async () => {
    delivery = 'dm_failed';
    const first = await ask('meego');
    expect(first).toMatchObject({ status: 'undeliverable', delivery: 'dm_failed' });
    expect(first.message).not.toContain(MEEGO_URL);
    const retry = await ask('meego');
    expect(retry).toMatchObject({ status: 'undeliverable', delivery: 'dm_failed' });
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it('the private card counts as delivered', async () => {
    delivery = 'ephemeral';
    expect(await ask('meego')).toMatchObject({ status: 'delivered', delivery: 'ephemeral' });
    expect((await ask('meego')).status).toBe('pending');
  });

  it('one person\'s pending link never holds back another person\'s', async () => {
    await ask('meego', 'ou_alice');
    await ask('meego', 'ou_bob');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    expect(deps.requestMeegoLogin).toHaveBeenNthCalledWith(1, 'ou_alice', undefined);
    expect(deps.requestMeegoLogin).toHaveBeenNthCalledWith(2, 'ou_bob', undefined);
  });

  it('the link sent for one conversation does not silence another one', async () => {
    await ask('meego', 'ou_alice', { chatId: 'oc_topic' });
    expect((await ask('meego', 'ou_alice', { chatId: 'oc_other_group' })).status).toBe('delivered');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    expect((await ask('meego', 'ou_alice', { chatId: 'oc_topic' })).status).toBe('pending');
  });

  it('the fallback command names the tenant, so a dcar user is pointed at the right login', async () => {
    await ask('meego', 'ou_alice', { tenant: 'dcar' });
    expect(deps.deliver.mock.calls[0]![1]).toBe('/login meego dcar');
    await ask('meego', 'ou_bob');
    expect(deps.deliver.mock.calls[1]![1]).toBe('/login meego');
  });

  it('asks for the tenant the command runs under, and tracks each tenant\'s link apart', async () => {
    await ask('meego');
    meego = { state: 'link', authUrl: MEEGO_URL };
    expect((await ask('meego', 'ou_alice', { tenant: 'dcar' })).status).toBe('delivered');
    expect(deps.requestMeegoLogin).toHaveBeenLastCalledWith('ou_alice', 'dcar');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
  });

  it('links sent long ago are forgotten, so a long-running daemon does not pile them up', async () => {
    await ask('meego', 'ou_alice', { chatId: 'oc_a' });
    await ask('meego', 'ou_bob', { chatId: 'oc_b' });
    expect(__providerAuthTrackedForTest()).toBe(2);
    clock += LINK_RESEND_MS;
    await ask('meego', 'ou_carol', { chatId: 'oc_c' });
    expect(__providerAuthTrackedForTest()).toBe(1);
  });

  it('provider down: unavailable, nothing sent', async () => {
    meego = { state: 'unavailable', detail: 'Meego status could not be read; retry shortly.' };
    expect((await ask('meego')).status).toBe('unavailable');
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});

describe('requestProviderAuth — ByteCloud', () => {
  it('authorized meanwhile: ready, no new login started', async () => {
    deps.bytedcliAuthorized = vi.fn(async () => true);
    expect((await ask('bytedcli')).status).toBe('ready');
    expect(deps.beginBytedcliLogin).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('not authorized: the link goes to the person, with /login bytedcli as the private fallback', async () => {
    const r = await ask('bytedcli');
    expect(r.status).toBe('delivered');
    const [text, command] = deps.deliver.mock.calls[0];
    expect(text).toContain(BYTED_URL);
    expect(command).toBe('/login bytedcli');
    expect(r.message).not.toContain(BYTED_URL);
  });

  it('a login that cannot be started is unavailable', async () => {
    deps.beginBytedcliLogin = vi.fn(async () => null);
    expect((await ask('bytedcli')).status).toBe('unavailable');
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('Meego and ByteCloud links are tracked separately', async () => {
    await ask('meego');
    expect((await ask('bytedcli')).status).toBe('delivered');
    expect(deps.deliver).toHaveBeenCalledTimes(2);
  });
});
