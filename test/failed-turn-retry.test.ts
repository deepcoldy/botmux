/**
 * Unit tests for failed-turn-retry: the pure bookkeeping behind /retry.
 *
 * Run: pnpm vitest run test/failed-turn-retry.test.ts
 */
import { describe, expect, it } from 'bun:test';
import {
  RETRY_COOLDOWN_MS,
  shouldRecordFailedTurn,
  buildFailedTurnRecord,
  retryCooldownRemaining,
  markRetryAttempt,
} from '../src/services/failed-turn-retry.js';
import type { FailedTurnRecord } from '../src/types.js';

describe('shouldRecordFailedTurn', () => {
  it('records failed terminals whose turn matches the current reply target', () => {
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'failed' }, 't1')).toBe(true);
  });

  it('records ambiguous terminals (interrupted turns)', () => {
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'ambiguous' }, 't1')).toBe(true);
  });

  it('does not record completed or cancelled terminals', () => {
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'completed' }, 't1')).toBe(false);
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'cancelled' }, 't1')).toBe(false);
  });

  it('skips type-ahead scenarios: a newer turn already owns the prompt', () => {
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'failed' }, 't2')).toBe(false);
  });

  it('records when no current reply target is known (best-effort)', () => {
    expect(shouldRecordFailedTurn({ turnId: 't1', status: 'failed' }, undefined)).toBe(true);
  });
});

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

describe('RETRY_COOLDOWN_MS', () => {
  it('is 10 seconds', () => {
    expect(RETRY_COOLDOWN_MS).toBe(10_000);
  });
});
