import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { verifyAcceptanceCriteria, reconcileTaskByCriteria, type AcceptanceVerifyResult } from '../src/verified-delivery/reconcile.js';
import type { AcceptanceCriteria, LedgerEventDraft } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}
const pass = (): AcceptanceVerifyResult => ({ passed: true, checks: [{ kind: 'exists', target: '/x', ok: true }], evidenceChecked: ['/x'], ranCommands: [] });
const fail = (): AcceptanceVerifyResult => ({ passed: false, checks: [{ kind: 'exists', target: '/x', ok: false, detail: '路径不存在' }], evidenceChecked: ['/x'], ranCommands: [] });

describe('verifyAcceptanceCriteria — mechanical checks', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vd-verify-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('exists check: passes when present, fails when absent', () => {
    const f = join(dir, 'a.txt'); writeFileSync(f, 'hi');
    const ok = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: f, checks: [{ type: 'exists' }] }] });
    expect(ok.passed).toBe(true);
    expect(ok.evidenceChecked).toEqual([f]);
    const bad = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: join(dir, 'nope'), checks: [{ type: 'exists' }] }] });
    expect(bad.passed).toBe(false);
    expect(bad.checks[0].detail).toContain('不存在');
  });

  it('contains check: substring match, and fails on missing file / missing text', () => {
    const f = join(dir, 'b.txt'); writeFileSync(f, 'DEMO-OK marker here');
    const ok = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: f, checks: [{ type: 'contains', text: 'DEMO-OK' }] }] });
    expect(ok.passed).toBe(true);
    const noText = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: f, checks: [{ type: 'contains', text: 'ABSENT' }] }] });
    expect(noText.passed).toBe(false);
    const missing = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: join(dir, 'gone'), checks: [{ type: 'contains', text: 'x' }] }] });
    expect(missing.passed).toBe(false);
  });

  it('contains check on a directory fails with a clear detail', () => {
    const sub = join(dir, 'd'); mkdirSync(sub);
    const r = verifyAcceptanceCriteria({ version: 1, artifacts: [{ path: sub, checks: [{ type: 'contains', text: 'x' }] }] });
    expect(r.passed).toBe(false);
    expect(r.checks[0].detail).toContain('目录');
  });

  it('command check: exit code compared to expectExitCode (default 0)', () => {
    const ok = verifyAcceptanceCriteria({ version: 1, commands: [{ cmd: 'exit 0' }] });
    expect(ok.passed).toBe(true);
    expect(ok.ranCommands).toEqual(['exit 0']);
    const bad = verifyAcceptanceCriteria({ version: 1, commands: [{ cmd: 'exit 3' }] });
    expect(bad.passed).toBe(false);
    expect(bad.checks[0].detail).toContain('退出码 3');
    const expectsThree = verifyAcceptanceCriteria({ version: 1, commands: [{ cmd: 'exit 3', expectExitCode: 3 }] });
    expect(expectsThree.passed).toBe(true);
  });

  it('all-or-nothing: one failing check fails the whole verify', () => {
    const f = join(dir, 'c.txt'); writeFileSync(f, 'ok');
    const r = verifyAcceptanceCriteria({
      version: 1,
      artifacts: [{ path: f, checks: [{ type: 'exists' }] }],
      commands: [{ cmd: 'exit 1' }],
    });
    expect(r.passed).toBe(false);
    expect(r.checks.filter((c) => c.ok)).toHaveLength(1);
    expect(r.checks.filter((c) => !c.ok)).toHaveLength(1);
  });
});

