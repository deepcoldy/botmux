import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stored: new Map<string, { status: string }>(),
  failNextUpdate: false,
  writes: [] as unknown[],
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/nonexistent-test-data-dir' } } }));
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => h.stored.get(id),
  updateSession: (session: { sessionId: string; lastTurn?: unknown }) => {
    if (h.failNextUpdate) {
      h.failNextUpdate = false;
      throw new Error('disk full');
    }
    h.writes.push(structuredClone(session.lastTurn));
  },
}));

import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import { deriveSessionTaskStatus } from '../src/core/session-task-status.js';
import {
  classifyTurnOutcome,
  holdLastTurnThrough,
  isMaintenanceTurnId,
  isTurnOutcomeExcluded,
  noteDiagnosticFinal,
  noteFinalOutputReceipt,
  noteFinalReplyText,
  noteLateFinalReply,
  noteTurnStarted,
  readFinalSendPreview,
  recordTurnOutcome,
} from '../src/core/turn-outcome.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import type { DaemonSession } from '../src/core/types.js';
import { onSessionTaskEvent, type SessionTaskEvent } from '../src/core/session-task-events.js';
import { markPassthroughActivity, publishAttentionPatch } from '../src/core/session-activity.js';
import { activeManualColumn, deriveKanbanColumn } from '../src/dashboard/web/kanban-model.js';

