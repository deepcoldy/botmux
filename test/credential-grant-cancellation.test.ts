import { describe, expect, it } from 'vitest';
import { requestCredentialGrant } from '../src/platform/credential-grant-client.js';
const binding = { platformUrl: 'https://platform.example.test', machineToken: 'fake-only', machineId: 'machine' };
const request = { tool: 'bytedcli' as const, unionId: 'on_person', appId: 'app', sessionId: 'session', cloudJwtRegions: ['cn' as const] };
const drain = () => new Promise<void>(resolve => setTimeout(resolve, 15));
function transport() {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let signal: AbortSignal | undefined; let calls = 0; let active = 0;
  const http = { post: async (_url: string, _body: unknown, options: any) => {
    signal = options.signal; calls++; active++;
    try { await gate; return { status: 403, json: {} }; } finally { active--; }
  } };
  return { http, release, signal: () => signal, calls: () => calls, active: () => active };
}
describe('owned cancellable platform grant attempts', () => {
  it('never starts a platform HTTP request after the caller already cancelled', async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const result = await requestCredentialGrant(request, { binding, signal: controller.signal, http: { post: async () => { calls++; return { status: 403, json: {} }; } } });
    expect(calls).toBe(0); expect(result.ok).toBe(false);
  });
  it('forwards caller cancellation and awaits transport cleanup without starting a retry', async () => {
    const t = transport(); const controller = new AbortController(); let settled = false;
    const pending = requestCredentialGrant(request, { binding, http: t.http, signal: controller.signal, timeoutMs: 1000, totalBudgetMs: 2000 }).then(result => { settled = true; return result; });
    await drain(); controller.abort(); await drain(); const aborted = t.signal()?.aborted; const premature = settled; const active = t.active();
    t.release(); const result = await pending;
    expect(aborted).toBe(true); expect(premature).toBe(false); expect(active).toBe(1); expect(t.active()).toBe(0); expect(t.calls()).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });
  it('retains the strict grant promise until a timed-out transport has completed cleanup', async () => {
    const t = transport(); let settled = false;
    const pending = requestCredentialGrant(request, { binding, http: t.http, signal: new AbortController().signal, timeoutMs: 20, totalBudgetMs: 20 }).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40)); const aborted = t.signal()?.aborted; const premature = settled;
    t.release(); const result = await pending; expect(aborted).toBe(true); expect(premature).toBe(false); expect(t.active()).toBe(0);
    expect(t.calls()).toBe(1); expect(result).toMatchObject({ ok: false, reason: 'network' });
  });
});