describe('reconcileTaskByCriteria — verify → ledger events', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-recon-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  const CRIT: AcceptanceCriteria = { version: 1, artifacts: [{ path: '/tmp/vd-demo/x.txt', checks: [{ type: 'exists' }] }] };
  function dispatched(taskId = 't1', extra: Partial<{ workerOpenIds: string[] }> = {}) {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId, chatId: 'oc_g', idempotencyKey: `dispatched:${taskId}`, payload: { taskId, acceptanceCriteria: CRIT, ...extra } }));
    return led;
  }

  it('unknown task → unknown-task, no write', () => {
    const led = openLedger({ baseDir });
    expect(reconcileTaskByCriteria(led, 'nope', { checkedBy: 'sup', now: TS }).action).toBe('unknown-task');
    expect(led.read()).toHaveLength(0);
  });

  it('legacy task without structured criteria → no-criteria (caller falls back to LLM)', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-legacy', chatId: 'oc_g', idempotencyKey: 'd', payload: { taskId: 't-legacy', acceptanceHint: 'just words' } }));
    const r = reconcileTaskByCriteria(led, 't-legacy', { checkedBy: 'sup', now: TS });
    expect(r.action).toBe('no-criteria');
    expect(led.read()).toHaveLength(1); // nothing appended
  });

  it('dispatched + verify pass but NO worker report → unreported-pass, writes NOTHING (defers to supervisor)', () => {
    // The bug 老滕 caught: a stray/leftover file satisfying the criteria must NOT be
    // auto-stamped as a completion. The mechanical layer surfaces a fact and leaves
    // the accept call to the supervisor (L2).
    const led = dispatched('t1', { workerOpenIds: ['ou_worker'] });
    const before = led.read().length;
    const r = reconcileTaskByCriteria(led, 't1', { checkedBy: 'ou_sup', now: TS, verify: pass });
    expect(r.action).toBe('unreported-pass');
    expect(r.verify?.passed).toBe(true);
    expect(r.inspectionFact).toContain('未走 botmux report'); // the fact handed to L2
    expect(r.inspectionFact).toContain('代办'); // and the options it must choose among
    expect(led.read()).toHaveLength(before); // mechanical layer fabricates no report/accept
    expect(led.task('t1')!.status).toBe('dispatched'); // still pending — supervisor owns the call
  });

  it('dispatched + verify fail → nudge, nothing written, surfaces a "尚无有效交付" fact for L2', () => {
    const led = dispatched('t2');
    const before = led.read().length;
    const r = reconcileTaskByCriteria(led, 't2', { checkedBy: 'sup', now: TS, verify: fail });
    expect(r.action).toBe('nudge');
    expect(r.verify?.passed).toBe(false);
    expect(led.read()).toHaveLength(before); // no fabricated failed report
    expect(led.task('t2')!.status).toBe('dispatched');
    // The mechanical layer no longer @s the worker; it hands L2 a fact to act on.
    expect(r.inspectionFact).toContain('尚无有效交付');
    expect(r.inspectionFact).toContain('不要机械重复催促');
  });

  it('rejected + still failing + worker has not re-reported → nudge with a "已被驳回、尚未重新 report" fact (no perpetual @worker)', () => {
    // Reproduce 老滕's bug: a task driven to rejected that the worker hasn't re-delivered
    // must NOT be mechanically nagged every tick — it returns to L2 with context.
    const led = dispatched('t-rej');
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-rej', chatId: 'oc_g', idempotencyKey: 'reported:t-rej-r1', payload: { taskId: 't-rej', reportId: 't-rej-r1', summary: 'try', evidence: [{ kind: 'path', path: '/tmp/vd-demo/x.txt' }] } }));
    reconcileTaskByCriteria(led, 't-rej', { checkedBy: 'sup', now: TS, verify: fail }); // → rejects r1
    expect(led.task('t-rej')!.status).toBe('rejected');
    const before = led.read().length;
    const r = reconcileTaskByCriteria(led, 't-rej', { checkedBy: 'sup', now: TS, verify: fail }); // re-run, no new report
    expect(r.action).toBe('nudge');
    expect(led.read()).toHaveLength(before); // idempotent, no fabricated event
    expect(r.inspectionFact).toContain('已被驳回');
    expect(r.inspectionFact).toContain('尚未重新 report');
  });

  it('worker reported + verify pass → accepts the existing report (no synthetic report)', () => {
    const led = dispatched('t3');
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't3', chatId: 'oc_g', idempotencyKey: 'reported:t3-r1', payload: { taskId: 't3', reportId: 't3-r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/vd-demo/x.txt' }] } }));
    const r = reconcileTaskByCriteria(led, 't3', { checkedBy: 'sup', now: TS, verify: pass });
    expect(r.action).toBe('accepted');
    expect(r.reportId).toBe('t3-r1');
    const task = led.task('t3')!;
    expect(task.reports).toHaveLength(1); // reused existing, no synthesis
    expect(task.status).toBe('accepted');
  });

  it('worker reported + verify fail → rejects the existing report with check_failed', () => {
    const led = dispatched('t4');
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't4', chatId: 'oc_g', idempotencyKey: 'reported:t4-r1', payload: { taskId: 't4', reportId: 't4-r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/vd-demo/x.txt' }] } }));
    const r = reconcileTaskByCriteria(led, 't4', { checkedBy: 'sup', now: TS, verify: fail });
    expect(r.action).toBe('rejected');
    const task = led.task('t4')!;
    expect(task.status).toBe('rejected');
    expect(task.reports[0].verdict).toBe('rejected');
    expect(task.reports[0].reason).toBe('check_failed');
    expect(task.reports[0].verdictVia).toBe('reconcile');
  });

  it('idempotent: re-running an accepted task does nothing', () => {
    const led = dispatched('t5');
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't5', chatId: 'oc_g', idempotencyKey: 'reported:t5-r1', payload: { taskId: 't5', reportId: 't5-r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/vd-demo/x.txt' }] } }));
    expect(reconcileTaskByCriteria(led, 't5', { checkedBy: 'sup', now: TS, verify: pass }).action).toBe('accepted');
    const after = led.read().length;
    const again = reconcileTaskByCriteria(led, 't5', { checkedBy: 'sup', now: TS + 1, verify: pass });
    expect(again.action).toBe('already-accepted');
    expect(led.read()).toHaveLength(after); // no new events
  });

  it('end-to-end with real files: worker reported + reconcile auto-accepts on real artifacts', () => {
    const led = openLedger({ baseDir });
    const dirReal = mkdtempSync(join(tmpdir(), 'vd-real-'));
    const file = join(dirReal, 'codex.txt'); writeFileSync(file, 'DEMO-CODEX-OK');
    const crit: AcceptanceCriteria = { version: 1, artifacts: [{ path: file, checks: [{ type: 'exists' }, { type: 'contains', text: 'DEMO-CODEX-OK' }] }] };
    led.append(draft({ type: 'TaskDispatched', taskId: 't-e2e', chatId: 'oc_g', idempotencyKey: 'dispatched:t-e2e', payload: { taskId: 't-e2e', acceptanceCriteria: crit, workerOpenIds: ['ou_codex'] } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 't-e2e', chatId: 'oc_g', idempotencyKey: 'reported:t-e2e-r1', payload: { taskId: 't-e2e', reportId: 't-e2e-r1', summary: 'done', evidence: [{ kind: 'path', path: file }] } }));
    const r = reconcileTaskByCriteria(led, 't-e2e', { checkedBy: 'ou_sup', now: TS });
    expect(r.action).toBe('accepted');
    expect(r.verify?.passed).toBe(true);
    expect(led.task('t-e2e')!.status).toBe('accepted');
    rmSync(dirReal, { recursive: true, force: true });
  });

  it('end-to-end with real files: artifacts pass but worker never reported → unreported-pass, no write', () => {
    const led = openLedger({ baseDir });
    const dirReal = mkdtempSync(join(tmpdir(), 'vd-real2-'));
    const file = join(dirReal, 'codex.txt'); writeFileSync(file, 'DEMO-CODEX-OK');
    const crit: AcceptanceCriteria = { version: 1, artifacts: [{ path: file, checks: [{ type: 'exists' }, { type: 'contains', text: 'DEMO-CODEX-OK' }] }] };
    led.append(draft({ type: 'TaskDispatched', taskId: 't-e2e2', chatId: 'oc_g', idempotencyKey: 'dispatched:t-e2e2', payload: { taskId: 't-e2e2', acceptanceCriteria: crit, workerOpenIds: ['ou_codex'] } }));
    const before = led.read().length;
    const r = reconcileTaskByCriteria(led, 't-e2e2', { checkedBy: 'ou_sup', now: TS });
    expect(r.action).toBe('unreported-pass'); // real artifacts, but no worker delivery → defer to L2
    expect(r.verify?.passed).toBe(true);
    expect(led.read()).toHaveLength(before); // nothing fabricated
    expect(led.task('t-e2e2')!.status).toBe('dispatched');
    rmSync(dirReal, { recursive: true, force: true });
  });
});
