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
    get: async () => ({ status: 404, json: {} }),
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
  ])('rejects a grant with %s — the platform cannot inject arbitrary env', async (_label, variables) => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(), variables } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('invalid_response');
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
    [404, { error: 'credential_not_found', authorizeUrl: 'https://p/credentials' }, 'not_authorized'],
    [409, { error: 'credential_reauth_required' }, 'not_authorized'],
    [403, { error: 'consent_missing', authorizeUrl: 'https://p/credentials' }, 'consent_missing'],
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

  it('turns a thrown transport error into network, not an exception', async () => {
    const { http } = fakeHttp([new Error('ECONNREFUSED')]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r).toEqual({ ok: false, reason: 'network', error: 'ECONNREFUSED' });
  });
});
