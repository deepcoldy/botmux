import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setPlatformCredentialDepsForTest, resolvePlatformIdentity } from '../src/core/platform-credential-source.js';
const contacts = { calls: [] as Array<AbortSignal | undefined>, gate: Promise.resolve(), unionId: 'on_person' };
vi.mock('../src/im/lark/client.js', () => ({ resolveUnionIdFromOpenId: async (_app: string, _id: string, signal?: AbortSignal) => {
  contacts.calls.push(signal); await contacts.gate; return contacts.unionId;
} }));
afterEach(() => { __setPlatformCredentialDepsForTest(null); contacts.calls.length = 0; contacts.gate = Promise.resolve(); });
const drain = () => new Promise<void>(resolve => setTimeout(resolve, 15));
function setup() {
  const grants: Array<AbortSignal | undefined> = [];
  __setPlatformCredentialDepsForTest({ readBinding: () => ({ platformUrl: 'https://platform.example.test', machineId: 'machine', machineToken: 'fake-only' }),
    requestGrant: async (_request, options) => { grants.push(options.signal); return { ok: false, reason: 'not_authorized', error: 'missing' }; } });
  const request = { botConfig: { larkAppId: 'app' }, tool: 'bytedcli' as const, sessionId: 'session', openId: 'ou_signal_person', cloudJwtRegions: ['cn' as const] };
  return { grants, request };
}
describe('request-owned platform identity cancellation', () => {
  it('passes the same caller signal through official contact lookup and grant', async () => {
    const s = setup(); const controller = new AbortController(); await resolvePlatformIdentity({ ...s.request, signal: controller.signal });
    expect(contacts.calls).toEqual([controller.signal]); expect(s.grants).toEqual([controller.signal]);
  });
  it('does not start contact or grant work for a pre-cancelled caller', async () => {
    const s = setup(); const controller = new AbortController(); controller.abort();
    await resolvePlatformIdentity({ ...s.request, signal: controller.signal }); expect(contacts.calls).toEqual([]); expect(s.grants).toEqual([]);
  });
  it('keeps independent contact cancellation from aborting another request or publishing a late grant', async () => {
    const s = setup(); let release!: () => void; contacts.gate = new Promise<void>(resolve => release = resolve);
    const first = new AbortController(); const second = new AbortController();
    const one = resolvePlatformIdentity({ ...s.request, signal: first.signal }); const two = resolvePlatformIdentity({ ...s.request, signal: second.signal });
    await drain(); first.abort(); const signals = [...contacts.calls]; release(); await Promise.all([one, two]);
    expect(signals).toEqual([first.signal, second.signal]); expect(second.signal.aborted).toBe(false); expect(s.grants).toEqual([second.signal]);
  });
});