const dataDir = mkdtempSync(join(tmpdir(), 'turn-outcome-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let clock = 1_800_000_000_000;
const now = () => clock;

function makeDs(sessionId: string, extra: Record<string, unknown> = {}): DaemonSession {
  h.stored.set(sessionId, { status: 'active' });
  return {
    session: { sessionId, status: 'active', ...extra },
    lastMessageAt: clock - 1_000,
  } as unknown as DaemonSession;
}

const patches: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
dashboardEventBus.subscribe(event => {
  if (event.type === 'session.update' && 'lastTurn' in ((event.body as { patch?: object }).patch ?? {})) patches.push(event.body as never);
});
const taskEvents: SessionTaskEvent[] = [];
onSessionTaskEvent(e => { taskEvents.push(e); });

beforeEach(() => {
  h.stored.clear();
  h.writes.length = 0;
  h.failNextUpdate = false;
  patches.length = 0;
  taskEvents.length = 0;
  clock += 60_000;
});

describe('classifyTurnOutcome', () => {
  it('completed is delivered only with a final reply receipt', () => {
    expect(classifyTurnOutcome({ turnId: 't', status: 'completed' }, { recoveryHandled: false, finalDelivered: true })).toBe('delivered');
    expect(classifyTurnOutcome({ turnId: 't', status: 'completed' }, { recoveryHandled: false, finalDelivered: false })).toBe('no_output');
  });

  it('failures the group is told about are interrupted; recovery-owned and user aborts are not', () => {
    expect(classifyTurnOutcome({ turnId: 't', status: 'failed', errorCode: 'api_error' }, { recoveryHandled: false, finalDelivered: false })).toBe('interrupted');
    expect(classifyTurnOutcome({ turnId: 't', status: 'failed' }, { recoveryHandled: true, finalDelivered: false })).toBe('no_output');
    expect(classifyTurnOutcome({ turnId: 't', status: 'cancelled' }, { recoveryHandled: false, finalDelivered: false })).toBe('no_output');
    expect(classifyTurnOutcome({ turnId: 't', status: 'ambiguous', errorCode: 'pi_turn_aborted' }, { recoveryHandled: false, finalDelivered: false })).toBe('no_output');
    expect(classifyTurnOutcome({ turnId: 't', status: 'ambiguous' }, { recoveryHandled: false, finalDelivered: false })).toBe('interrupted');
  });
});

describe('recordTurnOutcome', () => {
  it('waits for the daemon final delivery of the same turn before deciding', async () => {
    const ds = makeDs('s-drain');
    let delivered = false;
    const finish = beginFinalOutputDelivery(ds, 't1');
    const pending = recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => delivered, now, dataDir,
    });
    await new Promise(r => setTimeout(r, 5));
    expect(ds.session.lastTurn).toBeUndefined();
    noteFinalReplyText(ds, 't1', '## 已修好登录超时\n细节…');
    delivered = true;
    finish();
    const lastTurn = await pending;
    expect(lastTurn).toEqual({ turnId: 't1', outcome: 'delivered', at: clock, summary: '已修好登录超时' });
    expect(ds.session.lastTurn).toEqual(lastTurn);
    expect(h.writes).toEqual([lastTurn]);
    expect(patches).toEqual([{ sessionId: 's-drain', patch: { lastTurn } }]);
  });

  it('records no output when the final reply never lands within the wait', async () => {
    const ds = makeDs('s-timeout');
    beginFinalOutputDelivery(ds, 't1');
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, drainTimeoutMs: 20, dataDir,
    });
    expect(lastTurn?.outcome).toBe('no_output');
    expect(deriveSessionTaskStatus({ status: 'idle', lastTurn }).kind).toBe('idle');
  });

  it('an older terminal finishing its wait late does not overwrite a newer turn', async () => {
    const ds = makeDs('s-seq');
    const finish = beginFinalOutputDelivery(ds, 't1');
    const older = recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    const newer = await recordTurnOutcome(ds, { turnId: 't2', status: 'failed', errorCode: 'api_error' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    finish();
    expect(await older).toBeUndefined();
    expect(newer).toMatchObject({ turnId: 't2', outcome: 'interrupted', errorCode: 'api_error' });
    expect(ds.session.lastTurn).toEqual(newer);
  });

  it('does not write into a session that closed while waiting', async () => {
    const ds = makeDs('s-closed');
    const finish = beginFinalOutputDelivery(ds, 't1');
    const pending = recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    h.stored.set('s-closed', { status: 'closed' });
    finish();
    expect(await pending).toBeUndefined();
    expect(ds.session.lastTurn).toBeUndefined();
    expect(h.writes).toEqual([]);
    expect(patches).toEqual([]);
  });

  it('rolls back the in-memory result when saving fails', async () => {
    const previous = { turnId: 't0', outcome: 'delivered', at: clock - 5 };
    const ds = makeDs('s-fail', { lastTurn: previous });
    h.failNextUpdate = true;
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'failed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    expect(lastTurn).toBeUndefined();
    expect(ds.session.lastTurn).toEqual(previous);
    expect(patches).toEqual([]);
  });

  it('falls back to the final send preview recorded for the same turn', async () => {
    const ds = makeDs('s-preview');
    mkdirSync(join(dataDir, 'turn-sends'), { recursive: true });
    writeFileSync(join(dataDir, 'turn-sends', 's-preview.jsonl'), [
      JSON.stringify({ turnId: 't1', responseKind: 'progress', previewText: '进度' }),
      JSON.stringify({ turnId: 't1', responseKind: 'final', previewText: '**结论**：可以合入' }),
      JSON.stringify({ turnId: 't0', responseKind: 'final', previewText: '上一轮' }),
      '{"turnId":"t1","respo',
    ].join('\n'));
    expect(readFinalSendPreview(dataDir, 's-preview', 't1')).toBe('结论：可以合入');
    expect(readFinalSendPreview(dataDir, 's-preview', 't9')).toBeUndefined();
    expect(readFinalSendPreview(dataDir, 's-missing', 't1')).toBeUndefined();
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    expect(lastTurn?.summary).toBe('结论：可以合入');
  });

  it('a completed turn whose only final is the empty-completion diagnostic is not delivered', async () => {
    const ds = makeDs('s-diag');
    noteDiagnosticFinal(ds, 't1');
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    expect(lastTurn?.outcome).toBe('no_output');
    // 模型自己的最终回复晚到，仍然补登成已交付。
    expect(noteLateFinalReply(ds, 't1', { now, dataDir })?.outcome).toBe('delivered');
  });

  it('a diagnostic after the real answer of the same turn does not take the receipt away', async () => {
    const ds = makeDs('s-diag-after');
    noteFinalReplyText(ds, 't1', '结论：可以合入');
    noteDiagnosticFinal(ds, 't1');
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    expect(lastTurn).toMatchObject({ outcome: 'delivered', summary: '结论：可以合入' });
  });

  it('the summary of a reply recovered after restart skips the recovery notice line', async () => {
    const ds = makeDs('s-restored');
    noteFinalReplyText(ds, 't1', `${zhMessages['worker.bridge_restored_turn_notice']}\n\n## 登录超时已修好`);
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    expect(lastTurn?.summary).toBe('登录超时已修好');
  });

  it('a turn that ends with no output and no new message keeps the current result', async () => {
    const delivered = { turnId: 't1', outcome: 'delivered', at: clock - 10, summary: '上一轮结论' };
    const ds = makeDs('s-keepalive', { lastTurn: delivered });
    expect(await recordTurnOutcome(ds, { turnId: 'local-keepalive', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    })).toBeUndefined();
    expect(ds.session.lastTurn).toEqual(delivered);
    expect(h.writes).toEqual([]);
  });

  it('after a new message a no-output turn does replace the old result', async () => {
    const ds = makeDs('s-new-input', { lastTurn: { turnId: 't1', outcome: 'delivered', at: clock - 10 } });
    ds.lastMessageAt = clock - 5;
    const lastTurn = await recordTurnOutcome(ds, { turnId: 't2', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    expect(lastTurn).toMatchObject({ turnId: 't2', outcome: 'no_output' });
  });

  it('a held-back no-output turn is still upgraded when its final reply arrives late', async () => {
    const ds = makeDs('s-held-late', { lastTurn: { turnId: 't1', outcome: 'delivered', at: clock - 10 } });
    await recordTurnOutcome(ds, { turnId: 'scheduled-1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    noteFinalReplyText(ds, 'scheduled-1', '定时巡检：一切正常');
    expect(noteLateFinalReply(ds, 'scheduled-1', { now, dataDir })).toMatchObject({
      turnId: 'scheduled-1', outcome: 'delivered', summary: '定时巡检：一切正常',
    });
  });

  it('skips meeting receiver sessions', async () => {
    const ds = makeDs('s-vc', { vcMeetingReceiver: true });
    expect(await recordTurnOutcome(ds, { turnId: 't1', status: 'failed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    })).toBeUndefined();
  });

  it('a follow-up that started before the previous result settled replaces it even with no output', async () => {
    const ds = makeDs('s-follow-up');
    noteTurnStarted(ds, 't1', clock - 30);
    const finish = beginFinalOutputDelivery(ds, 't1');
    const first = recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    });
    // 上一轮还在等投递落地时，用户追发了一句，开了新一轮。
    ds.lastMessageAt = clock - 5;
    noteTurnStarted(ds, 't2', clock - 5);
    finish();
    expect(await first).toMatchObject({ turnId: 't1', outcome: 'delivered', startedAt: clock - 30, at: clock });
    clock += 1_000;
    const second = await recordTurnOutcome(ds, { turnId: 't2', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    expect(second).toEqual({ turnId: 't2', outcome: 'no_output', at: clock, startedAt: clock - 1_005 });
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: ds.lastMessageAt, lastTurn: second }).kind).toBe('idle');
  });

  it('a turn started after the current result with no new message is still held back', async () => {
    const delivered = { turnId: 't1', outcome: 'delivered', at: clock - 10, summary: '上一轮结论' };
    const ds = makeDs('s-later-start', { lastTurn: delivered });
    noteTurnStarted(ds, 'scheduled-2', clock - 5);
    expect(await recordTurnOutcome(ds, { turnId: 'scheduled-2', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    })).toBeUndefined();
    expect(ds.session.lastTurn).toEqual(delivered);
  });
});

describe('noteLateFinalReply', () => {
  it('upgrades the same completed turn from no output to delivered', async () => {
    const ds = makeDs('s-late');
    await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
    });
    clock += 1_000;
    noteFinalReplyText(ds, 't1', '补发的结论');
    const lastTurn = noteLateFinalReply(ds, 't1', { now, dataDir });
    expect(lastTurn).toEqual({ turnId: 't1', outcome: 'delivered', at: clock, summary: '补发的结论' });
    expect(patches).toHaveLength(2);
  });

  it('leaves other turns, other outcomes and superseded turns alone', async () => {
    const record = (ds: DaemonSession, status: 'completed' | 'failed', errorCode?: string) => recordTurnOutcome(ds, {
      turnId: 't1', status, ...(errorCode ? { errorCode } : {}),
    }, { recoveryHandled: false, isFinalDelivered: () => false, now, dataDir });
    const other = makeDs('s-other');
    await record(other, 'completed');
    expect(noteLateFinalReply(other, 't2', { now, dataDir })).toBeUndefined();
    const interrupted = makeDs('s-int');
    await record(interrupted, 'failed', 'api_error');
    expect(noteLateFinalReply(interrupted, 't1', { now, dataDir })).toBeUndefined();
    const superseded = makeDs('s-new-msg');
    await record(superseded, 'completed');
    superseded.lastMessageAt = clock + 1;
    expect(noteLateFinalReply(superseded, 't1', { now, dataDir })).toBeUndefined();
    expect(h.writes.every(w => (w as { outcome: string }).outcome !== 'delivered')).toBe(true);
  });

  it('a reply landing for a failed turn is not upgraded to delivered', async () => {
    const ds = makeDs('s-late-failed');
    // 续跑接管的失败记成「无最终输出」；之后送达的是失败提示，不是交付。
    expect(await recordTurnOutcome(ds, { turnId: 't1', status: 'failed', errorCode: 'api_error' }, {
      recoveryHandled: true, isFinalDelivered: () => false, now, dataDir,
    })).toMatchObject({ outcome: 'no_output' });
    expect(noteLateFinalReply(ds, 't1', { now, dataDir })).toBeUndefined();
    expect(ds.session.lastTurn).toMatchObject({ turnId: 't1', outcome: 'no_output' });
  });

  it('without the terminal of that turn (daemon restarted) nothing is upgraded', () => {
    const ds = makeDs('s-late-restart', { lastTurn: { turnId: 't1', outcome: 'no_output', at: clock - 10 } });
    expect(noteLateFinalReply(ds, 't1', { now, dataDir })).toBeUndefined();
  });
});

describe('holdLastTurnThrough', () => {
  it('auto-compact activity does not push the current result out', () => {
    const ds = makeDs('s-hold', { chatId: 'oc_a', lastTurn: { turnId: 't1', outcome: 'delivered', at: clock - 10 } });
    expect(isMaintenanceTurnId('auto-compact:lx1')).toBe(true);
    expect(isMaintenanceTurnId('auto-compact:idle:lx1')).toBe(true);
    expect(isMaintenanceTurnId('om_123')).toBe(false);
    const held = holdLastTurnThrough(ds, clock);
    expect(held).toEqual({ turnId: 't1', outcome: 'delivered', at: clock - 10, heldThrough: clock });
    expect(patches).toEqual([{ sessionId: 's-hold', patch: { lastTurn: held } }]);
    // 续期不是新结果，不再通知管家。
    expect(taskEvents).toEqual([]);
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: clock, lastTurn: held }).kind).toBe('delivered');
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: clock + 1, lastTurn: held }).kind).toBe('idle');
  });

  it('does not revive a result that a newer message already superseded', () => {
    const ds = makeDs('s-hold-stale', { lastTurn: { turnId: 't1', outcome: 'delivered', at: clock - 10 } });
    ds.lastMessageAt = clock - 5;
    expect(holdLastTurnThrough(ds, clock)).toBeUndefined();
    expect(h.writes).toEqual([]);
  });
});

