import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  feedbackPolicyForScheduledSend,
  reconcileScheduledDelivery,
  recordScheduledSessionRun,
  ScheduleSendAttempt,
  scheduledTurnsOfCurrentRuns,
  settleScheduledSend,
} from '../src/core/scheduled-send.js';
import { TURN_SEND_LEDGER_COMPLETED_RETENTION_MS, TurnSendLedger } from '../src/services/turn-send-ledger.js';
import type { Session } from '../src/types.js';

const turnId = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';
const session = { sessionId: 'scheduled-session', larkAppId: 'cli_app', chatId: 'oc_chat',
  scheduledRun: { taskId: 'abcdef12', runId: 'run-1', turnId } } as Session;
const key = { sessionId: session.sessionId, larkAppId: session.larkAppId!, turnId };
const roots: string[] = [];
const dir = () => { const root = mkdtempSync(join(tmpdir(), 'schedule-send-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('scheduled feedback policy', () => {
  it('omits requester feedback only for a verified ownerless scheduled turn', () => {
    const policy = { audience: 'requester' as const };
    const input = { policy, session, authenticatedTurnId: turnId };
    expect(feedbackPolicyForScheduledSend(input)).toBeUndefined();
    expect(feedbackPolicyForScheduledSend({ ...input, authenticatedTurnId: undefined })).toEqual(policy);
    expect(feedbackPolicyForScheduledSend({ ...input, authenticatedTurnId: 'om_human' })).toEqual(policy);
    expect(feedbackPolicyForScheduledSend({ ...input, session: { ...session, scheduledRun: undefined } })).toEqual(policy);
    expect(feedbackPolicyForScheduledSend({ ...input, requesterSubjectId: 'ou_claimant' })).toEqual(policy);
    expect(feedbackPolicyForScheduledSend({ ...input, policy: { audience: 'everyone' } })).toEqual({ audience: 'everyone' });
    expect(feedbackPolicyForScheduledSend({ ...input, policy: { audience: 'reviewers' } })).toEqual({ audience: 'reviewers' });
  });
});

describe('scheduled send settlement', () => {
  it('retains the exact older execution when a reused session receives another scheduled turn', () => {
    const dataDir = dir();
    const reused = { ...session };
    recordScheduledSessionRun(reused, session.scheduledRun!);
    new ScheduleSendAttempt(dataDir, reused, turnId).fail(new Error('first run failed'));
    recordScheduledSessionRun(reused, { taskId: 'abcdef12', runId: 'run-2',
      turnId: 'schedule:abcdef12:aaaaaaaa-1234-1234-1234-123456789abc' });
    expect(settleScheduledSend(dataDir, reused, turnId)).toMatchObject({ state: 'failed', runId: 'run-1' });
    expect(settleScheduledSend(dataDir, reused, reused.scheduledRun!.turnId)).toEqual({ state: 'silent' });
  });
  it('reports definite preflight rejection, but leaves silence and stale terminals alone', () => {
    const dataDir = dir();
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'silent' });
    const attempt = new ScheduleSendAttempt(dataDir, session, turnId);
    attempt.fail(new Error('requester missing'));
    expect(settleScheduledSend(dataDir, session, turnId)).toMatchObject({ state: 'failed',
      errorCode: 'schedule_send_rejected', error: 'requester missing', runId: 'run-1' });
    expect(settleScheduledSend(dataDir, session, 'om_other')).toEqual({ state: 'ignored' });
  });

  it('keeps an uncertain provider call unknown across a later rejected attempt', () => {
    const dataDir = dir();
    const attempt = new ScheduleSendAttempt(dataDir, session, turnId);
    attempt.providerRequestStarted();
    attempt.fail(new Error('timeout'));
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('later preflight rejected'));
    expect(settleScheduledSend(dataDir, session, turnId)).toMatchObject({ state: 'failed',
      errorCode: 'schedule_send_unknown' });
  });

  it('prefers a real final receipt over a rejected send and recognizes raw-card publication', async () => {
    const dataDir = dir();
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('first rejection'));
    const ledger = new TurnSendLedger(dataDir);
    await ledger.execute(key, 'final', 'raw card', async () => 'om_delivered');
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'delivered', messageId: 'om_delivered' });
  });

  it('accounts a fenced publication with no sidecar as unknown instead of silent', async () => {
    const dataDir = dir();
    // Hard-kill equivalent: the fenced publication is persisted, the dispatch
    // dies before any catch can write a failure sidecar.
    await new TurnSendLedger(dataDir).execute(
      key, 'final', 'maybe delivered',
      async () => { throw new Error('process killed after provider request'); },
      { fenced: true }).catch(() => undefined);
    expect(settleScheduledSend(dataDir, session, turnId)).toMatchObject({ state: 'failed',
      runId: 'run-1', errorCode: 'schedule_send_unknown' });
  });

  it('accounts an in-flight chunk marker without a sidecar as unknown', () => {
    const dataDir = dir();
    const ledger = new TurnSendLedger(dataDir);
    mkdirSync(dirname(ledger.recordPath(key)), { recursive: true });
    writeFileSync(ledger.recordPath(key), JSON.stringify({
      ...key, version: 1,
      nonIdempotentSequence: { fingerprint: 'fp', target: 'oc_chat',
        stepCount: 3, completedSteps: 1, inFlightStep: 1 },
    } satisfies import('../src/services/turn-send-ledger.js').TurnSendLedgerRecord));
    expect(settleScheduledSend(dataDir, session, turnId)).toMatchObject({ state: 'failed',
      errorCode: 'schedule_send_unknown' });
  });

  it('reconciles an unknown publication once a final receipt later lands', async () => {
    const dataDir = dir();
    const ledger = new TurnSendLedger(dataDir);
    await ledger.execute(key, 'final', 'late answer',
      async () => { throw new Error('killed mid-flight'); }, { fenced: true }).catch(() => undefined);
    expect(settleScheduledSend(dataDir, session, turnId).state).toBe('failed');
    await ledger.execute(key, 'final', 'late answer', async () => 'om_late');
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'delivered', messageId: 'om_late' });
  });
});

