/**
 * The session a main-topic handoff lands in (design 2026-11-03 §5.5): the
 * executing bot's ORDINARY session in the run's main topic — possibly an
 * existing one, for the main bot its main session — which outlives the
 * attempt. Its workflow-node marker is attempt-scoped:
 *
 * - it never makes the session a node session (kind, skills, plugin dir);
 * - the sidebar entry and stall tracking count only while the attempt is in
 *   progress (handed in, stopped / revoked, or reported blocked ends it);
 * - a stop interrupts only the handoff's own running turn, never someone
 *   else's turn in that shared session; a queued handoff turn that was
 *   stopped is interrupted the moment it starts;
 * - the turn's real start is reported so the node deadline counts from it.
 *
 * Real node-daemon wiring, routes and registry over fake sessions / IPC.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createWorkflowNodeDaemon, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { BotRun, cleanupBotRuns, reportDag } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf, orchestratorEvent } from './helpers/workflow-handoff-harness.js';
import { authorizeRun } from './helpers/workflow-identity-world.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';
import { revokeWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';
import {
  isWorkflowNodeSessionMarker,
  workflowHandoffInputOptions,
  workflowNodeMarkerActive,
  workflowNodeMarkerFromBinding,
} from '../src/core/workflow-node-session.js';
import { workflowNodeSessionEntry } from '../src/im/lark/workflow-sidebar-entry.js';

afterEach(() => cleanupBotRuns());

const ROOT = 'om_main_topic';
const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: ROOT };

async function mainHandoff(runId: string, world = handoffWorld()) {
  const run = new BotRun(reportDag(runId, { placement: 'main' }));
  await run.drive(world.executor, { opts: { chatBinding: BINDING } });
  const attempt = run.openAttempt('write');
  const marker: WorkflowNodeSessionMarker = {
    runId, nodeId: 'write', attemptId: attempt.attemptId, handoffMessageId: attempt.handoffMessageId!,
    nonce: nonceOf(attempt), publishRoot: ROOT, orchestratorAppId: MAIN,
    registeredAt: new Date(run.clock.t).toISOString(), placement: 'main',
  };
  return { run, world, attempt, marker };
}

function wiring(dataDir: string, run: BotRun, sessions: DaemonSession[]) {
  const posted: Array<{ path: string; body: any }> = [];
  const interrupted: string[] = [];
  const updated: string[] = [];
  const deps = wiringDeps(dataDir, run, sessions, posted, interrupted, updated);
  return { daemon: createWorkflowNodeDaemon(deps), posted, interrupted, updated };
}

function wiringDeps(
  dataDir: string,
  run: BotRun,
  sessions: DaemonSession[],
  posted: Array<{ path?: string; body: any }>,
  interrupted: string[] = [],
  updated: string[] = [],
): WorkflowNodeDaemonDeps {
  return {
    selfLarkAppId: () => 'cli_a',
    dataDir: () => dataDir,
    baseDir: () => run.base,
    sendCard: async () => 'om_unused',
    replyCard: async () => 'om_report_card',
    patchCard: async () => {},
    resolveBotInChat: async () => ({ ok: true, openId: 'ou_x' }),
    targetOpensTopicSessions: async () => 'yes',
    daemonPort: (appId) => (appId === MAIN ? 4100 : undefined),
    hostSecret: () => 'host-secret',
    bindingSecret: () => SECRET,
    postDaemon: async (_port, path, body) => { posted.push({ path, body }); return { status: 200, body: { ok: true } }; },
    ensureGrant: async () => {},
    loadSessions: () => [],
    isProcessAlive: () => true,
    activeSessions: () => sessions,
    updateSession: (ds) => { updated.push(ds.session.sessionId); },
    getSessionWorkingDir: () => '',
    findNodeSession: () => undefined,
    interruptTurn: (ds, opts) => { interrupted.push(`${ds.session.sessionId}${opts?.evenIfIdle ? ':force' : ''}`); return true; },
    proveBotSender: async () => true,
    noticeRetryMs: 5,
    deliverSelfTurn: async () => ({ sessionId: 'self-session' }),
    prepareTurnIdentity: async () => {},
    attachmentsDir: (appId, messageId) => join(dataDir, 'attachments', appId, messageId),
    loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', chatId: CHAT, title: 't' }),
    botWorkingDirConfig: () => ({}),
    daemonAppliesNodeWorkingDir: () => true,
    drive: () => {},
    botName: (appId) => appId,
    warn: () => {},
    handoffIdentity: { botTools: () => [], checkSelf: async () => ({ status: 'not_required' }) },
  };
}

const session = (sessionId: string, marker: WorkflowNodeSessionMarker) =>
  ({ session: { sessionId, rootMessageId: ROOT, workflowNode: marker } }) as unknown as DaemonSession;
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the marker of a main-topic handoff', () => {
  it('comes from the signed binding, and never makes the session a node session', async () => {
    const { world, attempt } = await mainHandoff('ms-kind');
    const { lookupWorkflowHandoff, readDispatchRegistryLoose } = await import('../src/core/workflow-handoff-binding.js');
    const found = lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(world.dataDir), dispatchRoot: attempt.handoffMessageId!, secret: SECRET });
    if (found.kind !== 'workflow') throw new Error('no binding');
    const marker = workflowNodeMarkerFromBinding(found.binding, attempt.handoffMessageId!);
    expect(marker).toMatchObject({ placement: 'main', publishRoot: ROOT });
    expect(isWorkflowNodeSessionMarker(marker)).toBe(false);
    // A node topic's marker still does (that session is the node's own).
    const { placement: _placement, ...topicMarker } = marker;
    expect(isWorkflowNodeSessionMarker(topicMarker)).toBe(true);
  });

  it('its turn waits behind a running turn of that session instead of being folded in', () => {
    expect(workflowHandoffInputOptions({ placement: 'main' })).toEqual({ queueAfterActiveTurn: true });
    expect(workflowHandoffInputOptions({})).toEqual({});
    expect(workflowHandoffInputOptions(undefined)).toEqual({});
  });

  it('carries the sidebar entry only while its attempt is in progress', () => {
    const marker = { runId: 'r', orchestratorAppId: MAIN, placement: 'main' as const };
    const entryFor = () => ({ url: 'https://dash/#/workflows/r' });
    expect(workflowNodeSessionEntry(marker, entryFor)).toEqual({ url: 'https://dash/#/workflows/r' });
    expect(workflowNodeSessionEntry({ ...marker, submittedAt: 'x' }, entryFor)).toBeUndefined();
    expect(workflowNodeSessionEntry({ ...marker, closedAt: 'x' }, entryFor)).toBeUndefined();
    // A node topic's session keeps it for good, as before.
    expect(workflowNodeSessionEntry({ runId: 'r', orchestratorAppId: MAIN, submittedAt: 'x' }, entryFor)).toBeDefined();
    expect(workflowNodeMarkerActive(undefined)).toBe(false);
  });
});

describe('stopping a main-topic attempt', () => {
  it('ends the marker; the shared session\'s other running turn is never interrupted', async () => {
    const { run, world, marker } = await mainHandoff('ms-stop-other');
    const ds = session('sess-a', marker);
    const { daemon, interrupted } = wiring(world.dataDir, run, [ds]);
    // Someone else's turn is running in that session; the handoff is queued.
    daemon.onTurnStarted(ds, { turnId: 'om_person', startedAt: run.clock.t });
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'runCancelled', run.clock.t);
    expect(daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'runCancelled' })).toMatchObject({ status: 200 });
    expect(interrupted).toEqual([]);
    expect(ds.session.workflowNode).toMatchObject({ closedAt: expect.any(String) });
    expect(workflowNodeMarkerActive(ds.session.workflowNode)).toBe(false);
    // The queued handoff turn reaching the CLI later is stopped right away.
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t + 1 });
    expect(interrupted).toEqual(['sess-a:force']);
  });

  it('interrupts the handoff\'s own running turn', async () => {
    const { run, world, marker } = await mainHandoff('ms-stop-own');
    const ds = session('sess-a', marker);
    const { daemon, interrupted } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'timeout', run.clock.t);
    daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'timeout' });
    expect(interrupted).toEqual(['sess-a']);
  });

  it('ADV-1: a person\'s message folded into the running handoff turn does not shield it: the stop interrupts it', async () => {
    const { run, world, marker } = await mainHandoff('ms-stop-merged');
    const ds = session('sess-a', marker);
    const { daemon, interrupted } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    // Type-ahead: the worker writes the person's message into the running CLI turn.
    daemon.onTurnStarted(ds, { turnId: 'om_person_merged', startedAt: run.clock.t + 1 });
    daemon.onInputCommitted(ds, { turnId: 'om_person_merged', committedAt: run.clock.t + 1 });
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'timeout', run.clock.t);
    daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'timeout' });
    expect(interrupted).toEqual(['sess-a']);
  });

  it('ADV-7: the handoff turn running is kept on the persisted marker — a stop after a restart still interrupts it', async () => {
    const { run, world, marker } = await mainHandoff('ms-stop-restart');
    const ds = session('sess-a', marker);
    wiring(world.dataDir, run, [ds]).daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    expect(ds.session.workflowNode).toMatchObject({ handoffStartedAt: expect.any(String) });
    // A fresh daemon (nothing in memory) over the same persisted session row.
    const restored = session('sess-a', JSON.parse(JSON.stringify(ds.session.workflowNode)));
    const after = wiring(world.dataDir, run, [restored]);
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'runCancelled', run.clock.t);
    after.daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'runCancelled' });
    expect(after.interrupted).toEqual(['sess-a']);
  });

  it('once the handoff turn went idle, a later unrelated turn of the shared session is not interrupted', async () => {
    const { run, world, marker } = await mainHandoff('ms-stop-settled');
    const ds = session('sess-a', marker);
    const { daemon, interrupted } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    daemon.onInputCommitted(ds, { turnId: marker.handoffMessageId, committedAt: run.clock.t });
    daemon.onTurnSettled(ds, { turnId: marker.handoffMessageId, at: run.clock.t + 10 });
    expect(ds.session.workflowNode).toMatchObject({ handoffSettledAt: expect.any(String) });
    daemon.onTurnStarted(ds, { turnId: 'workflow-event:other:7', startedAt: run.clock.t + 20 });
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'timeout', run.clock.t);
    daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'timeout' });
    expect(interrupted).toEqual([]);
  });

  it('a node topic\'s session is stopped exactly as before (whatever turn it runs)', async () => {
    const run = new BotRun(reportDag('ms-stop-topic'));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const marker: WorkflowNodeSessionMarker = {
      runId: 'ms-stop-topic', nodeId: 'write', attemptId: attempt.attemptId, handoffMessageId: attempt.handoffMessageId!,
      nonce: nonceOf(attempt), publishRoot: attempt.nodeCardMessageId!, orchestratorAppId: MAIN, registeredAt: new Date().toISOString(),
    };
    const ds = { session: { sessionId: 'sess-t', rootMessageId: marker.publishRoot, workflowNode: marker } } as unknown as DaemonSession;
    const { daemon, interrupted } = wiring(world.dataDir, run, [ds]);
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'runCancelled', run.clock.t);
    daemon.stopRoute({ nonce: marker.nonce, sessionId: 'sess-t', reason: 'runCancelled' });
    expect(interrupted).toEqual(['sess-t']);
    expect(ds.session.workflowNode).not.toHaveProperty('closedAt');
  });
});

describe('the real start of a queued main-topic turn', () => {
  it('is reported to the main bot with its start time; other turns are not', async () => {
    const { run, world, marker } = await mainHandoff('ms-start');
    const ds = session('sess-a', marker);
    const { daemon, posted } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: 'om_person', startedAt: 1 });
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: 42 });
    await flush();
    expect(posted).toEqual([{
      path: '/api/workflow/handoff-event',
      body: { kind: 'accepted', nonce: marker.nonce, dispatchRoot: marker.handoffMessageId, sessionId: 'sess-a', startedAt: 42 },
    }]);
  });

  it('a node topic\'s turn start is not reported (its timeout already counts from acceptance)', async () => {
    const { run, world, marker } = await mainHandoff('ms-start-topic');
    const { placement: _placement, ...topicMarker } = marker;
    const ds = session('sess-t', topicMarker);
    const { daemon, posted } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: 42 });
    await flush();
    expect(posted).toEqual([]);
  });
});

describe('while the attempt is in progress', () => {
  it('the main bot\'s own synthetic turns in the shared session are not the node\'s', async () => {
    const { run, world, marker } = await mainHandoff('ms-synthetic');
    const ds = session('sess-a', marker);
    const { daemon, posted } = wiring(world.dataDir, run, [ds]);
    // The handoff turn is under way; then a wake turn of the main bot runs.
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: 4 });
    await flush();
    posted.splice(0);
    daemon.onInputCommitted(ds, { turnId: 'workflow-event:other:3', committedAt: 5 });
    daemon.onTurnSettled(ds, { turnId: 'workflow-event:other:3', at: 6 });
    await flush();
    expect(posted).toEqual([]);
    expect(ds.session.workflowNode?.turnIds ?? []).not.toContain('workflow-event:other:3');
    // A message in the topic (someone answering the bot) is.
    daemon.onInputCommitted(ds, { turnId: 'om_answer', committedAt: 7 });
    await flush();
    expect(posted).toEqual([expect.objectContaining({ body: expect.objectContaining({ kind: 'active', sessionId: 'sess-a' }) })]);
  });
});

describe('what the report route sees of the marker (ADV-4)', () => {
  it('started only once the handoff turn started; active only while the attempt is in progress', async () => {
    const { run, world, marker } = await mainHandoff('ms-report-marker');
    const { workflowNodeReportMarker } = await import('../src/core/workflow-node-session.js');
    const ds = session('sess-a', marker);
    expect(workflowNodeReportMarker(ds.session.workflowNode!)).toMatchObject({ placement: 'main', started: false, active: true });
    const { daemon } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    expect(workflowNodeReportMarker(ds.session.workflowNode!)).toMatchObject({ started: true, active: true });
    expect(workflowNodeReportMarker({ ...ds.session.workflowNode!, closedAt: 'x' })).toMatchObject({ active: false });
    // A node topic's marker carries none of it (its report rules are unchanged).
    const { placement: _placement, ...topicMarker } = marker;
    expect(workflowNodeReportMarker(topicMarker)).toEqual({ handoffMessageId: marker.handoffMessageId, nonce: marker.nonce });
  });
});

describe('ADV-2: turns ahead of the queued handoff are not the node\'s', () => {
  it('someone else\'s turn ending before the handoff turn starts reports nothing for the node', async () => {
    const { run, world, marker } = await mainHandoff('ms-ahead');
    const ds = session('sess-a', marker);
    const { daemon, posted } = wiring(world.dataDir, run, [ds]);
    daemon.onInputCommitted(ds, { turnId: 'om_person_ahead', committedAt: 1 });
    daemon.onTurnSettled(ds, { turnId: 'om_person_ahead', at: 2 });
    await flush();
    expect(posted).toEqual([]);
    expect(ds.session.workflowNode?.turnIds).toBeUndefined();
    // Once the handoff turn started, a person answering the bot counts again.
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: 3 });
    daemon.onInputCommitted(ds, { turnId: 'om_person_answer', committedAt: 4 });
    await flush();
    expect(posted.map((entry) => entry.body.kind)).toEqual(['accepted', 'active']);
  });

  it('the card does not show a stall that came before the handoff turn started', async () => {
    const { v3NodeStalled } = await import('../src/im/lark/v3-node-card.js');
    expect(v3NodeStalled({ kind: 'running', acceptedAt: 0, stalledAt: 2, startedAt: 62 })).toBe(false);
    expect(v3NodeStalled({ kind: 'running', acceptedAt: 0, stalledAt: 70, startedAt: 62 })).toBe(true);
    expect(v3NodeStalled({ kind: 'running', acceptedAt: 0, stalledAt: 2 })).toBe(true);
  });
});

describe('ADV-3: one main-topic session carries one node at a time', () => {
  async function twoRuns() {
    const a = await mainHandoff('ms-busy-a');
    const b = await mainHandoff('ms-busy-b', a.world);
    return { a, b };
  }

  it('a second run\'s main-topic handoff to the same bot is refused while the first is in progress — visibly, and the first marker stays', async () => {
    const { a, b } = await twoRuns();
    const ds = session('sess-a', a.marker);
    const { daemon, posted } = wiring(a.world.dataDir, a.run, [ds]);
    const { lookupWorkflowHandoff, readDispatchRegistryLoose } = await import('../src/core/workflow-handoff-binding.js');
    const found = lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(a.world.dataDir), dispatchRoot: b.attempt.handoffMessageId!, secret: SECRET });
    if (found.kind !== 'workflow') throw new Error('no binding');
    const admission = daemon.admitInbound(found.binding, b.attempt.handoffMessageId!, 'cli_a', undefined, ds.session.workflowNode);
    expect(admission).toMatchObject({ start: false, reason: expect.stringContaining('正在执行另一个工作流节点') });
    expect(ds.session.workflowNode?.nonce).toBe(a.marker.nonce);
    await flush();
    expect(posted).toEqual([expect.objectContaining({ body: expect.objectContaining({ kind: 'refused', errorCode: 'MAIN_TOPIC_BUSY', nonce: b.marker.nonce }) })]);

    // The same handoff again (a re-delivery), or one after the first ended or
    // was revoked: not refused as busy (the next gate is the run's directory).
    const notBusy = (existing: WorkflowNodeSessionMarker) => {
      const out = daemon.admitInbound(found.binding, b.attempt.handoffMessageId!, 'cli_a', undefined, existing);
      return out.start || !out.reason.includes('另一个工作流节点');
    };
    expect(notBusy(b.marker)).toBe(true);
    expect(notBusy({ ...a.marker, submittedAt: 'x' })).toBe(true);
    expect(notBusy({ ...a.marker, placement: undefined })).toBe(true);
    expect(notBusy(a.marker)).toBe(false);
    await revokeWorkflowHandoff(a.world.dataDir, SECRET, a.marker.nonce, 'runCancelled', a.run.clock.t);
    expect(notBusy(a.marker)).toBe(true);
  });

  it('the refusal blocks the second node with MAIN_TOPIC_BUSY on its main bot', async () => {
    const { b } = await twoRuns();
    const { route } = orchestratorEvent(b.world, b.run.base, b.run.dag, () => b.run.clock.t);
    expect(await route({ kind: 'refused', nonce: b.marker.nonce, dispatchRoot: b.attempt.handoffMessageId, reason: '忙', errorCode: 'MAIN_TOPIC_BUSY' }))
      .toMatchObject({ status: 200, body: { outcome: 'blocked' } });
    expect(b.run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'MAIN_TOPIC_BUSY', message: '忙' })]);
  });

  it('the main bot\'s own main-topic node is not started in a main session carrying another run\'s node', async () => {
    const { a } = await twoRuns();
    const busy = session('main-session', { ...a.marker, nonce: 'wfh_another_runs_nonce_000', runId: 'other-run' });
    const delivered: string[] = [];
    const run = new BotRun(reportDag('ms-busy-self', { placement: 'main', bot: MAIN }));
    authorizeRun(run, { identity: null, selectors: [MAIN] });
    const world = handoffWorld();
    const posted: Array<{ body: any }> = [];
    const daemon = createWorkflowNodeDaemon({
      ...wiringDeps(world.dataDir, run, [busy], posted),
      selfLarkAppId: () => MAIN,
      findNodeSession: () => busy,
      deliverSelfTurn: async () => { delivered.push('x'); return { sessionId: 'main-session' }; },
    });
    await run.drive(daemon.executor, { opts: { chatBinding: BINDING } });
    expect(delivered).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'MAIN_TOPIC_BUSY' })]);
    expect(busy.session.workflowNode?.nonce).toBe('wfh_another_runs_nonce_000');
  });
});

describe('after the attempt ends', () => {
  it('a blocked report ends it: later turns of the session are no longer the node\'s', async () => {
    const { run, world, attempt, marker } = await mainHandoff('ms-after-blocked');
    run.accept(attempt.attemptId, 'sess-a');
    const ds = session('sess-a', marker);
    const { daemon, posted, updated } = wiring(world.dataDir, run, [ds]);
    daemon.onTurnStarted(ds, { turnId: marker.handoffMessageId, startedAt: run.clock.t });
    const { workflowNodeReportMarker } = await import('../src/core/workflow-node-session.js');
    const result = await daemon.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: '缺权限' },
      () => ({ ok: true, session: {
        sessionId: 'sess-a', larkAppId: 'cli_a', chatId: CHAT, scope: 'thread', rootMessageId: ROOT,
        workflowNode: workflowNodeReportMarker(ds.session.workflowNode!),
      } }),
    );
    expect(result).toMatchObject({ status: 200 });
    expect(ds.session.workflowNode).toMatchObject({ closedAt: expect.any(String) });
    expect(updated).toContain('sess-a');
    posted.splice(0);
    // A person keeps talking to the bot in the main topic: no node traffic.
    daemon.onInputCommitted(ds, { turnId: 'om_person_later', committedAt: 5 });
    daemon.onTurnSettled(ds, { turnId: 'om_person_later', at: 6 });
    await flush();
    expect(posted).toEqual([]);
  });
});
