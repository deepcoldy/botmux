import { describe, expect, it } from 'vitest';
import {
  acknowledgeFastModeResult,
  cancelFastModeResult,
  isFastModeResultPending,
  waitForFastModeResult,
} from '../src/core/fast-mode-handshake.js';

describe('Fast Mode IPC handshake', () => {
  it('resolves only the exact request ACK', async () => {
    const pending = waitForFastModeResult('req-1', 1_000);

    expect(isFastModeResultPending('req-1')).toBe(true);
    expect(isFastModeResultPending('other')).toBe(false);
    expect(acknowledgeFastModeResult({
      type: 'fast_mode_result',
      requestId: 'other',
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    })).toBe(false);
    expect(acknowledgeFastModeResult({
      type: 'fast_mode_result',
      requestId: 'req-1',
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    })).toBe(true);
    expect(isFastModeResultPending('req-1')).toBe(false);
    await expect(pending).resolves.toEqual({
      ok: true,
      enabled: true,
      serviceTier: 'priority',
    });
  });

  it('fails closed on timeout or send cancellation', async () => {
    const cancelled: string[] = [];
    await expect(waitForFastModeResult(
      'req-timeout',
      5,
      () => cancelled.push('req-timeout'),
    )).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
    });
    expect(cancelled).toEqual(['req-timeout']);

    const pending = waitForFastModeResult('req-cancel', 1_000);
    expect(cancelFastModeResult('req-cancel')).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
    });
  });
});
