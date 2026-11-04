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
import { BotRun, cleanupBotRuns, expectTerminal, reportDag, trackTempDir } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf } from './helpers/workflow-handoff-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';
import { readDispatchRegistryLoose, revokeWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';

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
    targetOpensTopicSessions: async () => 'yes',
    daemonPort: (appId) => (appId === MAIN ? 4100 : undefined),
    hostSecret: () => 'dashboard-secret',
    bindingSecret: () => SECRET,
    postDaemon: async (port, path, body) => { posted.push({ port, path, body }); return { status: 200, body: { ok: true } }; },
    ensureGrant: async () => {},
    loadSessions: () => [],
    isProcessAlive: () => true,
    activeSessions: () => sessions,
    updateSession: () => {},
    interruptTurn: (ds, opts) => { interrupted.push(`${ds.session.sessionId}${opts?.evenIfIdle ? ':force' : ''}`); return true; },
    proveBotSender: async () => true,
    noticeRetryMs: 5,
    deliverSelfTurn: async () => ({ sessionId: 'self-session' }),
    prepareTurnIdentity: async () => {},
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
    nonce: nonceOf(attempt), publishRoot: attempt.nodeCardMessageId!, orchestratorAppId: MAIN,
    registeredAt: new Date(run.clock.t).toISOString(),
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
      body: { kind: 'blocked', nonce: nonceOf(attempt), dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a', reason: 'cannot' },
    }]);
  });

  it('P2-2: with the main bot offline a valid submission is staged, and committed on its next drive', async () => {
    const { run, world, attempt } = await handedOff('wd-offline');
    run.accept(attempt.attemptId, 'sess-a');
    const target = daemon('cli_a', world.dataDir, run.base, run, { daemonPort: () => undefined });
    const before = run.events().length;
    const staged = await target.wiring.reportRoute(
      {
        dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'done offline',
        files: [{ key: 'report', name: 'report.md', data: Buffer.from('# r').toString('base64') }],
        resultText: '{"message":"ok"}',
      },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    );
    expect(staged).toEqual({ status: 202, body: { ok: true, outcome: 'staged', message: '已提交，编排方上线后处理' } });
    expect(run.events()).toHaveLength(before); // only the owner writes the journal
    // Even past the node deadline, the owner's next drive commits it.
    run.clock.t = run.openAttempt('write').deadlineAt! + 1;
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('succeeded');
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('P2-2: an invalid submission is not staged while the main bot is offline', async () => {
    const { run, world, attempt } = await handedOff('wd-offline-invalid');
    run.accept(attempt.attemptId, 'sess-a');
    const target = daemon('cli_a', world.dataDir, run.base, run, { daemonPort: () => undefined });
    expect(await target.wiring.reportRoute(
      { dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', resultText: '{"message":"ok"}' },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    )).toMatchObject({ status: 422, body: { error: 'invalid' } });
    run.clock.t = run.openAttempt('write').deadlineAt!;
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('blocked');
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
      fakeSession('sess-other', { ...marker, nonce: 'wfh_aaaaaaaaaaaaaaaaaaaaaaaa', handoffMessageId: 'om_other' }),
      fakeSession('sess-a', marker),
    );
    expect(target.wiring.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a' }))
      .toEqual({ status: 200, body: { ok: true, stopped: true } });
    expect(target.interrupted).toEqual(['sess-a']);
    // The main bot's daemon cannot stop someone else's handoff on this bot.
    const wrong = daemon('cli_b', world.dataDir, run.base, run);
    expect(wrong.wiring.stopRoute({ nonce: marker.nonce })).toMatchObject({ status: 409 });
  });

  it('a submission the main bot took withdraws that handoff turn\'s identity at once', async () => {
    const { run, world, attempt, marker } = await handedOff('wd-submit-identity');
    const withdrawn: string[] = [];
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      withdrawHandoffIdentity: async (ds, turnId) => { withdrawn.push(`${ds.session.sessionId}:${turnId}`); },
    });
    target.sessions.push(fakeSession('sess-a', marker));
    const result = await target.wiring.reportRoute(
      {
        dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'done',
        files: [{ key: 'report', name: 'report.md', data: Buffer.from('# r').toString('base64') }],
        resultText: '{"message":"ok"}',
      },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    );
    expect(result).toMatchObject({ status: 200 });
    expect(withdrawn).toEqual([`sess-a:${marker.handoffMessageId}`]);
  });

  it('a stop also withdraws the tool identity of exactly that handoff turn (交接带发起人身份, §10.3)', async () => {
    const { run, world, marker } = await handedOff('wd-stop-identity');
    const withdrawn: string[] = [];
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      withdrawHandoffIdentity: async (ds, turnId) => { withdrawn.push(`${ds.session.sessionId}:${turnId}`); },
    });
    target.sessions.push(
      fakeSession('sess-other', { ...marker, nonce: 'wfh_aaaaaaaaaaaaaaaaaaaaaaaa', handoffMessageId: 'om_other' }),
      fakeSession('sess-a', marker),
    );
    target.wiring.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a' });
    expect(withdrawn).toEqual([`sess-a:${marker.handoffMessageId}`]);
  });

  it('registration and the handoff turn\'s idle notify the main bot; a submitted handoff stays quiet', async () => {
    const { run, world, marker } = await handedOff('wd-notices');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.wiring.onRegistered('sess-a', marker);
    target.wiring.onTurnSettled(fakeSession('sess-a', marker), { turnId: marker.handoffMessageId, at: 5 });
    target.wiring.onTurnSettled(fakeSession('sess-a', { ...marker, submittedAt: new Date().toISOString() }), { turnId: marker.handoffMessageId, at: 6 });
    target.wiring.onTurnSettled(fakeSession('sess-plain'), { turnId: marker.handoffMessageId, at: 7 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(target.posted.map((post) => post.body.kind)).toEqual(['accepted', 'stalled']);
    expect(target.posted[0]!.body).toMatchObject({ nonce: marker.nonce, sessionId: 'sess-a', acceptedAt: Date.parse(marker.registeredAt) });
  });

  it('P3-8: only the handoff\'s own turn can stall it; a later turn starting reports the bot active again', async () => {
    const { run, world, marker } = await handedOff('wd-stall-turn');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    // An older turn of a busy session ends after the new handoff was registered.
    target.wiring.onTurnSettled(fakeSession('sess-a', marker), { turnId: 'om_previous_turn', at: 5 });
    // A human replied in the topic: a new turn starts.
    target.wiring.onInputCommitted(fakeSession('sess-a', marker), { turnId: 'om_human_reply', committedAt: 9 });
    target.wiring.onInputCommitted(fakeSession('sess-a', marker), { turnId: marker.handoffMessageId, committedAt: 4 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(target.posted.map((post) => post.body.kind)).toEqual(['active', 'accepted']);
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

describe('workflow node daemon wiring — second review pass', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('P2-a: after accepted → stalled → active, the next turn ending without a submission stalls again', async () => {
    const { run, world, marker } = await handedOff('wd2-stall-again');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    const ds = fakeSession('sess-a', marker);
    target.wiring.onInputCommitted(ds, { turnId: marker.handoffMessageId, committedAt: 1 });
    target.wiring.onTurnSettled(ds, { turnId: marker.handoffMessageId, at: 2 }); // asked a human
    target.wiring.onInputCommitted(ds, { turnId: 'om_human_answer', committedAt: 3 }); // the answer
    target.wiring.onTurnSettled(ds, { turnId: 'om_human_answer', at: 4 }); // forgot to submit
    await settle();
    expect(target.posted.map((post) => post.body.kind)).toEqual(['accepted', 'stalled', 'active', 'stalled']);
  });

  it('P3-b: a handoff revoked before its session registered it is never accepted and its turn is stopped', async () => {
    const { run, world, marker } = await handedOff('wd2-revoked-register');
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'runCancelled');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.sessions.push(fakeSession('sess-a', marker));
    expect(target.wiring.isRevoked(marker.nonce)).toBe(true);
    target.wiring.onRegistered('sess-a', marker);
    target.wiring.onInputCommitted(target.sessions[0]!, { turnId: marker.handoffMessageId, committedAt: 1 });
    await settle();
    expect(target.posted).toEqual([]);
    expect(target.interrupted).toEqual(['sess-a:force', 'sess-a:force']);
  });

  it('P3-b: the main bot answering "handoff_revoked" to the acceptance stops the turn', async () => {
    const { run, world, marker } = await handedOff('wd2-revoked-409');
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      postDaemon: async () => ({ status: 409, body: { ok: false, error: 'handoff_revoked' } }),
    });
    target.sessions.push(fakeSession('sess-a', marker));
    target.wiring.onRegistered('sess-a', marker);
    await settle();
    expect(target.interrupted).toEqual(['sess-a:force']);
  });

  it('M5: the target\'s stop route accepts the (always revoked) binding of a remote stop', async () => {
    const { run, world, marker } = await handedOff('wd2-remote-stop');
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'timeout');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.sessions.push(fakeSession('sess-a', marker));
    expect(target.wiring.stopRoute({ nonce: marker.nonce, sessionId: 'sess-a', reason: 'timeout' }))
      .toEqual({ status: 200, body: { ok: true, stopped: true } });
    expect(target.interrupted).toEqual(['sess-a']);
  });

  it('P3-d: after staging, the main bot is asked to drive once (retried when it looked offline)', async () => {
    const { run, world, attempt } = await handedOff('wd2-wake');
    run.accept(attempt.attemptId, 'sess-a');
    let online = false;
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      daemonPort: (appId) => (appId === MAIN && online ? 4100 : undefined),
    });
    const staged = await target.wiring.reportRoute(
      {
        dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x',
        files: [{ key: 'report', name: 'report.md', data: Buffer.from('# r').toString('base64') }], resultText: '{"message":"ok"}',
      },
      authorize({ sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, larkAppId: 'cli_a' }),
    );
    expect(staged.status).toBe(202);
    online = true; // the main bot was only missed for a moment
    await settle();
    expect(target.posted.map((post) => [post.path, post.body.kind])).toEqual([['/api/workflow/handoff-event', 'wake']]);
  });

  it('P3-c: before its id is linked, a handoff counts only when the sender is proven to be the main bot', async () => {
    const run = new BotRun(reportDag('wd2-prove'));
    const world = handoffWorld();
    const verdicts: unknown[] = [];
    const asked: unknown[] = [];
    world.lark.onReply = async () => {
      // The handoff reaches the target before the main bot linked its id.
      const key = Object.keys(readDispatchRegistryLoose(world.dataDir)).find((k) => k.startsWith('workflow-handoff:'))!;
      const inbound = {
        receiverLarkAppId: 'cli_a', messageId: 'om_incoming', chatId: CHAT,
        threadRootId: world.lark.sent[0]!.id, senderOpenId: 'ou_main_seen_by_a',
        content: `交接编号：${key.slice('workflow-handoff:'.length)}`,
      };
      for (const proveBotSender of [
        async () => { throw new Error('chat members lookup failed'); },
        async () => false,
        async (input: unknown) => { asked.push(input); return true; },
      ]) {
        const target = daemon('cli_a', world.dataDir, run.base, run, { proveBotSender });
        verdicts.push((await target.wiring.resolveInbound(inbound))?.kind);
      }
    };
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    expect(verdicts).toEqual([undefined, undefined, 'handoff']);
    expect(asked).toEqual([{ receiverLarkAppId: 'cli_a', chatId: CHAT, senderOpenId: 'ou_main_seen_by_a', sourceLarkAppId: MAIN }]);
  });

  it('P3-d: the wake event drives the run once', async () => {
    const { run, world, attempt } = await handedOff('wd2-wake-route');
    const drives: string[] = [];
    const main = daemon(MAIN, world.dataDir, run.base, run, { drive: (runId) => { drives.push(runId); } });
    expect(await main.wiring.eventRoute({ kind: 'wake', nonce: nonceOf(attempt), sessionId: 'sess-a' }))
      .toMatchObject({ status: 200 });
    expect(drives).toEqual(['wd2-wake-route']);
  });
});
