/**
 * Daemon wiring of bot-executed workflow nodes (design 2026-11-03 §6.5, §7.2,
 * §8, §9.3) with fake Lark / IPC / sessions: the main bot's own node reports
 * in-process, another bot's daemon forwards over trusted IPC, an offline main
 * bot is a retryable error, stop requests hit only the handoff's session, and
 * idle / registration notices reach the right daemon.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowNodeDaemon, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { BotRun, cleanupBotRuns, reportDag, trackTempDir } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld } from './helpers/workflow-handoff-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';

afterEach(() => cleanupBotRuns());

const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: 'om_main' };

function fakeSession(sessionId: string, marker?: WorkflowNodeSessionMarker, root = marker?.publishRoot): DaemonSession {
  return { session: { sessionId, rootMessageId: root, ...(marker ? { workflowNode: marker } : {}) } } as unknown as DaemonSession;
}

function daemon(self: string, dataDir: string, baseDir: string, run: BotRun, overrides: Partial<WorkflowNodeDaemonDeps> = {}) {
  const posted: Array<{ port: number; path: string; body: any }> = [];
  const interrupted: string[] = [];
  const sessions: DaemonSession[] = [];
  const deps: WorkflowNodeDaemonDeps = {
    selfLarkAppId: () => self,
    dataDir: () => dataDir,
    baseDir: () => baseDir,
    sendCard: async () => 'om_unused',
    replyCard: async () => 'om_report_card',
    patchCard: async () => {},
    resolveBotInChat: async () => ({ ok: true, openId: 'ou_x' }),
    daemonPort: (appId) => (appId === MAIN ? 4100 : undefined),
    hostSecret: () => 'dashboard-secret',
    bindingSecret: () => SECRET,
    postDaemon: async (port, path, body) => { posted.push({ port, path, body }); return { status: 200, body: { ok: true } }; },
    ensureGrant: async () => {},
    loadSessions: () => [],
    isProcessAlive: () => true,
    activeSessions: () => sessions,
    updateSession: () => {},
    interruptTurn: (ds) => { interrupted.push(ds.session.sessionId); return true; },
    deliverSelfTurn: async () => ({ sessionId: 'self-session' }),
    attachmentsDir: (appId, messageId) => join(dataDir, 'attachments', appId, messageId),
    loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', chatId: CHAT, title: 't' }),
    drive: () => {},
    botName: (appId) => appId,
    warn: () => {},
    ...overrides,
  };
  return { wiring: createWorkflowNodeDaemon(deps), posted, interrupted, sessions };
}

async function handedOff(runId: string) {
  const run = new BotRun(reportDag(runId));
  const world = handoffWorld();
  await run.drive(world.executor, { opts: { chatBinding: BINDING } });
  const attempt = run.openAttempt('write');
  const marker: WorkflowNodeSessionMarker = {
    runId, nodeId: 'write', attemptId: attempt.attemptId, handoffMessageId: attempt.handoffMessageId!,
    publishRoot: attempt.nodeCardMessageId!, orchestratorAppId: MAIN, registeredAt: new Date(run.clock.t).toISOString(),
  };
  return { run, world, attempt, marker };
}

const authorize = (session: { sessionId: string; rootMessageId: string; larkAppId: string }) => () =>
  ({ ok: true as const, session: { ...session, chatId: CHAT, scope: 'thread' as const } });

describe('workflow node daemon wiring', () => {
  it('another bot forwards its submission to the main bot\'s daemon over trusted IPC', async () => {
    const { run, world, attempt } = await handedOff('wd-forward');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    const result = await target.wiring.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'cannot' },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    );
    expect(result).toMatchObject({ status: 200 });
    expect(target.posted).toEqual([{
      port: 4100,
      path: '/api/workflow/handoff-event',
      body: { kind: 'blocked', dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a', reason: 'cannot' },
    }]);
  });

  it('an offline main bot is a retryable error and nothing is recorded', async () => {
    const { run, world, attempt } = await handedOff('wd-offline');
    const target = daemon('cli_a', world.dataDir, run.base, run, { daemonPort: () => undefined });
    const before = run.events().length;
    expect(await target.wiring.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'cannot' },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    )).toMatchObject({ status: 503, body: { error: 'orchestrator_offline' } });
    expect(run.events()).toHaveLength(before);
  });

  it('the main bot\'s own node is settled in-process (no IPC hop)', async () => {
    const run = new BotRun(reportDag('wd-self', { bot: undefined }));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const main = daemon(MAIN, world.dataDir, run.base, run);
    const result = await main.wiring.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'cannot' },
      authorize({ sessionId: 'self-session', rootMessageId: attempt.nodeCardMessageId!, larkAppId: MAIN }),
    );
    expect(result).toMatchObject({ status: 200, body: { outcome: 'blocked' } });
    expect(main.posted).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'BOT_REPORTED_BLOCKED' })]);
  });

  it('a stop request interrupts only the session running that handoff', async () => {
    const { run, world, attempt, marker } = await handedOff('wd-stop');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.sessions.push(
      fakeSession('sess-other', { ...marker, handoffMessageId: 'om_other' }),
      fakeSession('sess-a', marker),
    );
    expect(target.wiring.stopRoute({ dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' }))
      .toEqual({ status: 200, body: { ok: true, stopped: true } });
    expect(target.interrupted).toEqual(['sess-a']);
    // The main bot's daemon cannot stop someone else's handoff on this bot.
    const wrong = daemon('cli_b', world.dataDir, run.base, run);
    expect(wrong.wiring.stopRoute({ dispatchRoot: attempt.handoffMessageId })).toMatchObject({ status: 409 });
  });

  it('registration and an idle turn notify the main bot; a submitted handoff stays quiet', async () => {
    const { run, world, marker } = await handedOff('wd-notices');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.wiring.onRegistered('sess-a', marker);
    target.wiring.onTurnSettled(fakeSession('sess-a', marker), { at: 5 });
    target.wiring.onTurnSettled(fakeSession('sess-a', { ...marker, submittedAt: new Date().toISOString() }), { at: 6 });
    target.wiring.onTurnSettled(fakeSession('sess-plain'), { at: 7 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(target.posted.map((post) => post.body.kind)).toEqual(['accepted', 'stalled']);
    expect(target.posted[0]!.body).toMatchObject({ dispatchRoot: marker.handoffMessageId, sessionId: 'sess-a', acceptedAt: Date.parse(marker.registeredAt) });
  });

  it('node-card sync skips runs without an envelope entirely', async () => {
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wd-sync-')));
    let loads = 0;
    const run = new BotRun(reportDag('wd-sync'));
    const main = daemon(MAIN, dataDir, run.base, run, { loadRun: () => { loads++; return undefined; } });
    await main.wiring.syncNodeCards('wd-sync');
    await main.wiring.syncNodeCards('../escape');
    expect(loads).toBe(0);
  });
});