describe('scheduled send still being delivered', () => {
  it('waits while a sender holds the record inside its provider call, then settles its receipt', async () => {
    const dataDir = dir();
    let finish: ((messageId: string) => void) | undefined;
    const send = new TurnSendLedger(dataDir).execute(key, 'final', 'slow answer',
      () => new Promise<string>(resolve => { finish = resolve; }), { fenced: true });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('earlier attempt rejected'));
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'in_flight' });
    expect(settleScheduledSend(dataDir, session, turnId, { expired: true })).toMatchObject({
      state: 'failed', runId: 'run-1', errorCode: 'schedule_send_unknown' });
    finish('om_slow');
    await send;
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'delivered', messageId: 'om_slow' });
  });

  it('keeps the daemon delivery pending between attempts, but a receipt still settles it', async () => {
    const dataDir = dir();
    const ledger = new TurnSendLedger(dataDir);
    await ledger.execute(key, 'final', 'answer',
      async () => { throw new Error('transient'); }, { fenced: true }).catch(() => undefined);
    expect(settleScheduledSend(dataDir, session, turnId).state).toBe('failed');
    expect(settleScheduledSend(dataDir, session, turnId, { daemonDelivering: true })).toEqual({ state: 'in_flight' });
    await ledger.execute(key, 'final', 'answer', async () => 'om_retry');
    expect(settleScheduledSend(dataDir, session, turnId, { daemonDelivering: true }))
      .toEqual({ state: 'delivered', messageId: 'om_retry' });
  });
});

