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
import type { TriggerUserAuthCredentialSourceConfig } from '../src/services/trigger-user-auth.js';

const bot = (capabilities: string[], credentialSource?: TriggerUserAuthCredentialSourceConfig) => ({
  larkAppId: 'cli_bot',
  triggerUserAuth: { enabled: true, capabilities, credentialSource },
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

  it('leaves out a tool whose capability is off, and passes Lark scopes through', async () => {
    const { requests, deps } = setup();
    await askPlatformToAuthorize({
      botConfig: bot(['lark-user']), openId: 'ou_a', scopes: ['b:x', 'a:y', 'a:y'],
    }, deps);
    expect(requests[0]).toMatchObject({ tools: ['lark-cli'], scopes: ['a:y', 'b:x'] });
  });

  it('sends only the platform-backed capability and only attaches scopes to Lark', async () => {
    const { requests, deps } = setup();
    const capabilities = ['lark-user', 'bytecloud', 'meego'];
    await askPlatformToAuthorize({
      botConfig: bot(capabilities, { 'lark-user': 'local', bytecloud: 'platform' }),
      openId: 'ou_a', scopes: ['local-app:read'],
    }, deps);
    await askPlatformToAuthorize({
      botConfig: bot(capabilities, { 'lark-user': 'platform', bytecloud: 'local' }),
      openId: 'ou_a', scopes: ['lark:read'],
    }, deps);
    expect(requests).toEqual([
      { unionId: 'on_alice', appId: 'cli_bot', tools: ['bytedcli'] },
      { unionId: 'on_alice', appId: 'cli_bot', tools: ['lark-cli'], scopes: ['lark:read'] },
    ]);
  });

  it('does not reuse a recent card requested before the effective tool set changed', async () => {
    const { requests, deps } = setup();
    const capabilities = ['lark-user', 'bytecloud'];
    const ask = (credentialSource: TriggerUserAuthCredentialSourceConfig) =>
      askPlatformToAuthorize({ botConfig: bot(capabilities, credentialSource), openId: 'ou_a' }, deps);
    expect(await ask({ 'lark-user': 'local', bytecloud: 'platform' })).toEqual({ kind: 'sent', deduped: false });
    expect(await ask({ 'lark-user': 'platform', bytecloud: 'local' })).toEqual({ kind: 'sent', deduped: false });
    expect(requests.map(req => req.tools)).toEqual([['bytedcli'], ['lark-cli']]);
    expect(await ask({ default: 'platform', bytecloud: 'local' })).toEqual({ kind: 'sent', deduped: true });

    expect(await ask({ default: 'local' })).toEqual({ kind: 'unavailable' });
    expect(requests).toHaveLength(2);
  });

  it('uses a union id it was given instead of looking the open id up', async () => {
    const { requests, deps } = setup();
    await askPlatformToAuthorize({ botConfig: bot(['lark-user']), unionId: 'on_given' }, deps);
    expect(deps.unionIdFor).not.toHaveBeenCalled();
    expect(requests[0]!.unionId).toBe('on_given');
  });

  it('stops before sending when the authorization context changes during the union ID lookup', async () => {
    const { requests, deps } = setup();
    let current = true;
    deps.unionIdFor.mockImplementation(async () => { current = false; return 'on_alice'; });
    const result = await askPlatformToAuthorize({
      botConfig: bot(['lark-user']), openId: 'ou_a', isCurrent: () => current,
    }, deps);
    expect(result).toEqual({ kind: 'unavailable', guardRefused: true });
    expect(requests).toEqual([]);
  });

  it('does not send the old tool set if ByteCloud becomes local during the union ID lookup', async () => {
    const { requests, deps } = setup();
    const source: Exclude<TriggerUserAuthCredentialSourceConfig, string> = { 'lark-user': 'platform', bytecloud: 'platform' };
    deps.unionIdFor.mockImplementation(async () => { source.bytecloud = 'local'; return 'on_alice'; });
    const args = { botConfig: bot(['lark-user', 'bytecloud'], source), openId: 'ou_a', scopes: ['lark:read'] };
    expect(await askPlatformToAuthorize(args, deps)).toEqual({ kind: 'unavailable' });
    expect(requests).toEqual([]);
    expect(await askPlatformToAuthorize(args, deps)).toEqual({ kind: 'sent', deduped: false });
    expect(requests).toEqual([{ appId: 'cli_bot', unionId: 'on_alice', tools: ['lark-cli'], scopes: ['lark:read'] }]);
  });

  it('a lookup that never answers gives up after 15 s and does not block later requests', async () => {
    vi.useFakeTimers();
    try {
      const { requests, deps } = setup();
      deps.unionIdFor.mockReturnValueOnce(new Promise<string | null>(() => {}));
      const first = askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await first).toEqual({ kind: 'unavailable' });
      expect(await askPlatformToAuthorize({ botConfig: bot(['lark-user']), openId: 'ou_a' }, deps)).toEqual({ kind: 'sent', deduped: false });
      expect(requests).toHaveLength(1);
    } finally { vi.useRealTimers(); }
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

  it('lets a valid caller retry when the shared request stopped on another caller\'s fence', async () => {
    const { requests, deps } = setup();
    let resolveUnion!: (value: string) => void;
    deps.unionIdFor.mockReturnValue(new Promise<string | null>(resolve => { resolveUnion = resolve; }));
    let allowA = true;
    let bFenceCalls = 0;
    const args = { botConfig: bot(['bytecloud']), openId: 'ou_a' };
    const a = askPlatformToAuthorize({ ...args, stillAllowed: () => allowA }, deps);
    const b = askPlatformToAuthorize({ ...args, stillAllowed: () => { bFenceCalls++; return true; } }, deps);
    allowA = false;
    resolveUnion('on_alice');

    expect(await a).toMatchObject({ kind: 'unavailable', guardRefused: true });
    expect(await b).toEqual({ kind: 'sent', deduped: false });
    expect(bFenceCalls).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
  });

  it('checks a guarded caller\'s own fence before reusing a recent answer', async () => {
    const { requests, deps } = setup();
    const args = { botConfig: bot(['bytecloud']), openId: 'ou_a' };
    expect(await askPlatformToAuthorize(args, deps)).toEqual({ kind: 'sent', deduped: false });
    expect(await askPlatformToAuthorize({ ...args, stillAllowed: () => false }, deps))
      .toEqual({ kind: 'unavailable' });
    expect(requests).toHaveLength(1);
  });

  it('still coalesces concurrent callers whose guards remain valid', async () => {
    const { requests, deps } = setup();
    let resolveUnion!: (value: string) => void;
    deps.unionIdFor.mockReturnValue(new Promise<string | null>(resolve => { resolveUnion = resolve; }));
    const args = { botConfig: bot(['bytecloud']), openId: 'ou_a', stillAllowed: () => true };
    const a = askPlatformToAuthorize(args, deps);
    const b = askPlatformToAuthorize(args, deps);
    resolveUnion('on_alice');
    expect(await a).toEqual({ kind: 'sent', deduped: false });
    expect(await b).toEqual({ kind: 'sent', deduped: true });
    expect(requests).toHaveLength(1);
  });
});
