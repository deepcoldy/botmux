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
import { reviewGroupSessionTask } from '../src/core/group-session-supervision-review.js';
import { __setLoopbackTransportForTests } from '../src/core/loopback-fetch.js';
import type { SessionLastTurn } from '../src/core/session-task-status.js';
import { noteFinalReplyText, recordTurnOutcome, turnFinalText, turnOutcomePendingOrChanged } from '../src/core/turn-outcome.js';
import type { DaemonSession } from '../src/core/types.js';
import { isForkSourceBusy } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

const REWORK = { verdict: 'rework', missing: [1], reason: 'Affected tests still fail' } as const;
const WAIT = { verdict: 'wait', evidence: 'Test evidence', reason: 'CI still running', minutes: 5 } as const;

function usePassingReview(review: ReturnType<typeof fixture>['io']['review']) {
  review.mockImplementation(async (_task, answer, _signal, stage) => stage === 'completion'
    ? { verdict: 'ready' }
    : { verdict: 'accepted', evidence: [answer] });
}

function fixture(session = {} as Session) {
  const task = newGroupSessionSupervision({
    requester: 'ou_requester', chatId: 'oc_group', anchor: 'om_root',
    reviewer: { botAppId: 'local_reviewer', model: 'test-model' },
    task: 'Fix the build', criteria: 'The build and affected tests are green', turnId: 'om_task',
  }, 1);
  session.groupSessionSupervision = task;
  const io = {
    allowed: vi.fn(() => true),
    current: vi.fn(() => true),
    finalText: vi.fn<GroupSessionSupervisionIo['finalText']>(() => 'Test evidence'),
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
    io.canDispatch.mockReturnValue(false);
    await observeGroupSessionSupervision(saved, { now: checkAt }, io);
    expect(io.wake).toHaveBeenCalledOnce();
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
    } finally {
      __setLoopbackTransportForTests(restore);
    }
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
    io.finalText.mockImplementation(() => turnFinalText(ds, task.turnId, dataDir));
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
