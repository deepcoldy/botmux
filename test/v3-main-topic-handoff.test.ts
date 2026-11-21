/**
 * Main-topic placement (design 2026-11-03 §5.4, §5.5, P2, P3) driven by the
 * REAL runtime, the real Feishu handoff executor, the real event / report
 * routes and the real card sync, over a fake Lark and a fake clock:
 *
 * - no node card: the handoff card is replied straight into the main topic,
 *   carries the node's status line and is patched in place;
 * - the binding is keyed by the handoff message id, its publish root being
 *   the main topic's root, and is marked `main`;
 * - acceptance on entering the target session's queue, the node deadline
 *   counted from when its own turn starts (a backstop when it never does);
 * - node-topic attempts keep their exact journal shape.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  BotRun,
  TIMEOUT_SEC,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
  reportFiles,
} from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf, orchestratorEvent, targetReport } from './helpers/workflow-handoff-harness.js';
import {
  lookupWorkflowHandoff,
  readDispatchRegistryLoose,
  resolveInboundWorkflowHandoff,
} from '../src/core/workflow-handoff-binding.js';
import { readV3HandoffCardInput } from '../src/im/lark/v3-bot-handoff-executor.js';
import { createV3NodeCardSync } from '../src/im/lark/v3-node-card-sync.js';
import { safeExternalAttemptDir } from '../src/workflows/v3/external-control.js';
import { V3_DEFAULT_HANDOFF_ACCEPT_TIMEOUT_MS, V3_MAIN_TOPIC_QUEUE_GRACE_MIN_MS } from '../src/workflows/v3/external-executor.js';
import { foldV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import type { StoredEvent } from '../src/workflows/v3/event-contract.js';

/** The backstop of a queued main-topic handoff: timeout + max(timeout, 1 h). */
const BACKSTOP_MS = TIMEOUT_SEC * 1000 + Math.max(TIMEOUT_SEC * 1000, V3_MAIN_TOPIC_QUEUE_GRACE_MIN_MS);

afterEach(() => cleanupBotRuns());

const ROOT = 'om_main_topic';
const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: ROOT, sessionId: 'main-session' };
const MAIN_DAG = (runId: string, extra: Record<string, unknown> = {}) => reportDag(runId, { placement: 'main', ...extra });

function text(card: string): string {
  return JSON.stringify(JSON.parse(card));
}

describe('handoff in the main topic', () => {
  it('replies the handoff card into the main topic (no node card), mentioning the target, with a status line', async () => {
    const run = new BotRun(MAIN_DAG('m-content'));
    const world = handoffWorld({ mainTopicThreadId: () => 'omt_main' });
    expectAwaitingExternal(await run.drive(world.executor, { opts: { chatBinding: BINDING } }));

    expect(world.lark.sent).toEqual([]);
    expect(world.lark.replies).toHaveLength(1);
    const [handoff] = world.lark.replies;
    const attempt = run.openAttempt('write');
    expect(attempt.placement).toBe('main');
    expect(attempt.idempotency).toEqual({ handoff: expect.any(String) });
    expect(handoff).toMatchObject({ root: ROOT, uuid: attempt.idempotency!.handoff });
    expect(text(handoff!.card)).toContain('<at id=ou_bot_a>');
    expect(text(handoff!.card)).toContain('状态：交接中');
    expect(text(handoff!.card)).toContain('这一轮开始后');
    expect(attempt).toMatchObject({ phase: 'sent', handoffMessageId: handoff!.id, threadId: 'omt_main' });
    expect(attempt.nodeCardMessageId).toBeUndefined();

    // P3: bound by the handoff id; the publish root is the main topic.
    const found = lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(world.dataDir), dispatchRoot: handoff!.id, secret: SECRET });
    expect(found).toMatchObject({ kind: 'workflow', binding: { publishRoot: ROOT, placement: 'main', targetLarkAppId: 'cli_a' } });
    // The receiver recognizes it in the main topic, and only there.
    const inbound = (threadRootId: string) => resolveInboundWorkflowHandoff({
      readRegistry: () => readDispatchRegistryLoose(world.dataDir), secret: () => SECRET,
      messageId: handoff!.id, content: handoff!.card, chatId: CHAT, threadRootId, selfLarkAppId: 'cli_a',
      proveSender: async () => true,
    });
    expect(await inbound(ROOT)).toMatchObject({ binding: { placement: 'main' } });
    expect(await inbound('om_elsewhere')).toBeUndefined();

    // The card input is kept so the status line can be patched later.
    expect(readV3HandoffCardInput(safeExternalAttemptDir(run.runDir, attempt.attemptId)))
      .toMatchObject({ handoffRef: handoff!.id, nonce: nonceOf(attempt), mainTopic: true });
  });

  it('a target daemon that does not advertise main-topic handling gets nothing; the node blocks', async () => {
    const run = new BotRun(MAIN_DAG('m-old-daemon'));
    const world = handoffWorld({ daemonHandlesMainPlacement: () => false });
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'COLLABORATION_DENIED' })]);
    expect(run.of('nodeBlocked')[0]!.message).toContain('不支持在主话题里交接');
    expect(world.lark.replies).toEqual([]);
    expect(readDispatchRegistryLoose(world.dataDir)).toEqual({});
  });

  it('the main bot\'s own main-topic node starts a turn in the main session (no node card)', async () => {
    const run = new BotRun(MAIN_DAG('m-self', { bot: MAIN }));
    const world = handoffWorld();
    expectAwaitingExternal(await run.drive(world.executor, { opts: { chatBinding: BINDING } }));
    expect(world.lark.sent).toEqual([]);
    expect(world.lark.replies).toHaveLength(1);
    expect(text(world.lark.replies[0]!.card)).not.toContain('<at');
    expect(world.selfTurns).toHaveLength(1);
    const turn = world.selfTurns[0]!;
    expect(turn).toMatchObject({ publishRoot: ROOT, handoffMessageId: world.lark.replies[0]!.id });
    expect(turn.marker).toMatchObject({ placement: 'main', publishRoot: ROOT, handoffMessageId: world.lark.replies[0]!.id });
  });
});