describe('scheduled delivery accounting', () => {
  function accounting(current: boolean, logged = true) {
    const writes: string[] = [];
    return { writes, deps: {
      recordFailure: (_taskId: string, _runId: string, _error: string, code: string) => { writes.push(`task:${code}`); return current; },
      recordDelivered: () => { writes.push('task:delivered'); return current; },
      markRunLogFailed: () => { writes.push('log:failed'); return logged; },
      markRunLogDelivered: () => { writes.push('log:delivered'); return logged; },
    } };
  }

  it('writes the execution log only for the run the task row still owns', async () => {
    const dataDir = dir();
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('rejected'));
    const superseded = accounting(false);
    expect(reconcileScheduledDelivery(dataDir, session, turnId, {}, superseded.deps))
      .toMatchObject({ next: 'settled', superseded: true });
    expect(superseded.writes).toEqual(['task:schedule_send_rejected']);
    const owned = accounting(true);
    expect(reconcileScheduledDelivery(dataDir, session, turnId, {}, owned.deps)).toMatchObject({ next: 'settled' });
    expect(owned.writes).toEqual(['task:schedule_send_rejected', 'log:failed']);
    await new TurnSendLedger(dataDir).execute(key, 'final', 'late', async () => 'om_late');
    const lateSuperseded = accounting(false);
    reconcileScheduledDelivery(dataDir, session, turnId, {}, lateSuperseded.deps);
    expect(lateSuperseded.writes).toEqual(['task:delivered']);
  });

  it('asks for another pass while the execution-log row is missing, and writes nothing while in flight', () => {
    const dataDir = dir();
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('rejected'));
    expect(reconcileScheduledDelivery(dataDir, session, turnId, {}, accounting(true, false).deps))
      .toMatchObject({ next: 'retry_log' });
    const inFlight = accounting(true);
    expect(reconcileScheduledDelivery(dataDir, session, turnId, { daemonDelivering: true }, inFlight.deps))
      .toEqual({ next: 'in_flight' });
    expect(inFlight.writes).toEqual([]);
  });

  it('lists for restart reconciliation only the turns whose run is still current', () => {
    const reused = { ...session, scheduledRun: undefined } as Session;
    const later = 'schedule:abcdef12:bbbbbbbb-1234-1234-1234-123456789abc';
    const other = 'schedule:fedcba98:cccccccc-1234-1234-1234-123456789abc';
    recordScheduledSessionRun(reused, { taskId: 'abcdef12', runId: 'run-1', turnId });
    recordScheduledSessionRun(reused, { taskId: 'abcdef12', runId: 'run-2', turnId: later });
    recordScheduledSessionRun(reused, { taskId: 'fedcba98', runId: 'run-8', turnId: other });
    const current: Record<string, string> = { abcdef12: 'run-2', fedcba98: 'run-9' };
    expect(scheduledTurnsOfCurrentRuns([reused], taskId => current[taskId]))
      .toEqual([{ session: reused, turnId: later }]);
  });

  it('lists only the latest turn of a run that a recovery turn continued', () => {
    const recovered = { ...session, scheduledRun: undefined } as Session;
    const recovery = 'schedule:abcdef12:dddddddd-1234-1234-1234-123456789abc';
    recordScheduledSessionRun(recovered, { taskId: 'abcdef12', runId: 'run-1', turnId });
    recordScheduledSessionRun(recovered, { taskId: 'abcdef12', runId: 'run-1', turnId: recovery });
    expect(scheduledTurnsOfCurrentRuns([recovered], () => 'run-1'))
      .toEqual([{ session: recovered, turnId: recovery }]);
  });

  it('stops reporting a failure once the ledger prunes the delivered record it belonged to', async () => {
    const dataDir = dir();
    const ledger = new TurnSendLedger(dataDir);
    new ScheduleSendAttempt(dataDir, session, turnId).fail(new Error('rejected before the retry'));
    await ledger.execute(key, 'final', 'retried', async () => 'om_retried');
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'delivered', messageId: 'om_retried' });
    expect(await ledger.pruneCompleted(Date.now() + TURN_SEND_LEDGER_COMPLETED_RETENTION_MS + 1))
      .toEqual({ removed: 1, retained: 0 });
    expect(settleScheduledSend(dataDir, session, turnId)).toEqual({ state: 'silent' });
  });
});