describe('noteFinalOutputReceipt', () => {
  const completedWithoutReceipt = (ds: DaemonSession) => recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
    recoveryHandled: false, isFinalDelivered: () => false, now, dataDir,
  });

  it('a reply on the final channel upgrades the same turn with its first line', async () => {
    const ds = makeDs('s-receipt');
    await completedWithoutReceipt(ds);
    clock += 1_000;
    noteFinalOutputReceipt(ds, 't1', { text: '## 结论：可以合入\n细节' }, { now, dataDir });
    expect(ds.session.lastTurn).toEqual({ turnId: 't1', outcome: 'delivered', at: clock, summary: '结论：可以合入' });
  });

  it('a failure card on the final channel is not the final reply', async () => {
    const ds = makeDs('s-receipt-failed');
    await completedWithoutReceipt(ds);
    noteFinalOutputReceipt(ds, 't1', { turnFailed: true, text: '执行失败：额度已用完' }, { now, dataDir });
    expect(ds.session.lastTurn).toMatchObject({ turnId: 't1', outcome: 'no_output' });
  });

  it('the empty-completion diagnostic is noted as a diagnostic, not as the reply', async () => {
    const ds = makeDs('s-receipt-diag');
    noteFinalOutputReceipt(ds, 't1', { emptyCompletedNotice: true, text: '本轮已完成，但没有匹配到最终回复' }, { now, dataDir });
    expect(await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, {
      recoveryHandled: false, isFinalDelivered: () => true, now, dataDir,
    })).toMatchObject({ outcome: 'no_output' });
  });
});