describe('acceptance and the node deadline in the main topic', () => {
  async function sent(runId: string) {
    const run = new BotRun(MAIN_DAG(runId));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const { route } = orchestratorEvent(world, run.base, run.dag, () => run.clock.t);
    const key = { nonce: nonceOf(attempt), dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' };
    return { run, world, attempt, route, key };
  }

  it('entering a busy session\'s queue is the acceptance; the deadline counts from the turn\'s real start', async () => {
    const { run, world, attempt, route, key } = await sent('m-queue');
    const queuedAt = run.clock.t;
    expect(await route({ ...key, kind: 'accepted', acceptedAt: queuedAt })).toMatchObject({ status: 200 });
    expect(run.of('nodeHandoffAccepted')).toEqual([expect.objectContaining({ startPending: true, deadlineAt: queuedAt + BACKSTOP_MS })]);

    // Well past the acceptance window: queued, so no HANDOFF_NOT_ACCEPTED.
    run.clock.t += V3_DEFAULT_HANDOFF_ACCEPT_TIMEOUT_MS * 10;
    expectAwaitingExternal(await run.drive(world.executor, { opts: { chatBinding: BINDING } }));

    // The turn ahead of it ends after 5 minutes; the handoff's own turn starts.
    run.clock.t = queuedAt + 300_000;
    const startedAt = run.clock.t;
    expect(await route({ ...key, kind: 'accepted', startedAt })).toMatchObject({ status: 200 });
    expect(run.of('nodeHandoffStarted')).toEqual([expect.objectContaining({ startedAt, deadlineAt: startedAt + TIMEOUT_SEC * 1000 })]);
    // A repeated start notice changes nothing.
    expect(await route({ ...key, kind: 'accepted', startedAt: startedAt + 5 })).toMatchObject({ status: 200 });
    expect(run.of('nodeHandoffStarted')).toHaveLength(1);

    // Past what the timeout would be from the queue entry: still running.
    run.clock.t = queuedAt + TIMEOUT_SEC * 1000 + 1;
    expectAwaitingExternal(await run.drive(world.executor, { opts: { chatBinding: BINDING } }));
    expect(run.of('nodeBlocked')).toEqual([]);
    // Past the deadline from the real start: timed out.
    run.clock.t = startedAt + TIMEOUT_SEC * 1000;
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ attemptId: attempt.attemptId, errorCode: 'NODE_TIMEOUT' })]);
  });

  it('a queued turn behind a long one survives the node timeout; one that never starts times out at the backstop, saying so', async () => {
    const { run, world, route, key } = await sent('m-queue-backstop');
    const queuedAt = run.clock.t;
    await route({ ...key, kind: 'accepted', acceptedAt: queuedAt });
    // The turn ahead of it runs longer than the node's whole timeout.
    run.clock.t = queuedAt + TIMEOUT_SEC * 1000 + 1;
    expectAwaitingExternal(await run.drive(world.executor, { opts: { chatBinding: BINDING } }));
    expect(run.of('nodeBlocked')).toEqual([]);
    run.clock.t = queuedAt + BACKSTOP_MS;
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('blocked');
    const [blocked] = run.of('nodeBlocked');
    expect(blocked).toMatchObject({ errorCode: 'NODE_TIMEOUT' });
    expect(blocked!.message).toContain('没收到这一轮开始的信号');
    expect(blocked!.message).toContain('一直在执行 Bot 的主话题会话里排队');
    expect(blocked!.message).toContain('节点话题');
  });

  it('the ledger takes one start per attempt, and only after a queued acceptance (journal written out of order)', async () => {
    const { run, attempt, route, key } = await sent('m-ledger-start');
    await route({ ...key, kind: 'accepted', acceptedAt: run.clock.t });
    const events = run.events();
    const seq = events.length;
    const ident = { nodeId: 'write', ...(attempt.instanceId ? { instanceId: attempt.instanceId } : {}), attemptId: attempt.attemptId };
    const started = (n: number, at: number) =>
      ({ type: 'nodeHandoffStarted', ...ident, startedAt: at, deadlineAt: at + 1, ts: at, seq: seq + n } as unknown as StoredEvent);
    const fold = (extra: StoredEvent[]) => foldV3ExternalAttempts([...events, ...extra]).get(attempt.attemptId)!;
    const once = fold([started(1, 5_000)]);
    expect(once).toMatchObject({ startedAt: 5_000, deadlineAt: 5_001 });
    expect(once.startPending).toBeUndefined();
    // A second start (a duplicate or a stray write) moves nothing.
    expect(fold([started(1, 5_000), started(2, 9_000)])).toMatchObject({ startedAt: 5_000, deadlineAt: 5_001 });
    // A start before any acceptance is ignored.
    const beforeAccept = foldV3ExternalAttempts([...events.filter((event) => event.type !== 'nodeHandoffAccepted'), started(1, 5_000)])
      .get(attempt.attemptId)!;
    expect(beforeAccept.startedAt).toBeUndefined();
  });

  it('a start seen before any acceptance is one acceptance counting from the start', async () => {
    const { run, route, key } = await sent('m-start-first');
    run.clock.t += 1_000;
    const startedAt = run.clock.t;
    await route({ ...key, kind: 'accepted', startedAt });
    expect(run.of('nodeHandoffAccepted')).toEqual([expect.objectContaining({ deadlineAt: startedAt + TIMEOUT_SEC * 1000 })]);
    expect(run.of('nodeHandoffAccepted')[0]).not.toHaveProperty('startPending');
    expect(run.of('nodeHandoffStarted')).toEqual([]);
  });

  it('a node topic ignores start notices: its journal keeps the shape it always had', async () => {
    const run = new BotRun(reportDag('t-start-ignored'));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    expect(attempt.placement).toBe('topic');
    expect(attempt.idempotency).toEqual({ nodeCard: expect.any(String), handoff: expect.any(String) });
    const { route } = orchestratorEvent(world, run.base, run.dag, () => run.clock.t);
    const key = { nonce: nonceOf(attempt), dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' };
    const acceptedAt = run.clock.t;
    await route({ ...key, kind: 'accepted', acceptedAt });
    run.clock.t += 60_000;
    await route({ ...key, kind: 'accepted', startedAt: run.clock.t });
    const accepted = run.of('nodeHandoffAccepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).not.toHaveProperty('startPending');
    expect(accepted[0]!.deadlineAt).toBe(acceptedAt + TIMEOUT_SEC * 1000);
    expect(run.of('nodeHandoffStarted')).toEqual([]);
  });
});

