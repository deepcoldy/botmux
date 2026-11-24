import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { classifySlash } from '../src/core/command-router.js';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import {
  chooseGroupSupervisionDecision,
  newGroupSessionSupervision,
  groupSupervisionNotice,
  observeGroupSessionSupervision,
  replaceGroupSessionSupervision,
  resumeGroupSessionSupervision,
  stopGroupSessionSupervision,
  supervisionDecisionRef,
  type GroupSessionSupervisionIo,
} from '../src/core/group-session-supervision.js';
import { parseSupervisionAssessment, type SupervisionAssessment } from '../src/core/group-session-supervision-assessment.js';
import { groupSessionSupervisorConfig, sameGroupSessionSupervisor } from '../src/core/group-session-supervisor-config.js';
import { buildGroupSupervisionReviewPrompt, deriveGroupSupervisionCriteria, reviewGroupSessionTask } from '../src/core/group-session-supervision-review.js';
import { __setLoopbackTransportForTests } from '../src/core/loopback-fetch.js';
import type { SessionLastTurn } from '../src/core/session-task-status.js';
import { noteFinalReplyText, recordTurnOutcome, turnFinalText, turnOutcomePendingOrChanged, turnSupervisionFinalReply } from '../src/core/turn-outcome.js';
import type { DaemonSession } from '../src/core/types.js';
import { isForkSourceBusy } from '../src/core/worker-pool.js';
import { invocationRequest } from '../src/services/constrained-invocation/contract.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import { recordSessionTurnReply, stageSessionTurnInbound } from '../src/services/session-turns.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import * as sessionStore from '../src/services/session-store.js';
import { appendMessage, findQueuedMessage } from '../src/services/message-queue.js';
import type { LarkMessage, Session } from '../src/types.js';

const REWORK = { verdict: 'rework', missing: [1], reason: 'Affected tests still fail' } as const;
const WAIT = { verdict: 'wait', evidence: 'Test evidence', reason: 'CI still running', minutes: 5 } as const;

function usePassingReview(review: ReturnType<typeof fixture>['io']['review']) {
  review.mockImplementation(async (_task, answer, _signal, stage) => stage === 'completion'
    ? { verdict: 'ready' }
    : { verdict: 'accepted', evidence: [answer] });
}

function fixture(session = {} as Session, criteria = 'The build and affected tests are green') {
  const task = newGroupSessionSupervision({
    requester: 'ou_requester', chatId: 'oc_group', anchor: 'om_root',
    reviewer: { botAppId: 'local_reviewer', model: 'test-model' },
    task: 'Fix the build', criteria, turnId: 'om_task',
  }, 1);
  session.groupSessionSupervision = task;
  const io = {
    allowed: vi.fn(() => true),
    current: vi.fn(() => true),
    finalText: vi.fn<GroupSessionSupervisionIo['finalText']>(() => ({ text: 'Test evidence', complete: true })),
    deriveCriteria: vi.fn<GroupSessionSupervisionIo['deriveCriteria']>(async task => ({
      task: task.task, criteria: 'The build passes',
    })),
    review: vi.fn<GroupSessionSupervisionIo['review']>(async () => ({ ...REWORK, missing: [...REWORK.missing] })),
    serializeAdmission: vi.fn<GroupSessionSupervisionIo['serializeAdmission']>(async action => action()),
    canDispatch: vi.fn(() => true),
    stillMissingOutput: vi.fn<GroupSessionSupervisionIo['stillMissingOutput']>(() => true),
    wake: vi.fn(),
    dispatch: vi.fn<GroupSessionSupervisionIo['dispatch']>(() => true),
    persist: vi.fn(),
  };
  const outcome = (turnId = session.groupSessionSupervision!.turnId, result: SessionLastTurn['outcome'] = 'delivered', now = 10) =>
    observeGroupSessionSupervision(session, { now, outcome: { turnId, at: now, outcome: result } }, io);
  return { task, session, io, outcome };
}

