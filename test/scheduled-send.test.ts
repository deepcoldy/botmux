import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feedbackPolicyForScheduledSend, recordScheduledSessionRun, ScheduleSendAttempt, settleScheduledSend } from '../src/core/scheduled-send.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
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
