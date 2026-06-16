import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import type { LedgerEventDraft } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}

describe('verified-delivery ledger', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-ledger-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('dispatch → report → accept materializes the full task lifecycle', () => {
    const led = openLedger({ baseDir });
    led.append(draft({
      type: 'TaskDispatched', actor: 'orchestrator', taskId: 'task-1', chatId: 'oc_x', idempotencyKey: 'dispatched:task-1',
      payload: { taskId: 'task-1', title: 'do X', workerTopicRoot: 'om_root', workerOpenIds: ['ou_w'], acceptanceHint: 'run check.py exit 0' },
    }));
    const inline = led.writeInlineEvidence('PASS: all good\n', 'check-output');
    led.append(draft({
      type: 'TaskReported', actor: 'worker', taskId: 'task-1', chatId: 'oc_x', idempotencyKey: 'reported:r1',
      payload: { taskId: 'task-1', reportId: 'r1', workerOpenId: 'ou_w', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/out.json' }, inline] },
    }));
    led.append(draft({
      type: 'TaskAccepted', taskId: 'task-1', idempotencyKey: 'accepted:task-1:r1',
      payload: { taskId: 'task-1', reportId: 'r1', checkedBy: 'ou_orch', ranCommands: ['python check.py'], evidenceChecked: ['/tmp/out.json'] },
    }));

    const t = led.task('task-1')!;
    expect(t.status).toBe('accepted');
    expect(t.acceptanceHint).toBe('run check.py exit 0');
    expect(t.workerTopicRoot).toBe('om_root');
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ reportId: 'r1', verdict: 'accepted', ranCommands: ['python check.py'] });
    expect(t.reports[0].evidence).toHaveLength(2);
    expect(led.readInlineEvidence(inline.ref)).toBe('PASS: all good\n');
  });

  it('reject then re-report flips status back to reported (same task, new attempt)', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-2', idempotencyKey: 'dispatched:task-2', payload: { taskId: 'task-2' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-2', idempotencyKey: 'reported:r1', payload: { taskId: 'task-2', reportId: 'r1', summary: 'attempt 1', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 'task-2', idempotencyKey: 'rejected:task-2:r1', payload: { taskId: 'task-2', reportId: 'r1', reason: 'missing report.md', retryBrief: 'also write report.md' } }));
    expect(led.task('task-2')!.status).toBe('rejected');
    expect(led.task('task-2')!.reports[0]).toMatchObject({ verdict: 'rejected', reason: 'missing report.md' });

    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-2', idempotencyKey: 'reported:r2', payload: { taskId: 'task-2', reportId: 'r2', summary: 'attempt 2', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    const t = led.task('task-2')!;
    expect(t.status).toBe('reported');
    expect(t.latestReportId).toBe('r2');
    expect(t.reports).toHaveLength(2);
    expect(t.reports[0].verdict).toBe('rejected'); // attempt 1 keeps its verdict
  });

  it('idempotent append: same key twice is a no-op', () => {
    const led = openLedger({ baseDir });
    const a = led.append(draft({ type: 'TaskDispatched', taskId: 'task-3', idempotencyKey: 'dispatched:task-3', payload: { taskId: 'task-3' } }));
    const b = led.append(draft({ type: 'TaskDispatched', taskId: 'task-3', idempotencyKey: 'dispatched:task-3', payload: { taskId: 'task-3' } }));
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.event.seq).toBe(a.event.seq);
    expect(led.read()).toHaveLength(1);
  });

  it('tasks(chatId) scopes the board to one chat', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-a', chatId: 'oc_1', idempotencyKey: 'dispatched:t-a', payload: { taskId: 't-a' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-b', chatId: 'oc_2', idempotencyKey: 'dispatched:t-b', payload: { taskId: 't-b' } }));
    expect(led.tasks('oc_1').map((t) => t.taskId)).toEqual(['t-a']);
    expect(led.tasks()).toHaveLength(2);
  });
});
