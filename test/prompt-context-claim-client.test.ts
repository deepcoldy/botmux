import { describe, expect, it, vi } from 'vitest';
import {
  claimPromptContextEnvelopeWithLiveOrigin,
  claimPromptContextEnvelopeWithRetry,
} from '../src/services/prompt-context-claim-client.js';

function response(status: number, envelope?: string): Response {
  return new Response(JSON.stringify(envelope === undefined ? {} : { ok: true, envelope }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('prompt context claim client retry', () => {
  it('retries an explicit 404 until the queued registration becomes visible', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const request = vi.fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, 'ENV'));
    const envelope = await claimPromptContextEnvelopeWithRetry(request, {
      retryForMs: 100,
      retryIntervalMs: 10,
      now: () => now,
      sleep: async ms => { sleeps.push(ms); now += ms; },
    });
    expect(envelope).toBe('ENV');
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it('stops at the bounded deadline when every response is 404', async () => {
    let now = 0;
    const request = vi.fn(async () => response(404));
    const envelope = await claimPromptContextEnvelopeWithRetry(request, {
      retryForMs: 25,
      retryIntervalMs: 10,
      now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(envelope).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
    expect(now).toBe(25);
  });

  it('does not retry non-404 failures or a transport error that may hide a successful pop', async () => {
    const forbidden = vi.fn(async () => response(403));
    await expect(claimPromptContextEnvelopeWithRetry(forbidden)).resolves.toBeUndefined();
    expect(forbidden).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => { throw new Error('response lost'); });
    await expect(claimPromptContextEnvelopeWithRetry(failed)).rejects.toThrow('response lost');
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('retries 403 origin_unproven in live-origin mode (re-reading capability and ipcPort) but never retries managed_action_required', async () => {
    let now = 0;
    let attempt = 0;
    const seenPorts: Array<number | undefined> = [];
    const seenCaps: unknown[] = [];
    const envelope = await claimPromptContextEnvelopeWithLiveOrigin({
      fingerprint: 'a'.repeat(64),
      prefix: 'hello',
      readOrigin: () => attempt === 0
        ? { capability: 'oldcap'.padEnd(64, '0'), turnId: 't1', ipcPort: 19001 }
        : { capability: 'newcap'.padEnd(64, '0'), turnId: 't2', ipcPort: 19002 },
      request: async (body, claim) => {
        seenPorts.push(claim?.ipcPort);
        seenCaps.push(body.originCapability);
        attempt++;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: 'origin_unproven' }), { status: 403 });
        }
        return response(200, 'ROTATED_ENV');
      },
    }, {
      retryForMs: 100,
      retryIntervalMs: 10,
      now: () => now,
      sleep: async ms => { now += ms; },
    });
    expect(envelope).toBe('ROTATED_ENV');
    expect(seenPorts).toEqual([19001, 19002]);
    expect(seenCaps).toEqual(['oldcap'.padEnd(64, '0'), 'newcap'.padEnd(64, '0')]);

    // 403 managed_action_required must abort on attempt 1.
    const managedReq = vi.fn(async () => new Response(JSON.stringify({ error: 'managed_action_required' }), { status: 403 }));
    const blocked = await claimPromptContextEnvelopeWithLiveOrigin({
      fingerprint: 'a'.repeat(64),
      readOrigin: () => ({ capability: 'cap'.padEnd(64, '0') }),
      request: managedReq,
    }, { retryForMs: 100, retryIntervalMs: 10 });
    expect(blocked).toBeUndefined();
    expect(managedReq).toHaveBeenCalledTimes(1);
  });
});