describe('isTurnOutcomeExcluded', () => {
  it('auto-compact and HTTP-caller turns do not count; ordinary chat turns do', () => {
    const ds = makeDs('s-excluded', { idleAutoCompact: { enabled: true, inFlight: { turnId: 'om_idle_compact', at: clock } } });
    Object.assign(ds, {
      idleAutoCompactDispatchedTurnId: 'om_dispatched_compact',
      pendingWaitPromises: new Map([['http_wait', {}]]),
      asyncTriggerResults: new Map([['http_async', {}]]),
      settledHttpTerminalTurns: new Set(['http_settled']),
    });
    for (const turnId of ['auto-compact:lx1', 'om_idle_compact', 'om_dispatched_compact', 'http_wait', 'http_async', 'http_settled']) {
      expect(isTurnOutcomeExcluded(ds, turnId), turnId).toBe(true);
    }
    expect(isTurnOutcomeExcluded(ds, 'om_chat')).toBe(false);
    expect(isTurnOutcomeExcluded(makeDs('s-plain'), 'om_chat')).toBe(false);
  });
});

describe('markPassthroughActivity', () => {
  it('an auto-compact passthrough keeps the delivered result and a manual column; a real command does not', () => {
    const ds = makeDs('s-passthrough', { lastTurn: { turnId: 't1', outcome: 'delivered', at: clock - 10 } });
    const row = () => ({
      status: 'idle', lastMessageAt: ds.lastMessageAt, lastTurn: ds.session.lastTurn, kanbanColumn: 'todo', kanbanColumnAt: clock - 5,
    });
    markPassthroughActivity(ds, 'auto-compact:idle:lx1', clock);
    expect(ds.session.lastMessageAt).toBe(new Date(clock).toISOString());
    expect(deriveSessionTaskStatus(row()).kind).toBe('delivered');
    expect(deriveKanbanColumn(row())).toBe('todo');
    markPassthroughActivity(ds, 'om_model', clock + 1_000);
    expect(deriveSessionTaskStatus(row()).kind).toBe('idle');
    expect(activeManualColumn(row())).toBeNull();
  });
});

