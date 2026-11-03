/**
 * Node cards of bot-executed runs follow the journal (design 2026-11-03 §5.3):
 * handing off → running → stopped-without-submitting → done / blocked (with
 * reason) / timed out / cancelled — patched in place only when what the card
 * shows changes; non-bot runs never get a node card.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { BotRun, cleanupBotRuns, expectTerminal, reportDag, reportFiles } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, handoffWorld } from './helpers/workflow-handoff-harness.js';
import { createV3NodeCardSync, v3NodeCardStatusFor } from '../src/im/lark/v3-node-card-sync.js';
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