describe('reports in the main topic', () => {
  it('the target\'s main-topic session submits by the handoff id; a blocked report closes its attempt there', async () => {
    const run = new BotRun(MAIN_DAG('m-report'));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    run.accept(attempt.attemptId, 'sess-a');
    const { route } = orchestratorEvent(world, run.base, run.dag, () => run.clock.t);
    const closed: string[] = [];
    const { report } = targetReport(world, 'cli_a', route, { markClosed: (sessionId) => { closed.push(sessionId); } });
    const marker = (state: { started?: boolean; active?: boolean; nonce?: string }) => ({
      handoffMessageId: attempt.handoffMessageId!, nonce: state.nonce ?? nonceOf(attempt), placement: 'main' as const,
      started: state.started ?? true, active: state.active ?? true,
    });
    const as = (workflowNode: ReturnType<typeof marker> | undefined, rootMessageId = ROOT) =>
      ({ sessionId: 'sess-a', rootMessageId, ...(workflowNode ? { workflowNode } : {}) });
    // A session of the node in some other topic is refused.
    expect(await report({ dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'x' }, as(marker({}), 'om_other')))
      .toMatchObject({ status: 403 });
    // ADV-4: in the shared main-topic session, only while the node's own turn
    // has started and its attempt is in progress — never from a turn that ran
    // before it (queued), after it ended, or from a session that does not hold it.
    const files = { dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'done',
      files: [{ key: 'report', name: 'r.md', data: Buffer.from('# r').toString('base64') }], resultText: '{"message":"ok"}' };
    expect(await report(files, as(marker({ started: false })))).toMatchObject({ status: 409, body: { error: 'handoff_not_started' } });
    expect(await report(files, as(marker({ active: false })))).toMatchObject({ status: 409, body: { error: 'handoff_not_active' } });
    expect(await report(files, as(undefined))).toMatchObject({ status: 409, body: { error: 'handoff_not_active' } });
    expect(await report(files, as(marker({ nonce: 'wfh_other_handoff_nonce_00' })))).toMatchObject({ status: 409, body: { error: 'handoff_not_active' } });
    expect(run.of('nodeSucceeded')).toEqual([]);
    expect(await report({ dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: '缺权限' }, as(marker({}))))
      .toMatchObject({ status: 200, body: { outcome: 'blocked' } });
    expect(closed).toEqual(['sess-a']);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'BOT_REPORTED_BLOCKED' })]);
  });
});

