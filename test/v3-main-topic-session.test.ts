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
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf } from './helpers/workflow-handoff-harness.js';
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

async function mainHandoff(runId: string) {
  const run = new BotRun(reportDag(runId, { placement: 'main' }));
  const world = handoffWorld();
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
  const deps: WorkflowNodeDaemonDeps = {
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
  return { daemon: createWorkflowNodeDaemon(deps), posted, interrupted, updated };
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
    daemon.onInputCommitted(ds, { turnId: 'workflow-event:other:3', committedAt: 5 });
    daemon.onTurnSettled(ds, { turnId: 'workflow-event:other:3', at: 6 });
    await flush();
    expect(posted).toEqual([]);
    // A message in the topic (someone answering the bot) is.
    daemon.onInputCommitted(ds, { turnId: 'om_answer', committedAt: 7 });
    await flush();
    expect(posted).toEqual([expect.objectContaining({ body: expect.objectContaining({ kind: 'active', sessionId: 'sess-a' }) })]);
  });
});

describe('after the attempt ends', () => {
  it('a blocked report ends it: later turns of the session are no longer the node\'s', async () => {
    const { run, world, attempt, marker } = await mainHandoff('ms-after-blocked');
    run.accept(attempt.attemptId, 'sess-a');
    const ds = session('sess-a', marker);
    const { daemon, posted, updated } = wiring(world.dataDir, run, [ds]);
    const result = await daemon.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: '缺权限' },
      () => ({ ok: true, session: { sessionId: 'sess-a', larkAppId: 'cli_a', chatId: CHAT, scope: 'thread', rootMessageId: ROOT } }),
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
