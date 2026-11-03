/**
 * Platform credential-grant client: request shape, response validation and
 * failure classification, with the platform faked at the http seam.
 *
 * Run:  npx vitest run --project unit test/credential-grant-client.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  requestCredentialGrant,
  platformCredentialsUrl,
  CREDENTIAL_GRANT_PATH,
  type CredentialGrantClientOptions,
} from '../src/platform/credential-grant-client.js';

const BINDING = { platformUrl: 'https://platform.example.test/', machineToken: 'mt-secret', machineId: 'm-1' };

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ url: string; body: unknown; opts: any }> = [];
  const http: NonNullable<CredentialGrantClientOptions['http']> = {
    post: async (url, body, opts) => {
      calls.push({ url, body, opts });
      const next = responses.shift();
      if (!next) throw new Error('no scripted response');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { calls, http };
}

const REQ = { tool: 'lark-cli' as const, unionId: 'on_alice', appId: 'cli_bot', sessionId: 'sess-1', turnId: 'om_turn' };
const future = () => Date.now() + 3_600_000;

describe('requestCredentialGrant', () => {
  it('is unbound without a platform binding and never calls out', async () => {
    const { calls, http } = fakeHttp([]);
    const r = await requestCredentialGrant(REQ, { binding: null, http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(calls).toHaveLength(0);
    expect(platformCredentialsUrl({ binding: null })).toBeNull();
  });

  it('posts the turn sender, tool and machine with the machine token', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(),
      variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-at' },
    } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.variables).toEqual({ LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-at' });
    expect(calls[0]!.url).toBe(`https://platform.example.test${CREDENTIAL_GRANT_PATH}`);
    expect(calls[0]!.opts.headers.authorization).toBe('Bearer mt-secret');
    expect(calls[0]!.body).toEqual({
      unionId: 'on_alice', tool: 'lark-cli', appId: 'cli_bot', sessionId: 'sess-1', turnId: 'om_turn', machineId: 'm-1',
    });
    expect(platformCredentialsUrl({ binding: BINDING })).toBe('https://platform.example.test/credentials');
  });

  it('accepts the optional Codebase JWT for bytedcli', async () => {
    const { http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(),
      variables: { BYTEDCLI_USER_CLOUD_JWT: 'cloud', BYTEDCLI_USER_CODE_JWT: 'code' },
    } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(r.ok && r.value.variables).toEqual({ BYTEDCLI_USER_CLOUD_JWT: 'cloud', BYTEDCLI_USER_CODE_JWT: 'code' });
  });

  it.each([
    ['extra variables', { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't', PATH: '/evil' }],
    ['missing required', { LARKSUITE_CLI_APP_ID: 'a' }],
    ['newline in value', { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't\nexport X=1' }],
  ])('rejects a lark-cli grant with %s — the platform cannot inject arbitrary env', async (_label, variables) => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(), variables } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it.each([
    ['missing cloud JWT', { BYTEDCLI_USER_CODE_JWT: 'code' }],
    ['lark keys smuggled into a bytedcli grant', { BYTEDCLI_USER_CLOUD_JWT: 'c', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' }],
    ['empty required value', { BYTEDCLI_USER_CLOUD_JWT: '' }],
  ])('rejects a bytedcli grant with %s', async (_label, variables) => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it('accepts a bytedcli grant with only the cloud JWT (Codebase JWT is optional)', async () => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables: { BYTEDCLI_USER_CLOUD_JWT: 'cloud' } } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(r.ok && r.value.variables).toEqual({ BYTEDCLI_USER_CLOUD_JWT: 'cloud' });
  });

  it('passes retryAfterMs through on 429 so callers can back off', async () => {
    const { http } = fakeHttp([{ status: 429, json: { error: 'rate_limited', retryAfterMs: 750 } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason === 'rate_limited' && r.retryAfterMs).toBe(750);
  });

  it.each([
    ['tool mismatch', { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables: {} }],
    ['unionId mismatch', { ok: true, tool: 'lark-cli', unionId: 'on_mallory', expiresAt: future(), variables: {} }],
    ['already expired', { ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: Date.now() - 1, variables: { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' } }],
    ['ok flag missing', { tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(), variables: {} }],
  ])('rejects a 200 with %s', async (_label, json) => {
    const { http } = fakeHttp([{ status: 200, json }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it.each([
    [404, { error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' }, 'not_authorized'],
    [409, { error: 'credential_reauth_required' }, 'not_authorized'],
    [403, { error: 'consent_missing', authorizeUrl: 'https://platform.example.test/credentials' }, 'consent_missing'],
    [403, { error: 'not_teammate' }, 'not_teammate'],
    [403, { error: 'machine_ownership_mismatch' }, 'forbidden'],
    [401, { error: 'invalid_machine_token' }, 'forbidden'],
    [404, {}, 'not_deployed'],
    [429, { error: 'rate_limited', retryAfterMs: 500 }, 'rate_limited'],
    [503, { error: 'store_unavailable' }, 'unavailable'],
    [502, { error: 'provider_unavailable' }, 'unavailable'],
    [400, { error: 'invalid' }, 'client'],
  ])('classifies %s %j as %s', async (status, json, reason) => {
    const { http } = fakeHttp([{ status, json }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
    if (!r.ok && (r.reason === 'not_authorized' || r.reason === 'consent_missing') && (json as any).authorizeUrl) {
      expect(r.authorizeUrl).toBe((json as any).authorizeUrl);
    }
  });

  it('classifies any other 404 (older platform, generic router body) as not_deployed', async () => {
    const { http } = fakeHttp([{ status: 404, json: { error: 'Not Found', message: 'Route POST:/v1/machine/credential-grant not found' } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('not_deployed');
  });

  it('relays authorizeUrl only when it is an https link on the bound platform', async () => {
    const { http } = fakeHttp([
      { status: 404, json: { error: 'credential_not_found', authorizeUrl: 'https://evil.example.test/phish' } },
      { status: 404, json: { error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' } },
    ]);
    const r1 = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r1.ok && r1.reason === 'not_authorized' && r1.authorizeUrl).toBeUndefined();
    const r2 = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r2.ok && r2.reason === 'not_authorized' && r2.authorizeUrl).toBe('https://platform.example.test/credentials');
  });

  it('caps an absurd expiresAt at 24h and refuses an invalid union id before calling out', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: Date.now() + 365 * 24 * 3_600_000,
      variables: { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' },
    } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok && r.value.expiresAt <= Date.now() + 24 * 3_600_000 + 1000).toBe(true);
    const bad = await requestCredentialGrant({ ...REQ, unionId: '' }, { binding: BINDING, http });
    expect(!bad.ok && bad.reason).toBe('client');
    expect(calls).toHaveLength(1);
  });

  it('turns a thrown transport error into network, not an exception', async () => {
    const { http } = fakeHttp([new Error('ECONNREFUSED')]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r).toEqual({ ok: false, reason: 'network', error: 'ECONNREFUSED' });
  });
});
