import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSessionReady,
  cancelSessionReadyAck,
  waitForSessionReadyAck,
} from '../src/core/session-ready-handshake.js';

describe('SessionStart worker acknowledgement', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves true when the worker acknowledges the request', async () => {
    const pending = waitForSessionReadyAck('request-1', 2_000);
    expect(acknowledgeSessionReady('request-1')).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(acknowledgeSessionReady('request-1')).toBe(false);
  });

  it('fails open after a bounded timeout', async () => {
    const pending = waitForSessionReadyAck('request-2', 2_000);
    vi.advanceTimersByTime(2_000);
    await expect(pending).resolves.toBe(false);
    expect(acknowledgeSessionReady('request-2')).toBe(false);
  });

  it('can be cancelled immediately when IPC forwarding fails', async () => {
    const pending = waitForSessionReadyAck('request-3', 2_000);
    expect(cancelSessionReadyAck('request-3')).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(cancelSessionReadyAck('request-3')).toBe(false);
  });
});
