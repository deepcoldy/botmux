/**
 * Node cards of bot-executed runs follow the journal (design 2026-11-03 §5.3):
 * handing off → running → stopped-without-submitting → done / blocked (with
 * reason) / timed out / cancelled — patched in place only when what the card
 * shows changes; non-bot runs never get a node card.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { BotRun, cleanupBotRuns, expectTerminal, reportDag, reportFiles } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, handoffWorld } from './helpers/workflow-handoff-harness.js';
import { checkpointLine, createV3NodeCardSync, v3NodeCardStatusFor } from '../src/im/lark/v3-node-card-sync.js';
import { buildV3NodeCard, v3NodeStalled } from '../src/im/lark/v3-node-card.js';
import { foldV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import { recordExternalStalled, reportExternalBlocked } from '../src/workflows/v3/external-control.js';
import { requestV3RunCancel } from '../src/workflows/v3/daemon-run.js';

afterEach(() => cleanupBotRuns());

const BINDING = { larkAppId: MAIN, chatId: CHAT, chatType: 'group' as const, rootMessageId: 'om_main' };

async function started(runId: string) {
  const run = new BotRun(reportDag(runId));
  const world = handoffWorld();
  await run.drive(world.executor, { opts: { chatBinding: BINDING } });
  const patches: Array<{ id: string; card: string }> = [];
  const sync = createV3NodeCardSync({
    baseDir: run.base,
    selfLarkAppId: MAIN,
    loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', title: 'report' }),
    patchCard: async (id, card) => { patches.push({ id, card }); },
    botName: (appId) => `bot(${appId})`,
    now: () => run.clock.t,
  });
  const status = () => {
    const events = run.events();
    const attempt = [...foldV3ExternalAttempts(events).values()].at(-1)!;
    const snap = run.snap();
    return v3NodeCardStatusFor(attempt, events, attempt.instanceId ? snap.instances.get(attempt.instanceId)?.status : undefined);
  };
  return { run, world, patches, sync, status };
}

describe('node card follows the journal', () => {
  it('handing off → running → stopped without submitting → done, one patch per change', async () => {
    const { run, patches, sync, status } = await started('card-happy');
    const attempt = run.openAttempt('write');
    await sync('card-happy');
    expect(status()).toEqual({ kind: 'handing_off' });
    expect(patches.map((patch) => patch.id)).toEqual([attempt.nodeCardMessageId]);

    await sync('card-happy');
    expect(patches).toHaveLength(1); // nothing changed, nothing patched

    run.accept(attempt.attemptId, 'sess-a');
    await sync('card-happy');
    expect(status()).toMatchObject({ kind: 'running', acceptedAt: run.clock.t });
    expect(patches).toHaveLength(2);

    run.clock.t += 60_000;
    recordExternalStalled(run.runDir, { attemptId: attempt.attemptId, sessionId: 'sess-a' }, run.ctx());
    await sync('card-happy');
    expect(status()).toMatchObject({ kind: 'running', stalledAt: run.clock.t });
    expect(patches).toHaveLength(3);

    run.clock.t += 60_000;
    expect(await run.submit(attempt.attemptId, { ...reportFiles(), sessionId: 'sess-a' })).toMatchObject({ ok: true });
    await sync('card-happy');
    expect(status()).toMatchObject({ kind: 'done' });
    expect(patches).toHaveLength(4);
    expect(new Set(patches.map((patch) => patch.card)).size).toBe(4);
  });

  it('P3-8: a later turn clears "stopped without submitting"; the card shows a start time, not a stale elapsed', async () => {
    const { run, patches, sync } = await started('card-active');
    const attempt = run.openAttempt('write');
    run.accept(attempt.attemptId, 'sess-a');
    run.clock.t += 60_000;
    recordExternalStalled(run.runDir, { attemptId: attempt.attemptId, sessionId: 'sess-a' }, run.ctx());
    const stalledAt = run.clock.t;
    const syncWith = (activeAt?: number) => createV3NodeCardSync({
      baseDir: run.base,
      selfLarkAppId: MAIN,
      loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', title: 'report' }),
      patchCard: async (id, card) => { patches.push({ id, card }); },
      botName: (appId) => appId,
      activity: () => (activeAt !== undefined ? { activeAt } : {}),
      now: () => run.clock.t,
    });
    const stalledStatus = v3NodeCardStatusFor(run.openAttempt('write'), run.events(), 'running');
    expect(v3NodeStalled(stalledStatus as any)).toBe(true);
    const resumed = v3NodeCardStatusFor(run.openAttempt('write'), run.events(), 'running', undefined, stalledAt + 1);
    expect(v3NodeStalled(resumed as any)).toBe(false);

    // A card synced long after acceptance shows the same text as one synced
    // right away: no elapsed figure goes stale between state changes.
    const early = syncWith(stalledAt + 1);
    await early('card-active');
    const cardEarly = patches.at(-1)!.card;
    run.clock.t += 6 * 3600_000;
    const late = syncWith(stalledAt + 1);
    await late('card-active');
    expect(patches.at(-1)!.card).toBe(cardEarly);
    void sync;
  });

  it('P3-10: overlapping syncs patch in journal order — the last patch shows the latest state', async () => {
    const { run } = await started('card-overlap');
    const attempt = run.openAttempt('write');
    run.accept(attempt.attemptId, 'sess-a');
    const patched: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const sync = createV3NodeCardSync({
      baseDir: run.base,
      selfLarkAppId: MAIN,
      loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot', title: 'report' }),
      patchCard: async (_id, card) => {
        if (!releaseFirst && patched.length === 0) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        patched.push(card);
      },
      botName: (appId) => appId,
      now: () => run.clock.t,
    });
    const first = sync('card-overlap'); // reads "running", its patch is slow
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await run.submit(attempt.attemptId, { ...reportFiles(), sessionId: 'sess-a' })).toMatchObject({ ok: true });
    const second = sync('card-overlap'); // must not overtake the first
    releaseFirst!();
    await Promise.all([first, second]);
    const finalCard = patched.at(-1)!;
    const doneCard = buildV3NodeCard({
      runTitle: 'report', runId: 'card-overlap', nodeId: 'write', nodeIndex: 1, nodeCount: 1, botName: 'cli_a',
      selfExecuted: false, attemptNumber: 1, status: v3NodeCardStatusFor([...foldV3ExternalAttempts(run.events()).values()].at(-1)!, run.events(), 'done'), upstream: [], now: run.clock.t,
    });
    expect(finalCard).toBe(doneCard);
  });

  it('a bot-reported block shows its reason; a timeout shows as such', async () => {
    const blocked = await started('card-blocked');
    const attempt = blocked.run.openAttempt('write');
    reportExternalBlocked(blocked.run.runDir, { attemptId: attempt.attemptId, reason: 'no repo access' });
    expect(blocked.status()).toEqual({ kind: 'blocked', errorCode: 'BOT_REPORTED_BLOCKED', message: 'no repo access' });

    const timedOut = await started('card-timeout');
    const t = timedOut.run.openAttempt('write');
    timedOut.run.accept(t.attemptId, 'sess-a');
    timedOut.run.clock.t = timedOut.run.openAttempt('write').deadlineAt!;
    expect(expectTerminal(await timedOut.run.drive(timedOut.world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('blocked');
    expect(timedOut.status()).toEqual({ kind: 'blocked', errorCode: 'NODE_TIMEOUT' });
  });

  it('cancellation closes the card as cancelled', async () => {
    const { run, world, status } = await started('card-cancel');
    run.accept(run.openAttempt('write').attemptId, 'sess-a');
    requestV3RunCancel(run.base, run.dag.runId, { by: 'ou_owner' });
    expect(expectTerminal(await run.drive(world.executor, { opts: { chatBinding: BINDING } })).runStatus).toBe('cancelled');
    expect(status()).toEqual({ kind: 'cancelled' });
    expect(world.stops).toEqual([expect.objectContaining({ reason: 'runCancelled', sessionId: 'sess-a' })]);
  });

  it('a run that is not bot-executed is never touched', async () => {
    const { run, patches } = await started('card-plain');
    const sync = createV3NodeCardSync({
      baseDir: run.base,
      selfLarkAppId: MAIN,
      loadRun: () => ({ dag: run.dag, title: 'plain' }),
      patchCard: async (id, card) => { patches.push({ id, card }); },
      botName: (appId) => appId,
    });
    await sync('card-plain');
    expect(patches).toEqual([]);
  });
});

describe('checkpoint line (M21): the four texts a completed checkpoint card can show', () => {
  // Mutation coverage for checkpointLine: every release reason has its own
  // wording — a delivery failure, a closed session and the timeout must not
  // be presented as "the main bot reviewed it".
  const success = (released?: { reason: 'wakeTurnEnded' | 'wakeNotDelivered' | 'wakeSessionEnded' | 'holdTimeout'; at: number }) => ({
    nodeId: 'survey',
    attemptId: 'survey/attempts/001',
    eventSeq: 7,
    at: 1000,
    ...(released ? { released } : {}),
  });

  it('no record: no line; still holding: the wait line', () => {
    expect(checkpointLine(undefined)).toBeUndefined();
    expect(checkpointLine(success())).toBe('检查点：等主 Bot 看完结果，后续节点暂停');
  });

  it('a turn that ended: the reviewed line (the only "happy" wording)', () => {
    expect(checkpointLine(success({ reason: 'wakeTurnEnded', at: 2000 })))
      .toBe('检查点：主 Bot 已看过结果，后续节点继续');
  });

  it('each fallback reason keeps its own, distinguishable text', () => {
    expect(checkpointLine(success({ reason: 'holdTimeout', at: 2000 })))
      .toBe('检查点：等主 Bot 看结果超时，已按原流程继续');
    expect(checkpointLine(success({ reason: 'wakeSessionEnded', at: 2000 })))
      .toBe('检查点：主 Bot 的会话中途结束，已按原流程继续');
    expect(checkpointLine(success({ reason: 'wakeNotDelivered', at: 2000 })))
      .toBe('检查点：没能唤醒主 Bot 看结果，已按原流程继续');
  });
});
