/**
 * The Feishu handoff transport for bot-executed workflow nodes (design
 * 2026-11-03 §5.3, §5.4, §6.3, §6.5, §9) driven by the REAL runtime: node card
 * as a new topic without a mention, handoff card in that topic mentioning the
 * target, frozen idempotency uuids on every send, pre-send rejections that
 * send nothing, a signed binding keyed by the handoff id, the main bot's own
 * nodes started in-process, and retries handed off in the node's topic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BotRun,
  FakeExecutor,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
} from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf, orchestratorEvent } from './helpers/workflow-handoff-harness.js';
import {
  lookupWorkflowHandoff,
  lookupWorkflowHandoffByNonce,
  readDispatchRegistryLoose,
  resolveInboundWorkflowHandoff,
  revokeWorkflowHandoff,
} from '../src/core/workflow-handoff-binding.js';
import { V3_HANDOFF_CARD_MAX_BYTES } from '../src/im/lark/v3-node-card.js';
import { readWorkflowAttemptInputs } from '../src/core/workflow-node-session.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { V3_HANDOFF_IDEMPOTENCY_WINDOW_MS } from '../src/workflows/v3/external-executor.js';
import { requestV3RunCancel } from '../src/workflows/v3/daemon-run.js';
import { requestV3Retry } from '../src/workflows/v3/daemon-run.js';
import { reportExternalBlocked } from '../src/workflows/v3/external-control.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { foldV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import type { V3ExternalDispatchRequest } from '../src/workflows/v3/external-executor.js';

afterEach(() => cleanupBotRuns());

const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: 'om_main_topic' };
const drive = (run: BotRun, world: ReturnType<typeof handoffWorld>) =>
  run.drive(world.executor, { opts: { chatBinding: BINDING } });

function cardText(card: string): string {
  return JSON.stringify(JSON.parse(card));
}

describe('handoff to another bot (topic placement)', () => {
  it('posts the node card (no mention) then the handoff card into its topic, mentioning the target', async () => {
    const run = new BotRun(reportDag('h-content', { goal: 'write risk-report.md from the upstream notes' }));
    const world = handoffWorld();
    expectAwaitingExternal(await drive(run, world));

    const attempt = run.openAttempt('write');
    expect(world.lark.sent).toHaveLength(1);
    const [nodeCard] = world.lark.sent;
    expect(nodeCard).toMatchObject({ chatId: CHAT, uuid: attempt.idempotency!.nodeCard });
    expect(cardText(nodeCard!.card)).not.toContain('<at');

    expect(world.lark.replies).toHaveLength(1);
    const [handoff] = world.lark.replies;
    expect(handoff).toMatchObject({ root: nodeCard!.id, uuid: attempt.idempotency!.handoff });
    const text = cardText(handoff!.card);
    expect(text).toContain('<at id=ou_bot_a>');
    expect(text).toContain('write risk-report.md from the upstream notes');
    expect(text).toContain('report.md'); // declared output path
    expect(text).toContain('message'); // resultSchema field
    // The posted card is patched to name its own id in the report commands.
    const patched = world.lark.patches.find((patch) => patch.id === handoff!.id);
    expect(cardText(patched!.card)).toContain(`--dispatch-root ${handoff!.id}`);

    // The run journal records exactly these messages.
    expect(attempt).toMatchObject({ phase: 'sent', handoffMessageId: handoff!.id, nodeCardMessageId: nodeCard!.id });
    // §6.1 item 4 was ensured for this pair before anything was sent.
    expect(world.grants).toEqual([{ chatId: CHAT, target: 'cli_a' }]);
  });

  it('registers a host-signed binding before the send and links the handoff id after it', async () => {
    const run = new BotRun(reportDag('h-binding'));
    const world = handoffWorld();
    let atReply: ReturnType<typeof lookupWorkflowHandoffByNonce> | undefined;
    world.lark.onReply = () => {
      atReply = lookupWorkflowHandoffByNonce({ registry: readDispatchRegistryLoose(world.dataDir), nonce: nonceOf(run.openAttempt('write')), secret: SECRET });
    };
    await drive(run, world);
    const attempt = run.openAttempt('write');
    // The card carries the nonce the binding was registered under.
    expect(cardText(world.lark.replies[0]!.card)).toContain(nonceOf(attempt));
    expect(atReply).toMatchObject({ kind: 'workflow', revoked: false });
    expect(atReply).not.toHaveProperty('messageId');
    const registry = readDispatchRegistryLoose(world.dataDir);
    const found = lookupWorkflowHandoff({ registry, dispatchRoot: attempt.handoffMessageId!, secret: SECRET });
    expect(found).toMatchObject({
      kind: 'workflow',
      binding: {
        publishRoot: attempt.nodeCardMessageId,
        targetLarkAppId: 'cli_a',
        targetChatId: CHAT,
        sourceLarkAppId: MAIN,
        workflow: { runId: 'h-binding', nodeId: 'write', attemptId: attempt.attemptId, revision: 1 },
      },
    });
  });

  it('a re-send after an unknown failure reuses the frozen uuids: one node card, one handoff', async () => {
    const run = new BotRun(reportDag('h-idempotent'));
    const world = handoffWorld();
    world.lark.failNextReply = true; // the handoff send dies after the node card went out
    expectAwaitingExternal(await drive(run, world));
    expect(run.openAttempt('write').phase).toBe('prepared');

    run.clock.t += 60_000; // past the re-send backoff, well inside the window
    await drive(run, world);
    expect(world.lark.sent).toHaveLength(1);
    expect(world.lark.replies).toHaveLength(1);
    const attempt = run.openAttempt('write');
    expect(attempt).toMatchObject({ phase: 'sent', handoffMessageId: world.lark.replies[0]!.id });
    expect(lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(world.dataDir), dispatchRoot: attempt.handoffMessageId!, secret: SECRET }))
      .toMatchObject({ kind: 'workflow', messageId: attempt.handoffMessageId });
  });

  it.each([
    ['offline target daemon', (world: ReturnType<typeof handoffWorld>) => { world.online.delete('cli_a'); }, 'BOT_OFFLINE'],
    ['target not in the chat', (world: ReturnType<typeof handoffWorld>) => { world.members.delete('cli_a'); }, 'BOT_NOT_IN_CHAT'],
    ['chat grant refused', (world: ReturnType<typeof handoffWorld>) => { world.grantError = 'receiver daemon offline'; }, 'COLLABORATION_DENIED'],
  ])('%s blocks the node with %s and sends nothing', async (_label, arrange, code) => {
    const run = new BotRun(reportDag(`h-reject-${code.toLowerCase()}`));
    const world = handoffWorld();
    arrange(world);
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: code })]);
    expect(world.lark.sent).toEqual([]);
    expect(world.lark.replies).toEqual([]);
    expect(readDispatchRegistryLoose(world.dataDir)).toEqual({});
  });

  it('an undeterminable membership is an unknown outcome, not a block', async () => {
    const run = new BotRun(reportDag('h-membership-unknown'));
    const world = handoffWorld();
    world.members.set('cli_a', { ok: false, code: 'UNKNOWN', message: 'api timeout' });
    expectAwaitingExternal(await drive(run, world));
    expect(run.openAttempt('write').phase).toBe('prepared');
    expect(run.of('nodeBlocked')).toEqual([]);
    expect(world.lark.sent).toEqual([]);
  });

  it('acceptance is probed through the signed registry (also after a restart) and starts the timeout', async () => {
    const run = new BotRun(reportDag('h-probe'));
    const world = handoffWorld();
    await drive(run, world);
    const attempt = run.openAttempt('write');
    world.acceptance.set(attempt.handoffMessageId!, { sessionId: 'sess-a', acceptedAt: run.clock.t });
    const restarted = handoffWorld({ dataDir: world.dataDir, findAcceptance: (input) => world.acceptance.get(input.handoffMessageId) });
    run.clock.t = attempt.acceptDeadlineAt!; // the acceptance deadline probe
    await drive(run, restarted);
    expect(run.openAttempt('write')).toMatchObject({ phase: 'accepted', sessionId: 'sess-a' });
  });

  it('stop requests carry the handoff and the accepting session', async () => {
    const run = new BotRun(reportDag('h-stop'));
    const world = handoffWorld();
    await drive(run, world);
    const attempt = run.openAttempt('write');
    run.accept(attempt.attemptId, 'sess-a');
    run.clock.t = run.openAttempt('write').deadlineAt!;
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(world.stops).toEqual([{ targetLarkAppId: 'cli_a', nonce: nonceOf(attempt), handoffMessageId: attempt.handoffMessageId, sessionId: 'sess-a', reason: 'timeout' }]);
  });

  it('a retry hands off again inside the node\'s existing topic', async () => {
    const run = new BotRun(reportDag('h-retry-topic'));
    const world = handoffWorld();
    await drive(run, world);
    const first = run.openAttempt('write');
    expect(reportExternalBlocked(run.runDir, { attemptId: first.attemptId, reason: 'need data' })).toEqual({ ok: true });
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await drive(run, world);
    const second = run.openAttempt('write');
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(world.lark.sent).toHaveLength(1);
    expect(world.lark.replies.map((reply) => reply.root)).toEqual([first.nodeCardMessageId, first.nodeCardMessageId]);
    expect(second.nodeCardMessageId).toBe(first.nodeCardMessageId);
  });
});

describe('the main bot executes its own node (§6.5)', () => {
  it('posts both cards without a mention and starts the turn in-process with the real handoff id', async () => {
    const run = new BotRun(validateDag({
      schemaVersion: 2,
      runId: 'h-self',
      nodes: [{ id: 'sum', type: 'goal', goal: 'summarize the thread', timeoutSec: 600 }],
    }));
    const world = handoffWorld();
    expectAwaitingExternal(await drive(run, world));
    const attempt = run.openAttempt('sum');
    expect(attempt.targetLarkAppId).toBe(MAIN);
    expect(world.lark.replies.every((reply) => !cardText(reply.card).includes('<at'))).toBe(true);
    expect(world.grants).toEqual([]);
    expect(world.selfTurns).toHaveLength(1);
    const turn = world.selfTurns[0]!;
    expect(turn).toMatchObject({
      chatId: CHAT,
      publishRoot: attempt.nodeCardMessageId,
      handoffMessageId: attempt.handoffMessageId,
      marker: {
        runId: 'h-self', nodeId: 'sum', attemptId: attempt.attemptId,
        handoffMessageId: attempt.handoffMessageId, publishRoot: attempt.nodeCardMessageId, orchestratorAppId: MAIN,
      },
    });
    expect(turn.prompt).toContain('summarize the thread');
    expect(turn.prompt).toContain(`--dispatch-root ${attempt.handoffMessageId}`);
    expect(lookupWorkflowHandoff({ registry: readDispatchRegistryLoose(world.dataDir), dispatchRoot: attempt.handoffMessageId!, secret: SECRET }))
      .toMatchObject({ kind: 'workflow', binding: { targetLarkAppId: MAIN } });
  });

  it('acceptance reported by the in-process session settles through the event route', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'h-self-accept', nodes: [{ id: 'sum', type: 'goal', goal: 'g', timeoutSec: 600 }] });
    const run = new BotRun(dag);
    const world = handoffWorld();
    await drive(run, world);
    const attempt = run.openAttempt('sum');
    const { route, drives } = orchestratorEvent(world, run.base, dag, () => run.clock.t);
    expect(await route({ kind: 'accepted', dispatchRoot: attempt.handoffMessageId, sessionId: 'self-session', acceptedAt: run.clock.t }))
      .toMatchObject({ status: 200 });
    expect(drives).toEqual(['h-self-accept']);
    expect(run.openAttempt('sum')).toMatchObject({ phase: 'accepted', sessionId: 'self-session' });
  });
});

describe('review regressions (PR 5a adversarial review)', () => {
  /** What the target daemon decides for the delivered handoff card. */
  const receiverView = (world: ReturnType<typeof handoffWorld>, run: BotRun, overrides: Record<string, unknown> = {}) => {
    const reply = world.lark.replies.at(-1)!;
    const attempt = [...readJournalAttempts(run)].at(-1)!;
    return resolveInboundWorkflowHandoff({
      readRegistry: () => readDispatchRegistryLoose(world.dataDir),
      secret: () => SECRET,
      messageId: reply.id,
      content: cardText(reply.card),
      chatId: CHAT,
      threadRootId: reply.root,
      selfLarkAppId: attempt.targetLarkAppId!,
      proveSender: (source) => source === MAIN,
      ...overrides,
    });
  };

  it('P2-1a: after a run cancel the delivered handoff is revoked — the receiver drops it', async () => {
    const run = new BotRun(reportDag('rv-p21a'));
    const world = handoffWorld();
    await drive(run, world);
    expect(await receiverView(world, run)).toMatchObject({ kind: 'handoff' });
    requestV3RunCancel(run.base, run.dag.runId, { by: 'ou_owner' });
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('cancelled');
    expect(world.stops).toEqual([expect.objectContaining({ reason: 'runCancelled' })]);
    expect(await receiverView(world, run)).toMatchObject({ kind: 'revoked' });
  });

  it('P2-1b: HANDOFF_NOT_ACCEPTED revokes the handoff', async () => {
    const run = new BotRun(reportDag('rv-p21b'));
    const world = handoffWorld();
    await drive(run, world);
    run.clock.t = run.openAttempt('write').acceptDeadlineAt!;
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'HANDOFF_NOT_ACCEPTED' })]);
    expect(await receiverView(world, run)).toMatchObject({ kind: 'revoked' });
  });

  it('P2-1c: a cancel landing during the self handoff send never starts the turn', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'rv-p21c', nodes: [{ id: 'sum', type: 'goal', goal: 'g', timeoutSec: 600 }] });
    const run = new BotRun(dag);
    const world = handoffWorld();
    world.lark.onReply = () => {
      world.lark.onReply = undefined;
      requestV3RunCancel(run.base, run.dag.runId, { by: 'ou_owner' });
    };
    await drive(run, world);
    for (let i = 0; i < 3 && run.snap().runStatus !== 'cancelled'; i++) await drive(run, world);
    expect(run.snap().runStatus).toBe('cancelled');
    expect(world.calls).not.toContain('startSelfTurn');
    expect(world.selfTurns).toEqual([]);
  });

  it('P2-1c: a journal already cancelled before the self turn starts is honoured even without an abort signal', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'rv-p21c-journal', nodes: [{ id: 'sum', type: 'goal', goal: 'g', timeoutSec: 600 }] });
    const run = new BotRun(dag);
    const world = handoffWorld();
    world.lark.onReply = () => {
      world.lark.onReply = undefined;
      appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'c-1', by: 'ou_owner' });
    };
    await world.executor.dispatch({
      ...(await firstDispatchRequest(run, dag)),
      signal: new AbortController().signal,
    });
    expect(world.selfTurns).toEqual([]);
  });

  it('P2-3: a target that folds node-topic replies into its group session is refused before anything is sent', async () => {
    const run = new BotRun(reportDag('rv-p23'));
    const world = handoffWorld();
    world.foldsTopics.add('cli_a');
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'COLLABORATION_DENIED' })]);
    expect(world.lark.sent).toEqual([]);
  });

  it('P3-7: a node whose handoff never got through keeps one topic; the retry reuses and updates its card', async () => {
    const run = new BotRun(reportDag('rv-p37'));
    const world = handoffWorld();
    world.lark.failReplies = 1_000;
    await drive(run, world);
    run.clock.t = run.openAttempt('write').preparedAt! + V3_HANDOFF_IDEMPOTENCY_WINDOW_MS;
    expect(expectTerminal(await drive(run, world)).runStatus).toBe('blocked');
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'HANDOFF_UNCERTAIN' })]);
    world.lark.failReplies = 0;
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await drive(run, world);
    expect(world.lark.sent).toHaveLength(1);
    expect(world.lark.replies.map((reply) => reply.root)).toEqual([world.lark.sent[0]!.id]);
    expect(world.lark.patches.some((patch) => patch.id === world.lark.sent[0]!.id)).toBe(true);
  });

  it('P3-9b: a long Chinese goal keeps the card within the byte budget and travels in full as an attachment', async () => {
    const goal = '请审阅全部改动并写出风险报告，'.repeat(2_000);
    const run = new BotRun(reportDag('rv-p39b', { goal }));
    const world = handoffWorld();
    await drive(run, world);
    const attempt = run.openAttempt('write');
    for (const reply of world.lark.replies) expect(Buffer.byteLength(reply.card)).toBeLessThanOrEqual(V3_HANDOFF_CARD_MAX_BYTES);
    for (const patch of world.lark.patches) expect(Buffer.byteLength(patch.card)).toBeLessThanOrEqual(V3_HANDOFF_CARD_MAX_BYTES);
    const inputs = readWorkflowAttemptInputs(run.runDir, attempt.attemptId)!;
    const task = inputs.inputs.find((input) => input.from === 'handoff')!;
    expect(task).toBeDefined();
    expect(readFileSync(task.path, 'utf-8')).toContain(goal);
  });
});

