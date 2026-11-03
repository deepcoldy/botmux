/**
 * The Feishu handoff transport for bot-executed workflow nodes (design
 * 2026-11-03 §5.3, §5.4, §6.3, §6.5, §9) driven by the REAL runtime: node card
 * as a new topic without a mention, handoff card in that topic mentioning the
 * target, frozen idempotency uuids on every send, pre-send rejections that
 * send nothing, a signed binding keyed by the handoff id, the main bot's own
 * nodes started in-process, and retries handed off in the node's topic.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  BotRun,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
} from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, orchestratorEvent } from './helpers/workflow-handoff-harness.js';
import { lookupWorkflowHandoff, readDispatchRegistryLoose } from '../src/core/workflow-handoff-binding.js';
import { requestV3Retry } from '../src/workflows/v3/daemon-run.js';
import { reportExternalBlocked } from '../src/workflows/v3/external-control.js';
import { validateDag } from '../src/workflows/v3/dag.js';

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

  it('registers a host-signed binding keyed by the handoff id', async () => {
    const run = new BotRun(reportDag('h-binding'));
    const world = handoffWorld();
    await drive(run, world);
    const attempt = run.openAttempt('write');
    const registry = readDispatchRegistryLoose(world.dataDir);
    expect(Object.keys(registry)).toEqual([attempt.handoffMessageId]);
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
    expect(Object.keys(readDispatchRegistryLoose(world.dataDir))).toEqual([attempt.handoffMessageId]);
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
    expect(world.stops).toEqual([{ targetLarkAppId: 'cli_a', handoffMessageId: attempt.handoffMessageId, sessionId: 'sess-a', reason: 'timeout' }]);
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
    // No receiver event exists for a bot's own message: no pending marker.
    expect(Object.keys(readDispatchRegistryLoose(world.dataDir))).toEqual([attempt.handoffMessageId]);
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
