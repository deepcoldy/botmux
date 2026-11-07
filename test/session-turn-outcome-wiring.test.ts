import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const pool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

// 源码结构护栏：本轮结果的判定在 core/turn-outcome.ts 里有行为测试，这里只钉住散在 worker /
// worker-pool / daemon 巨型闭包里、没有可调用入口的接线。
describe('turn outcome wiring', () => {
  it('the worker marks the empty-completion diagnostic on every final_output it sends', () => {
    const marks = worker.match(/\.\.\.\(fallbackKind === 'empty_completed' \? \{ emptyCompletedNotice: true \} : \{\}\)/g) ?? [];
    expect(marks).toHaveLength(2);
  });

  it('a failure card delivered on the final channel is never noted as the final reply', () => {
    const guard = pool.indexOf('if (messageId && !managedReceiver && !msg.turnFailed) {');
    expect(guard).toBeGreaterThan(-1);
    expect(pool.indexOf('if (msg.emptyCompletedNotice) {', guard) - guard).toBeLessThan(120);
    expect(pool.match(/noteFinalReplyText\(ds, msg\.turnId/g) ?? []).toHaveLength(1);
  });

  it('the daemon never counts the diagnostic as the final reply of the turn', () => {
    const branch = pool.indexOf('if (msg.emptyCompletedNotice) {');
    expect(branch).toBeGreaterThan(-1);
    const block = pool.slice(branch, pool.indexOf('}\n      }', branch));
    expect(block).toContain('noteDiagnosticFinal(ds, msg.turnId);');
    const [diagnostic, answer] = block.split('} else {');
    expect(diagnostic).not.toMatch(/noteFinalReplyText|noteLateFinalReply/);
    expect(answer).toContain('noteFinalReplyText(ds, msg.turnId');
    expect(answer).toContain('noteLateFinalReply(ds, msg.turnId);');
  });

  it('auto-compact turns are excluded before the outcome is recorded', () => {
    const excluded = pool.indexOf('const outcomeExcluded = isMaintenanceTurnId(msg.turnId)');
    const record = pool.indexOf('if (!outcomeExcluded && !nonLarkFailureHandled && !ordinaryHttpTerminal) {', excluded);
    expect(excluded).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(excluded);
    expect(pool.slice(record, record + 200)).toContain('void recordTurnOutcome(ds, msg, {');
  });

  it('an explicit final reply observed later still upgrades the turn', () => {
    expect(pool).toContain("if (msg.responseKind === 'final') noteLateFinalReply(ds, msg.turnId);");
  });

  it('the auto-compact passthrough holds the current result before it bumps session activity', () => {
    const hold = daemon.indexOf('if (isMaintenanceTurnId(turnId)) holdLastTurnThrough(ds, activityAt);');
    const mark = daemon.indexOf('markSessionActivity(ds, activityAt);', hold);
    expect(hold).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(hold);
    expect(daemon.slice(hold - 200, hold)).toContain('const activityAt = Date.now();');
  });

  it('only the agent attention route marks a raised hand as the agent asking', () => {
    expect(daemon.match(/source: 'agent'/g) ?? []).toHaveLength(1);
  });

  it('every dispatched turn records its start time', () => {
    const begin = daemon.indexOf('function beginNewTurn(ds: DaemonSession, title: string, turnId: string): void {');
    expect(begin).toBeGreaterThan(-1);
    expect(daemon.slice(begin, begin + 160)).toContain('noteTurnStarted(ds, turnId);');
  });

  it('final delivery retries keep the first raise instead of re-stamping it', () => {
    expect(pool).not.toMatch(/reason: FINAL_HANDOFF_DELIVERY_REASON, at: Date\.now\(\)/);
    expect(pool.match(/raiseDaemonAttention\(ds, 'blocked', FINAL_HANDOFF_DELIVERY_REASON\)/g) ?? []).toHaveLength(2);
    expect(pool).toContain('raiseDaemonAttention(ds, \'blocked\', `Durable final output is ambiguous: ${durableDelivery.error}`)');
    expect(pool).toContain("if (raiseDaemonAttention(ds, 'blocked', err.message)) publishAttentionPatch(ds);");
  });
});
