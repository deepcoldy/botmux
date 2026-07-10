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
      payload: { taskId: 'task-1', title: 'do X', workerTopicRoot: 'om_root', workerOpenIds: ['ou_w'], requiredRepo: 'github.com/acme/project', acceptanceHint: 'run check.py exit 0' },
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
    expect(t.requiredRepo).toBe('github.com/acme/project');
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

  it('keeps an accepted task terminal when a delayed report arrives', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-late', idempotencyKey: 'dispatched:task-late', payload: { taskId: 'task-late' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-late', idempotencyKey: 'reported:r1', payload: { taskId: 'task-late', reportId: 'r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-late', idempotencyKey: 'accepted:task-late:r1', payload: { taskId: 'task-late', reportId: 'r1', checkedBy: 'sup' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-late', idempotencyKey: 'reported:r2', payload: { taskId: 'task-late', reportId: 'r2', summary: 'delayed retry', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));

    const t = led.task('task-late')!;
    expect(t.status).toBe('accepted');
    expect(t.latestReportId).toBe('r1');
    expect(t.reports).toHaveLength(2);
    expect(t.reports.find((r) => r.reportId === 'r1')?.verdict).toBe('accepted');
    expect(t.reports.find((r) => r.reportId === 'r2')?.verdict).toBeUndefined();
  });

  it('a late verdict for a superseded report does not drag the new attempt back', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-4', idempotencyKey: 'dispatched:task-4', payload: { taskId: 'task-4' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-4', idempotencyKey: 'reported:r1', payload: { taskId: 'task-4', reportId: 'r1', summary: 'a1', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 'task-4', idempotencyKey: 'rejected:task-4:r1', payload: { taskId: 'task-4', reportId: 'r1', reason: 'insufficient' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-4', idempotencyKey: 'reported:r2', payload: { taskId: 'task-4', reportId: 'r2', summary: 'a2', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    // a stray late accept for the OLD report r1 arrives after r2 is the live attempt
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-4', idempotencyKey: 'accepted:task-4:r1', payload: { taskId: 'task-4', reportId: 'r1' } }));

    const t = led.task('task-4')!;
    expect(t.status).toBe('reported');       // still on r2, NOT dragged to accepted
    expect(t.latestReportId).toBe('r2');
    expect(t.reports.find((r) => r.reportId === 'r1')!.verdict).toBe('accepted'); // r1 still records its (late) verdict
  });

  it('TaskReported with no evidence is refused at the seam', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-5', idempotencyKey: 'dispatched:task-5', payload: { taskId: 'task-5' } }));
    expect(() => led.append(draft({
      type: 'TaskReported', actor: 'worker', taskId: 'task-5', idempotencyKey: 'reported:empty',
      payload: { taskId: 'task-5', reportId: 'empty', summary: 'no proof', evidence: [] },
    }))).toThrow(/at least one evidence/);
  });

  it('refuses taskId mismatches and malformed core fields at the append seam', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-a',
      idempotencyKey: 'dispatched:task-a',
      payload: { taskId: 'task-b' },
    }))).toThrow(/payload\.taskId must match/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: '',
      idempotencyKey: 'dispatched:empty',
      payload: { taskId: '' },
    }))).toThrow(/taskId must be non-empty/);
  });

  it('refuses misaligned worker metadata and malformed acceptanceCriteria', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-repo',
      idempotencyKey: 'dispatched:task-repo',
      payload: { taskId: 'task-repo', requiredRepo: '   ' },
    }))).toThrow(/requiredRepo must be non-empty/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-meta',
      idempotencyKey: 'dispatched:task-meta',
      payload: { taskId: 'task-meta', workerOpenIds: ['ou_a', 'ou_b'], workerLarkAppIds: ['cli_a'] },
    }))).toThrow(/workerLarkAppIds must be index-aligned/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-criteria',
      idempotencyKey: 'dispatched:task-criteria',
      payload: { taskId: 'task-criteria', acceptanceCriteria: { version: 1, artifacts: [{ path: '', checks: [] }] } },
    }))).toThrow(/acceptanceCriteria invalid/);
  });

  it('refuses malformed evidence, help kind, and empty verdict/escalation fields', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskReported',
      actor: 'worker',
      taskId: 'task-ev',
      idempotencyKey: 'reported:bad-path',
      payload: { taskId: 'task-ev', reportId: 'r1', summary: 'bad', evidence: [{ kind: 'path', path: '' }] },
    }))).toThrow(/evidence\[0\]\.path/);
    expect(() => led.append(draft({
      type: 'TaskReported',
      actor: 'worker',
      taskId: 'task-ev',
      idempotencyKey: 'reported:bad-url',
      payload: { taskId: 'task-ev', reportId: 'r2', summary: 'bad', evidence: [{ kind: 'url', url: 'ftp://example.test/a' }] },
    }))).toThrow(/http or https/);
    expect(() => led.append(draft({
      type: 'TaskHelpRequested',
      actor: 'worker',
      taskId: 'task-help',
      idempotencyKey: 'help:bad-kind',
      payload: { taskId: 'task-help', blocker: 'blocked', kind: 'mystery' as never },
    }))).toThrow(/kind is invalid/);
    expect(() => led.append(draft({
      type: 'TaskAccepted',
      taskId: 'task-acc',
      idempotencyKey: 'accepted:empty-report',
      payload: { taskId: 'task-acc', reportId: '' },
    }))).toThrow(/TaskAccepted\.reportId/);
    expect(() => led.append(draft({
      type: 'TaskEscalated',
      taskId: 'task-esc',
      idempotencyKey: 'escalated:empty',
      payload: { taskId: 'task-esc', reason: '' },
    }))).toThrow(/TaskEscalated\.reason/);
  });

  it('keeps deferred invariants backward-compatible for now', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskReported',
      taskId: 'task-legacy-report',
      idempotencyKey: 'reported:legacy-actor',
      payload: { taskId: 'task-legacy-report', reportId: 'r1', summary: 'legacy actor', evidence: [{ kind: 'path', path: '/tmp/a' }] },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskHelpRequested',
      taskId: 'task-legacy-help',
      idempotencyKey: 'help:legacy-actor',
      payload: { taskId: 'task-legacy-help', blocker: 'legacy actor' },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskAccepted',
      taskId: 'task-legacy-accept',
      idempotencyKey: 'accepted:legacy-light',
      payload: { taskId: 'task-legacy-accept', reportId: 'r1' },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskRejected',
      taskId: 'task-legacy-reject',
      idempotencyKey: 'rejected:legacy-free-text',
      payload: { taskId: 'task-legacy-reject', reportId: 'r1', reason: 'missing report.md' },
    }))).not.toThrow();
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
