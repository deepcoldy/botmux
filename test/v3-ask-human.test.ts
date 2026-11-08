/**
 * The main bot handles a node on its own, or hands it to a person — and says
 * why every time (design 2026-11-03 §13.6, M3). Real runtime, journal,
 * external attempt ledger and engine controls over a temp run dir with a fake
 * bot transport and an injectable clock; the relay and IPC body checks use
 * the same pure authorizers the daemon routes call.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { appendEvent } from '../src/workflows/v3/journal.js';
import { handNodeToHuman, reassignNode } from '../src/workflows/v3/external-control.js';
import { pendingV3MainWakes } from '../src/workflows/v3/main-wake.js';
import { openV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import { requestV3Retry } from '../src/workflows/v3/daemon-run.js';
import { v3ActionRecord, v3ReasonRequiredProblem } from '../src/workflows/v3/action-provenance.js';
import { parseWorkflowDaemonMutationBody } from '../src/workflows/v3/daemon-ipc-body.js';
import {
  foldV3NodeInterventions,
  formatV3Intervention,
  latestV3InterventionFor,
} from '../src/workflows/v3/interventions.js';
import { buildV3NodeCard } from '../src/im/lark/v3-node-card.js';
import { v3NodeCardStatusFor } from '../src/im/lark/v3-node-card-sync.js';
import { nodeStatusLine } from '../src/dashboard/web/v3-model.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';
import { parseV3AskHumanCliOptions } from '../src/cli/v3-run-actions.js';
import { parseV3RunEditCliOptions } from '../src/cli/v3-run-edit.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import {
  BotRun,
  FakeExecutor,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
} from './helpers/v3-external-harness.js';

afterEach(cleanupBotRuns);

const REASON = 'the bot needs the prod token; only the initiator can grant it';

// ─── ask-human ───────────────────────────────────────────────────────────

describe('ask-human on a running node: record, stop, block', () => {
  it('stops the bot\'s turn like a timeout, then records the hand-over and blocks HANDED_TO_HUMAN', async () => {
    const run = new BotRun(reportDag('ask-running'));
    const executor = new FakeExecutor();
    expectAwaitingExternal(await run.drive(executor));
    const open = run.openAttempt('write');
    run.accept(open.attemptId);

    const out = await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot', turnId: 'workflow-event:ask-running:4' }, { executor });
    expect(out).toMatchObject({ kind: 'handed', attemptId: open.attemptId, closedOpenAttempt: true });
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: open.attemptId, reason: 'handedToHuman', sessionId: 'sess-1' })]);
    const [handed] = run.of('nodeHandedToHuman');
    expect(handed).toMatchObject({ attemptId: open.attemptId, reason: REASON, by: 'main_bot', turnId: 'workflow-event:ask-running:4' });
    const [blocked] = run.of('nodeBlocked');
    expect(blocked).toMatchObject({
      attemptId: open.attemptId, errorClass: 'workerError', recovery: 'retry', errorCode: 'HANDED_TO_HUMAN', message: REASON,
    });
    // The record precedes the close, and the attempt binding is closed.
    const events = run.events();
    expect(events.indexOf(handed!)).toBeLessThan(events.findIndex((event) => event.type === 'nodeBlocked'));
    expect(openV3ExternalAttempts(run.events())).toEqual([]);

    // The ordinary blocked path takes it from here: no new deadline, a retry
    // brings it back.
    const blockedRun = expectTerminal(await run.drive(new FakeExecutor()));
    expect(blockedRun).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
  });

  it('a submission that came first wins; one that lands after the hand-over was recorded is refused', async () => {
    // First: the bot handed in before anyone decided — nothing to hand over.
    const done = new BotRun(reportDag('ask-first'));
    const executorA = new FakeExecutor();
    await done.drive(executorA);
    const first = done.openAttempt('write');
    done.accept(first.attemptId);
    expect(await done.submit(first.attemptId, {
      sessionId: 'sess-1', files: [{ key: 'report', name: 'r.md', data: Buffer.from('# r\n') }], result: { message: 'ok' },
    })).toMatchObject({ ok: true, kind: 'succeeded' });
    expect(await handNodeToHuman(done.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor: executorA }))
      .toEqual({ kind: 'rejected', reason: 'not-handable' });
    expect(done.of('nodeHandedToHuman')).toEqual([]);

    // After: the decision is on record before the turn is stopped, so a
    // submission racing the stop no longer counts.
    const run = new BotRun(reportDag('ask-race'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    run.accept(open.attemptId);
    let late: unknown;
    executor.onStop = async () => {
      expect(run.of('nodeHandedToHuman')).toHaveLength(1);
      late = await run.submit(open.attemptId, {
        sessionId: 'sess-1', files: [{ key: 'report', name: 'r.md', data: Buffer.from('# r\n') }], result: { message: 'ok' },
      });
    };
    expect(await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor }))
      .toMatchObject({ kind: 'handed', closedOpenAttempt: true });
    expect(late).toMatchObject({ ok: false, reason: 'handed-to-human' });
    expect(run.of('nodeSucceeded')).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'HANDED_TO_HUMAN' })]);
  });

  it('a proposal that appears while the turn is being stopped: the node is still closed, never left "running" with nobody on it', async () => {
    const run = new BotRun(reportDag('ask-proposal'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    run.accept(open.attemptId);
    executor.onStop = async () => {
      appendEvent(run.journalPath, {
        type: 'dagRevisionProposed', revision: 2, baseRevision: 1, sha256: 'x', patchSha256: 'y', summary: 's',
        by: 'ou_member', reasons: ['callerNotInitiator'], touched: ['write'],
      });
    };
    expect(await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor }))
      .toMatchObject({ kind: 'handed', closedOpenAttempt: true });
    expect(openV3ExternalAttempts(run.events())).toEqual([]);
    expect(run.snap().nodes.get('write')?.status).toBe('blocked');
  });

  it('closed some other way while being stopped (timed out and retried, or reassigned): that close stands, the reason stays on record', async () => {
    const run = new BotRun(reportDag('ask-replaced'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const first = run.openAttempt('write');
    run.accept(first.attemptId);
    // Meanwhile: it timed out, a person retried, and a new attempt went out.
    executor.onStop = async () => {
      appendEvent(run.journalPath, {
        type: 'nodeBlocked', nodeId: 'write', ...(first.instanceId ? { instanceId: first.instanceId } : {}),
        attemptId: first.attemptId, errorClass: 'timeout', errorCode: 'NODE_TIMEOUT',
      });
      expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
      executor.onStop = async () => {};
      await run.drive(executor);
    };
    expect(await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor }))
      .toMatchObject({ kind: 'handed', attemptId: first.attemptId, closedOpenAttempt: false, settledMeanwhile: 'blocked' });
    // The new attempt is nobody's hand-over; the old block wakes nobody.
    const second = run.openAttempt('write');
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(run.of('nodeHandedToHuman')).toEqual([expect.objectContaining({ attemptId: first.attemptId })]);
    expect(pendingV3MainWakes({ events: run.events(), dag: run.dag, isIssued: () => false })).toEqual([]);

    // Reassigned by the initiator while the turn was being stopped.
    const two = new BotRun(validateDag({
      schemaVersion: 2, runId: 'ask-reassign',
      nodes: [
        { id: 'write', type: 'goal', goal: 'w', bot: 'cli_a', depends: [], inputs: [] },
        { id: 'other', type: 'goal', goal: 'o', bot: 'cli_b', depends: ['write'], inputs: [] },
      ],
    }));
    const executor2 = new FakeExecutor();
    await two.drive(executor2);
    const attempt = two.openAttempt('write');
    two.accept(attempt.attemptId);
    executor2.onStop = async () => {
      executor2.onStop = async () => {};
      expect(await reassignNode(two.runDir, { nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou_initiator' }, { ...two.ctx(), executor: executor2 }))
        .toMatchObject({ kind: 'reassigned' });
    };
    expect(await handNodeToHuman(two.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor: executor2 }))
      .toMatchObject({ kind: 'handed', closedOpenAttempt: false, settledMeanwhile: 'reassigned' });
    expect(two.of('nodeBlocked')).toEqual([]);
  });
});

describe('ask-human on other node states', () => {
  it('a node already blocked: only the record — its block (and recovery) stays as it was', async () => {
    const run = new BotRun(reportDag('ask-blocked'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    appendEvent(run.journalPath, {
      type: 'nodeBlocked', nodeId: 'write', ...(open.instanceId ? { instanceId: open.instanceId } : {}), attemptId: open.attemptId,
      errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', message: 'no access',
    });
    const stopsBefore = executor.stops.length;
    expect(await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'ou_initiator' }, { executor }))
      .toMatchObject({ kind: 'handed', attemptId: open.attemptId, closedOpenAttempt: false });
    expect(executor.stops).toHaveLength(stopsBefore);
    expect(run.of('nodeHandedToHuman')).toEqual([expect.objectContaining({ attemptId: open.attemptId, by: 'ou_initiator' })]);
    expect(run.of('nodeBlocked')).toHaveLength(1);
    // Its block had not woken the main bot yet: now it never will (a person
    // decided; waking would invite the main bot to undo that).
    expect(pendingV3MainWakes({ events: run.events(), dag: run.dag, isIssued: () => false })).toEqual([]);
  });

  it('refuses a node that never ran, a finished one, a run on temporary workers, and a held one', async () => {
    const run = new BotRun(validateDag({
      schemaVersion: 2, runId: 'ask-states',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a', depends: [], inputs: [] },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b', depends: ['a'], inputs: [] },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const hand = (nodeId: string) => handNodeToHuman(run.runDir, { nodeId, reason: REASON, by: 'main_bot' }, { executor, dag: run.dag });
    expect(await hand('b')).toEqual({ kind: 'rejected', reason: 'never-dispatched' });
    expect(await hand('zzz')).toEqual({ kind: 'rejected', reason: 'unknown-node' });
    const a = run.openAttempt('a');
    run.accept(a.attemptId);
    await run.submit(a.attemptId, { sessionId: 'sess-1', files: [{ key: 'notes', name: 'n.md', data: Buffer.from('n') }] });
    expect(await hand('a')).toEqual({ kind: 'rejected', reason: 'not-handable' });
    expect(await handNodeToHuman(run.runDir, { nodeId: 'a', reason: REASON, by: 'main_bot' }, { nodeExecutor: null }))
      .toEqual({ kind: 'rejected', reason: 'not-bot-run' });
    // A pending proposal touching a running node decides it first.
    await run.drive(executor);
    expect(run.openAttempt('b')).toBeDefined();
    appendEvent(run.journalPath, {
      type: 'dagRevisionProposed', revision: 2, baseRevision: 1, sha256: 'x', patchSha256: 'y', summary: 's',
      by: 'ou_member', reasons: ['callerNotInitiator'], touched: ['b'],
    });
    expect(await hand('b')).toEqual({ kind: 'rejected', reason: 'revision-pending' });
    expect(run.of('nodeHandedToHuman')).toEqual([]);
  });
});

describe('a hand-over half written (crash between its two journal lines)', () => {
  it('is closed on the next drive at once — HANDED_TO_HUMAN with the recorded reason, not at the deadline', async () => {
    const run = new BotRun(reportDag('ask-heal'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    run.accept(open.attemptId);
    appendEvent(run.journalPath, {
      type: 'nodeHandedToHuman', nodeId: 'write', ...(open.instanceId ? { instanceId: open.instanceId } : {}),
      attemptId: open.attemptId, reason: REASON, by: 'main_bot',
    });
    // Well before the node's deadline.
    run.clock.t += 1_000;
    const restarted = new FakeExecutor();
    expect(expectTerminal(await run.drive(restarted))).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
      attemptId: open.attemptId, errorCode: 'HANDED_TO_HUMAN', recovery: 'retry', message: REASON,
    })]);
    expect(restarted.stops).toEqual([expect.objectContaining({ attemptId: open.attemptId, reason: 'handedToHuman' })]);
  });
});

// ─── Reasons ─────────────────────────────────────────────────────────────

describe('--reason: required in a wake turn, optional (and unchanged) otherwise', () => {
  it('a wake turn without a reason is refused; with one, or any human turn, is fine', () => {
    expect(v3ReasonRequiredProblem({ origin: 'runEvent', wakeTurn: true }, undefined)).toContain('--reason');
    expect(v3ReasonRequiredProblem({ origin: 'human', wakeTurn: true }, '  ')).toContain('--reason');
    expect(v3ReasonRequiredProblem({ origin: 'runEvent', wakeTurn: true }, REASON)).toBeUndefined();
    expect(v3ReasonRequiredProblem({ origin: 'human', openId: 'ou_initiator' }, undefined)).toBeUndefined();
    // A scheduled turn of the initiator is the main bot's, but may still
    // leave the reason out (retry kept working there before).
    expect(v3ReasonRequiredProblem({ origin: 'runEvent' }, undefined)).toBeUndefined();
    expect(v3ReasonRequiredProblem(undefined, undefined)).toBeUndefined();
  });

  it('a retry records main_bot + reason; a human turn without one keeps the old bytes', async () => {
    const run = new BotRun(reportDag('retry-why'));
    await run.drive(new FakeExecutor());
    const blockOpen = () => {
      const open = run.openAttempt('write');
      appendEvent(run.journalPath, {
        type: 'nodeBlocked', nodeId: 'write', ...(open.instanceId ? { instanceId: open.instanceId } : {}),
        attemptId: open.attemptId, errorClass: 'timeout', errorCode: 'NODE_TIMEOUT',
      });
    };
    blockOpen();
    expect(requestV3Retry(run.base, run.dag.runId, {
      nodeId: 'write', record: v3ActionRecord({ origin: 'runEvent', wakeTurn: true, openId: 'ou_initiator' }, REASON),
    })).toMatchObject({ kind: 'requested' });
    expect(run.of('nodeRetryRequested').at(-1)).toMatchObject({ by: 'main_bot', auto: { reason: REASON }, reason: 'blockedRetry' });

    await run.drive(new FakeExecutor());
    blockOpen();
    const record = v3ActionRecord({ origin: 'human', openId: 'ou_initiator' }, undefined);
    expect(record).toEqual({});
    requestV3Retry(run.base, run.dag.runId, { nodeId: 'write', ...(Object.keys(record).length ? { record } : {}) });
    const human = run.of('nodeRetryRequested').at(-1)!;
    expect(Object.keys(human).sort()).toEqual([
      'nextAttemptId', 'nodeId', 'previousAttemptId', 'previousErrorClass', 'previousErrorCode', 'reason', 'ts', 'type',
      ...(human.instanceId ? ['instanceId'] : []),
    ].sort());
    // A human who does give a reason is recorded as themselves, with a note.
    expect(v3ActionRecord({ origin: 'human', openId: 'ou_initiator' }, 'try again')).toEqual({ by: 'ou_initiator', note: 'try again' });
  });

  it('the IPC bodies: old shapes still parse, a forged or malformed caller does not', () => {
    const parse = (mutation: 'retry' | 'ask-human' | 'edit', value: unknown) => parseWorkflowDaemonMutationBody(mutation, JSON.stringify(value));
    expect(parse('retry', {})).toEqual({ ok: true, body: { mutation: 'retry', value: {} } });
    expect(parse('retry', { nodeId: 'write' })).toEqual({ ok: true, body: { mutation: 'retry', value: { nodeId: 'write' } } });
    expect(parse('retry', { nodeId: 'write', reason: REASON, caller: { origin: 'runEvent', wakeTurn: true, openId: 'ou_i' } }))
      .toMatchObject({ ok: true, body: { value: { reason: REASON, caller: { origin: 'runEvent', wakeTurn: true } } } });
    expect(parse('retry', { caller: { origin: 'god' } })).toEqual({ ok: false, error: 'bad_caller' });
    expect(parse('retry', { caller: { origin: 'human', extra: 1 } })).toEqual({ ok: false, error: 'bad_caller' });
    expect(parse('retry', { reason: 'x'.repeat(501) })).toEqual({ ok: false, error: 'bad_reason' });
    expect(parse('ask-human', { nodeId: 'write', caller: { origin: 'runEvent' } })).toEqual({ ok: false, error: 'bad_reason' });
    expect(parse('ask-human', { nodeId: 'write', reason: REASON })).toEqual({ ok: false, error: 'bad_caller' });
    expect(parse('edit', { patch: [], base: 1, caller: { openId: 'ou_i', origin: 'human' } })).toMatchObject({ ok: true });
    expect(parse('edit', { patch: [], base: 1, caller: { openId: 'ou_i', origin: 'runEvent', wakeTurn: true }, reason: REASON }))
      .toMatchObject({ ok: true, body: { value: { reason: REASON, caller: { wakeTurn: true } } } });
  });

  it('the CLI flags', () => {
    expect(parseV3AskHumanCliOptions(['--node', 'write', '--reason', REASON])).toEqual({ ok: true, nodeId: 'write', reason: REASON });
    expect(parseV3AskHumanCliOptions(['--node', 'write'])).toMatchObject({ ok: false });
    expect(parseV3AskHumanCliOptions(['--reason', REASON])).toMatchObject({ ok: false });
    expect(parseV3AskHumanCliOptions(['--node', '../x', '--reason', REASON])).toMatchObject({ ok: false });
    expect(parseV3RunEditCliOptions(['--patch-file', 'p.json', '--base', '2', '--reason', REASON]))
      .toEqual({ ok: true, patchFile: 'p.json', base: 2, json: false, reason: REASON });
    expect(parseV3RunEditCliOptions(['--patch-file', 'p.json', '--base', '2'])).toEqual({ ok: true, patchFile: 'p.json', base: 2, json: false });
    expect(parseV3RunEditCliOptions(['--patch-file', 'p.json', '--base', '2', '--reason'])).toMatchObject({ ok: false });
  });
});

// ─── What people see ─────────────────────────────────────────────────────

describe('display: the node card, the Dashboard node panel', () => {
  it('lists the main bot\'s automatic handling and every hand-over, roles only, oldest first', () => {
    const events = [
      { type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/001', nextAttemptId: 'a/attempts/002', reason: 'blockedRetry', ts: 1 },
      { type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/002', nextAttemptId: 'a/attempts/003', reason: 'blockedRetry', by: 'main_bot', auto: { reason: 'flaky upstream' }, ts: 2 },
      { type: 'nodeReassigned', nodeId: 'a', from: 'cli_a', to: 'cli_b', by: 'main_bot', auto: { reason: 'cli_a lacks access' }, ts: 3 },
      { type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/003', nextAttemptId: 'a/attempts/004', reason: 'blockedRetry', by: 'main_bot', auto: { reason: 'cli_a lacks access' }, ts: 4 },
      { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/004', ts: 5 },
      { type: 'nodeHandedToHuman', nodeId: 'a', attemptId: 'a/attempts/004', reason: 'still failing', by: 'ou_initiator', ts: 6 },
      { type: 'nodeReassigned', nodeId: 'b', from: 'cli_a', to: 'cli_b', by: 'ou_initiator', ts: 7 },
    ] as never[];
    const folded = foldV3NodeInterventions(events, 'ou_initiator');
    expect(folded.get('a')).toEqual([
      { kind: 'retry', by: 'mainBot', reason: 'flaky upstream', at: 2, attemptId: 'a/attempts/003' },
      // The retry that moves a blocked node onto its new bot is part of the reassignment.
      { kind: 'reassign', by: 'mainBot', reason: 'cli_a lacks access', at: 3, attemptId: 'a/attempts/004' },
      { kind: 'handedToHuman', by: 'initiator', reason: 'still failing', at: 6, attemptId: 'a/attempts/004' },
    ]);
    // Human actions are not listed; nothing names an open_id.
    expect(folded.has('b')).toBe(false);
    expect(JSON.stringify([...folded.values()])).not.toContain('ou_');
    expect(formatV3Intervention(latestV3InterventionFor(folded.get('a'), 'a/attempts/004')!)).toBe('交给人决定：still failing');
    expect(formatV3Intervention(latestV3InterventionFor(folded.get('a'), 'a/attempts/003')!)).toBe('主 Bot 自动重试：flaky upstream');
    // Journals without these records (older runs) yield nothing.
    expect(foldV3NodeInterventions([events[0]!, events[4]!]).size).toBe(0);
  });

  it('a handed-over node reads 等人工确认 on the card and the graph, with its reason once', async () => {
    const run = new BotRun(reportDag('ask-display'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const open = run.openAttempt('write');
    run.accept(open.attemptId);
    await handNodeToHuman(run.runDir, { nodeId: 'write', reason: REASON, by: 'main_bot' }, { executor });
    const events = run.events();
    const attempt = [...(await import('../src/workflows/v3/external-attempt-ledger.js')).foldV3ExternalAttempts(events).values()][0]!;
    const status = v3NodeCardStatusFor(attempt, events, 'blocked');
    const intervention = formatV3Intervention(latestV3InterventionFor(foldV3NodeInterventions(events).get('write'), attempt.attemptId)!);
    const card = buildV3NodeCard({
      runTitle: 't', runId: 'ask-display', nodeId: 'write', botName: 'B', selfExecuted: false, attemptNumber: 1,
      status, upstream: [], now: 0, intervention,
    });
    expect(card).toContain('等人工确认');
    expect(card).toContain(`交给人决定：${REASON}`);
    expect(card.split(REASON)).toHaveLength(2); // shown once, not also as 原因

    const node = projectRun('ask-display', run.runDir).nodes.find((item) => item.id === 'write')!;
    expect(node.interventions).toEqual([expect.objectContaining({ kind: 'handedToHuman', by: 'mainBot', reason: REASON })]);
    expect(nodeStatusLine(node, undefined)).toBe('等人工确认 · 交给人决定');
  });
});
