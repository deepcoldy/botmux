/**
 * Bound lark-cli `--as user`: which grant a person gets.
 *
 * The bot app's own grant first (the owner keeps its wider scopes); everyone
 * else can only be served by the platform, because a bot app's availability
 * range normally excludes them. `platform` mode never uses the bot-app grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boundLarkPlatformPolicy,
  platformAuthRequestRedirect,
  resolveBoundLarkUserCredential,
} from '../src/core/lark-tool-platform-credential.js';
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';

const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };
const PAGE = 'https://platform.example.test/credentials';
let bound: boolean;
let grantCalls: any[];
let grantResponse: any;

beforeEach(() => {
  bound = true;
  grantCalls = [];
  grantResponse = { ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: PAGE };
  __setPlatformCredentialDepsForTest({
    readBinding: () => (bound ? BINDING : null),
    resolveUnionId: async () => 'on_person',
    requestGrant: async (req) => { grantCalls.push(req); return grantResponse; },
  });
});
afterEach(() => __setPlatformCredentialDepsForTest(null));

const bot = (triggerUserAuth?: unknown) => ({
  larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu',
  ...(triggerUserAuth === undefined ? {} : { triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) ?? undefined }),
}) as any;
const granted = {
  ok: true,
  value: {
    tool: 'lark-cli', unionId: 'on_person', expiresAt: Date.now() + 3_600_000,
    variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'platform-user-token' },
  },
};
const resolve = (config: any, botAppToken: string | null, delegated = false) => {
  const tokenFn = vi.fn(async (_openId: string) => botAppToken);
  return {
    tokenFn,
    result: resolveBoundLarkUserCredential({ bot: config, openId: 'ou_person', sessionId: 's-1', turnId: 'om_t', delegated, botAppToken: tokenFn }),
  };
};

describe('policy', () => {
  it.each([
    [undefined, 'off'],
    [{ enabled: false, tools: ['lark-cli'] }, 'off'],
    [{ enabled: true, tools: ['bytedcli'] }, 'off'],
    [{ enabled: true, tools: ['lark-cli'], credentialSource: 'local' }, 'off'],
    [{ enabled: true, tools: ['lark-cli'] }, 'prefer-bot-app'],
    [{ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }, 'platform-only'],
  ])('%j → %s', (tua, expected) => {
    expect(boundLarkPlatformPolicy(bot(tua))).toBe(expected);
  });
});

describe('resolveBoundLarkUserCredential', () => {
  it('without trigger-user auth for lark-cli the platform is never asked', async () => {
    const { result } = resolve(bot(), null);
    expect(await result).toEqual({ ok: false, reason: 'bot_app_missing' });
    expect(grantCalls).toHaveLength(0);
  });

  it('auto: a person with a bot-app grant keeps it and the platform is not asked', async () => {
    const { result, tokenFn } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), 'bot-app-token');
    expect(await result).toEqual({ ok: true, appId: 'cli_bot', credential: 'bot-app-token' });
    expect(tokenFn).toHaveBeenCalledExactlyOnceWith('ou_person');
    expect(grantCalls).toHaveLength(0);
  });

  it('auto: a person without a bot-app grant gets the platform grant, marked with its own application', async () => {
    grantResponse = granted;
    const { result } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), null);
    expect(await result).toEqual({ ok: true, appId: 'cli_platform', credential: 'platform-user-token', issuer: 'platform' });
    expect(grantCalls[0]).toMatchObject({ tool: 'lark-cli', unionId: 'on_person', appId: 'cli_bot', sessionId: 's-1', turnId: 'om_t' });
  });

  it('auto on an unbound machine behaves as before', async () => {
    bound = false;
    const { result } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), null);
    expect(await result).toEqual({ ok: false, reason: 'bot_app_missing' });
    expect(grantCalls).toHaveLength(0);
  });

  it('auto: no grant anywhere → a platform refusal that carries the platform page', async () => {
    const { result } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), null);
    const out = await result;
    expect(out).toMatchObject({ ok: false, reason: 'platform', authorizeUrl: PAGE });
    expect(out.ok === false && out.reason === 'platform' && out.error).toContain(PAGE);
  });

  it('platform mode never consults the bot-app grant', async () => {
    grantResponse = granted;
    const { result, tokenFn } = resolve(bot({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), 'bot-app-token');
    expect(await result).toMatchObject({ ok: true, appId: 'cli_platform', issuer: 'platform' });
    expect(tokenFn).not.toHaveBeenCalled();
  });

  it('platform mode on an unbound machine refuses instead of falling back', async () => {
    bound = false;
    const { result, tokenFn } = resolve(bot({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), 'bot-app-token');
    expect(await result).toMatchObject({ ok: false, reason: 'platform' });
    expect(tokenFn).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'denied', error: 'not_teammate' }],
    [{ ok: false, reason: 'unavailable', error: 'network' }],
    [{ ok: false, reason: 'consent_missing', error: 'consent_missing', authorizeUrl: PAGE }],
  ])('every platform refusal is final and never turns into a bot-app credential: %j', async (response) => {
    grantResponse = response;
    const { result } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), null);
    const out = await result;
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ reason: 'platform' });
  });

  it('a granted resolution of the wrong tool is refused as final, not as a transient outage', async () => {
    const platformSource = await import('../src/core/platform-credential-source.js');
    const spy = vi.spyOn(platformSource, 'resolvePlatformIdentity').mockResolvedValue(
      { state: 'granted', identity: { tool: 'bytedcli', cloudJwt: 'x' }, expiresAt: Date.now() + 1000 } as any);
    try {
      const out = await resolve(bot({ enabled: true, tools: ['lark-cli'] }), null).result;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ ok: false, reason: 'platform' });
      expect(out).not.toHaveProperty('authorizeUrl');
      expect(out.ok === false && out.reason === 'platform' && out.error).not.toMatch(/temporarily|retry later/i);
    } finally { spy.mockRestore(); }
  });

  it('a malformed platform grant is not used', async () => {
    grantResponse = { ...granted, value: { ...granted.value, variables: { LARKSUITE_CLI_APP_ID: 'cli_platform' } } };
    const { result } = resolve(bot({ enabled: true, tools: ['lark-cli'] }), null);
    expect((await result).ok).toBe(false);
  });
});

describe('platformAuthRequestRedirect', () => {
  const redirect = (config: any, botAppToken: string | null) =>
    platformAuthRequestRedirect({ bot: config, openId: 'ou_person', delegated: false,
      botAppToken: async openId => (openId === 'ou_person' ? botAppToken : 'WRONG_PERSON') });

  it('leaves the bot-app flow alone when the platform does not apply', async () => {
    expect(await redirect(bot(), null)).toBeNull();
    expect(await redirect(bot({ enabled: true, tools: ['lark-cli'], credentialSource: 'local' }), null)).toBeNull();
  });

  it('auto: a person who already holds a bot-app grant can still extend it there', async () => {
    expect(await redirect(bot({ enabled: true, tools: ['lark-cli'] }), 'bot-app-token')).toBeNull();
  });

  it('auto: a person without one is sent to the platform page', async () => {
    const out = await redirect(bot({ enabled: true, tools: ['lark-cli'] }), null);
    expect(out).toMatchObject({ authorizeUrl: PAGE });
    expect(out?.error).toContain(PAGE);
  });

  it('auto on an unbound machine keeps the bot-app flow', async () => {
    bound = false;
    expect(await redirect(bot({ enabled: true, tools: ['lark-cli'] }), null)).toBeNull();
  });

  it('platform mode always redirects, and says so when the machine is unbound', async () => {
    expect(await redirect(bot({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), 'bot-app-token'))
      .toMatchObject({ authorizeUrl: PAGE });
    bound = false;
    const out = await redirect(bot({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), 'bot-app-token');
    expect(out).not.toBeNull();
    expect(out?.authorizeUrl).toBeUndefined();
  });
});
