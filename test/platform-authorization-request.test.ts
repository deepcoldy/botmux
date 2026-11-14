/**
 * askPlatformToAuthorize: which tools one card covers, how the platform's
 * answer maps, and that bursts of refusals send one request.
 *
 * Run:  npx vitest run --project unit test/platform-authorization-request.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  askPlatformToAuthorize,
  __resetPlatformAuthorizationRequestForTest,
} from '../src/core/platform-authorization-request.js';
import { LINK_RESEND_MS } from '../src/core/provider-auth-request.js';
import type { CredentialRequest, CredentialRequestResult } from '../src/platform/credential-request-client.js';

const bot = (capabilities: string[]) => ({
  larkAppId: 'cli_bot',
  triggerUserAuth: { enabled: true, capabilities },
}) as any;

function setup(results: CredentialRequestResult[] = [{ ok: true, status: 'sent', deduped: false }]) {
  const requests: CredentialRequest[] = [];
  let at = 1_000_000;
  const deps = {
    request: vi.fn(async (req: CredentialRequest) => { requests.push(req); return results.length > 1 ? results.shift()! : results[0]!; }),
    unionIdFor: vi.fn(async () => 'on_alice' as string | null),
    now: () => at,
  };
  return { requests, deps, advance: (ms: number) => { at += ms; } };
}

beforeEach(() => __resetPlatformAuthorizationRequestForTest());

describe('askPlatformToAuthorize', () => {
  it('asks for every platform-backed governed tool, not only the refused one', async () => {
    const { requests, deps } = setup();
    await askPlatformToAuthorize({ botConfig: bot(['lark-user', 'bytecloud', 'meego']), openId: 'ou_a' }, deps);
    expect(requests).toEqual([{ unionId: 'on_alice', appId: 'cli_bot', tools: ['lark-cli', 'bytedcli'] }]);
  });

  it('leaves out a tool whose capability is off, and passes scopes through', async () => {
    const { requests, deps } = setup();
    await askPlatformToAuthorize({
      botConfig: bot(['bytecloud']), openId: 'ou_a', scopes: ['b:x', 'a:y', 'a:y'],
    }, deps);
    expect(requests[0]).toMatchObject({ tools: ['bytedcli'], scopes: ['a:y', 'b:x'] });
  });

  it('uses a union id it was given instead of looking the open id up', async () => {
    const { requests, deps } = setup();
    await askPlatformToAuthorize({ botConfig: bot(['lark-user']), unionId: 'on_given' }, deps);
    expect(deps.unionIdFor).not.toHaveBeenCalled();
    expect(requests[0]!.unionId).toBe('on_given');
  });

  it('is unavailable, and sends nothing, when the union id cannot be resolved', async () => {
    const { requests, deps } = setup();
    deps.unionIdFor.mockResolvedValue(null);
    const r = await askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
    expect(r).toEqual({ kind: 'unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('remembers an undeliverable or capped answer for the resend interval and marks the repeat', async () => {
    const { requests, deps, advance } = setup([{ ok: true, status: 'undeliverable', detail: 'x' }]);
    const ask = () => askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
    expect(await ask()).toEqual({ kind: 'undeliverable' });
    for (let i = 0; i < 4; i++) expect(await ask()).toEqual({ kind: 'undeliverable', repeat: true });
    expect(requests).toHaveLength(1);
    advance(LINK_RESEND_MS + 1);
    expect(await ask()).toEqual({ kind: 'undeliverable' });
    expect(requests).toHaveLength(2);
  });

  it.each([
    [{ ok: true, status: 'sent', deduped: false }, { kind: 'sent', deduped: false }],
    [{ ok: true, status: 'sent', deduped: true }, { kind: 'sent', deduped: true }],
    [{ ok: true, status: 'ready' }, { kind: 'ready' }],
    [{ ok: true, status: 'undeliverable', detail: 'feishu code=230013' }, { kind: 'undeliverable' }],
    [{ ok: false, reason: 'not_deployed' }, { kind: 'legacy' }],
    [{ ok: false, reason: 'request_cap' }, { kind: 'request_cap' }],
    [{ ok: false, reason: 'unbound' }, { kind: 'unavailable' }],
    [{ ok: false, reason: 'failed', detail: 'http 503 store_unavailable' }, { kind: 'unavailable' }],
  ] as Array<[CredentialRequestResult, unknown]>)('maps %j', async (answer, expected) => {
    const { deps } = setup([answer]);
    expect(await askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps)).toEqual(expected);
  });

  it('coalesces a burst of refusals into one request', async () => {
    const { requests, deps } = setup();
    const ask = () => askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
    const [a, b, c] = await Promise.all([ask(), ask(), ask()]);
    expect(requests).toHaveLength(1);
    expect(a).toEqual({ kind: 'sent', deduped: false });
    expect(b).toEqual({ kind: 'sent', deduped: true });
    expect(c).toEqual({ kind: 'sent', deduped: true });
  });

  it('does not repeat a sent request within the resend interval, and asks again after it', async () => {
    const { requests, deps, advance } = setup();
    const ask = () => askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
    await ask();
    advance(LINK_RESEND_MS - 1);
    expect(await ask()).toEqual({ kind: 'sent', deduped: true });
    expect(requests).toHaveLength(1);
    advance(2);
    await ask();
    expect(requests).toHaveLength(2);
  });

  it('keeps separate people and scope sets apart', async () => {
    const { requests, deps } = setup();
    const base = { botConfig: bot(['lark-user']) };
    await askPlatformToAuthorize({ ...base, openId: 'ou_a' }, deps);
    await askPlatformToAuthorize({ ...base, openId: 'ou_b' }, deps);
    await askPlatformToAuthorize({ ...base, openId: 'ou_a', scopes: ['x:y'] }, deps);
    expect(requests).toHaveLength(3);
  });

  it('does not remember a request that was not sent, so the next refusal asks again', async () => {
    const { requests, deps } = setup([
      { ok: false, reason: 'failed', detail: 'http 503' },
      { ok: true, status: 'sent', deduped: false },
    ]);
    const ask = () => askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
    expect((await ask()).kind).toBe('unavailable');
    expect(await ask()).toEqual({ kind: 'sent', deduped: false });
    expect(requests).toHaveLength(2);
  });
});
