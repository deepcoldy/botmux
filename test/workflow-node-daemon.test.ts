/**
 * Daemon wiring of bot-executed workflow nodes (design 2026-11-03 §6.5, §7.2,
 * §8, §9.3) with fake Lark / IPC / sessions: the main bot's own node reports
 * in-process, another bot's daemon forwards over trusted IPC, an offline main
 * bot is a retryable error, stop requests hit only the handoff's session, and
 * idle / registration notices reach the right daemon.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowNodeDaemon, workflowNodePinnedStart, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { BotRun, cleanupBotRuns, expectTerminal, reportDag, trackTempDir } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf } from './helpers/workflow-handoff-harness.js';
import { activeSessionKey, sessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';
import { readDispatchRegistryLoose, revokeWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';
import { authorizeRun } from './helpers/workflow-identity-world.js';

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
    getSessionWorkingDir: (ds: DaemonSession) => ds.workingDir ?? ds.session.workingDir ?? '',
    findNodeSession: (anchor, appId) => [...deps.activeSessions()].find((ds) => activeSessionKey(ds) === sessionKey(anchor, appId)),
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

describe('workflow node daemon wiring — the run\'s working dir (design §15.4)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** `repos/project` is the Gate-2 directory; `lab` is somewhere else. */
  function dirs() {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wd-dir-')));
    const repos = join(root, 'repos');
    const project = join(repos, 'project');
    const lab = join(root, 'lab');
    mkdirSync(project, { recursive: true });
    mkdirSync(lab, { recursive: true });
    return { repos, project, lab };
  }

  /** A real authorized bot run (run.json as Gate-2 writes it), handed off. */
  async function handedOffPinned(runId: string, nodeWorkingDir: string | undefined) {
    const run = new BotRun(reportDag(runId));
    authorizeRun(run, { identity: null, ...(nodeWorkingDir ? { nodeWorkingDir } : {}) });
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const binding = { nonce: nonceOf(attempt), sourceLarkAppId: MAIN, workflow: { runId } } as never;
    return { run, world, attempt, binding };
  }

  it('the executing bot\'s daemon decides from run.json and its configuration now: in range → that directory, out of range → refused', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-decide', d.project);
    let config: Record<string, unknown> = { workingDirs: [d.repos] };
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => config });
    const admit = () => target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a');
    expect(admit()).toEqual({ start: true, workingDir: realpathSync(d.project) });
    // Narrowed after approval: the current configuration decides.
    config = { workingDirs: [d.lab] };
    const refused = admit();
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain(d.project);
    config = {};
    expect(admit()).toMatchObject({ start: false });
  });

  it('a symlinked directory is applied as its target: the session never stores the link', async () => {
    const d = dirs();
    const link = join(d.lab, 'project-link');
    symlinkSync(d.project, link);
    const { run, world, attempt, binding } = await handedOffPinned('wdd-link', link);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({ workingDirs: [d.repos] }) });
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a')).toEqual({ start: true, workingDir: realpathSync(d.project) });
    // Retargeted outside the range: the next handoff is refused.
    rmSync(link);
    symlinkSync(d.lab, link);
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a')).toMatchObject({ start: false });
  });

  it('a run approved without --working-dir keeps the bot\'s own default; an unreadable approval record is never guessed', async () => {
    const { run, world, attempt, binding } = await handedOffPinned('wdd-default', undefined);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({}) });
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a')).toEqual({ start: true });
    const elsewhere = daemon('cli_a', world.dataDir, trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-empty-'))), run);
    expect(elsewhere.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a')).toMatchObject({ start: false });
    await settle();
    expect(target.posted).toEqual([]);
  });

  it('a refusal reaches the main bot, which blocks the node with the reason (no session involved)', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-refuse', d.project);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({ workingDirs: [d.lab] }) });
    const decision = target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a');
    if (decision.start) throw new Error('expected a refusal');
    await settle();
    expect(target.posted).toEqual([{
      port: 4100,
      path: '/api/workflow/handoff-event',
      body: { kind: 'refused', nonce: nonceOf(attempt), dispatchRoot: attempt.handoffMessageId, reason: decision.reason },
    }]);
    const drives: string[] = [];
    const main = daemon(MAIN, world.dataDir, run.base, run, { drive: (runId) => { drives.push(runId); } });
    expect(await main.wiring.eventRoute(target.posted[0]!.body)).toMatchObject({ status: 200, body: { outcome: 'blocked' } });
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
      attemptId: attempt.attemptId, errorCode: 'WORKING_DIR_REFUSED', message: decision.reason,
    })]);
    expect(drives).toEqual(['wdd-refuse']);
  });

  it('the refusal notice is retried once after an unreachable main bot (thrown error) as after an error answer', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-retry', d.project);
    const main = daemon(MAIN, world.dataDir, run.base, run);
    let calls = 0;
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.lab] }),
      postDaemon: async (_port, _path, body) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        return main.wiring.eventRoute(body);
      },
    });
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a')).toMatchObject({ start: false });
    await settle();
    expect(calls).toBe(2);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]);
  });

  it('when the notice never arrives the node still blocks at the acceptance deadline, keeping the directory reason', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-lost', d.project);
    const warnings: string[] = [];
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.lab] }),
      postDaemon: async () => { throw new Error('connect ECONNREFUSED'); },
      warn: (message) => { warnings.push(message); },
    });
    const decision = target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a');
    if (decision.start) throw new Error('expected a refusal');
    await settle();
    expect(run.of('nodeBlocked')).toEqual([]);
    expect(warnings.join('\n')).toContain(decision.reason);
    run.clock.t = run.openAttempt('write').acceptDeadlineAt! + 1;
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const [blocked] = run.of('nodeBlocked');
    expect(blocked).toMatchObject({ errorCode: 'HANDOFF_NOT_ACCEPTED' });
    expect(blocked!.message).toContain(decision.reason);
  });

  it('a node topic that already has a session: continued only when that session runs in the directory', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-existing', d.project);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({ workingDirs: [d.repos, d.lab] }) });
    // The session an earlier attempt of this run started (stored as given, or via a link).
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a', d.project))
      .toEqual({ start: true, workingDir: realpathSync(d.project) });
    const link = join(d.lab, 'p-link');
    symlinkSync(d.project, link);
    expect(target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a', link)).toMatchObject({ start: true });
    // Someone talked to the bot in the topic first, in its default (or a /cd) directory.
    const other = target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a', d.lab);
    expect(other).toMatchObject({ start: false });
    expect((other as { reason: string }).reason).toContain('节点话题里已有会话，工作目录与指定的不一致');
    await settle();
    expect(target.posted.map((post) => post.body.kind)).toEqual(['refused']);
    // Without a pinned directory an existing session is used as before.
    const plainRun = await handedOffPinned('wdd-existing-plain', undefined);
    const plain = daemon('cli_a', plainRun.world.dataDir, plainRun.run.base, plainRun.run);
    expect(plain.wiring.admitInbound(plainRun.binding, plainRun.attempt.handoffMessageId!, 'cli_a', d.lab)).toEqual({ start: true });
  });

  it('a new session for an admitted handoff starts exactly in the pinned directory, else the ordinary resolution applies', () => {
    expect(workflowNodePinnedStart({ start: true, workingDir: '/srv/task' }))
      .toEqual({ pinnedWorkingDir: '/srv/task', oncallEntry: undefined, inheritedFrom: null, pinnedFromBotDefault: false });
    expect(workflowNodePinnedStart({ start: true })).toBeUndefined();
    expect(workflowNodePinnedStart({ start: false, reason: 'x' })).toBeUndefined();
    expect(workflowNodePinnedStart(undefined)).toBeUndefined();
  });

  it('a refusal never closes an attempt a session has already accepted', async () => {
    const { run, world, attempt } = await handedOff('wdd-accepted');
    run.accept(attempt.attemptId, 'sess-a');
    const main = daemon(MAIN, world.dataDir, run.base, run);
    expect(await main.wiring.eventRoute({ kind: 'refused', nonce: nonceOf(attempt), reason: 'x' }))
      .toMatchObject({ status: 409, body: { error: 'session-mismatch' } });
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('the main bot\'s own node: out of its range nothing is posted or started and the node blocks; in range the session starts there', async () => {
    const d = dirs();
    for (const [config, expectStarted] of [[{ defaultWorkingDir: d.lab }, false], [{ defaultWorkingDir: d.repos }, true]] as const) {
      const run = new BotRun(reportDag(`wdd-self-${expectStarted}`, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.project });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-self-data-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const posted: string[] = [];
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => config,
        sendCard: async () => { posted.push('node card'); return 'om_node_card'; },
        replyCard: async () => { posted.push('handoff card'); return 'om_handoff_card'; },
        deliverSelfTurn: async (input) => { delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) }); return { sessionId: 'self-session' }; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      await settle();
      if (expectStarted) {
        expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]);
        expect(posted).toEqual(['node card', 'handoff card']);
        expect(run.of('nodeBlocked')).toEqual([]);
      } else {
        expect(delivered).toEqual([]);
        // Decided before the cards: no task card is left in the topic.
        expect(posted).toEqual([]);
        expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]);
      }
    }
  });

  it('a run with a working dir is not handed to a bot whose daemon would not apply it (older version)', async () => {
    const d = dirs();
    for (const [nodeWorkingDir, applies, expectSent] of [
      [d.project, false, false],
      [d.project, true, true],
      // Without a directory an older daemon is fine, as before.
      [undefined, false, true],
    ] as const) {
      const run = new BotRun(reportDag(`wdd-old-${String(nodeWorkingDir !== undefined)}-${String(applies)}`));
      authorizeRun(run, { identity: null, ...(nodeWorkingDir ? { nodeWorkingDir } : {}) });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-old-data-')));
      const posted: string[] = [];
      const main = daemon(MAIN, dataDir, run.base, run, {
        daemonPort: () => 4100,
        daemonAppliesNodeWorkingDir: (appId) => (appId === 'cli_a' ? applies : true),
        sendCard: async () => { posted.push('node card'); return 'om_node_card'; },
        replyCard: async () => { posted.push('handoff card'); return 'om_handoff_card'; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      if (expectSent) {
        expect(posted).toEqual(['node card', 'handoff card']);
        expect(run.of('nodeBlocked')).toEqual([]);
      } else {
        expect(posted).toEqual([]);
        const [blocked] = run.of('nodeBlocked');
        expect(blocked).toMatchObject({ errorCode: 'WORKING_DIR_REFUSED' });
        expect(blocked!.message).toContain('版本过旧');
      }
    }
  });

  it('the main bot\'s own node: a session already in its topic that runs elsewhere blocks the node too (same gate as another bot\'s handoff)', async () => {
    const d = dirs();
    for (const [existingDir, status, expectBlocked, runId] of [
      [d.lab, 'active', true, 'wdd-self-mismatch'],
      [d.project, 'active', false, 'wdd-self-match'],
      // A closed session at the key is not reused: no conflict, new in pinned.
      [d.lab, 'closed', false, 'wdd-self-closed'],
    ] as const) {
      const run = new BotRun(reportDag(runId, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.project });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-self-existing-data-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const existingSession = {
        session: { sessionId: 'sess-existing', rootMessageId: 'om_node_card', status, workingDir: existingDir },
        larkAppId: MAIN, chatId: CHAT, chatType: 'group', scope: 'thread', workingDir: existingDir,
      } as unknown as DaemonSession;
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
        activeSessions: () => [existingSession],
        sendCard: async () => 'om_node_card',
        replyCard: async () => 'om_handoff_card',
        deliverSelfTurn: async (input) => {
          delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) });
          return { sessionId: 'sess-existing' };
        },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      await settle();
      if (expectBlocked) {
        expect(delivered).toEqual([]);
        expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
          errorCode: 'WORKING_DIR_REFUSED',
          message: expect.stringContaining('节点话题里已有会话'),
        })]);
      } else {
        expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]);
        expect(run.of('nodeBlocked')).toEqual([]);
      }
    }
  });

  it('the main bot\'s own node: the directory is re-checked when the turn starts — narrowing the configuration after preflight blocks it', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdd-self-narrowed', { bot: undefined }));
    authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.project });
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-self-narrowed-data-')));
    let reads = 0;
    const delivered: Array<{ workingDir?: string }> = [];
    const main = daemon(MAIN, dataDir, run.base, run, {
      // First read: workingDirPreflight (in range, so the cards go out).
      // Second read: startSelfTurn (the configuration was narrowed meanwhile).
      botWorkingDirConfig: () => (reads++ === 0 ? { defaultWorkingDir: d.repos } : { defaultWorkingDir: d.lab }),
      sendCard: async () => 'om_node_card',
      replyCard: async () => 'om_handoff_card',
      deliverSelfTurn: async (input) => {
        delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) });
        return { sessionId: 'self-session' };
      },
    });
    await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
    await settle();
    expect(delivered).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]);
  });

  it('the main bot\'s own node: a principal-lane session stored under a virtual anchor is not reused by the turn and must not be blocked (its rootMessageId happens to be the node card)', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdd-self-lane', { bot: undefined }));
    authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.project });
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-self-lane-data-')));
    const delivered: Array<{ workingDir?: string }> = [];
    // Registered under a virtual principal-lane anchor (rootMessageId is the
    // node card, but the storage key is not): deliverWorkflowNodeTurn would
    // start a new session in the pinned directory, never reuse this one.
    const laneSession = {
      session: { sessionId: 'sess-lane', rootMessageId: 'om_node_card', status: 'active', workingDir: d.lab },
      larkAppId: MAIN, chatId: CHAT, chatType: 'group', scope: 'thread',
      workingDir: d.lab, runtimeRoutingAnchor: 'principal-lane:om_node_card',
    } as unknown as DaemonSession;
    const main = daemon(MAIN, dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
      activeSessions: () => [laneSession],
      sendCard: async () => 'om_node_card',
      replyCard: async () => 'om_handoff_card',
      deliverSelfTurn: async (input) => {
        delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) });
        return { sessionId: 'sess-new' };
      },
    });
    await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
    await settle();
    expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]);
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('the main bot\'s own node: a session stored under the node-card key with a different rootMessageId IS the one the turn reuses, so it blocks when it runs elsewhere', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdd-self-deferred', { bot: undefined }));
    authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.project });
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-self-deferred-data-')));
    const delivered: Array<{ workingDir?: string }> = [];
    // A deferred-routing shape: stored at the node-card anchor, but the
    // session's own rootMessageId is a different value. Matching by
    // rootMessageId would miss it; the node would run in /elsewhere.
    const deferredSession = {
      session: {
        sessionId: 'sess-deferred', rootMessageId: 'om_scheduled', status: 'active', workingDir: d.lab,
        deferredScheduleRun: { routingAnchor: 'om_node_card' },
      },
      larkAppId: MAIN, chatId: CHAT, chatType: 'group', scope: 'thread', workingDir: d.lab,
    } as unknown as DaemonSession;
    const main = daemon(MAIN, dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
      activeSessions: () => [deferredSession],
      sendCard: async () => 'om_node_card',
      replyCard: async () => 'om_handoff_card',
      deliverSelfTurn: async (input) => {
        delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) });
        return { sessionId: 'sess-deferred' };
      },
    });
    await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
    await settle();
    expect(delivered).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
      errorCode: 'WORKING_DIR_REFUSED',
      message: expect.stringContaining('节点话题里已有会话'),
    })]);
  });
});
