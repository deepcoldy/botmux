import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import {
  classifyTaskDisposition,
  buildGoalAttentionBoard,
  type ClassifiableTask,
} from '../src/verified-delivery/attention.js';
import type { LedgerEventDraft } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
const T = (n: number): number => TS + n * 1000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}
const task = (status: ClassifiableTask['status'], extra: Partial<ClassifiableTask> = {}): ClassifiableTask =>
  ({ taskId: 'x', status, ...extra });

describe('classifyTaskDisposition — the shared pure rule', () => {
  it('escalated → needsHuman (a person must decide)', () => {
    expect(classifyTaskDisposition(task('escalated'))).toEqual({ bucket: 'needsHuman', reason: 'escalated', next: '等人拍板' });
  });

  it('blocked → blocked, reason carries the help kind when present', () => {
    expect(classifyTaskDisposition(task('blocked', { help: { blocker: 'b', kind: 'ambiguous' } })).reason).toBe('help:ambiguous');
    expect(classifyTaskDisposition(task('blocked', { help: { blocker: 'b' } })).reason).toBe('help'); // no kind
    expect(classifyTaskDisposition(task('blocked')).bucket).toBe('blocked'); // help record absent → still blocked
  });

  it('reported → readyToVerify (ledger-only: status=reported, no verdict)', () => {
    expect(classifyTaskDisposition(task('reported'))).toEqual({ bucket: 'readyToVerify', reason: 'awaiting_verdict', next: '已有提交，等验收' });
  });

  it('accepted → completed (the ONLY thing that is "completed")', () => {
    expect(classifyTaskDisposition(task('accepted'))).toEqual({ bucket: 'completed', reason: 'accepted', next: '已验收' });
  });

  it('dispatched → inProgress; rejected → inProgress (not terminal, retrying)', () => {
    expect(classifyTaskDisposition(task('dispatched'))).toMatchObject({ bucket: 'inProgress', reason: 'dispatched' });
    expect(classifyTaskDisposition(task('rejected'))).toMatchObject({ bucket: 'inProgress', reason: 'rejected_retrying' });
  });

  describe('store-derived risk (supplied via context) overrides an ACTIVE task', () => {
    it('dispatched + reassign-budget exhausted → systemRisk', () => {
      const d = classifyTaskDisposition(task('dispatched'), { reassignBudgetExhausted: new Set(['x']) });
      expect(d).toMatchObject({ bucket: 'systemRisk', reason: 'reassign_budget_exhausted' });
    });
    it('dispatched + dead-letter → systemRisk', () => {
      const d = classifyTaskDisposition(task('dispatched'), { deadLetterTaskIds: new Set(['x']) });
      expect(d).toMatchObject({ bucket: 'systemRisk', reason: 'deadletter_pending' });
    });
    it('rejected + risk also flips to systemRisk', () => {
      expect(classifyTaskDisposition(task('rejected'), { reassignBudgetExhausted: new Set(['x']) }).bucket).toBe('systemRisk');
    });
    it('reassign exhaustion takes precedence over dead-letter', () => {
      const d = classifyTaskDisposition(task('dispatched'), { reassignBudgetExhausted: new Set(['x']), deadLetterTaskIds: new Set(['x']) });
      expect(d.reason).toBe('reassign_budget_exhausted');
    });
    it('context that does not name this task leaves it inProgress', () => {
      expect(classifyTaskDisposition(task('dispatched'), { reassignBudgetExhausted: new Set(['other']) }).bucket).toBe('inProgress');
    });
    it('does NOT override terminal/awaiting states (only active dispatched/rejected)', () => {
      const ctx = { reassignBudgetExhausted: new Set(['x']), deadLetterTaskIds: new Set(['x']) };
      expect(classifyTaskDisposition(task('accepted'), ctx).bucket).toBe('completed');
      expect(classifyTaskDisposition(task('escalated'), ctx).bucket).toBe('needsHuman');
      expect(classifyTaskDisposition(task('reported'), ctx).bucket).toBe('readyToVerify');
    });
  });
});