describe('the handoff card stands in for the node card (P2)', () => {
  it('its status line follows the journal: queued → running → done, patched only on change', async () => {
    const run = new BotRun(MAIN_DAG('m-card'));
    const world = handoffWorld();
    await run.drive(world.executor, { opts: { chatBinding: BINDING } });
    const attempt = run.openAttempt('write');
    const patches: Array<{ id: string; card: string }> = [];
    const sync = createV3NodeCardSync({
      baseDir: run.base,
      selfLarkAppId: MAIN,
      loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', title: 'report' }),
      patchCard: async (id, card) => { patches.push({ id, card }); },
      botName: (appId) => `bot(${appId})`,
      handoffCardInput: (runDir, attemptId) => readV3HandoffCardInput(safeExternalAttemptDir(runDir, attemptId)),
      now: () => run.clock.t,
    });
    const { route } = orchestratorEvent(world, run.base, run.dag, () => run.clock.t);
    const key = { nonce: nonceOf(attempt), dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' };

    await sync('m-card');
    expect(patches.map((patch) => patch.id)).toEqual([attempt.handoffMessageId]);
    expect(text(patches[0]!.card)).toContain('状态：交接中');
    await route({ ...key, kind: 'accepted', acceptedAt: run.clock.t });
    await sync('m-card');
    expect(text(patches.at(-1)!.card)).toContain('排队中');
    await sync('m-card');
    expect(patches).toHaveLength(2);
    run.clock.t += 30_000;
    await route({ ...key, kind: 'accepted', startedAt: run.clock.t });
    await sync('m-card');
    expect(text(patches.at(-1)!.card)).toMatch(/状态：进行中 · \d\d-\d\d \d\d:\d\d 开始/);
    expect(await run.submit(attempt.attemptId, { ...reportFiles(), sessionId: 'sess-a' })).toMatchObject({ ok: true });
    await sync('m-card');
    const done = text(patches.at(-1)!.card);
    expect(done).toContain('状态：已完成');
    // Still the full handoff: the card keeps its report commands and mention.
    expect(done).toContain(`--dispatch-root ${attempt.handoffMessageId}`);
    expect(done).toContain('<at id=ou_bot_a>');
    expect(patches.every((patch) => patch.id === attempt.handoffMessageId)).toBe(true);
  });
});
