import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import { beginReplyTargetTurn, bindTriggerReplyTarget, frozenReplyContextForTurn,
  replyContextForSessionTurn } from '../src/core/reply-target.js';
import { captureTerminalReplyContext } from '../src/core/terminal-reply-context.js';
import { createDispatchReportBinding, verifyDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { buildOrchestratorReportTrigger, prepareAutomaticDispatchReport } from '../src/core/report-session-relay.js';
import { validateTriggerRequest } from '../src/services/trigger-types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPersistedSessionRows, seedPersistedSessionRows } from './helpers/session-store-disk.js';

function sessionView(): DaemonSession {
  const session = { sessionId: 'lead', larkAppId: 'cli_lead', chatId: 'oc_chat', rootMessageId: 'oc_chat',
    scope: 'chat', status: 'active' } as Session;
  return { session, scope: 'chat', chatId: 'oc_chat' } as DaemonSession;
}

function accept(ds: DaemonSession, index: number, root = 'om_topic_b'): string {
  const turnId = `om_turn_${index}`;
  ds.session.quoteTargetId = turnId;
  beginReplyTargetTurn(ds, root, turnId, new Date(index * 1000).toISOString(), { inThread: true });
  return turnId;
}

describe('frozen outbound reply routing', () => {
  it('keeps interleaved topics and long-running turns after the short registry is pruned', () => {
    const ds = sessionView();
    const turnA = accept(ds, 0, 'om_topic_a');
    const turnB = accept(ds, 1);
    for (let index = 2; index <= 40; index += 1) accept(ds, index);
    expect(ds.session.replyTargets?.[turnA]).toBeUndefined();
    expect(replyContextForSessionTurn(ds.session, turnA).target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
    expect(replyContextForSessionTurn(ds.session, turnB).target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_b' });
  });

  it('protects an executing target beyond the frozen registry bound and across serialization', () => {
    const ds = sessionView();
    const turnA = accept(ds, 0, 'om_topic_a');
    ds.managedTurnOrigin = { turnId: turnA } as DaemonSession['managedTurnOrigin'];
    for (let index = 1; index <= 400; index += 1) accept(ds, index);
    const restored = JSON.parse(JSON.stringify(ds.session)) as Session;
    expect(replyContextForSessionTurn(restored, turnA).target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
    captureTerminalReplyContext(ds, 'native_turn', 400_000, turnA);
    expect(frozenReplyContextForTurn(ds, 'native_turn').target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
  });

  it('refuses an evicted exact turn instead of sending into a later topic or group', () => {
    const ds = sessionView();
    const turnA = accept(ds, 0, 'om_topic_a');
    for (let index = 1; index <= 400; index += 1) accept(ds, index);
    expect(() => replyContextForSessionTurn(ds.session, turnA)).toThrow('REPLY_TARGET_MISSING');
  });

  it('requires exact turn identity when the session currently has a topic-bound destination', () => {
    const ds = sessionView();
    accept(ds, 0, 'om_topic_a');
    expect(() => replyContextForSessionTurn(ds.session)).toThrow('REPLY_TARGET_MISSING');
  });

  it('restores the same frozen topic from persisted SQLite rows after the short registry is evicted', () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-route-store-'));
    try {
      const ds = sessionView();
      const turnA = accept(ds, 0, 'om_topic_a');
      for (let index = 1; index <= 40; index += 1) accept(ds, index);
      seedPersistedSessionRows(root, 'cli_lead', { lead: ds.session });
      const restored = readPersistedSessionRows(root, 'cli_lead').lead as Session;
      expect(restored.replyTargets?.[turnA]).toBeUndefined();
      expect(replyContextForSessionTurn(restored, turnA).target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['plain', 'quote'] as const)('retains intentional %s routing', mode => {
    const ds = sessionView();
    const turn = 'om_origin';
    beginReplyTargetTurn(ds, mode === 'plain' ? undefined : 'om_quote', turn, undefined, { quoteOnly: mode === 'quote' });
    expect(replyContextForSessionTurn(ds.session, turn).target).toEqual(mode === 'plain'
      ? { mode: 'plain', chatId: 'oc_chat' } : { mode: 'quote', rootMessageId: 'om_quote' });
  });

  it('rejects malformed persisted targets without changing legacy thread sessions', () => {
    const ds = sessionView();
    ds.session.turnReplyContexts = { om_bad: { target: { mode: 'thread', rootMessageId: '' } } };
    expect(() => replyContextForSessionTurn(ds.session, 'om_bad')).toThrow('REPLY_TARGET_INVALID');
    expect(replyContextForSessionTurn({ ...ds.session, scope: 'thread', rootMessageId: 'om_thread' }, 'legacy').target)
      .toEqual({ mode: 'thread', rootMessageId: 'om_thread' });
  });
});

describe('signed report destination', () => {
  it('retains the original lead topic independently of subsequent input and dispatchRoot', () => {
    const ds = sessionView();
    const turnA = accept(ds, 0, 'om_topic_a');
    const binding = createDispatchReportBinding('secret', { dispatchRoot: 'om_subtask', targetLarkAppId: 'cli_lead',
      targetSessionId: 'lead', targetChatId: 'oc_chat', targetScope: 'chat',
      targetReplyTarget: replyContextForSessionTurn(ds.session, turnA).target, sourceName: 'subtask' });
    for (let index = 1; index <= 300; index += 1) accept(ds, index);
    const decision = prepareAutomaticDispatchReport({ registry: JSON.parse(JSON.stringify({ om_subtask: { reportBinding: binding } })),
      bindingSecret: 'secret', dispatchRoot: 'om_subtask', sourceSessionId: 'subtask', sourceLarkAppId: 'cli_worker', content: 'done' });
    expect(decision).toBeDefined();
    const trigger = buildOrchestratorReportTrigger(decision!, { requestId: 'report', receivedAt: new Date().toISOString() });
    expect(trigger.target).toMatchObject({ sessionId: 'lead', chatId: 'oc_chat', rootMessageId: 'om_topic_a',
      replyTarget: { mode: 'thread', rootMessageId: 'om_topic_a' } });
    expect(validateTriggerRequest(trigger).ok).toBe(true);
    bindTriggerReplyTarget(ds, 'trg_report', decision!.targetReplyTarget!);
    expect(replyContextForSessionTurn(ds.session, 'trg_report').target).toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });
    const successor = buildOrchestratorReportTrigger(decision!, { requestId: 'report', receivedAt: new Date().toISOString() },
      { sessionId: 'lead_after_restore', larkAppId: 'cli_lead' });
    expect(successor.target).toMatchObject({ sessionId: 'lead_after_restore', rootMessageId: 'om_topic_a' });
  });

  it('rejects changed signed roots and conflicting reuse of a report turn', () => {
    const binding = createDispatchReportBinding('secret', { dispatchRoot: 'om_subtask', targetLarkAppId: 'cli_lead',
      targetSessionId: 'lead', targetChatId: 'oc_chat', targetScope: 'chat',
      targetReplyTarget: { mode: 'thread', rootMessageId: 'om_topic_a' }, sourceName: 'subtask' });
    const changed = { ...binding, payload: { ...binding.payload, targetReplyTarget: { mode: 'thread', rootMessageId: 'om_topic_b' } } };
    expect(verifyDispatchReportBinding('secret', 'om_subtask', changed)).toBeNull();
    const ds = sessionView();
    expect(bindTriggerReplyTarget(ds, 'trg_report', { mode: 'thread', rootMessageId: 'om_topic_a' })).toBe(true);
    expect(bindTriggerReplyTarget(ds, 'trg_report', { mode: 'thread', rootMessageId: 'om_topic_a' })).toBe(false);
    expect(() => bindTriggerReplyTarget(ds, 'trg_report', { mode: 'thread', rootMessageId: 'om_topic_b' })).toThrow('REPLY_TARGET_CONFLICT');
  });
});
