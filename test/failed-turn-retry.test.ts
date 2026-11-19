/**
 * Unit tests for failed-turn-retry: the pure bookkeeping behind /retry.
 *
 * Run: pnpm vitest run test/failed-turn-retry.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  buildFailedTurnRecord,
  retryCooldownRemaining,
  markRetryAttempt,
  refundRetryAttempt,
} from '../src/services/failed-turn-retry.js';
import type { FailedTurnRecord } from '../src/types.js';

describe('buildFailedTurnRecord', () => {
  it('builds a complete record from terminal + sources', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    const record = buildFailedTurnRecord(
      { turnId: 't1', status: 'failed', errorCode: 'provider_unexpected_eof' },
      { userPrompt: 'fix the bug', cliInput: '<user-prompt>fix the bug</user-prompt>' },
      now,
    );
    expect(record).toEqual({
      turnId: 't1',
      userPrompt: 'fix the bug',
      cliInput: '<user-prompt>fix the bug</user-prompt>',
      failedAt: '2026-08-21T10:00:00.000Z',
      errorCode: 'provider_unexpected_eof',
      status: 'failed',
      retryCount: 0,
    });
  });

  it('returns undefined when there is no CLI input to re-inject', () => {
    expect(buildFailedTurnRecord(
      { turnId: 't1', status: 'failed' },
      { userPrompt: 'fix the bug', cliInput: '' },
    )).toBeUndefined();
    expect(buildFailedTurnRecord(
      { turnId: 't1', status: 'failed' },
      { userPrompt: 'fix the bug' },
    )).toBeUndefined();
  });

  it('falls back to cliInput as userPrompt when the prompt was not captured', () => {
    const record = buildFailedTurnRecord(
      { turnId: 't1', status: 'ambiguous' },
      { cliInput: '<user-prompt>fix the bug</user-prompt>' },
    );
    expect(record?.userPrompt).toBe('<user-prompt>fix the bug</user-prompt>');
    expect(record?.status).toBe('ambiguous');
  });

  it('passes the Codex App sidecar through untouched', () => {
    const codexAppInput = { text: 'fix the bug', clientUserMessageId: 'client-msg-1' };
    const record = buildFailedTurnRecord(
      { turnId: 't1', status: 'failed' },
      { userPrompt: 'fix the bug', cliInput: '<user-prompt>fix the bug</user-prompt>', codexAppInput },
    );
    expect(record?.codexAppInput).toEqual(codexAppInput);
  });

  it('omits errorCode when the terminal carried none', () => {
    const record = buildFailedTurnRecord(
      { turnId: 't1', status: 'failed' },
      { cliInput: 'input' },
    );
    expect(record?.errorCode).toBeUndefined();
  });
});

describe('retryCooldownRemaining', () => {
  function record(overrides: Partial<FailedTurnRecord> = {}): FailedTurnRecord {
    return {
      turnId: 't1',
      userPrompt: 'p',
      cliInput: 'i',
      failedAt: '2026-08-21T10:00:00.000Z',
      status: 'failed',
      retryCount: 0,
      ...overrides,
    };
  }

  it('is zero when no retry has been attempted yet', () => {
    expect(retryCooldownRemaining(record())).toBe(0);
  });

  it('is positive while the cooldown is still running', () => {
    const now = new Date('2026-08-21T10:00:05.000Z');
    const remaining = retryCooldownRemaining(
      record({ lastRetryAt: '2026-08-21T10:00:00.000Z' }),
      now,
    );
    expect(remaining).toBe(5_000);
  });

  it('is zero once the cooldown has elapsed', () => {
    const now = new Date('2026-08-21T10:00:15.000Z');
    expect(retryCooldownRemaining(
      record({ lastRetryAt: '2026-08-21T10:00:00.000Z' }),
      now,
    )).toBe(0);
  });

  it('honors a custom cooldown', () => {
    const now = new Date('2026-08-21T10:00:03.000Z');
    expect(retryCooldownRemaining(
      record({ lastRetryAt: '2026-08-21T10:00:00.000Z' }),
      now,
      5_000,
    )).toBe(2_000);
  });
});

describe('markRetryAttempt', () => {
  it('increments retryCount and stamps lastRetryAt', () => {
    const session: { lastFailedTurn?: FailedTurnRecord } = {
      lastFailedTurn: {
        turnId: 't1',
        userPrompt: 'p',
        cliInput: 'i',
        failedAt: '2026-08-21T10:00:00.000Z',
        status: 'failed',
        retryCount: 0,
      },
    };
    const now = new Date('2026-08-21T10:00:05.000Z');
    markRetryAttempt(session, now);
    expect(session.lastFailedTurn!.retryCount).toBe(1);
    expect(session.lastFailedTurn!.lastRetryAt).toBe('2026-08-21T10:00:05.000Z');
  });

  it('is a no-op when the session has no failed turn', () => {
    const session: { lastFailedTurn?: FailedTurnRecord } = {};
    expect(() => markRetryAttempt(session)).not.toThrow();
    expect(session.lastFailedTurn).toBeUndefined();
  });
});

describe('refundRetryAttempt', () => {
  function session(overrides: Partial<FailedTurnRecord> = {}): { lastFailedTurn?: FailedTurnRecord } {
    return {
      lastFailedTurn: {
        turnId: 't1',
        userPrompt: 'p',
        cliInput: 'i',
        failedAt: '2026-08-21T10:00:00.000Z',
        status: 'failed',
        retryCount: 0,
        ...overrides,
      },
    };
  }

  it('gives back the cooldown of an attempt that never ran', () => {
    const s = session();
    const receipt = markRetryAttempt(s, new Date('2026-08-21T10:00:05.000Z'))!;
    expect(retryCooldownRemaining(s.lastFailedTurn!, new Date('2026-08-21T10:00:06.000Z'))).toBeGreaterThan(0);

    expect(refundRetryAttempt(s, receipt)).toBe(true);
    expect(s.lastFailedTurn!.retryCount).toBe(0);
    expect(s.lastFailedTurn!.lastRetryAt).toBeUndefined();
    expect(retryCooldownRemaining(s.lastFailedTurn!, new Date('2026-08-21T10:00:06.000Z'))).toBe(0);
    expect(refundRetryAttempt(s, receipt)).toBe(false);
  });

  it('restores the previous attempt stamp rather than clearing it', () => {
    const s = session({ retryCount: 2, lastRetryAt: '2026-08-21T09:00:00.000Z' });
    const receipt = markRetryAttempt(s, new Date('2026-08-21T10:00:05.000Z'))!;
    expect(refundRetryAttempt(s, receipt)).toBe(true);
    expect(s.lastFailedTurn).toMatchObject({ retryCount: 2, lastRetryAt: '2026-08-21T09:00:00.000Z' });
  });

  it('leaves a newer failure or a later attempt alone', () => {
    const replaced = session();
    const staleReceipt = markRetryAttempt(replaced, new Date('2026-08-21T10:00:05.000Z'))!;
    replaced.lastFailedTurn = { ...replaced.lastFailedTurn!, turnId: 't2' };
    expect(refundRetryAttempt(replaced, staleReceipt)).toBe(false);
    expect(replaced.lastFailedTurn.retryCount).toBe(1);

    const retried = session();
    const firstReceipt = markRetryAttempt(retried, new Date('2026-08-21T10:00:05.000Z'))!;
    markRetryAttempt(retried, new Date('2026-08-21T10:00:20.000Z'));
    expect(refundRetryAttempt(retried, firstReceipt)).toBe(false);
    expect(retried.lastFailedTurn).toMatchObject({ retryCount: 2, lastRetryAt: '2026-08-21T10:00:20.000Z' });
  });

  it('does not let an old receipt undo a newer attempt at the same count', () => {
    const s = session();
    const old = markRetryAttempt(s, new Date('2026-08-21T10:00:05.000Z'))!;
    refundRetryAttempt(s, old);
    markRetryAttempt(s, new Date('2026-08-21T10:00:30.000Z'));
    expect(refundRetryAttempt(s, old)).toBe(false);
    expect(s.lastFailedTurn).toMatchObject({ retryCount: 1, lastRetryAt: '2026-08-21T10:00:30.000Z' });
  });
});