describe('buildGoalAttentionBoard — cross-goal rollup', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-attn-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  function seedTwoGoals(): void {
    const led = openLedger({ baseDir });
    // ── oc_g1 ────────────────────────────────────────────────────────────────
    // escalated (oldest) → needsHuman
    led.append(draft({ type: 'TaskDispatched', taskId: 't-esc1', chatId: 'oc_g1', idempotencyKey: 'd:esc1', ts: T(0), payload: { taskId: 't-esc1', title: 'E1' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't-esc1', chatId: 'oc_g1', idempotencyKey: 'h:esc1', ts: T(1), payload: { taskId: 't-esc1', blocker: '歧义' } }));
    led.append(draft({ type: 'TaskEscalated', taskId: 't-esc1', chatId: 'oc_g1', idempotencyKey: 'e:esc1', ts: T(2), payload: { taskId: 't-esc1', reason: '要人拍', by: 'goal-watchdog' } }));
    // blocked (access)
    led.append(draft({ type: 'TaskDispatched', taskId: 't-blk', chatId: 'oc_g1', idempotencyKey: 'd:blk', ts: T(3), payload: { taskId: 't-blk', title: 'BLK' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't-blk', chatId: 'oc_g1', idempotencyKey: 'h:blk', ts: T(4), payload: { taskId: 't-blk', blocker: '没权限', kind: 'access', workerOpenId: 'ou_w' } }));
    // accepted (with verification trail) → completed
    led.append(draft({ type: 'TaskDispatched', taskId: 't-acc', chatId: 'oc_g1', idempotencyKey: 'd:acc', ts: T(5), payload: { taskId: 't-acc', title: 'ACC' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-acc', chatId: 'oc_g1', idempotencyKey: 'r:acc', ts: T(6), payload: { taskId: 't-acc', reportId: 'ra', summary: '做完了', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 't-acc', chatId: 'oc_g1', idempotencyKey: 'a:acc', ts: T(7), payload: { taskId: 't-acc', reportId: 'ra', checkedBy: 'ou_orch', evidenceChecked: ['/tmp/a exists'], ranCommands: ['test -f /tmp/a'] } }));
    // rejected → inProgress (retrying)
    led.append(draft({ type: 'TaskDispatched', taskId: 't-rej', chatId: 'oc_g1', idempotencyKey: 'd:rej', ts: T(8), payload: { taskId: 't-rej', title: 'REJ' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-rej', chatId: 'oc_g1', idempotencyKey: 'r:rej', ts: T(9), payload: { taskId: 't-rej', reportId: 'rr', summary: '尝试1', evidence: [{ kind: 'path', path: '/tmp/r' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 't-rej', chatId: 'oc_g1', idempotencyKey: 'x:rej', ts: T(10), payload: { taskId: 't-rej', reportId: 'rr', reason: 'check_failed' } }));
    // ── oc_g2 ────────────────────────────────────────────────────────────────
    // escalated (newer than t-esc1) → needsHuman
    led.append(draft({ type: 'TaskDispatched', taskId: 't-esc2', chatId: 'oc_g2', idempotencyKey: 'd:esc2', ts: T(11), payload: { taskId: 't-esc2', title: 'E2' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't-esc2', chatId: 'oc_g2', idempotencyKey: 'h:esc2', ts: T(12), payload: { taskId: 't-esc2', blocker: '歧义2' } }));
    led.append(draft({ type: 'TaskEscalated', taskId: 't-esc2', chatId: 'oc_g2', idempotencyKey: 'e:esc2', ts: T(13), payload: { taskId: 't-esc2', reason: '要人拍2' } }));
    // reported → readyToVerify
    led.append(draft({ type: 'TaskDispatched', taskId: 't-rep', chatId: 'oc_g2', idempotencyKey: 'd:rep', ts: T(14), payload: { taskId: 't-rep', title: 'REP' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-rep', chatId: 'oc_g2', idempotencyKey: 'r:rep', ts: T(15), payload: { taskId: 't-rep', reportId: 'rp', summary: '请验收', evidence: [{ kind: 'path', path: '/tmp/p' }] } }));
    // dispatched only → inProgress
    led.append(draft({ type: 'TaskDispatched', taskId: 't-disp', chatId: 'oc_g2', idempotencyKey: 'd:disp', ts: T(16), payload: { taskId: 't-disp', title: 'DISP' } }));
  }

  it('rolls tasks into the right buckets, flat across goals', () => {
    seedTwoGoals();
    const b = buildGoalAttentionBoard({ baseDir });
    expect(b.needsHuman.map((t) => t.taskId).sort()).toEqual(['t-esc1', 't-esc2']);
    expect(b.blocked.map((t) => t.taskId)).toEqual(['t-blk']);
    expect(b.readyToVerify.map((t) => t.taskId)).toEqual(['t-rep']);
    expect(b.inProgress.map((t) => t.taskId).sort()).toEqual(['t-disp', 't-rej']);
    expect(b.recentlyCompleted.map((t) => t.taskId)).toEqual(['t-acc']);
    expect(b.systemRisk).toEqual([]);
    expect(b.counts).toEqual({ needsHuman: 2, blocked: 1, systemRisk: 0, inProgress: 2, readyToVerify: 1, completed: 1 });
    // per-goal drill-down is preserved
    expect(b.perGoal.map((g) => g.goalChatId).sort()).toEqual(['oc_g1', 'oc_g2']);
  });

  it('orders needs-attention oldest-waiting first (across goals)', () => {
    seedTwoGoals();
    const b = buildGoalAttentionBoard({ baseDir });
    // t-esc1 escalated at T(2), t-esc2 at T(13) → oldest first
    expect(b.needsHuman.map((t) => t.taskId)).toEqual(['t-esc1', 't-esc2']);
  });

  it('carries disposition + recent-evidence per row', () => {
    seedTwoGoals();
    const b = buildGoalAttentionBoard({ baseDir });
    expect(b.blocked[0].disposition).toMatchObject({ bucket: 'blocked', reason: 'help:access' });
    // completed row keeps the verification trail (the "really done" proof)
    const acc = b.recentlyCompleted[0];
    expect(acc.recentEvidence).toMatchObject({ checkedBy: 'ou_orch', evidenceChecked: ['/tmp/a exists'], ranCommands: ['test -f /tmp/a'], latestSummary: '做完了' });
    // ready-to-verify row carries the worker's own summary
    expect(b.readyToVerify[0].recentEvidence?.latestSummary).toBe('请验收');
    // rejected row is inProgress with the retrying reason
    expect(b.inProgress.find((t) => t.taskId === 't-rej')?.disposition.reason).toBe('rejected_retrying');
  });

  it('applies supplied context → store-derived systemRisk pulls an active task out of inProgress', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-stuck', chatId: 'oc_g', idempotencyKey: 'd:stuck', ts: T(0), payload: { taskId: 't-stuck', title: 'STUCK' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-ok', chatId: 'oc_g', idempotencyKey: 'd:ok', ts: T(1), payload: { taskId: 't-ok', title: 'OK' } }));

    const b = buildGoalAttentionBoard({ baseDir, context: { reassignBudgetExhausted: new Set(['t-stuck']) } });
    expect(b.systemRisk.map((t) => t.taskId)).toEqual(['t-stuck']);
    expect(b.systemRisk[0].disposition.reason).toBe('reassign_budget_exhausted');
    expect(b.inProgress.map((t) => t.taskId)).toEqual(['t-ok']); // unaffected task stays inProgress
    expect(b.counts).toMatchObject({ systemRisk: 1, inProgress: 1 });
  });

  it('without context, a bare ledger projection has no store-derived systemRisk', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-stuck', chatId: 'oc_g', idempotencyKey: 'd:stuck', ts: T(0), payload: { taskId: 't-stuck' } }));
    const b = buildGoalAttentionBoard({ baseDir });
    expect(b.systemRisk).toEqual([]);
    expect(b.inProgress.map((t) => t.taskId)).toEqual(['t-stuck']);
  });

  it('scopes to a single goal when chatId is given', () => {
    seedTwoGoals();
    const b = buildGoalAttentionBoard({ baseDir, chatId: 'oc_g2' });
    expect(b.perGoal.map((g) => g.goalChatId)).toEqual(['oc_g2']);
    expect(b.needsHuman.map((t) => t.taskId)).toEqual(['t-esc2']); // oc_g1's escalation excluded
    expect(b.blocked).toEqual([]);
  });

  it('returns empty buckets for an empty ledger', () => {
    const b = buildGoalAttentionBoard({ baseDir });
    expect(b.counts).toEqual({ needsHuman: 0, blocked: 0, systemRisk: 0, inProgress: 0, readyToVerify: 0, completed: 0 });
    expect(b.perGoal).toEqual([]);
  });
});
