import { describe, expect, it, vi } from 'vitest';
import { claimPromptContextEnvelopeWithRetry } from '../src/services/prompt-context-claim-client.js';

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
});
