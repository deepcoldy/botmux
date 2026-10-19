import { describe, expect, it } from 'vitest';
import { planScheduleFinalCleanup } from '../src/cli/schedule-final-cleanup.js';

const scheduledTurn = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';

describe('schedule final cleanup plan', () => {
  it('derives the exact task from a scheduled final turn', () => {
    expect(planScheduleFinalCleanup({
      requested: true,
      responseKind: 'final',
      turnId: scheduledTurn,
      incompatible: [],
    })).toEqual({ ok: true, taskId: 'a1b2c3d4' });
  });

  it('requires an explicit final and a scheduled turn', () => {
    expect(planScheduleFinalCleanup({
      requested: true,
      responseKind: 'progress',
      turnId: scheduledTurn,
      incompatible: [],
    })).toMatchObject({ ok: false });
    expect(planScheduleFinalCleanup({
      requested: true,
      responseKind: 'final',
      turnId: 'om_human',
      incompatible: [],
    })).toMatchObject({ ok: false });
  });

  it('rejects a non-canonical final shape before provider effects', () => {
    expect(planScheduleFinalCleanup({
      requested: true,
      responseKind: 'final',
      turnId: scheduledTurn,
      incompatible: ['--top-level', '--files'],
    })).toEqual({
      ok: false,
      error: '--schedule-remove-self 不支持这些发送形态：--top-level, --files',
    });
  });

  it('is a no-op for ordinary sends', () => {
    expect(planScheduleFinalCleanup({
      requested: false,
      responseKind: 'progress',
      turnId: 'om_human',
      incompatible: [],
    })).toEqual({ ok: true });
  });
});
