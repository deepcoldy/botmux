/**
 * Daemon wiring of bot-executed workflow nodes (design 2026-11-03 §6.5, §7.2,
 * §8, §9.3) with fake Lark / IPC / sessions: the main bot's own node reports
 * in-process, another bot's daemon forwards over trusted IPC, an offline main
 * bot is a retryable error, stop requests hit only the handoff's session, and
 * idle / registration notices reach the right daemon.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowNodeDaemon, workflowNodePinnedStart, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { BotRun, cleanupBotRuns, expectTerminal, reportDag, snapshotFor, trackTempDir } from './helpers/v3-external-harness.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import { WorkflowSidebarMembershipCache } from '../src/core/workflow-sidebar-membership.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf } from './helpers/workflow-handoff-harness.js';
import { activeSessionKey, sessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';
import { readDispatchRegistryLoose, revokeWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';
import { INITIATOR_MAIN_OU, INITIATOR_OU_IN, INITIATOR_UNION, authorizeRun } from './helpers/workflow-identity-world.js';
import {
  WORKFLOW_INITIATOR_UNION_ROUTE,
  WORKFLOW_OPERATOR_BUDGET_MS,
  WORKFLOW_WORKING_DIR_OPERATOR_ROUTE,
  createWorkflowWorkingDirOperatorWiring,
  type WorkflowWorkingDirOperatorIo,
} from '../src/core/workflow-working-dir-operator.js';
import { writeGrillState } from '../src/workflows/v3/grill-state.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import type { TargetAppOpenIdResolution } from '../src/im/lark/client.js';
import { createLiveV3WorkingDirOperator } from '../src/im/lark/v3-bot-eligibility.js';

/** Background work (notices behind a file lock, retries) finishes when it
 *  finishes on a loaded runner: wait for what a test expects to happen
 *  instead of sleeping a fixed time. */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10_000, interval: 10 });

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
    daemonReadsNodeProjectDir: () => true,
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
    await eventually(() => expect(target.posted.map((post) => post.body.kind)).toEqual(['accepted', 'stalled']));
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
    await eventually(() => expect(target.posted.map((post) => post.body.kind)).toEqual(['active', 'accepted']));
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

  it('P2-a: after accepted → stalled → active, the next turn ending without a submission stalls again', async () => {
    const { run, world, marker } = await handedOff('wd2-stall-again');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    const ds = fakeSession('sess-a', marker);
    target.wiring.onInputCommitted(ds, { turnId: marker.handoffMessageId, committedAt: 1 });
    target.wiring.onTurnSettled(ds, { turnId: marker.handoffMessageId, at: 2 }); // asked a human
    target.wiring.onInputCommitted(ds, { turnId: 'om_human_answer', committedAt: 3 }); // the answer
    target.wiring.onTurnSettled(ds, { turnId: 'om_human_answer', at: 4 }); // forgot to submit
    await eventually(() => expect(target.posted.map((post) => post.body.kind)).toEqual(['accepted', 'stalled', 'active', 'stalled']));
  });

  it('P3-b: a handoff revoked before its session registered it is never accepted and its turn is stopped', async () => {
    const { run, world, marker } = await handedOff('wd2-revoked-register');
    await revokeWorkflowHandoff(world.dataDir, SECRET, marker.nonce, 'runCancelled');
    const target = daemon('cli_a', world.dataDir, run.base, run);
    target.sessions.push(fakeSession('sess-a', marker));
    expect(target.wiring.isRevoked(marker.nonce)).toBe(true);
    target.wiring.onRegistered('sess-a', marker);
    target.wiring.onInputCommitted(target.sessions[0]!, { turnId: marker.handoffMessageId, committedAt: 1 });
    await eventually(() => expect(target.interrupted).toEqual(['sess-a:force', 'sess-a:force']));
    expect(target.posted).toEqual([]);
  });

  it('P3-b: the main bot answering "handoff_revoked" to the acceptance stops the turn', async () => {
    const { run, world, marker } = await handedOff('wd2-revoked-409');
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      postDaemon: async () => ({ status: 409, body: { ok: false, error: 'handoff_revoked' } }),
    });
    target.sessions.push(fakeSession('sess-a', marker));
    target.wiring.onRegistered('sess-a', marker);
    await eventually(() => expect(target.interrupted).toEqual(['sess-a:force']));
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
    await eventually(() => expect(target.posted.map((post) => [post.path, post.body.kind])).toEqual([['/api/workflow/handoff-event', 'wake']]));
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

  /** The inbound route's gate as daemon.ts calls it; `existingDir` = the
   *  directory of a session already in the node topic. No operate check is
   *  wired here, so the configured range alone decides. */
  async function admitted(target: ReturnType<typeof daemon>, binding: never, messageId: string, existingDir?: string) {
    const gate = await target.wiring.admitInboundHandoff({
      binding,
      handoffMessageId: messageId,
      executingLarkAppId: 'cli_a',
      currentSession: () => ({ dir: existingDir }),
      describeSession: (session) => (session.dir ? { dir: session.dir } : {}),
    });
    if (gate.kind !== 'admission') throw new Error(`expected an admission, got ${gate.kind}`);
    return gate.admission;
  }

  it('the executing bot\'s daemon decides from run.json and its configuration now: in range → that directory, out of range → refused', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-decide', d.project);
    let config: Record<string, unknown> = { workingDirs: [d.repos] };
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => config });
    const admit = () => admitted(target, binding, attempt.handoffMessageId!);
    expect(await admit()).toEqual({ start: true, workingDir: realpathSync(d.project) });
    // Narrowed after approval: the current configuration decides.
    config = { workingDirs: [d.lab] };
    const refused = await admit();
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain(d.project);
    config = {};
    expect(await admit()).toMatchObject({ start: false });
  });

  it('a symlinked directory is applied as its target: the session never stores the link', async () => {
    const d = dirs();
    const link = join(d.lab, 'project-link');
    symlinkSync(d.project, link);
    const { run, world, attempt, binding } = await handedOffPinned('wdd-link', link);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({ workingDirs: [d.repos] }) });
    expect(await admitted(target, binding, attempt.handoffMessageId!)).toEqual({ start: true, workingDir: realpathSync(d.project) });
    // Retargeted outside the range: the next handoff is refused.
    rmSync(link);
    symlinkSync(d.lab, link);
    expect(await admitted(target, binding, attempt.handoffMessageId!)).toMatchObject({ start: false });
  });

  it('a run approved without --working-dir keeps the bot\'s own default; an unreadable approval record is never guessed', async () => {
    const { run, world, attempt, binding } = await handedOffPinned('wdd-default', undefined);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({}) });
    expect(await admitted(target, binding, attempt.handoffMessageId!)).toEqual({ start: true });
    const elsewhere = daemon('cli_a', world.dataDir, trackTempDir(mkdtempSync(join(tmpdir(), 'wdd-empty-'))), run);
    expect(await admitted(elsewhere, binding, attempt.handoffMessageId!)).toMatchObject({ start: false });
    await settle();
    expect(target.posted).toEqual([]);
  });

  it('only a known decision starts the node: an unknown kind, a pinned one without a directory, or a promise never awaited is refused with a reason that names nothing internal', async () => {
    const { run, world, attempt, binding } = await handedOffPinned('wdd-undecided', undefined);
    const warnings: string[] = [];
    const target = daemon('cli_a', world.dataDir, run.base, run, { warn: (message) => { warnings.push(message); } });
    const admit = (dir: unknown) => target.wiring.admitInbound(binding, attempt.handoffMessageId!, 'cli_a', undefined, undefined, dir as never);
    expect(admit({ kind: 'default' })).toEqual({ start: true });
    const undecided = [{ kind: 'bogus' }, { kind: 'pinned' }, Promise.resolve({ kind: 'default' }), undefined];
    for (const dir of undecided) {
      const decision = admit(dir);
      expect(decision).toEqual({ start: false, reason: expect.stringContaining('没能确定节点该在哪个目录执行') });
      expect((decision as { reason: string }).reason).not.toMatch(/kind|bogus|Promise|object|undefined/);
    }
    // Each refusal reaches the main bot, which blocks the node; no session starts.
    await eventually(() => expect(target.posted.map((post) => post.body.kind)).toEqual(undecided.map(() => 'refused')));
    expect(warnings.join('\n')).toContain('kind bogus');
  });

  it('a refusal reaches the main bot, which blocks the node with the reason (no session involved)', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await handedOffPinned('wdd-refuse', d.project);
    const target = daemon('cli_a', world.dataDir, run.base, run, { botWorkingDirConfig: () => ({ workingDirs: [d.lab] }) });
    const decision = await admitted(target, binding, attempt.handoffMessageId!);
    if (decision.start) throw new Error('expected a refusal');
    await eventually(() => expect(target.posted).toHaveLength(1));
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
    expect(await admitted(target, binding, attempt.handoffMessageId!)).toMatchObject({ start: false });
    await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
    expect(calls).toBe(2);
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
    const decision = await admitted(target, binding, attempt.handoffMessageId!);
    if (decision.start) throw new Error('expected a refusal');
    // Both sends fail (the second after the retry delay), then it gives up.
    await eventually(() => expect(warnings.join('\n')).toContain(decision.reason));
    expect(run.of('nodeBlocked')).toEqual([]);
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
    expect(await admitted(target, binding, attempt.handoffMessageId!, d.project))
      .toEqual({ start: true, workingDir: realpathSync(d.project) });
    const link = join(d.lab, 'p-link');
    symlinkSync(d.project, link);
    expect(await admitted(target, binding, attempt.handoffMessageId!, link)).toMatchObject({ start: true });
    // Someone talked to the bot in the topic first, in its default (or a /cd) directory.
    const other = await admitted(target, binding, attempt.handoffMessageId!, d.lab);
    expect(other).toMatchObject({ start: false });
    expect((other as { reason: string }).reason).toContain('节点话题里已有会话，工作目录与指定的不一致');
    await eventually(() => expect(target.posted.map((post) => post.body.kind)).toEqual(['refused']));
    // Without a pinned directory an existing session is used as before.
    const plainRun = await handedOffPinned('wdd-existing-plain', undefined);
    const plain = daemon('cli_a', plainRun.world.dataDir, plainRun.run.base, plainRun.run);
    expect(await admitted(plain, plainRun.binding, plainRun.attempt.handoffMessageId!, d.lab)).toEqual({ start: true });
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
      if (expectStarted) {
        await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]));
        expect(posted).toEqual(['node card', 'handoff card']);
        expect(run.of('nodeBlocked')).toEqual([]);
      } else {
        await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
        expect(delivered).toEqual([]);
        // Decided before the cards: no task card is left in the topic.
        expect(posted).toEqual([]);
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
      if (expectBlocked) {
        await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
          errorCode: 'WORKING_DIR_REFUSED',
          message: expect.stringContaining('节点话题里已有会话'),
        })]));
        expect(delivered).toEqual([]);
      } else {
        await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]));
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
    await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
    expect(delivered).toEqual([]);
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
    await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.project) }]));
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
    await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({
      errorCode: 'WORKING_DIR_REFUSED',
      message: expect.stringContaining('节点话题里已有会话'),
    })]));
    expect(delivered).toEqual([]);
  });
});

