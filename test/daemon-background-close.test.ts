import { describe, expect, it, vi } from 'vitest';
import {
  runIdempotencyFailClose,
  runWithdrawAutoClose,
  type BackgroundClose,
} from '../src/core/daemon-background-close.js';
import type { CloseSessionResult } from '../src/core/worker-pool.js';

const SESSION_ID = 'session-12345678';

function closeReturning(result: CloseSessionResult): BackgroundClose {
  return vi.fn(async () => result);
}

describe('daemon background close consumers', () => {
  it('idempotency refusal does not claim fail-closed', async () => {
    const close = closeReturning({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      taskId: 'mojo-remote-1',
    });
    const logger = { error: vi.fn() };

    await runIdempotencyFailClose(SESSION_ID, close, logger);

    expect(close).toHaveBeenCalledWith(
      SESSION_ID,
      'idempotency fail-close after exit-convergence write failure',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('idempotency residual is locally closed and keeps the typed background path', async () => {
    const close = closeReturning({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-remote-2' },
      alreadyClosed: false,
      known: true,
    });
    const logger = { error: vi.fn() };

    await runIdempotencyFailClose(SESSION_ID, close, logger);

    expect(close).toHaveBeenCalledWith(
      SESSION_ID,
      'idempotency fail-close after exit-convergence write failure',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('fail-closed session session-'),
    );
  });

  it('idempotency close throw is observable and never escapes the exit hook', async () => {
    const close = vi.fn<BackgroundClose>(async () => {
      throw new Error('disk full');
    });
    const logger = { error: vi.fn() };

    await expect(runIdempotencyFailClose(SESSION_ID, close, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/UNPROVEN.*disk full/));
  });

  it('withdraw refusal returns false and does not log auto-closed', async () => {
    const close = closeReturning({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
    });
    const logger = { info: vi.fn(), error: vi.fn() };

    await expect(runWithdrawAutoClose(SESSION_ID, close, logger)).resolves.toBe(false);
    expect(close).toHaveBeenCalledWith(SESSION_ID, 'withdraw auto-close');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('withdraw residual returns true because local close succeeded', async () => {
    const close = closeReturning({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-remote-3' },
      alreadyClosed: false,
      known: true,
    });
    const logger = { info: vi.fn(), error: vi.fn() };

    await expect(runWithdrawAutoClose(SESSION_ID, close, logger)).resolves.toBe(true);
    expect(close).toHaveBeenCalledWith(SESSION_ID, 'withdraw auto-close');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Session auto-closed'));
  });

  it('withdraw throw is observable and returns false without claiming success', async () => {
    const close = vi.fn<BackgroundClose>(async () => {
      throw new Error('store unavailable');
    });
    const logger = { info: vi.fn(), error: vi.fn() };

    await expect(runWithdrawAutoClose(SESSION_ID, close, logger))
      .resolves.toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/UNPROVEN.*store unavailable/),
    );
  });
});
