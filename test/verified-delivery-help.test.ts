import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { buildGoalBoard } from '../src/verified-delivery/goal-board.js';
import { reconcileTaskByCriteria } from '../src/verified-delivery/reconcile.js';
import type { AcceptanceCriteria, LedgerEventDraft } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}
const CRIT: AcceptanceCriteria = { version: 1, artifacts: [{ path: '/tmp/vd-x/x.txt', checks: [{ type: 'exists' }] }] };

describe('help / escalation ledger semantics', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-help-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  function dispatched(taskId = 't1') {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId, chatId: 'oc_g', idempotencyKey: `dispatched:${taskId}`, payload: { taskId, acceptanceCriteria: CRIT } }));
    return led;
  }

  it('TaskHelpRequested → status blocked + help recorded', () => {
    const led = dispatched();
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'help:t1:1', payload: { taskId: 't1', workerOpenId: 'ou_w', blocker: '缺仓库权限', kind: 'access' } }));
    const t = led.task('t1')!;
    expect(t.status).toBe('blocked');
    expect(t.help).toEqual({ blocker: '缺仓库权限', kind: 'access', workerOpenId: 'ou_w' });
  });

  it('TaskEscalated → status escalated + escalation recorded', () => {
    const led = dispatched();
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'help:t1:1', payload: { taskId: 't1', blocker: '需求有歧义' } }));
    led.append(draft({ type: 'TaskEscalated', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'escalated:t1', payload: { taskId: 't1', reason: '要改需求范围,只有人能拍', by: 'goal-watchdog', retryBrief: '请确认是否扩大到 X' } }));
    const t = led.task('t1')!;
    expect(t.status).toBe('escalated');
    expect(t.escalation).toEqual({ reason: '要改需求范围,只有人能拍', by: 'goal-watchdog', retryBrief: '请确认是否扩大到 X' });
    expect(t.help?.blocker).toBe('需求有歧义'); // help record survives alongside escalation
  });

  it('re-dispatch after blocked/escalated clears back to dispatched', () => {
    const led = dispatched();
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'help:t1:1', payload: { taskId: 't1', blocker: 'b' } }));
    led.append(draft({ type: 'TaskEscalated', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'escalated:t1', payload: { taskId: 't1', reason: 'r' } }));
    expect(led.task('t1')!.status).toBe('escalated');
    // supervisor/human addressed it → re-dispatch with a clarified brief
    led.append(draft({ type: 'TaskDispatched', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'dispatched:t1:redo', payload: { taskId: 't1', brief: '已补权限,重做' } }));
    expect(led.task('t1')!.status).toBe('dispatched');
  });

  it('worker can recover: blocked → report → reported', () => {
    const led = dispatched();
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'help:t1:1', payload: { taskId: 't1', blocker: 'b' } }));
    expect(led.task('t1')!.status).toBe('blocked');
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'reported:t1-r1', payload: { taskId: 't1', reportId: 't1-r1', summary: '自己解决了', evidence: [{ kind: 'path', path: '/tmp/x' }] } }));
    expect(led.task('t1')!.status).toBe('reported');
  });

  it('a late help does NOT drag a terminal (accepted) task back to blocked', () => {
    const led = dispatched();
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'reported:t1-r1', payload: { taskId: 't1', reportId: 't1-r1', summary: 's', evidence: [{ kind: 'path', path: '/tmp/x' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'accepted:t1:t1-r1', payload: { taskId: 't1', reportId: 't1-r1', checkedBy: 'sup' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't1', chatId: 'oc_g', idempotencyKey: 'help:t1:late', payload: { taskId: 't1', blocker: '迟到的求助' } }));
    expect(led.task('t1')!.status).toBe('accepted'); // terminal holds
    expect(led.task('t1')!.help?.blocker).toBe('迟到的求助'); // record still kept
  });

  it('reconcile SKIPS blocked/escalated tasks (help is not a failed delivery)', () => {
    const led = dispatched('tb');
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 'tb', chatId: 'oc_g', idempotencyKey: 'help:tb', payload: { taskId: 'tb', blocker: 'b' } }));
    const before = led.read().length;
    const rb = reconcileTaskByCriteria(led, 'tb', { checkedBy: 'sup', now: TS, verify: () => ({ passed: false, checks: [], evidenceChecked: [], ranCommands: [] }) });
    expect(rb.action).toBe('blocked');
    expect(led.read()).toHaveLength(before); // never verified, never wrote a reject

    led.append(draft({ type: 'TaskEscalated', taskId: 'tb', chatId: 'oc_g', idempotencyKey: 'escalated:tb', payload: { taskId: 'tb', reason: 'r' } }));
    const re = reconcileTaskByCriteria(led, 'tb', { checkedBy: 'sup', now: TS });
    expect(re.action).toBe('escalated');
  });

  it('goal-board surfaces help/escalation, counts them, and sorts them to the top', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-acc', chatId: 'oc_g', idempotencyKey: 'd:acc', payload: { taskId: 't-acc' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-acc', chatId: 'oc_g', idempotencyKey: 'r:acc', payload: { taskId: 't-acc', reportId: 'ra', summary: 's', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 't-acc', chatId: 'oc_g', idempotencyKey: 'a:acc', payload: { taskId: 't-acc', reportId: 'ra', checkedBy: 'sup' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-blk', chatId: 'oc_g', idempotencyKey: 'd:blk', payload: { taskId: 't-blk' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't-blk', chatId: 'oc_g', idempotencyKey: 'h:blk', payload: { taskId: 't-blk', blocker: '没权限', kind: 'access', workerOpenId: 'ou_w' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-esc', chatId: 'oc_g', idempotencyKey: 'd:esc', payload: { taskId: 't-esc' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 't-esc', chatId: 'oc_g', idempotencyKey: 'h:esc', payload: { taskId: 't-esc', blocker: '歧义' } }));
    led.append(draft({ type: 'TaskEscalated', taskId: 't-esc', chatId: 'oc_g', idempotencyKey: 'e:esc', payload: { taskId: 't-esc', reason: '要人拍', by: 'goal-watchdog' } }));

    const g = buildGoalBoard({ baseDir, chatId: 'oc_g' }).goals[0];
    expect(g.counts).toMatchObject({ accepted: 1, blocked: 1, escalated: 1, total: 3 });
    // escalated (waiting human) sorts first, then blocked, then accepted (terminal)
    expect(g.tasks.map((t) => t.taskId)).toEqual(['t-esc', 't-blk', 't-acc']);
    const blk = g.tasks.find((t) => t.taskId === 't-blk')!;
    expect(blk.help).toEqual({ blocker: '没权限', kind: 'access', workerOpenId: 'ou_w' });
    const esc = g.tasks.find((t) => t.taskId === 't-esc')!;
    expect(esc.escalation).toMatchObject({ reason: '要人拍', by: 'goal-watchdog' });
  });
});