describe('workflow node daemon wiring — the launching draft\'s project (nodeProjectDir, design §15.4)', () => {
  /** `repos/project` is the draft's project; `lab` is somewhere else. */
  function dirs() {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wdp-dir-')));
    const repos = join(root, 'repos');
    const project = join(repos, 'project');
    const lab = join(root, 'lab');
    mkdirSync(project, { recursive: true });
    mkdirSync(lab, { recursive: true });
    return { repos, project, lab };
  }

  /** A run as the Dashboard launch writes it (`nodeProjectDir` or, for a run
   *  from before projects, none), handed off to cli_a. */
  async function launched(runId: string, nodeProjectDir: string | undefined) {
    const run = new BotRun(reportDag(runId));
    authorizeRun(run, { identity: null, ...(nodeProjectDir ? { nodeProjectDir } : {}) });
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const binding = { nonce: nonceOf(attempt), sourceLarkAppId: MAIN, workflow: { runId } } as never;
    return { run, world, attempt, binding };
  }

  /** cli_a's inbound gate, its configuration alone deciding the range. */
  async function admittedOn(config: Record<string, unknown>, handed: Awaited<ReturnType<typeof launched>>) {
    const target = daemon('cli_a', handed.world.dataDir, handed.run.base, handed.run, { botWorkingDirConfig: () => config });
    const gate = await target.wiring.admitInboundHandoff({
      binding: handed.binding,
      handoffMessageId: handed.attempt.handoffMessageId!,
      executingLarkAppId: 'cli_a',
      currentSession: () => ({}),
      describeSession: () => ({}),
    });
    if (gate.kind !== 'admission') throw new Error(`expected an admission, got ${gate.kind}`);
    return { admission: gate.admission, target };
  }

  it('a bot without a default working dir starts the node in the draft\'s project (in its range), not in ~ or its first repo dir', async () => {
    const d = dirs();
    const handed = await launched('wdp-no-default', d.project);
    for (const config of [{ workingDirs: [d.repos] }, { workingDir: d.repos }, { workingDirs: [d.lab, d.repos] }]) {
      expect((await admittedOn(config, handed)).admission).toEqual({ start: true, workingDir: realpathSync(d.project) });
    }
  });

  it('a bot with a default working dir keeps it: the project is neither applied nor checked against its range', async () => {
    const d = dirs();
    const handed = await launched('wdp-has-default', d.project);
    for (const config of [
      { defaultWorkingDir: d.lab },
      { defaultWorkingDir: d.lab, workingDirs: [d.repos] },
      { defaultOncall: { enabled: true, workingDir: d.lab } },
    ]) {
      const { admission, target } = await admittedOn(config, handed);
      expect(admission).toEqual({ start: true });
      await settleBriefly();
      expect(target.posted).toEqual([]);
    }
    // A disabled Oncall dir is no default: the project applies.
    expect((await admittedOn({ defaultOncall: { enabled: false, workingDir: d.lab }, workingDirs: [d.repos] }, handed)).admission)
      .toEqual({ start: true, workingDir: realpathSync(d.project) });
  });

  it('a run from before projects (no nodeProjectDir in run.json) keeps every bot\'s own default resolution, as before', async () => {
    const d = dirs();
    const handed = await launched('wdp-old-run', undefined);
    expect(JSON.parse(readFileSync(join(handed.run.runDir, 'run.json'), 'utf-8'))).not.toHaveProperty('nodeProjectDir');
    for (const config of [{}, { workingDirs: [d.repos] }, { defaultWorkingDir: d.lab }]) {
      expect((await admittedOn(config, handed)).admission).toEqual({ start: true });
    }
  });

  it('a project outside the bot\'s range (no operate right) is refused, naming the project, and the node blocks', async () => {
    const d = dirs();
    const handed = await launched('wdp-outside', d.project);
    for (const [config, why] of [
      [{ workingDirs: [d.lab] }, '不在这个 Bot 配置的目录范围内'],
      [{}, '没有配置目录范围'],
    ] as const) {
      const { admission } = await admittedOn(config, handed);
      expect(admission).toMatchObject({ start: false });
      expect((admission as { reason: string }).reason).toContain(`工作流的项目目录 ${d.project}`);
      expect((admission as { reason: string }).reason).toContain(why);
    }
    const gone = await launched('wdp-gone', join(d.repos, 'gone'));
    const { admission, target } = await admittedOn({ workingDirs: [d.repos] }, gone);
    expect((admission as { reason: string }).reason).toContain('目录不存在');
    // The refusal reaches the main bot, which blocks the node with it.
    await eventually(() => expect(target.posted).toHaveLength(1));
    const main = daemon(MAIN, gone.world.dataDir, gone.run.base, gone.run);
    await main.wiring.eventRoute(target.posted[0]!.body);
    expect(gone.run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED', message: (admission as { reason: string }).reason })]);
  });

  it('the main bot\'s own node: without a default dir it starts in the project; with one it stays in its default', async () => {
    const d = dirs();
    for (const [config, expected] of [
      [{ workingDirs: [d.repos] }, { workingDir: realpathSync(d.project) }],
      [{ defaultWorkingDir: d.lab }, {}],
    ] as const) {
      const run = new BotRun(reportDag(`wdp-self-${'defaultWorkingDir' in config}`, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeProjectDir: d.project });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdp-self-data-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => config,
        sendCard: async () => 'om_node_card',
        replyCard: async () => 'om_handoff_card',
        deliverSelfTurn: async (input) => { delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) }); return { sessionId: 'self-session' }; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      await eventually(() => expect(delivered).toEqual([expected]));
      expect(run.of('nodeBlocked')).toEqual([]);
    }
  });

  it('a run carrying a project is not handed to a bot whose daemon cannot read it (reassigned to an older version); a run without one still is', async () => {
    const d = dirs();
    for (const [nodeProjectDir, reads, expectSent] of [
      [d.project, false, false],
      [d.project, true, true],
      [undefined, false, true],
    ] as const) {
      const run = new BotRun(reportDag(`wdp-old-${String(nodeProjectDir !== undefined)}-${String(reads)}`));
      authorizeRun(run, { identity: null, ...(nodeProjectDir ? { nodeProjectDir } : {}) });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdp-old-data-')));
      const posted: string[] = [];
      const main = daemon(MAIN, dataDir, run.base, run, {
        daemonPort: () => 4100,
        daemonReadsNodeProjectDir: (appId) => (appId === 'cli_a' ? reads : true),
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
});

describe('workflow node daemon wiring — the initiator\'s operate right decides the range (design §15.4)', () => {
  /** `repos/project` is in cli_a's range; `lab` is not. */
  function dirs() {
    const root = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-dir-')));
    const repos = join(root, 'repos');
    const project = join(repos, 'project');
    const lab = join(root, 'lab');
    mkdirSync(project, { recursive: true });
    mkdirSync(lab, { recursive: true });
    return { root, repos, project, lab };
  }

  /**
   * The production wiring (createWorkflowWorkingDirOperatorWiring) over a
   * fake contact directory — each app's open_id for the initiator's union_id
   * as INITIATOR_OU_IN says — fake member lists (`members[app]`, default:
   * the initiator is in the chat), and a command gate that lets
   * `cdUsers[app]` run `/cd`, and `cdUnions[app]` (union_ids: the platform
   * team member leg) when the gate is given one. `seen` records every gate
   * question, `unionLookups` every open_id → union_id lookup (`unionLookup`:
   * that lookup fails for now, never answers, or the app definitively cannot
   * see her), `memberReads` every member list read.
   */
  function operateDeps(cdUsers: Record<string, string[]>, opts: {
    directory?: 'up' | 'down' | 'definitive';
    members?: Record<string, string[] | Error>;
    membershipCache?: WorkflowSidebarMembershipCache;
    cdUnions?: Record<string, string[]>;
    unionLookup?: 'down' | 'hang' | 'unavailable';
  } = {}) {
    const seen: string[] = [];
    const conversions: string[] = [];
    const unionLookups: string[] = [];
    const memberReads: string[] = [];
    const io: WorkflowWorkingDirOperatorIo = {
      resolveTargetAppOpenId: async (appId, unionId): Promise<TargetAppOpenIdResolution> => {
        conversions.push(`${appId}:${unionId}`);
        if (opts.directory === 'down') return { status: 'transient' };
        if (opts.directory === 'definitive' || unionId !== INITIATOR_UNION || !INITIATOR_OU_IN[appId]) return { status: 'definitive' };
        return { status: 'resolved', openId: INITIATOR_OU_IN[appId]! };
      },
      resolveUnionIdFromOpenId: async (appId, openId) => {
        unionLookups.push(`${appId}:${openId}`);
        if (opts.unionLookup === 'hang') return new Promise(() => {});
        if (opts.unionLookup === 'down') return { status: 'retryable', error: 'contact api 503' };
        if (opts.unionLookup === 'unavailable') return { status: 'unavailable' };
        return openId === INITIATOR_OU_IN[appId] ? { status: 'resolved', unionId: INITIATOR_UNION } : { status: 'unavailable' };
      },
      listChatMemberOpenIds: async (appId) => {
        memberReads.push(appId);
        const members = opts.members?.[appId] ?? Object.values(INITIATOR_OU_IN);
        if (members instanceof Error) throw members;
        return members;
      },
      canRunDaemonCommand: (appId, _chatId, openId, unionId, cmd) => {
        seen.push(`${appId}:${openId}:${cmd}`);
        return cmd === '/cd' && ((cdUsers[appId]?.includes(openId) ?? false)
          || (unionId !== undefined && (opts.cdUnions?.[appId]?.includes(unionId) ?? false)));
      },
      selfLarkAppId: () => MAIN,
      ...(opts.membershipCache ? { membershipCache: opts.membershipCache } : {}),
    };
    const wiring = createWorkflowWorkingDirOperatorWiring(io);
    return { initiatorOperates: wiring.initiatorOperates, initiatorCdGate: wiring.initiatorCdGate, seen, conversions, unionLookups, memberReads };
  }

  const FROZEN_UNION = { unionId: INITIATOR_UNION, tools: ['lark-cli' as const] };

  async function pinnedRun(runId: string, dir: string, identity: typeof FROZEN_UNION | null) {
    const run = new BotRun(reportDag(runId));
    authorizeRun(run, { identity, nodeWorkingDir: dir });
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const binding = { nonce: nonceOf(attempt), sourceLarkAppId: MAIN, workflow: { runId } } as never;
    return { run, world, attempt, binding };
  }

  /** The inbound route's one gate, as daemon.ts calls it. `order` records
   *  when the session was read relative to the operate answer. */
  async function admit(target: ReturnType<typeof daemon>, binding: never, messageId: string, session?: { dir?: string }) {
    const gate = await target.wiring.admitInboundHandoff({
      binding,
      handoffMessageId: messageId,
      executingLarkAppId: 'cli_a',
      currentSession: () => ({ current: session }),
      describeSession: ({ current }) => (current?.dir ? { dir: current.dir } : {}),
    });
    if (gate.kind !== 'admission') return gate;
    return gate.admission;
  }

  it('her own bot (she may /cd there and is in the chat): any existing directory starts the node, outside its range too', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-own', d.lab, FROZEN_UNION);
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
    });
    expect(await admit(target, binding, attempt.handoffMessageId!)).toEqual({ start: true, workingDir: realpathSync(d.lab) });
    // Converted in cli_a's own app from the frozen union_id; the main app's
    // open_id never reached cli_a's gate, and the gate asked about /cd.
    expect(op.conversions).toEqual([`cli_a:${INITIATOR_UNION}`]);
    expect(op.seen).toEqual([`cli_a:${INITIATOR_OU_IN.cli_a}:/cd`]);
  });

  it('a colleague\'s bot (she may not /cd there): outside its range refused with the range reason, inside it started', async () => {
    const d = dirs();
    const outside = await pinnedRun('wdo-colleague-out', d.lab, FROZEN_UNION);
    const op = operateDeps({ cli_a: ['ou_bob_in_a'] });
    const config = { botWorkingDirConfig: () => ({ workingDirs: [d.repos] }), initiatorOperates: op.initiatorOperates };
    const refused = await admit(daemon('cli_a', outside.world.dataDir, outside.run.base, outside.run, config), outside.binding, outside.attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain('不在这个 Bot 配置的目录范围内');
    expect((refused as { reason: string }).reason).not.toContain('暂时无法确认');
    const inside = await pinnedRun('wdo-colleague-in', d.project, FROZEN_UNION);
    const before = op.seen.length;
    expect(await admit(daemon('cli_a', inside.world.dataDir, inside.run.base, inside.run, config), inside.binding, inside.attempt.handoffMessageId!))
      .toEqual({ start: true, workingDir: realpathSync(d.project) });
    // In range: nobody was asked about operating.
    expect(op.seen).toHaveLength(before);
  });

  it('she left the chat: even with the /cd right the range applies again', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-left', d.lab, FROZEN_UNION);
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] }, { members: { cli_a: ['ou_bob_in_a'] } });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
    });
    const refused = await admit(target, binding, attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain('不在这个 Bot 配置的目录范围内');
  });

  it('a lookup that fails is "could not confirm": still refused outside the range, but saying so and why', async () => {
    const d = dirs();
    for (const [opts, why] of [
      [{ directory: 'down' as const }, '换算'],
      [{ members: { cli_a: new Error('429') } }, '群里'],
    ] as const) {
      const { run, world, attempt, binding } = await pinnedRun(`wdo-unknown-${why === '换算' ? 'convert' : 'members'}`, d.lab, FROZEN_UNION);
      const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] }, opts);
      const target = daemon('cli_a', world.dataDir, run.base, run, {
        botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
        initiatorOperates: op.initiatorOperates,
      });
      const refused = await admit(target, binding, attempt.handoffMessageId!);
      expect(refused).toMatchObject({ start: false });
      const reason = (refused as { reason: string }).reason;
      expect(reason).toContain('暂时无法确认发起人能否操作 cli_a');
      expect(reason).toContain(why);
      expect(reason).toContain('稍后重试');
    }
  });

  it('a definitive conversion miss is "cannot operate" — even when the bot happens to list the main app\'s open_id', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-convert-fails', d.lab, FROZEN_UNION);
    // The same string as the main app's id for her: it must not be used here.
    const op = operateDeps({ cli_a: [INITIATOR_MAIN_OU, INITIATOR_OU_IN.cli_a!] }, { directory: 'definitive' });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
    });
    const refused = await admit(target, binding, attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).not.toContain('暂时无法确认');
    expect(op.seen).toEqual([]);
  });

  it('the gate decides first, then reads the session it would land in, then re-checks revocation', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-gate-order', d.lab, FROZEN_UNION);
    const order: string[] = [];
    let release!: () => void;
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: async () => { order.push('asked'); await new Promise<void>((r) => { release = r; }); order.push('answered'); return 'yes'; },
    });
    const pending = target.wiring.admitInboundHandoff({
      binding,
      handoffMessageId: attempt.handoffMessageId!,
      executingLarkAppId: 'cli_a',
      currentSession: () => { order.push('session read'); return { dir: d.lab }; },
      describeSession: (session) => ({ dir: session.dir }),
    });
    await eventually(() => expect(order).toEqual(['asked']));
    release();
    expect(await pending).toEqual({ kind: 'admission', session: { dir: d.lab }, admission: { start: true, workingDir: realpathSync(d.lab) } });
    expect(order).toEqual(['asked', 'answered', 'session read']);
    // A caller whose turn went stale meanwhile: nothing admitted, nothing posted.
    const stale = await target.wiring.admitInboundHandoff({
      binding, handoffMessageId: attempt.handoffMessageId!, executingLarkAppId: 'cli_a',
      currentSession: () => 'stale' as const, describeSession: () => ({}),
    });
    expect(stale).toEqual({ kind: 'stale' });
  });

  it('stopped while the operate lookup waits: the gate answers revoked and starts nothing', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-gate-revoke', d.lab, FROZEN_UNION);
    let release!: () => void;
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: async () => { await new Promise<void>((r) => { release = r; }); return 'yes'; },
    });
    const pending = admit(target, binding, attempt.handoffMessageId!);
    await eventually(() => expect(release).toBeTypeOf('function'));
    await revokeWorkflowHandoff(world.dataDir, SECRET, nonceOf(attempt), 'runCancelled');
    release();
    expect(await pending).toEqual({ kind: 'revoked' });
    expect(target.posted).toEqual([]);
  });

  it('no union_id frozen on the run: the main bot\'s daemon is asked for it; no answer = could not confirm', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-ask-main', d.lab, null);
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
    const lookups: string[] = [];
    let mainKnows = true;
    const main = daemon(MAIN, world.dataDir, run.base, run, {
      lookupOwnUnionId: async (openId) => { lookups.push(openId); return mainKnows ? { unionId: INITIATOR_UNION } : { unknown: 'lookup failed' }; },
    });
    const posted: Array<{ path: string; body: unknown }> = [];
    let mainAnswers: 'route' | 'offline' | 'old' = 'route';
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
      daemonPort: (appId) => (appId === MAIN && mainAnswers !== 'offline' ? 4100 : undefined),
      postDaemon: async (_port, path, body) => {
        posted.push({ path, body });
        if (path !== WORKFLOW_INITIATOR_UNION_ROUTE) return { status: 200, body: { ok: true } };
        return mainAnswers === 'old' ? { status: 404, body: {} } : main.wiring.initiatorUnionRoute(body);
      },
    });
    expect(await admit(target, binding, attempt.handoffMessageId!)).toEqual({ start: true, workingDir: realpathSync(d.lab) });
    // The asker names itself; the main bot looked her up by the open_id ITS app issued.
    expect(posted[0]).toEqual({ path: WORKFLOW_INITIATOR_UNION_ROUTE, body: { runId: run.dag.runId, requesterLarkAppId: 'cli_a' } });
    expect(lookups).toEqual([INITIATOR_MAIN_OU]);
    for (const [setup, expected] of [
      [() => { mainKnows = false; }, 'lookup failed'],
      [() => { mainKnows = true; mainAnswers = 'offline'; }, '不在线'],
      [() => { mainAnswers = 'old'; }, '版本过旧'],
    ] as const) {
      setup();
      const refused = await admit(target, binding, attempt.handoffMessageId!);
      expect(refused).toMatchObject({ start: false });
      expect((refused as { reason: string }).reason).toContain('暂时无法确认');
      expect((refused as { reason: string }).reason).toContain(expected);
    }
  });

  it('the main bot\'s union route answers only for its own pinned runs, and only to one of their executing bots', async () => {
    const d = dirs();
    const { run, world } = await pinnedRun('wdo-union-route', d.lab, null);
    const main = daemon(MAIN, world.dataDir, run.base, run, { lookupOwnUnionId: async () => ({ unionId: INITIATOR_UNION }) });
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_a' }))
      .toEqual({ status: 200, body: { ok: true, unionId: INITIATOR_UNION } });
    // A bot that executes no node of this run.
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_b' })).toMatchObject({ status: 404 });
    // Another bot's daemon is not this run's main bot.
    expect(await daemon('cli_b', world.dataDir, run.base, run).wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_a' }))
      .toMatchObject({ status: 404 });
    expect(await main.wiring.initiatorUnionRoute({ runId: '../x', requesterLarkAppId: 'cli_a' })).toMatchObject({ status: 400 });
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId })).toMatchObject({ status: 400 });
    // A run without a working dir: nothing to answer for.
    const plain = await pinnedRun('wdo-union-plain', d.lab, null);
    const plainEnvelope = join(plain.run.runDir, 'run.json');
    const raw = JSON.parse(readFileSync(plainEnvelope, 'utf-8')) as Record<string, unknown>;
    delete raw.nodeWorkingDir;
    writeFileSync(plainEnvelope, JSON.stringify(raw));
    expect(await main.wiring.initiatorUnionRoute({ runId: plain.run.dag.runId, requesterLarkAppId: 'cli_a' })).toMatchObject({ status: 404 });
  });

  it('the launching draft\'s project follows the same rule on a bot without a default dir: outside its range only when she may operate it (union_id asked of the main bot)', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdo-project'));
    authorizeRun(run, { identity: null, nodeProjectDir: d.lab });
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const binding = { nonce: nonceOf(attempt), sourceLarkAppId: MAIN, workflow: { runId: run.dag.runId } } as never;
    const main = daemon(MAIN, world.dataDir, run.base, run, { lookupOwnUnionId: async () => ({ unionId: INITIATOR_UNION }) });
    const onCliA = (cdUsers: string[]) => daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: operateDeps({ cli_a: cdUsers }).initiatorOperates,
      postDaemon: async (_port, path, body) => (path === WORKFLOW_INITIATOR_UNION_ROUTE
        ? main.wiring.initiatorUnionRoute(body)
        : { status: 200, body: { ok: true } }),
    });
    expect(await admit(onCliA([INITIATOR_OU_IN.cli_a!]), binding, attempt.handoffMessageId!))
      .toEqual({ start: true, workingDir: realpathSync(d.lab) });
    const refused = await admit(onCliA(['ou_bob_in_a']), binding, attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain(`工作流的项目目录 ${d.lab}`);
    expect((refused as { reason: string }).reason).toContain('不在这个 Bot 配置的目录范围内');
    expect((refused as { reason: string }).reason).not.toContain('暂时无法确认');
  });

  it('a directory gone since approval is refused even on her own bot', async () => {
    const d = dirs();
    const gone = join(d.lab, 'gone');
    mkdirSync(gone);
    const { run, world, attempt, binding } = await pinnedRun('wdo-gone', gone, FROZEN_UNION);
    rmSync(gone, { recursive: true });
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
    });
    const refused = await admit(target, binding, attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain('目录不存在');
    expect(op.seen).toEqual([]);
  });

  it('the main bot\'s own node follows the same rule, with the open_id its own app issued', async () => {
    const d = dirs();
    for (const [cdUsers, expectStarted] of [[[INITIATOR_MAIN_OU], true], [['ou_bob_in_main'], false]] as const) {
      const run = new BotRun(reportDag(`wdo-self-${expectStarted}`, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.lab });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-self-data-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const posted: string[] = [];
      const op = operateDeps({ [MAIN]: [...cdUsers] });
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
        initiatorOperates: op.initiatorOperates,
        initiatorCdGate: op.initiatorCdGate,
        sendCard: async () => { posted.push('node card'); return 'om_node_card'; },
        replyCard: async () => { posted.push('handoff card'); return 'om_handoff_card'; },
        deliverSelfTurn: async (input) => { delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) }); return { sessionId: 'self-session' }; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      if (expectStarted) {
        await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.lab) }]));
        expect(run.of('nodeBlocked')).toEqual([]);
        // The open_id alone passes: no union_id lookup.
        expect(op.unionLookups).toEqual([]);
      } else {
        await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
        expect(run.of('nodeBlocked')[0]!.message).not.toContain('暂时无法确认');
        expect(delivered).toEqual([]);
        // Refused before the cards, without reading the chat's members.
        expect(posted).toEqual([]);
        expect(op.memberReads).toEqual([]);
      }
      expect(op.conversions).toEqual([]);
      expect(new Set(op.seen)).toEqual(new Set([`${MAIN}:${INITIATOR_MAIN_OU}:/cd`]));
    }
  });

  it('the main bot\'s own node: stopped while startSelfTurn waits for the operate answer → never delivered', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdo-self-revoke', { bot: undefined }));
    authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.lab });
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-self-rv-')));
    const delivered: unknown[] = [];
    let asks = 0;
    const main = daemon(MAIN, dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
      initiatorOperates: async () => {
        // Asked only inside startSelfTurn (the preflight reads no members),
        // after the executor's own revoke checks: the attempt is stopped
        // while this answer is on its way.
        asks += 1;
        const key = Object.keys(readDispatchRegistryLoose(dataDir)).find((k) => k.startsWith('workflow-handoff:'))!;
        await revokeWorkflowHandoff(dataDir, SECRET, key.slice('workflow-handoff:'.length), 'runCancelled');
        return 'yes';
      },
      sendCard: async () => 'om_node_card',
      replyCard: async () => 'om_handoff_card',
      deliverSelfTurn: async (input) => { delivered.push(input.marker.nonce); return { sessionId: 'self-session' }; },
    });
    await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
    await eventually(() => expect(asks).toBe(1));
    await settleBriefly();
    expect(delivered).toEqual([]);
  });

  it('the main bot\'s own node reads the chat\'s members once, when it starts — not also before its cards go out', async () => {
    const d = dirs();
    for (const [members, expectStarted] of [[undefined, true], [['ou_bob_in_main'], false]] as const) {
      const run = new BotRun(reportDag(`wdo-self-members-${expectStarted}`, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.lab });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-self-mem-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const posted: string[] = [];
      const op = operateDeps({ [MAIN]: [INITIATOR_MAIN_OU] }, members ? { members: { [MAIN]: [...members] } } : {});
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
        initiatorOperates: op.initiatorOperates,
        initiatorCdGate: op.initiatorCdGate,
        sendCard: async () => { posted.push('node card'); return 'om_node_card'; },
        replyCard: async () => { posted.push('handoff card'); return 'om_handoff_card'; },
        deliverSelfTurn: async (input) => { delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) }); return { sessionId: 'self-session' }; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      if (expectStarted) {
        await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.lab) }]));
      } else {
        // She left the chat: only the start sees it, so the cards are out
        // and the node blocks there.
        await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
        expect(delivered).toEqual([]);
        expect(posted).toEqual(['node card', 'handoff card']);
      }
      expect(op.memberReads).toEqual([MAIN]);
    }
  });

  it('the main bot\'s own node, no union_id frozen: the /cd gate gets the union_id its own app looks up; a failed lookup is "could not confirm", one its app definitively cannot answer is the range refusal — never a pass, and no card goes out', async () => {
    const d = dirs();
    for (const [unionLookup, expected] of [[undefined, 'started'], ['down', 'unknown'], ['unavailable', 'out of range']] as const) {
      const run = new BotRun(reportDag(`wdo-self-team-${unionLookup ?? 'up'}`, { bot: undefined }));
      authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.lab });
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-self-team-')));
      const delivered: Array<{ workingDir?: string }> = [];
      const cardsOut: string[] = [];
      // No admin of the main bot: its gate lets her use /cd by her union_id
      // (a platform team member of a bot that lowered /cd to talk).
      const op = operateDeps({ [MAIN]: [] }, { cdUnions: { [MAIN]: [INITIATOR_UNION] }, ...(unionLookup ? { unionLookup } : {}) });
      const main = daemon(MAIN, dataDir, run.base, run, {
        botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
        initiatorOperates: op.initiatorOperates,
        initiatorCdGate: op.initiatorCdGate,
        sendCard: async () => { cardsOut.push('node'); return 'om_node_card'; },
        replyCard: async () => { cardsOut.push('handoff'); return 'om_handoff_card'; },
        deliverSelfTurn: async (input) => { delivered.push({ ...(input.workingDir ? { workingDir: input.workingDir } : {}) }); return { sessionId: 'self-session' }; },
      });
      await run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      if (expected === 'started') {
        await eventually(() => expect(delivered).toEqual([{ workingDir: realpathSync(d.lab) }]));
        expect(run.of('nodeBlocked')).toEqual([]);
        expect(cardsOut).toEqual(['node', 'handoff']);
      } else {
        await eventually(() => expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]));
        const message = run.of('nodeBlocked')[0]!.message;
        if (expected === 'unknown') {
          expect(message).toContain('暂时无法确认发起人能否操作');
          expect(message).toContain('稍后重试');
        } else {
          expect(message).toContain('不在这个 Bot 配置的目录范围内');
          expect(message).not.toContain('暂时无法确认');
        }
        expect(delivered).toEqual([]);
        // Refused before anything is posted: no node card, no handoff card.
        expect(cardsOut).toEqual([]);
      }
      // Looked up through the main bot's own app, by the open_id it issued.
      expect(new Set(op.unionLookups)).toEqual(new Set([`${MAIN}:${INITIATOR_MAIN_OU}`]));
      expect(op.conversions).toEqual([]);
    }
  });

  it('the main bot\'s own node: the lookup before its cards go out counts toward the same 8 s budget; nothing is posted before the refusal (fake clock)', async () => {
    const d = dirs();
    const run = new BotRun(reportDag('wdo-self-team-hang', { bot: undefined }));
    authorizeRun(run, { identity: null, selectors: [''], nodeWorkingDir: d.lab });
    const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-self-hang-')));
    const op = operateDeps({ [MAIN]: [] }, { cdUnions: { [MAIN]: [INITIATOR_UNION] }, unionLookup: 'hang' });
    const cards: string[] = [];
    const main = daemon(MAIN, dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ defaultWorkingDir: d.repos }),
      initiatorOperates: op.initiatorOperates,
      initiatorCdGate: op.initiatorCdGate,
      sendCard: async () => { cards.push('node'); return 'om_node_card'; },
      replyCard: async () => { cards.push('handoff'); return 'om_handoff_card'; },
      deliverSelfTurn: async () => ({ sessionId: 'self-session' }),
    });
    // Only the budget's clock is faked: file I/O and setImmediate stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const until = async (done: () => boolean) => {
        for (const deadline = Date.now() + 10_000; !done() && Date.now() < deadline;) {
          await vi.advanceTimersByTimeAsync(0);
          await new Promise<void>((r) => setImmediate(r));
        }
      };
      void run.drive(main.wiring.executor, { opts: { chatBinding: BINDING } });
      await until(() => op.unionLookups.length > 0);
      expect(op.unionLookups).toEqual([`${MAIN}:${INITIATOR_MAIN_OU}`]);
      await vi.advanceTimersByTimeAsync(WORKFLOW_OPERATOR_BUDGET_MS - 1);
      expect(run.of('nodeBlocked')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => run.of('nodeBlocked').length > 0);
    } finally {
      vi.useRealTimers();
    }
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'WORKING_DIR_REFUSED' })]);
    const message = run.of('nodeBlocked')[0]!.message;
    expect(message).toContain('暂时无法确认发起人能否操作');
    expect(message).toContain('超时');
    expect(cards).toEqual([]);
    expect(op.memberReads).toEqual([]);
  });

  it('run records that cannot be read at node start are "could not confirm" (retry later), never "cannot operate" — and the range still decides', async () => {
    const d = dirs();
    const breakers = {
      journal: (runDir: string) => {
        const path = join(runDir, 'journal.ndjson');
        writeFileSync(path, `not json\n${readFileSync(path, 'utf-8')}`);
      },
      artifact: (runDir: string) => writeFileSync(join(runDir, 'dag.json'), '{}\n'),
    };
    for (const [what, breakIt] of Object.entries(breakers)) {
      // Her own bot: with readable records she would start it outside the range.
      const outside = await pinnedRun(`wdo-unreadable-${what}`, d.lab, FROZEN_UNION);
      breakIt(outside.run.runDir);
      const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
      const config = { botWorkingDirConfig: () => ({ workingDirs: [d.repos] }), initiatorOperates: op.initiatorOperates };
      const refused = await admit(daemon('cli_a', outside.world.dataDir, outside.run.base, outside.run, config), outside.binding, outside.attempt.handoffMessageId!);
      expect(refused).toMatchObject({ start: false });
      const reason = (refused as { reason: string }).reason;
      expect(reason).toContain('暂时无法确认发起人能否操作 cli_a');
      expect(reason).toContain('稍后重试');
      expect(op.seen).toEqual([]);
      // Inside the range nobody is asked: it starts as before.
      const inside = await pinnedRun(`wdo-unreadable-${what}-in`, d.project, FROZEN_UNION);
      breakIt(inside.run.runDir);
      expect(await admit(daemon('cli_a', inside.world.dataDir, inside.run.base, inside.run, config), inside.binding, inside.attempt.handoffMessageId!))
        .toEqual({ start: true, workingDir: realpathSync(d.project) });
    }
  });

  it('a bot someone else reassigned a node to gets the union_id from the main bot; a bot outside the run still does not', async () => {
    const d = dirs();
    const { run, world } = await pinnedRun('wdo-union-reassigned', d.lab, null);
    // Not by the initiator, so outside the approved scope — but cli_c
    // executes the node now.
    appendEvent(join(run.runDir, 'journal.ndjson'), {
      type: 'nodeReassigned', nodeId: 'write', instanceId: 'write#001', from: 'cli_a', to: 'cli_c', by: 'ou_someone_else',
    });
    const main = daemon(MAIN, world.dataDir, run.base, run, { lookupOwnUnionId: async () => ({ unionId: INITIATOR_UNION }) });
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_c' }))
      .toEqual({ status: 200, body: { ok: true, unionId: INITIATOR_UNION } });
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_b' }))
      .toMatchObject({ status: 404, body: { error: 'run_not_eligible' } });
  });

  it('a revision brought in a new bot: the main bot still answers the original executor (and the new one), from the real journal', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-revised', d.lab, null);
    // A real runtime edit by the initiator: a node on cli_d, a bot outside
    // the frozen bots.snapshot.json (recorded as the revision's bot additions).
    const edited = applyV3RunEdit({
      baseDir: run.base, runId: run.dag.runId, baseRevision: 1,
      caller: { openId: INITIATOR_MAIN_OU, origin: 'human' },
      patch: [{ op: 'addNode', node: { id: 'extra', type: 'goal', goal: 'more', bot: 'cli_d', depends: [], inputs: [] } }],
      resolveNewBotSnapshot: (selector) => snapshotFor(selector),
    });
    expect(edited).toMatchObject({ kind: 'applied' });
    expect(readFileSync(join(run.runDir, 'journal.ndjson'), 'utf-8')).toContain('dagRevised');
    const main = daemon(MAIN, world.dataDir, run.base, run, { lookupOwnUnionId: async () => ({ unionId: INITIATOR_UNION }) });
    for (const requester of ['cli_a', 'cli_d']) {
      expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: requester }))
        .toEqual({ status: 200, body: { ok: true, unionId: INITIATOR_UNION } });
    }
    expect(await main.wiring.initiatorUnionRoute({ runId: run.dag.runId, requesterLarkAppId: 'cli_b' })).toMatchObject({ status: 404 });
    // And so her own bot cli_a still starts the original node outside its range.
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
      postDaemon: async (_port, path, body) => (path === WORKFLOW_INITIATOR_UNION_ROUTE
        ? main.wiring.initiatorUnionRoute(body)
        : { status: 200, body: { ok: true } }),
    });
    expect(await admit(target, binding, attempt.handoffMessageId!)).toEqual({ start: true, workingDir: realpathSync(d.lab) });
  });

  it('node start reads the chat members fresh: she left 1 s ago, inside the cache window, and no longer counts', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-fresh-members', d.lab, FROZEN_UNION);
    let now = 1_000_000;
    const members: Record<string, string[]> = { cli_a: [INITIATOR_OU_IN.cli_a!] };
    const cache = new WorkflowSidebarMembershipCache({ now: () => now });
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] }, { members, membershipCache: cache });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
    });
    const gate2Ask = () => op.initiatorOperates({ larkAppId: 'cli_a', chatId: CHAT, initiator: { sourceLarkAppId: MAIN, unionId: INITIATOR_UNION } });
    // Gate-2 asked while she was in the chat: its verdict is cached.
    expect(await gate2Ask()).toBe('yes');
    expect(await admit(target, binding, attempt.handoffMessageId!)).toEqual({ start: true, workingDir: realpathSync(d.lab) });
    members.cli_a = ['ou_bob_in_a'];
    now += 1_000;
    // Node start ignores the cache: refused at once.
    expect(await admit(target, binding, attempt.handoffMessageId!)).toMatchObject({ start: false });
    // Gate-2 still reads the cache within its window (the documented
    // trade-off), and sees the change once it expires.
    expect(await gate2Ask()).toBe('yes');
    now += 60_000;
    expect(await gate2Ask()).toBe('no');
  });

  it('a non-200 answer from the main bot is never taken as the union_id, even when it carries one', async () => {
    const d = dirs();
    const { run, world, attempt, binding } = await pinnedRun('wdo-union-non200', d.lab, null);
    const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
    const target = daemon('cli_a', world.dataDir, run.base, run, {
      botWorkingDirConfig: () => ({ workingDirs: [d.repos] }),
      initiatorOperates: op.initiatorOperates,
      postDaemon: async () => ({ status: 503, body: { ok: false, unionId: INITIATOR_UNION, error: 'busy' } }),
    });
    const refused = await admit(target, binding, attempt.handoffMessageId!);
    expect(refused).toMatchObject({ start: false });
    expect((refused as { reason: string }).reason).toContain('暂时无法确认');
    expect(op.conversions).toEqual([]);
  });

  describe('Gate-2 asks the executing bot about a run still waiting for approval', () => {
    /** A run at Gate-2 (grill state dag_ready, no run.json), its node on cli_a
     *  unless `dag` says otherwise. */
    function pendingRun(runId: string, inBase?: string, dag: unknown = reportDag(runId)) {
      const base = inBase ?? trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-pending-')));
      const runDir = join(base, runId);
      mkdirSync(runDir, { recursive: true });
      const dagPath = join(runDir, 'dag.json');
      writeFileSync(dagPath, JSON.stringify(dag));
      writeGrillState(runDir, {
        schemaVersion: 1, runId, goal: 'g', status: 'dag_ready',
        createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
        specPath: join(runDir, 'spec.md'), specJsonPath: join(runDir, 'spec.json'), dagPath,
        chatBinding: { ...BINDING, ownerOpenId: INITIATOR_MAIN_OU },
      });
      return { base, runId };
    }
    const BOTS = [MAIN, 'cli_a', 'cli_b'].map((larkAppId) => ({ larkAppId, larkAppSecret: 's', cliId: 'claude-code' })) as never[];

    function hosts(runId: string, base: string, dataDir: string, op: ReturnType<typeof operateDeps>) {
      const run = new BotRun(reportDag(runId));
      const main = daemon(MAIN, dataDir, base, run, {
        currentBots: () => BOTS,
        lookupOwnUnionId: async (openId) => (openId === INITIATOR_MAIN_OU ? { unionId: INITIATOR_UNION } : { unknown: 'no' }),
        initiatorOperates: op.initiatorOperates,
      });
      const target = daemon('cli_a', dataDir, base, run, {
        currentBots: () => BOTS,
        initiatorOperates: op.initiatorOperates,
        daemonPort: (appId) => (appId === MAIN ? 4100 : undefined),
        postDaemon: async (_port, path, body) => (path === WORKFLOW_INITIATOR_UNION_ROUTE
          ? main.wiring.initiatorUnionRoute(body)
          : { status: 200, body: { ok: true } }),
      });
      const byApp = new Map([[MAIN, main], ['cli_a', target]]);
      const operator = createLiveV3WorkingDirOperator({ runId }, {
        daemonPort: (appId) => (byApp.has(appId) ? (appId === MAIN ? 4100 : 4200) : undefined),
        post: async (port, path, body) => {
          expect(path).toBe(WORKFLOW_WORKING_DIR_OPERATOR_ROUTE);
          return byApp.get(port === 4100 ? MAIN : 'cli_a')!.wiring.workingDirOperatorRoute(body);
        },
      });
      return { operator, main, target };
    }

    it('her bot says yes, a colleague\'s says no — the union_id comes from the main bot, as at node start', async () => {
      const { base, runId } = pendingRun('wdo-g2');
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-g2-data-')));
      const mine = hosts(runId, base, dataDir, operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] }));
      expect(await mine.operator({ nodeId: 'write', larkAppId: 'cli_a' })).toBe('yes');
      const colleague = operateDeps({ cli_a: ['ou_bob_in_a'] });
      expect(await hosts(runId, base, dataDir, colleague).operator({ nodeId: 'write', larkAppId: 'cli_a' })).toBe('no');
      expect(colleague.conversions).toEqual([`cli_a:${INITIATOR_UNION}`]);
    });

    it('the question is bound to the run: a node the bot does not execute, or a run not at Gate-2, gets no answer', async () => {
      const { base, runId } = pendingRun('wdo-g2-bound');
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-g2b-data-')));
      const { operator, target } = hosts(runId, base, dataDir, operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!], [MAIN]: [INITIATOR_MAIN_OU] }));
      // MAIN executes no node of this run: its daemon refuses (Gate-2 sees "could not confirm").
      expect(await operator({ nodeId: 'write', larkAppId: MAIN })).toEqual({ unknown: expect.any(String) });
      expect(await target.wiring.workingDirOperatorRoute({ runId, nodeId: 'nope' })).toMatchObject({ status: 404 });
      expect(await target.wiring.workingDirOperatorRoute({ runId: 'missing-run', nodeId: 'write' })).toMatchObject({ status: 404 });
      expect(await target.wiring.workingDirOperatorRoute({ runId, nodeId: 'write', chatId: CHAT })).toMatchObject({ status: 400 });
    });

    it('only a run still waiting at Gate-2: approved already (dag_approved), or run.json published in the crash window, gets no answer', async () => {
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-g2c-data-')));
      const op = operateDeps({ cli_a: [INITIATOR_OU_IN.cli_a!] });
      // Approved: the grill moved on.
      const approved = pendingRun('wdo-g2-approved');
      const approvedDir = join(approved.base, approved.runId);
      const grill = JSON.parse(readFileSync(join(approvedDir, 'grill.state.json'), 'utf-8')) as Record<string, unknown>;
      writeGrillState(approvedDir, { ...grill, status: 'dag_approved' } as never);
      expect(await hosts(approved.runId, approved.base, dataDir, op).target.wiring.workingDirOperatorRoute({ runId: approved.runId, nodeId: 'write' }))
        .toMatchObject({ status: 404 });
      // Crash window: run.json is published, the grill still says dag_ready.
      const windowRun = new BotRun(reportDag('wdo-g2-window'));
      const window = pendingRun(windowRun.dag.runId, windowRun.base);
      expect(await hosts(window.runId, window.base, dataDir, op).target.wiring.workingDirOperatorRoute({ runId: window.runId, nodeId: 'write' }))
        .toMatchObject({ status: 200 });
      authorizeRun(windowRun, { identity: null, nodeWorkingDir: trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-g2w-dir-'))) });
      expect(readFileSync(join(window.base, window.runId, 'grill.state.json'), 'utf-8')).toContain('dag_ready');
      expect(await hosts(window.runId, window.base, dataDir, op).target.wiring.workingDirOperatorRoute({ runId: window.runId, nodeId: 'write' }))
        .toMatchObject({ status: 404 });
    });

    it('the main bot\'s own node: the union_id its /cd gate may need is looked up within the same 8 s budget (fake clock)', async () => {
      const runId = 'wdo-g2-self';
      const { base } = pendingRun(runId, undefined, reportDag(runId, { bot: undefined }));
      const dataDir = trackTempDir(mkdtempSync(join(tmpdir(), 'wdo-g2s-data-')));
      const ask = (op: ReturnType<typeof operateDeps>) => hosts(runId, base, dataDir, op).main.wiring.workingDirOperatorRoute({ runId, nodeId: 'write' });
      // A platform team member, no admin: passes once the lookup answers.
      const teamMember = { cdUnions: { [MAIN]: [INITIATOR_UNION] } };
      expect(await ask(operateDeps({ [MAIN]: [] }, teamMember))).toEqual({ status: 200, body: { ok: true, operate: 'yes' } });
      // Its app definitively cannot see her: the open_id's refusal stands (the
      // range refusal at Gate-2), as before the lookup existed; a lookup that
      // fails for now is "could not confirm".
      expect(await ask(operateDeps({ [MAIN]: [] }, { ...teamMember, unionLookup: 'unavailable' }))).toEqual({ status: 200, body: { ok: true, operate: 'no' } });
      expect(await ask(operateDeps({ [MAIN]: [] }, { ...teamMember, unionLookup: 'down' })))
        .toEqual({ status: 200, body: { ok: true, operate: { unknown: expect.any(String) } } });
      vi.useFakeTimers();
      try {
        let answered: unknown;
        void ask(operateDeps({ [MAIN]: [] }, { ...teamMember, unionLookup: 'hang' })).then((r) => { answered = r; });
        await vi.advanceTimersByTimeAsync(WORKFLOW_OPERATOR_BUDGET_MS - 1);
        expect(answered).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(answered).toEqual({ status: 200, body: { ok: true, operate: { unknown: expect.stringContaining('超时') } } });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/** Let fire-and-forget work queued by the code under test run. */
const settleBriefly = () => new Promise((resolve) => setTimeout(resolve, 50));
