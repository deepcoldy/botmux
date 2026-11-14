/**
 * Platform credential-request client: request shape and the classification of
 * every platform answer, with the platform faked at the http seam.
 *
 * Run:  npx vitest run --project unit test/credential-request-client.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  requestCredentialAuthorization,
  CREDENTIAL_REQUEST_PATH,
  type CredentialRequestClientOptions,
} from '../src/platform/credential-request-client.js';

const BINDING = { platformUrl: 'https://platform.example.test/', machineToken: 'mt-secret', machineId: 'm-1' };
const REQ = { unionId: 'on_alice', appId: 'cli_bot', tools: ['lark-cli', 'bytedcli'] as const };

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ url: string; body: unknown; opts: any }> = [];
  const http: NonNullable<CredentialRequestClientOptions['http']> = {
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

describe('requestCredentialAuthorization', () => {
  it('is unbound without a platform binding and never calls out', async () => {
    const { calls, http } = fakeHttp([]);
    expect(await requestCredentialAuthorization(REQ, { binding: null, http })).toEqual({ ok: false, reason: 'unbound' });
    expect(calls).toHaveLength(0);
  });

  it('posts the person, bot, tools and machine with the machine token', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: { ok: true, status: 'ready' } }]);
    await requestCredentialAuthorization({ ...REQ, scopes: ['docx:document:readonly'] }, { binding: BINDING, http });
    expect(calls[0]!.url).toBe(`https://platform.example.test${CREDENTIAL_REQUEST_PATH}`);
    expect(calls[0]!.opts.headers.authorization).toBe('Bearer mt-secret');
    expect(calls[0]!.body).toEqual({
      unionId: 'on_alice', appId: 'cli_bot', tools: ['lark-cli', 'bytedcli'], scopes: ['docx:document:readonly'], machineId: 'm-1',
    });
  });

  it('omits scopes when none are given', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: { ok: true, status: 'ready' } }]);
    await requestCredentialAuthorization({ unionId: 'on_alice', appId: 'cli_bot', tools: ['bytedcli'] }, { binding: BINDING, http });
    expect(calls[0]!.body).toEqual({ unionId: 'on_alice', appId: 'cli_bot', tools: ['bytedcli'], machineId: 'm-1' });
  });

  it.each([
    ['ready', { ok: true, status: 'ready' }, { ok: true, status: 'ready' }],
    ['sent', { ok: true, status: 'sent', requestId: 'cr_1', expiresAt: 1 }, { ok: true, status: 'sent', deduped: false }],
    ['deduped sent', { ok: true, status: 'sent', requestId: 'cr_1', deduped: true }, { ok: true, status: 'sent', deduped: true }],
    ['undeliverable', { ok: true, status: 'undeliverable', requestId: 'cr_1', detail: 'no user authority' }, { ok: true, status: 'undeliverable', detail: 'no user authority' }],
  ])('classifies a 200 %s answer as success', async (_label, json, expected) => {
    const { http } = fakeHttp([{ status: 200, json }]);
    expect(await requestCredentialAuthorization(REQ, { binding: BINDING, http })).toEqual(expected);
  });

  it.each([
    ['ok flag missing', { status: 'ready' }],
    ['unknown status', { ok: true, status: 'weird' }],
    ['non-object body', 'text'],
  ])('fails a 200 answer with %s', async (_label, json) => {
    const { http } = fakeHttp([{ status: 200, json }]);
    expect(await requestCredentialAuthorization(REQ, { binding: BINDING, http })).toMatchObject({ ok: false, reason: 'failed' });
  });

  it.each([
    ['any 404', 404, {}, { reason: 'not_deployed' }],
    ['a 404 that names an error', 404, { error: 'credential_not_found' }, { reason: 'not_deployed' }],
    ['429 request_cap', 429, { error: 'request_cap' }, { reason: 'request_cap' }],
    ['429 rate_limited', 429, { error: 'rate_limited' }, { reason: 'failed', detail: 'http 429 rate_limited' }],
    ['403', 403, { error: 'machine_mismatch' }, { reason: 'failed', detail: 'http 403 machine_mismatch' }],
    ['503', 503, { error: 'store_unavailable' }, { reason: 'failed', detail: 'http 503 store_unavailable' }],
  ])('classifies %s', async (_label, status, json, expected) => {
    const { http } = fakeHttp([{ status, json }]);
    expect(await requestCredentialAuthorization(REQ, { binding: BINDING, http })).toEqual({ ok: false, ...expected });
  });

  it('sends one request only after a network error and never throws', async () => {
    const { calls, http } = fakeHttp([new Error('socket hang up'), { status: 200, json: { ok: true, status: 'sent' } }]);
    const r = await requestCredentialAuthorization(REQ, { binding: BINDING, http });
    expect(r).toEqual({ ok: false, reason: 'failed', detail: 'socket hang up' });
    expect(calls).toHaveLength(1);
  });

  it('turns a throwing transport (malformed binding) into a failure', async () => {
    const r = await requestCredentialAuthorization(REQ, { binding: { ...BINDING, platformUrl: 'not a url' } });
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
  });
});