describe('任务状态事件（给管家的子任务提醒）', () => {
  it('已交付、中断、补登成已交付时按群发一次；没有输出、没有群、没写进去的不发', async () => {
    const opts = { recoveryHandled: false, now, dataDir };
    const ds = makeDs('s-ev', { chatId: 'oc_a' });
    await recordTurnOutcome(ds, { turnId: 't1', status: 'completed' }, { ...opts, isFinalDelivered: () => true });
    expect(taskEvents).toEqual([{ chatId: 'oc_a', sessionId: 's-ev' }]);
    await recordTurnOutcome(ds, { turnId: 't2', status: 'failed', errorCode: 'api_error' }, { ...opts, isFinalDelivered: () => false });
    expect(taskEvents).toHaveLength(2);
    clock += 10;
    ds.lastMessageAt = clock - 5;
    await recordTurnOutcome(ds, { turnId: 't3', status: 'completed' }, { ...opts, isFinalDelivered: () => false });
    expect(ds.session.lastTurn).toMatchObject({ turnId: 't3', outcome: 'no_output' });
    expect(taskEvents).toHaveLength(2);
    noteLateFinalReply(ds, 't3', { now, dataDir });
    expect(taskEvents).toHaveLength(3);

    h.failNextUpdate = true;
    await recordTurnOutcome(ds, { turnId: 't4', status: 'completed' }, { ...opts, isFinalDelivered: () => true });
    expect(taskEvents).toHaveLength(3);
    const noChat = makeDs('s-nochat');
    await recordTurnOutcome(noChat, { turnId: 't1', status: 'completed' }, { ...opts, isFinalDelivered: () => true });
    expect(taskEvents).toHaveLength(3);
  });

  it('举手：同一次举手只发一次，新举手再发；放下不发', () => {
    const ds = makeDs('s-hand', { chatId: 'oc_a' }) as DaemonSession & { agentAttention?: unknown };
    publishAttentionPatch(ds);
    expect(taskEvents).toEqual([]);
    ds.agentAttention = { kind: 'decision', reason: '要不要合？', at: clock, source: 'agent' };
    publishAttentionPatch(ds);
    publishAttentionPatch(ds);
    expect(taskEvents).toEqual([{ chatId: 'oc_a', sessionId: 's-hand' }]);
    ds.agentAttention = undefined;
    publishAttentionPatch(ds);
    ds.agentAttention = { kind: 'decision', reason: '又来一个', at: clock + 1, source: 'agent' };
    publishAttentionPatch(ds);
    expect(taskEvents).toHaveLength(2);
  });
});