function readJournalAttempts(run: BotRun) {
  return foldV3ExternalAttempts(run.events()).values();
}

/** The dispatch request the runtime would build for the first attempt. */
async function firstDispatchRequest(run: BotRun, dag: ReturnType<typeof validateDag>) {
  const captured: V3ExternalDispatchRequest[] = [];
  const probe = new FakeExecutor();
  probe.onDispatch = (req) => { captured.push(req); throw new Error('capture only'); };
  await run.drive(probe, { opts: { chatBinding: BINDING } });
  const req = captured[0]!;
  expect(req.node.id).toBe(dag.nodes[0]!.id);
  return req;
}

describe('second review pass', () => {
  it('M7: a stop landing while the node card is sent keeps the handoff from being sent at all', async () => {
    const run = new BotRun(reportDag('rv2-m7'));
    const world = handoffWorld();
    world.lark.onSend = async () => {
      world.lark.onSend = undefined;
      await revokeWorkflowHandoff(world.dataDir, SECRET, nonceOf(run.openAttempt('write')), 'runCancelled');
    };
    await drive(run, world);
    expect(world.lark.sent).toHaveLength(1);
    expect(world.lark.replies).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'COLLABORATION_DENIED' })]);
  });

  it('M8: a revocation landing during the self handoff send stops the turn even with a live journal and signal', async () => {
    const dag = validateDag({ schemaVersion: 2, runId: 'rv2-m8', nodes: [{ id: 'sum', type: 'goal', goal: 'g', timeoutSec: 600 }] });
    const run = new BotRun(dag);
    const world = handoffWorld();
    world.lark.onReply = async () => {
      world.lark.onReply = undefined;
      await revokeWorkflowHandoff(world.dataDir, SECRET, nonceOf(run.openAttempt('sum')), 'reassigned');
    };
    await drive(run, world);
    expect(world.lark.replies).toHaveLength(1);
    expect(world.selfTurns).toEqual([]);
  });
});