describe('group session supervision', () => {
  it('routes an existing-session command with literal multiline criteria', () => {
    const content = '/supervise on\nTests pass\n/check evidence';
    expect(classifySlash({
      text: content, context: 'thread', phase: 'running', passthrough: new Set(),
      coldStartPassthrough: new Set(), senderIsBot: false, acceptSlashFromBots: false,
    })).toMatchObject({ kind: 'daemon', cmd: '/supervise', sessionPolicy: 'existing_only', content });
    expect(groupSessionSupervisorConfig.safeParse({ botAppId: 'local_reviewer', model: ' model ' }).data)
      .toEqual({ botAppId: 'local_reviewer', model: 'model' });
    expect(groupSessionSupervisorConfig.safeParse({ botAppId: 'https://other-host', model: 'model' }).success)
      .toBe(false);
    const reviewer = groupSessionSupervisorConfig.parse({ provider: 'magpie', model: ' model ' });
    expect(reviewer).toEqual({ provider: 'magpie', model: 'model' });
    expect(groupSessionSupervisorConfig.safeParse({ ...reviewer, url: 'http://example.org' }).success).toBe(false);
    expect(sameGroupSessionSupervisor(reviewer, { botAppId: 'local_reviewer', model: 'model' })).toBe(false);
  });

  it('reviews the bound turn only and stops when the reviewer accepts it', async () => {
    const { session, io, outcome } = fixture();
    usePassingReview(io.review);
    await outcome('om_other');
    expect(io.review).not.toHaveBeenCalled();
    await outcome();
    expect(session.groupSessionSupervision?.state).toBe('pending_review');
    expect(groupSupervisionNotice(session.groupSessionSupervision!)).toBeUndefined();
    await outcome();
    await outcome();
    expect(io.review.mock.calls.map(call => call[3])).toEqual(['completion', 'acceptance']);
    expect(session.groupSessionSupervision?.state).toBe('accepted');
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('retries criteria preparation after restart and saves criteria before reviewing the finished turn', async () => {
    const { session, task, io, outcome } = fixture(undefined, '');
    expect(task.state).toBe('preparing');
    io.deriveCriteria.mockResolvedValueOnce(undefined);
    await outcome();
    const saved = JSON.parse(JSON.stringify(session)) as Session;
    const checkAt = saved.groupSessionSupervision!.checkAt!;
    const delivered = { turnId: task.turnId, at: 10, outcome: 'delivered' as const };
    await observeGroupSessionSupervision(saved, { now: checkAt - 1, outcome: delivered }, io);
    expect(io.deriveCriteria).toHaveBeenCalledOnce();
    await observeGroupSessionSupervision(saved, { now: checkAt, outcome: delivered }, io);
    expect(saved.groupSessionSupervision).toMatchObject({ criteria: 'The build passes', state: 'watching' });
    expect(io.review).not.toHaveBeenCalled();
    usePassingReview(io.review);
    await observeGroupSessionSupervision(saved, { now: checkAt, outcome: delivered }, io);
    await observeGroupSessionSupervision(saved, { now: checkAt, outcome: delivered }, io);
    expect(saved.groupSessionSupervision?.state).toBe('accepted');
    expect(io.deriveCriteria).toHaveBeenCalledTimes(2);
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('discards derived criteria if supervision switches to explicit criteria while preparing', async () => {
    const { task, session, io, outcome } = fixture(undefined, '');
    io.deriveCriteria.mockImplementation(async () => {
      replaceGroupSessionSupervision(session, newGroupSessionSupervision({
        ...task, criteria: 'User supplied criteria',
      }), io.persist);
      return { task: task.task, criteria: 'Outdated generated criteria' };
    });
    await outcome();
    expect(session.groupSessionSupervision).toMatchObject({ criteria: 'User supplied criteria', state: 'watching' });
    expect(io.review).not.toHaveBeenCalled();
  });

  it('persists each rework identity before dispatch and does not exceed the round limit', async () => {
    const { task, session, io, outcome } = fixture();
    io.dispatch.mockImplementation((turnId, source, prompt) => {
      expect(session.groupSessionSupervision?.turnId).toBe(turnId);
      expect(turnId).not.toBe(source);
      expect(prompt).toContain(task.criteria);
      expect(prompt).not.toContain('Test evidence');
      return true;
    });
    await Promise.all([outcome(), outcome()]);
    expect(io.dispatch).toHaveBeenCalledTimes(1);
    await outcome();
    await outcome();
    expect(io.dispatch).toHaveBeenCalledTimes(2);
    expect(session.groupSessionSupervision).toMatchObject({ round: 2, state: 'needs_user', reason: 'round_limit' });
  });

  it('discards an in-flight verdict when the requester turns supervision off', async () => {
    const { session, io, outcome } = fixture();
    let resolve!: (verdict: SupervisionAssessment) => void;
    let reviewStarted!: () => void;
    const started = new Promise<void>(done => { reviewStarted = done; });
    io.review.mockImplementation(() => new Promise(done => { resolve = done; reviewStarted(); }));
    const reviewing = outcome();
    await started;
    const signal = io.review.mock.calls[0]![2];
    replaceGroupSessionSupervision(session, undefined, io.persist);
    expect(signal.aborted).toBe(true);
    resolve({ ...REWORK, missing: [1] });
    await reviewing;
    expect(session.groupSessionSupervision).toBeUndefined();
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('pauses instead of dispatching if the user has moved onto another turn during review', async () => {
    const { session, io, outcome } = fixture();
    io.review.mockImplementation(async () => {
      io.current.mockReturnValue(false);
      return { ...REWORK, missing: [1] };
    });
    await outcome();
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'session_changed' });
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an unconfirmed dispatch from being replayed', async () => {
    const { session, io, outcome } = fixture();
    io.dispatch.mockReturnValue(false);
    await outcome();
    await outcome();
    expect(session.groupSessionSupervision).toMatchObject({ round: 1, state: 'needs_user', reason: 'dispatch_failed' });
    expect(io.dispatch).toHaveBeenCalledTimes(1);
  });

  it('waits for already queued human input and rechecks before committing a rework verdict', async () => {
    const { session, io, outcome } = fixture();
    let releaseAdmission!: () => void;
    let queued!: () => void;
    const waitingForAdmission = new Promise<void>(resolve => { queued = resolve; });
    const humanInputAdmitted = new Promise<void>(resolve => { releaseAdmission = resolve; });
    io.serializeAdmission.mockImplementationOnce(async action => action()).mockImplementation(async action => {
      queued();
      await humanInputAdmitted;
      action();
    });
    const reviewing = outcome();
    await waitingForAdmission;
    await outcome();
    expect(io.review).toHaveBeenCalledTimes(1);
    expect(io.dispatch).not.toHaveBeenCalled();
    io.current.mockReturnValue(false);
    releaseAdmission();
    await reviewing;
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'session_changed' });
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the previous persisted state when recording new work fails', async () => {
    const { task, session, io, outcome } = fixture();
    io.persist.mockImplementation(() => { throw new Error('write failed'); });
    await expect(outcome()).rejects.toThrow('write failed');
    expect(session.groupSessionSupervision).toBe(task);
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('pauses a failed execution without sending any evidence to the reviewer', async () => {
    const { task, session, io, outcome } = fixture();
    await outcome(task.turnId, 'interrupted');
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'interrupted' });
    expect(io.review).not.toHaveBeenCalled();
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('rechecks a parked dependency after reloading its saved state and reviews the new turn', async () => {
    const { session, io, outcome } = fixture();
    io.review.mockResolvedValue(WAIT);
    await outcome();
    const saved = JSON.parse(JSON.stringify(session)) as Session;
    const checkAt = saved.groupSessionSupervision!.checkAt!;
    expect(saved.groupSessionSupervision?.state).toBe('waiting');
    await observeGroupSessionSupervision(saved, { now: checkAt - 1 }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
    await observeGroupSessionSupervision(saved, { now: checkAt, running: true }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
    expect(saved.groupSessionSupervision?.waitBusySince).toBe(checkAt);
    io.canDispatch.mockReturnValue(false);
    await observeGroupSessionSupervision(saved, { now: checkAt }, io);
    expect(io.wake).toHaveBeenCalledOnce();
    expect(saved.groupSessionSupervision?.waitBusySince).toBeUndefined();
    expect(saved.groupSessionSupervision?.state).toBe('waiting');
    io.canDispatch.mockReturnValue(true);
    await observeGroupSessionSupervision(saved, { now: checkAt }, io);
    expect(io.dispatch).toHaveBeenCalledTimes(1);
    expect(io.dispatch.mock.calls[0]![2]).toContain('Recheck the external dependency');
    expect(saved.groupSessionSupervision).toMatchObject({ state: 'watching', round: 0, waitChecks: 1 });
    const turnId = saved.groupSessionSupervision!.turnId;
    usePassingReview(io.review);
    const signal = { now: checkAt + 1, outcome: { turnId, at: checkAt + 1, outcome: 'delivered' as const } };
    await observeGroupSessionSupervision(saved, signal, io);
    await observeGroupSessionSupervision(saved, signal, io);
    expect(saved.groupSessionSupervision?.state).toBe('accepted');
  });

  it('escalates a continuously busy parked dependency after a bounded grace', async () => {
    const { session, io, outcome } = fixture();
    io.review.mockResolvedValue(WAIT);
    await outcome();
    const task = session.groupSessionSupervision!;
    const checkAt = task.checkAt!;
    const previousNoticeKey = `${task.id}:${task.turnId}:stalled`;
    task.notifiedKey = previousNoticeKey;
    task.waitChecks = 2;
    await observeGroupSessionSupervision(session, { now: checkAt, running: true }, io);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'waiting', waitBusySince: checkAt, waitChecks: 2 });

    // The durable busy deadline, not a fresh scan timestamp, controls escalation.
    const restored = JSON.parse(JSON.stringify(session)) as Session;
    await observeGroupSessionSupervision(restored, { now: checkAt + 60_000, running: true }, io);
    expect(restored.groupSessionSupervision).toMatchObject({ state: 'waiting', waitBusySince: checkAt, waitChecks: 2 });
    await observeGroupSessionSupervision(restored, { now: checkAt + 86_400_000, running: true }, io);
    expect(restored.groupSessionSupervision).toMatchObject({
      state: 'needs_user', reason: 'stalled', waitChecks: 2, notifiedKey: previousNoticeKey,
    });
    expect(restored.groupSessionSupervision?.waitBusySince).toBeUndefined();
    expect(groupSupervisionNotice(restored.groupSessionSupervision!)).toBe('wait_stalled');
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('keeps monitoring a live stall and accepts eventual completion without another command', async () => {
    const { session, io, outcome } = fixture();
    await observeGroupSessionSupervision(session, { now: 15 * 60_000, running: true, stalled: true }, io);
    expect(session.groupSessionSupervision?.state).toBe('watching');
    expect(groupSupervisionNotice(session.groupSessionSupervision!)).toBe('stalled');
    await observeGroupSessionSupervision(session, { now: 15 * 60_000 + 10, running: true }, io);
    expect(groupSupervisionNotice(session.groupSessionSupervision!)).toBeUndefined();
    expect(io.dispatch).not.toHaveBeenCalled();
    usePassingReview(io.review);
    await outcome(undefined, 'delivered', 16 * 60_000);
    await outcome(undefined, 'delivered', 16 * 60_000);
    expect(groupSupervisionNotice(session.groupSessionSupervision!)).toBe('accepted');
  });

  it('retains terminal evidence and retries an unavailable judge after its backoff', async () => {
    const { session, io, outcome } = fixture();
    io.review.mockResolvedValue(undefined);
    await outcome();
    const saved = JSON.parse(JSON.stringify(session)) as Session;
    const task = saved.groupSessionSupervision!;
    expect(task).toMatchObject({ state: 'watching', reviewAttempt: 1, reviewEvidence: 'Test evidence' });
    const observation = { outcome: { turnId: task.turnId, at: 10, outcome: 'delivered' } as SessionLastTurn };
    await observeGroupSessionSupervision(saved, { ...observation, now: task.checkAt! - 1 }, io);
    expect(io.review).toHaveBeenCalledTimes(1);
    io.finalText.mockClear();
    usePassingReview(io.review);
    await observeGroupSessionSupervision(saved, { ...observation, now: task.checkAt! }, io);
    await observeGroupSessionSupervision(saved, { ...observation, now: task.checkAt! }, io);
    expect(io.finalText).not.toHaveBeenCalled();
    expect(saved.groupSessionSupervision?.state).toBe('accepted');
  });

  it('stops a parked task, preserves its criteria, and can reattach to an explicit human follow-up', async () => {
    const { task, session, io, outcome } = fixture();
    io.review.mockResolvedValue(WAIT);
    await outcome();
    const checkAt = session.groupSessionSupervision!.checkAt!;
    stopGroupSessionSupervision(session, io.persist);
    await observeGroupSessionSupervision(session, { now: checkAt }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'stopped' });
    const resume = resumeGroupSessionSupervision(session.groupSessionSupervision!, 'om_followup', checkAt);
    replaceGroupSessionSupervision(session, resume, io.persist);
    expect(session.groupSessionSupervision).toMatchObject({
      state: 'watching', turnId: 'om_followup', originTurnId: task.turnId, criteria: task.criteria, reviewEpoch: 1,
    });
  });

  it('retries a failed stop before reporting it while keeping this process stopped', () => {
    const { session, io } = fixture();
    let attempts = 0;
    io.persist.mockImplementation(() => { attempts++; throw new Error('storage unavailable'); });
    expect(() => stopGroupSessionSupervision(session, io.persist)).toThrow('storage unavailable');
    expect(attempts).toBeGreaterThan(1);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'stopped' });
  });

  it('waits for a delayed final output without losing the watched task', async () => {
    const { session, io, outcome } = fixture();
    await outcome(undefined, 'no_output');
    expect(session.groupSessionSupervision?.state).toBe('watching');
    expect(io.review).not.toHaveBeenCalled();
    usePassingReview(io.review);
    await outcome(undefined, 'delivered', 30_000);
    await outcome(undefined, 'delivered', 30_000);
    expect(session.groupSessionSupervision?.state).toBe('accepted');
  });

  it('reviews and anchors evidence beyond the short next-step prefix', async () => {
    const { task, session, io, outcome } = fixture();
    const ds = { session, chatType: 'group' } as DaemonSession;
    const tail = 'TAIL_EVIDENCE: 47 affected tests passed';
    const answer = `${'x'.repeat(2_100)}\n${tail}`;
    noteFinalReplyText(ds, task.turnId, answer);
    io.finalText.mockImplementation(() => turnSupervisionFinalReply(ds, task.turnId, config.session.dataDir));
    const seen: string[] = [];
    io.review.mockImplementation(async (_task, reviewAnswer, _signal, stage) => {
      seen.push(reviewAnswer);
      return stage === 'completion' ? { verdict: 'ready' } : parseSupervisionAssessment(
        { verdict: 'accepted', evidence: [tail] }, stage, task.criteria, reviewAnswer,
      );
    });
    await outcome();
    await outcome();
    expect(seen).toEqual([answer, answer]);
    expect(session.groupSessionSupervision?.state).toBe('accepted');
    // The existing next-step context intentionally keeps its independent bound.
    expect(turnFinalText(ds, task.turnId, config.session.dataDir)).not.toContain(tail);
  });

  it('keeps a failure qualifier at the long-reply tail visible to acceptance', async () => {
    const { task, session, io, outcome } = fixture();
    const ds = { session, chatType: 'group' } as DaemonSession;
    const failure = 'TAIL_FAILURE: the deployment was rolled back';
    const answer = `${'All checks initially passed.\n'}${'x'.repeat(2_100)}\n${failure}`;
    noteFinalReplyText(ds, task.turnId, answer);
    io.finalText.mockImplementation(() => turnSupervisionFinalReply(ds, task.turnId, config.session.dataDir));
    io.review.mockImplementation(async (_task, reviewAnswer, _signal, stage) => {
      if (stage === 'completion') return { verdict: 'ready' };
      return reviewAnswer.includes(failure)
        ? { verdict: 'needs_user', reason: 'The tail reports a rollback' }
        : { verdict: 'accepted', evidence: ['All checks initially passed.'] };
    });
    await outcome();
    await outcome();
    expect(io.review.mock.calls[1]?.[1]).toContain(failure);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'needs_user' });
  });

  it('keeps the largest captured supervision reply within the invocation prompt contract', () => {
    const { task, session } = fixture();
    task.task = 't'.repeat(8_000);
    task.criteria = 'c'.repeat(1_600);
    const ds = { session, chatType: 'group' } as DaemonSession;
    noteFinalReplyText(ds, task.turnId, 'x'.repeat(600_000));
    const captured = turnSupervisionFinalReply(ds, task.turnId, config.session.dataDir)!;
    expect(captured.complete).toBe(false);
    const rendered = buildGroupSupervisionReviewPrompt(task, captured.text, 'acceptance');
    expect(rendered.complete).toBe(true);
    expect(invocationRequest.safeParse({
      requestId: 'supervision-prompt-bound', prompt: rendered.prompt, model: 'test-model', deadlineMs: 45_000,
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }).success).toBe(true);
  });

  it('refuses acceptance when the in-memory reply crossed the capture boundary', async () => {
    const { task, session, io, outcome } = fixture();
    const ds = { session, chatType: 'group' } as DaemonSession;
    noteFinalReplyText(ds, task.turnId, `${'x'.repeat(256_100)}\nTAIL_FAILURE: rolled back`);
    const captured = turnSupervisionFinalReply(ds, task.turnId, config.session.dataDir)!;
    expect(captured.complete).toBe(false);
    expect(captured.text).not.toContain('TAIL_FAILURE');
    io.finalText.mockReturnValue(captured);
    await outcome();
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'review_incomplete' });
    expect(io.review).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'backslashes', raw: '\\'.repeat(600_000) },
    { name: 'control characters', raw: '\u0001'.repeat(200_000) },
  ])('fits $name into the prompt contract and refuses an incomplete review', async ({ raw }) => {
    const { task, session } = fixture();
    const ds = { session, chatType: 'group' } as DaemonSession;
    noteFinalReplyText(ds, task.turnId, raw);
    const captured = turnSupervisionFinalReply(ds, task.turnId, config.session.dataDir)!;
    const rendered = buildGroupSupervisionReviewPrompt(task, captured.text, 'acceptance');
    expect(rendered.complete).toBe(false);
    expect(invocationRequest.safeParse({
      requestId: 'supervision-prompt-bound', prompt: rendered.prompt, model: 'test-model', deadlineMs: 45_000,
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }).success).toBe(true);
    await expect(reviewGroupSessionTask(task.reviewer, task, captured.text, new AbortController().signal, 'acceptance'))
      .resolves.toMatchObject({ verdict: 'needs_user' });
  });

  it('restores pending acceptance and rejects evidence that the executor never reported', async () => {
    const { session, io, outcome } = fixture();
    usePassingReview(io.review);
    await outcome();
    const restored = JSON.parse(JSON.stringify(session)) as Session;
    const task = restored.groupSessionSupervision!;
    io.review.mockImplementation(async (_task, answer, _signal, stage) => parseSupervisionAssessment(
      { verdict: 'accepted', evidence: ['A model-invented CI result'] }, stage, task.criteria, answer,
    ));
    await observeGroupSessionSupervision(restored, { now: 11, outcome: { turnId: task.turnId, at: 10, outcome: 'delivered' } }, io);
    expect(restored.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'needs_user' });
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('requires a quote per acceptance criterion and binds a park to reported evidence', () => {
    const criteria = 'Build passes\nTests pass';
    const answer = 'Build: exit 0. Tests: 42 passed.';
    expect(parseSupervisionAssessment({ verdict: 'accepted', evidence: ['Build: exit 0.'] }, 'acceptance', criteria, answer))
      .toMatchObject({ verdict: 'needs_user' });
    expect(parseSupervisionAssessment({ verdict: 'accepted', evidence: ['Build: exit 0.', 'Tests: 42 passed.'] }, 'acceptance', criteria, answer))
      .toEqual({ verdict: 'accepted', evidence: ['Build: exit 0.', 'Tests: 42 passed.'] });
    expect(parseSupervisionAssessment({ verdict: 'accepted' }, 'completion', criteria, answer)).toBeUndefined();
    expect(parseSupervisionAssessment({ verdict: 'wait', evidence: ['CI still running'], reason: 'CI', minutes: 5 }, 'completion', criteria, answer))
      .toMatchObject({ verdict: 'needs_user' });
  });

  it('sends only the selected acceptance criteria as the rework gaps', async () => {
    const { session, io, outcome } = fixture();
    session.groupSessionSupervision!.criteria = 'Build passes\nTests pass';
    io.review.mockResolvedValue({ verdict: 'rework', missing: [2], reason: 'Tests still fail' });
    await outcome();
    const prompt = io.dispatch.mock.calls[0]![2];
    expect(JSON.parse(prompt.split('\n\n').at(-1)!).unmet_criteria).toEqual(['Tests pass']);
    expect(prompt).not.toContain('Tests still fail');
  });

  it('gives one safe chance to continue after an idle turn with no result', async () => {
    const { session, io } = fixture();
    const lastActivityAt = 9 * 60_000;
    await observeGroupSessionSupervision(session, { now: 10 * 60_000 + 1, lastActivityAt }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
    const idleAt = lastActivityAt + 10 * 60_000;
    await observeGroupSessionSupervision(session, { now: idleAt, lastActivityAt }, io);
    expect(io.dispatch).toHaveBeenCalledOnce();
    expect(session.groupSessionSupervision).toMatchObject({ state: 'watching', probes: 1, round: 0 });
    await observeGroupSessionSupervision(session, { now: idleAt + 10 * 60_000 }, io);
    expect(io.dispatch).toHaveBeenCalledOnce();
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'no_output' });
  });

  it('sends a pending decision only after a matching explicit selection', async () => {
    const { session, io, outcome } = fixture();
    io.review.mockResolvedValue({
      verdict: 'needs_user', reason: 'Requires approval',
      decision: { question: 'Run the migration?', options: ['Run migration and verify', 'Leave the schema unchanged'], recommended: 2 },
    });
    await outcome();
    const task = session.groupSessionSupervision!;
    const ref = supervisionDecisionRef(task);
    expect(chooseGroupSupervisionDecision(task, 'stale-ref', 1, 11)).toBeUndefined();
    await observeGroupSessionSupervision(session, { now: 60_000 }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
    const selected = chooseGroupSupervisionDecision(task, ref, 2, 60_000);
    expect(selected?.lastDecision?.choice).toBe('Leave the schema unchanged');
    replaceGroupSessionSupervision(session, selected, io.persist);
    await observeGroupSessionSupervision(session, { now: 60_000 }, io);
    expect(io.dispatch).toHaveBeenCalledOnce();
    expect(io.dispatch.mock.calls[0]![2]).toContain('Leave the schema unchanged');
    expect(io.dispatch.mock.calls[0]![2]).not.toContain('Run migration and verify');
    expect(chooseGroupSupervisionDecision(session.groupSessionSupervision!, ref, 1, 60_001)).toBeUndefined();
  });
});

