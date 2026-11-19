import { describe, expect, it } from 'vitest';
import type { CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { uncollectedTurnsNeedingNotice } from '../src/services/structured-uncollected-notice.js';

const turn = (turnId: string, extra: Partial<CodexPendingTurn> = {}): CodexPendingTurn => (
  { turnId, started: false, ...extra }
);

describe('uncollectedTurnsNeedingNotice', () => {
  it('notifies an ordinary Lark turn whose transcript start never arrived', () => {
    const ordinary = turn('om_ordinary');
    expect(uncollectedTurnsNeedingNotice([ordinary], {
      settledByTerminal: new Set(),
      hasOwnNotice: () => false,
    })).toEqual([ordinary]);
  });

  it('leaves out turns that already have a terminal, a local origin, or their own notice', () => {
    const durable = turn('om_durable', { dispatchAttempt: 1 });
    const local = turn('codex-local-1', { isLocal: true, started: true });
    const writeFailed = turn('om_write_failed');
    const ordinary = turn('om_ordinary');
    const asked: string[] = [];
    const picked = uncollectedTurnsNeedingNotice([durable, local, writeFailed, ordinary], {
      settledByTerminal: new Set([durable]),
      hasOwnNotice: t => { asked.push(t.turnId); return t.turnId === 'om_write_failed'; },
    });
    expect(picked.map(t => t.turnId)).toEqual(['om_ordinary']);
    // The own-notice check consumes state in the worker; it must only be asked
    // about turns that are otherwise eligible.
    expect(asked).toEqual(['om_write_failed', 'om_ordinary']);
  });
});