describe('group session supervision with the session store', () => {
  const appId = 'test-group-session-supervision';
  let dataDir: string;
  let previousDataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-supervision-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init(appId);
  });

  afterEach(() => {
    sessionStore.init(appId);
    config.session.dataDir = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function storedFixture() {
    const f = fixture(sessionStore.createSession('oc_group', 'om_root', 'Build', 'group', 'thread'));
    f.io.persist.mockImplementation(() => sessionStore.updateSession(f.session));
    f.io.persist();
    return f;
  }

  it('loads the whole authored turn by message and sender from the local queue', () => {
    const message = {
      messageId: 'om_task', senderId: 'ou_requester', content: `${'a'.repeat(8_000)} 不要部署`,
    } as LarkMessage;
    appendMessage('oc_group', message);
    appendMessage('oc_group', { ...message, senderId: 'ou_other', content: 'Other bot view' });
    expect(findQueuedMessage('oc_group', 'om_task', 'ou_requester')?.content).toBe(message.content);
    expect(findQueuedMessage('oc_group', 'om_task', 'ou_missing')).toBeUndefined();
  });

  it('uses Magpie only on loopback and checks its verdicts and evidence', async () => {
    const reviewer = { provider: 'magpie', model: 'claude/sonnet' } as const;
    const task = { ...storedFixture().task, reviewer };
    writeFileSync(join(dataDir, 'magpie-reviewer.key'), 'fixture-key', { mode: 0o600 });
    const transport = vi.fn(async () => Response.json({ choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({
        verdict: 'ready', evidence: [], reason: '', missing: [], minutes: 0, question: '', options: [], recommended: 0,
      }) },
    }] }));
    const restore = __setLoopbackTransportForTests(transport);
    try {
      const signal = new AbortController().signal;
      const review = () => reviewGroupSessionTask(reviewer, task, 'Build and tests passed', signal);
      expect(await review()).toEqual({ verdict: 'ready' });
      expect(await review()).toEqual({ verdict: 'ready' });
      expect(transport).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledWith('http://127.0.0.1:3425/v1/chat/completions', expect.objectContaining({
        headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json' },
        body: expect.stringContaining('"type":"json_schema"'),
      }));
      transport.mockResolvedValueOnce(Response.json({ choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({
          verdict: 'accepted', evidence: ['Invented evidence'], reason: '', missing: [], minutes: 0, question: '', options: [], recommended: 0,
        }) },
      }] }));
      expect(await reviewGroupSessionTask(reviewer, task, 'Build and tests passed', signal, 'acceptance')).toEqual({
        verdict: 'needs_user', reason: '',
      });
      transport.mockResolvedValueOnce(Response.json({ choices: [{
        finish_reason: 'stop', message: { content: JSON.stringify({ criteria: ['The build passes', 'Provide the build result'] }) },
      }] }));
      expect(await deriveGroupSupervisionCriteria(task, signal)).toBe('The build passes\nProvide the build result');
      expect(transport).toHaveBeenLastCalledWith('http://127.0.0.1:3425/v1/chat/completions', expect.objectContaining({
        body: expect.stringContaining('original_task'),
      }));
    } finally {
      __setLoopbackTransportForTests(restore);
    }
  });

  function recordExplicitFinal(session: Session, turnId: string, text: string) {
    stageSessionTurnInbound(dataDir, session.sessionId, turnId, {
      messageId: turnId, text: 'Fix the build', via: 'lark', placement: { kind: 'thread', rootMessageId: 'om_root' },
    });
    recordSessionTurnReply(dataDir, session.sessionId, turnId, {
      messageId: 'om_final', responseKind: 'final', at: 10, text,
    });
    recordBridgeReplyMarker({
      dataDir, sessionId: session.sessionId, sentAtMs: 10, messageId: 'om_final',
      deliveryKind: 'current_session_send', content: text, responseKind: 'final', turnId,
    });
  }

  it('uses the complete structured explicit final after a restart, not its 4k preview', async () => {
    const { session, io } = storedFixture();
    const turnId = session.groupSessionSupervision!.turnId;
    const failure = 'TAIL_FAILURE: deployment rolled back';
    const answer = `Deployment is live.\n${'x'.repeat(5_000)}\n${failure}`;
    recordExplicitFinal(session, turnId, answer);
    const restored = JSON.parse(JSON.stringify(session)) as Session;
    const ds = { session: restored, chatType: 'group' } as DaemonSession;
    io.persist.mockImplementation(() => sessionStore.updateSession(restored));
    io.finalText.mockImplementation(() => turnSupervisionFinalReply(ds, turnId, dataDir));
    const seen: number[] = [];
    io.review.mockImplementation(async (_task, reviewAnswer, _signal, stage) => {
      seen.push(reviewAnswer.length);
      if (stage === 'completion') return { verdict: 'ready' };
      return reviewAnswer.includes(failure)
        ? { verdict: 'needs_user', reason: 'Rollback found' }
        : { verdict: 'accepted', evidence: ['Deployment is live.'] };
    });
    const outcome = { turnId, at: 10, outcome: 'delivered' as const };
    await observeGroupSessionSupervision(restored, { now: 10, outcome }, io);
    await observeGroupSessionSupervision(restored, { now: 11, outcome }, io);
    expect(seen).toEqual([answer.length, answer.length]);
    expect(restored.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'needs_user' });
  });

  it('refuses acceptance from a preview-only final whose tail cannot be proven complete', async () => {
    const { session, io } = storedFixture();
    const turnId = session.groupSessionSupervision!.turnId;
    const answer = `Deployment is live.\n${'x'.repeat(5_000)}\nTAIL_FAILURE: deployment rolled back`;
    recordBridgeReplyMarker({
      dataDir, sessionId: session.sessionId, sentAtMs: 10, messageId: 'om_final',
      deliveryKind: 'current_session_send', content: answer, responseKind: 'final', turnId,
    });
    const ds = { session, chatType: 'group' } as DaemonSession;
    io.finalText.mockImplementation(() => turnSupervisionFinalReply(ds, turnId, dataDir));
    await observeGroupSessionSupervision(session, {
      now: 10, outcome: { turnId, at: 10, outcome: 'delivered' },
    }, io);
    expect(session.groupSessionSupervision).toMatchObject({
      state: 'needs_user', reason: 'review_incomplete', reviewEvidenceComplete: false,
    });
    expect(io.review).not.toHaveBeenCalled();
    expect(sessionStore.getSessionFresh(session.sessionId)?.groupSessionSupervision).toMatchObject({
      state: 'needs_user', reason: 'review_incomplete', reviewEvidenceComplete: false,
    });
  });

  it('persists and honors the structured receipt truncation marker', async () => {
    const { session, io } = storedFixture();
    const turnId = session.groupSessionSupervision!.turnId;
    recordExplicitFinal(session, turnId, `${'x'.repeat(256 * 1024)}\nTAIL_FAILURE: deployment rolled back`);
    const ds = { session, chatType: 'group' } as DaemonSession;
    const captured = turnSupervisionFinalReply(ds, turnId, dataDir)!;
    expect(captured.complete).toBe(false);
    expect(captured.text).not.toContain('TAIL_FAILURE');
    io.finalText.mockReturnValue(captured);
    await observeGroupSessionSupervision(session, {
      now: 10, outcome: { turnId, at: 10, outcome: 'delivered' },
    }, io);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'review_incomplete' });
    expect(io.review).not.toHaveBeenCalled();
  });

  it('treats legacy structured replies without an explicit completeness marker as incomplete', async () => {
    const { session, io } = storedFixture();
    const turnId = session.groupSessionSupervision!.turnId;
    recordExplicitFinal(session, turnId, `Deployment is live.\n/home/${'a'.repeat(300_000)}\nTAIL_FAILURE: deployment rolled back`);
    const db = openDatabaseSyncOrThrow(join(dataDir, 'session-turns', 'turns.sqlite'));
    try {
      db.prepare("UPDATE events SET payload=json_remove(payload, '$.reply.textTruncated') WHERE session_id=? AND turn_id=?")
        .run(session.sessionId, turnId);
    } finally { db.close(); }
    const ds = { session, chatType: 'group' } as DaemonSession;
    const captured = turnSupervisionFinalReply(ds, turnId, dataDir)!;
    // Redaction after truncation can remove both the length signal and ellipsis.
    expect(captured.text.endsWith('…')).toBe(false);
    expect(captured.text).not.toContain('TAIL_FAILURE');
    expect(captured.complete).toBe(false);
    io.finalText.mockReturnValue(captured);
    await observeGroupSessionSupervision(session, {
      now: 10, outcome: { turnId, at: 10, outcome: 'delivered' },
    }, io);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'review_incomplete' });
    expect(io.review).not.toHaveBeenCalled();
  });

  it('keeps the latest text-bearing final after an attachment-only final', async () => {
    const { session, io } = storedFixture();
    const turnId = session.groupSessionSupervision!.turnId;
    const failure = 'TAIL_FAILURE: deployment rolled back';
    const answer = `Deployment is live.\n${'x'.repeat(5_000)}\n${failure}`;
    recordExplicitFinal(session, turnId, answer);
    recordSessionTurnReply(dataDir, session.sessionId, turnId, {
      messageId: 'om_attachment_final', responseKind: 'final', at: 11,
    });
    recordBridgeReplyMarker({
      dataDir, sessionId: session.sessionId, sentAtMs: 11, messageId: 'om_attachment_final',
      deliveryKind: 'current_session_send', content: '', responseKind: 'final', turnId,
    });
    const ds = { session, chatType: 'group' } as DaemonSession;
    const captured = turnSupervisionFinalReply(ds, turnId, dataDir)!;
    expect(captured).toEqual({ text: answer, complete: true });
    io.finalText.mockReturnValue(captured);
    io.review.mockImplementation(async (_task, reviewAnswer, _signal, stage) => {
      if (stage === 'completion') return { verdict: 'ready' };
      return reviewAnswer.includes(failure)
        ? { verdict: 'needs_user', reason: 'Rollback found' }
        : { verdict: 'accepted', evidence: ['Deployment is live.'] };
    });
    const outcome = { turnId, at: 10, outcome: 'delivered' as const };
    await observeGroupSessionSupervision(session, { now: 10, outcome }, io);
    await observeGroupSessionSupervision(session, { now: 11, outcome }, io);
    expect(io.review.mock.calls.map(call => call[1])).toEqual([answer, answer]);
    expect(session.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'needs_user' });
  });

  it('persists a stop through transient write failures before any restart', async () => {
    const { session, io } = storedFixture();
    const update = io.persist.getMockImplementation()!;
    let failures = 2;
    io.persist.mockImplementation(() => {
      if (failures > 0) { failures--; throw new Error('injected SQLite write failure'); }
      update();
    });
    stopGroupSessionSupervision(session, io.persist);
    expect(failures).toBe(0);
    const restored = sessionStore.getSessionFresh(session.sessionId)!;
    expect(restored.groupSessionSupervision).toMatchObject({ state: 'needs_user', reason: 'stopped' });
    await observeGroupSessionSupervision(restored, {
      now: 20,
      outcome: { turnId: restored.groupSessionSupervision!.turnId, at: 20, outcome: 'delivered' },
    }, io);
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it.each(['draining', 'committed'] as const)('preserves the watched turn if its result is %s at probe admission', async phase => {
    const { task, session, io } = storedFixture();
    const now = 12 * 60_000;
    const ds = {
      session, worker: { connected: true, killed: false }, lastMessageAt: 1,
      lastScreenStatus: 'idle', currentTurnId: task.turnId,
    } as DaemonSession;
    noteFinalReplyText(ds, task.turnId, 'Build and tests passed');
    const finish = beginFinalOutputDelivery(ds, task.turnId);
    let pending = Promise.resolve<SessionLastTurn | undefined>(undefined);
    io.finalText.mockImplementation(() => turnSupervisionFinalReply(ds, task.turnId, dataDir));
    io.canDispatch.mockImplementation(() => !isForkSourceBusy(ds));
    io.stillMissingOutput.mockImplementation((turnId, observed) => !turnOutcomePendingOrChanged(ds, turnId, observed));
    usePassingReview(io.review);
    io.serializeAdmission.mockImplementationOnce(async action => {
      // The scan saw no outcome. The terminal arrives before it gains admission.
      ds.lastTurnTerminalTurnId = task.turnId;
      ds.lastTurnTerminalStatus = 'completed';
      ds.lastTurnTerminalAt = now;
      pending = recordTurnOutcome(ds, { turnId: task.turnId, status: 'completed' }, {
        recoveryHandled: false, isFinalDelivered: () => true, now: () => now, dataDir,
      });
      if (phase === 'committed') {
        finish();
        await pending;
      }
      expect(isForkSourceBusy(ds)).toBe(false);
      action();
    });
    try {
      await observeGroupSessionSupervision(session, { now, running: false }, io);
      expect(io.dispatch).not.toHaveBeenCalled();
      expect(session.groupSessionSupervision?.turnId).toBe(task.turnId);
    } finally {
      finish();
    }
    const outcome = await pending;
    expect(outcome?.outcome).toBe('delivered');
    await observeGroupSessionSupervision(session, { now, outcome }, io);
    await observeGroupSessionSupervision(session, { now, outcome }, io);
    expect(sessionStore.getSessionFresh(session.sessionId)?.groupSessionSupervision?.state).toBe('accepted');
    expect(io.dispatch).not.toHaveBeenCalled();
  });

  it('commits both review stages through independent SQLite session updates', async () => {
    const { io, session, outcome } = storedFixture();
    io.review.mockImplementation(async (task, answer, _signal, stage) => {
      expect(task.reviewEvidence).toBe(answer);
      session.title = stage;
      sessionStore.updateSession(session);
      return stage === 'completion' ? { verdict: 'ready' } : { verdict: 'accepted', evidence: [answer] };
    });
    await outcome();
    expect(session.groupSessionSupervision?.state).toBe('pending_review');
    await outcome();
    expect(io.review.mock.calls.map(call => call[3])).toEqual(['completion', 'acceptance']);
    expect(sessionStore.getSessionFresh(session.sessionId)).toMatchObject({
      title: 'acceptance', groupSessionSupervision: { state: 'accepted', reviewEvidence: 'Test evidence' },
    });
  });
});
