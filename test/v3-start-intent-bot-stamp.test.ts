/**
 * A bot-executed run started the way `botmux workflow start` / the Saved
 * Workflow entry start it: the daemon's start intent roots the journal with
 * `runStarted`, then the runtime drives the run. Readers that ask "is this a
 * bot-executed run?" — the Dashboard projection (handoffs, checkpoints) and
 * the engine controls (reassign, hand to a human) — must say yes, both for a
 * run started now and for one whose journal was rooted before the start
 * intent carried the executor (an unstamped `runStarted`, as every such live
 * run has).
 *
 * Real run.json, start intent, daemon driver, journal and engine controls;
 * fake bot transport.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { persistV3StartIntent } from '../src/workflows/v3/start-intent.js';
import { driveV3Run, type V3DaemonRunDeps } from '../src/workflows/v3/daemon-run.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import {
  handNodeToHuman,
  ingestExternalSubmission,
  reassignNode,
  recordExternalAccepted,
} from '../src/workflows/v3/external-control.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';
import { FakeExecutor, cleanupBotRuns, trackTempDir } from './helpers/v3-external-harness.js';

afterEach(cleanupBotRuns);

const BINDING = {
  larkAppId: 'cli_main', chatId: 'oc_chat', chatType: 'group' as const, rootMessageId: 'om_root', ownerOpenId: 'ou_initiator',
};

const DAG = (runId: string) => ({
  schemaVersion: 2,
  runId,
  nodes: [
    { id: 'a', type: 'goal', goal: 'survey', bot: 'cli_a', checkpoint: true, depends: [], inputs: [] },
    { id: 'b', type: 'goal', goal: 'build', bot: 'cli_b', placement: 'main', depends: ['a'], inputs: [] },
  ],
});

/**
 * An authorized run in the shape Gate-2 leaves it (run.json + artifacts, no
 * journal). `rootedBy: 'legacy'` roots the journal the way the start intent
 * did before it carried the executor; then the current start intent runs
 * (idempotent on that root) exactly as `workflow start` calls it.
 */
function authorizedRun(runId: string, opts: { nodeExecutor?: 'bot'; rootedBy?: 'legacy' } = {}) {
  const base = trackTempDir(mkdtempSync(join(tmpdir(), 'v3-start-stamp-')));
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', DAG(runId));
  write('spec.json', {
    schemaVersion: 1, runId, title: '周报', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'a', input_needs: [], expected_outputs: ['o'], acceptance: 'x', risk_gate: false, unknowns: [] }],
  });
  write('bots.snapshot.json', {
    '': { larkAppId: 'cli_main', cliId: 'claude-code', workingDir: '/w' },
    cli_a: { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/w' },
    cli_b: { larkAppId: 'cli_b', cliId: 'claude-code', workingDir: '/w' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-06T08:00:00.000Z', authorizedAt: '2026-11-06T08:01:00.000Z',
    authorizedByOpenId: 'ou_initiator', chatBinding: BINDING,
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    ...(opts.nodeExecutor ? { nodeExecutor: opts.nodeExecutor } : {}),
  }));
  const journalPath = join(runDir, 'journal.ndjson');
  if (opts.rootedBy === 'legacy') appendEvent(journalPath, { type: 'runStarted', runId });
  persistV3StartIntent(runId, runDir);
  const executor = new FakeExecutor();
  const deps: V3DaemonRunDeps = {
    baseDir: base,
    loadBots: () => [],
    makeRunNode: () => async () => { throw new Error('no ephemeral workers in bot mode'); },
    postGateCard: async () => {},
    externalExecutor: executor,
  };
  const dag = validateDag(DAG(runId));
  return {
    runId,
    runDir,
    executor,
    dag,
    drive: () => driveV3Run(runId, deps),
    journal: () => readJournal(journalPath),
    attemptOf: (nodeId: string) => executor.dispatches.filter((req) => req.nodeId === nodeId).at(-1)!.attemptId,
  };
}

type Run = ReturnType<typeof authorizedRun>;

/** `a` hands off, is accepted and finishes; `b` waits behind the checkpoint. */
async function finishCheckpoint(run: Run): Promise<void> {
  await run.drive();
  const attemptId = run.attemptOf('a');
  expect(recordExternalAccepted(run.runDir, { attemptId, sessionId: 'sess-a' }, { dag: run.dag })).toMatchObject({ ok: true });
  expect(await ingestExternalSubmission(run.runDir, {
    attemptId, sessionId: 'sess-a', summary: 'done', files: [{ key: 'notes', name: 'notes.md', data: Buffer.from('a') }],
  }, { dag: run.dag })).toMatchObject({ ok: true, kind: 'succeeded' });
  await run.drive();
}

describe.each([
  ['started now', {}],
  ['rooted before the start intent carried the executor', { rootedBy: 'legacy' as const }],
])('a bot-executed run %s', (_label, shape) => {
  it('the board shows its handoffs and checkpoint holds', async () => {
    const run = authorizedRun('stamp-board', { nodeExecutor: 'bot', ...shape });
    await run.drive();
    const handedOff = projectRun(run.runId, run.runDir).nodes.find((node) => node.id === 'a')!;
    expect(handedOff.handoff).toMatchObject({ placement: 'topic' });

    await finishCheckpoint(run);
    const view = projectRun(run.runId, run.runDir);
    expect(view.nodes.find((node) => node.id === 'a')!.checkpoint).toBe('holding');
    expect(view.nodes.find((node) => node.id === 'b')!.waitingOnCheckpoint).toEqual(['a']);
  });

  it('reassign and hand-to-human without a pinned executor treat it as bot-executed', async () => {
    const run = authorizedRun('stamp-controls', { nodeExecutor: 'bot', ...shape });
    await run.drive();
    const first = run.attemptOf('a');
    expect(await reassignNode(run.runDir, { nodeId: 'a', toLarkAppId: 'cli_b', by: 'ou_initiator' }, { executor: run.executor }))
      .toMatchObject({ kind: 'reassigned', from: 'cli_a', to: 'cli_b', closedAttemptId: first });

    await run.drive();
    const second = run.attemptOf('a');
    expect(second).not.toBe(first);
    expect(await handNodeToHuman(run.runDir, { nodeId: 'a', reason: 'needs a person', by: 'main_bot' }, { executor: run.executor }))
      .toMatchObject({ kind: 'handed', attemptId: second });
  });
});

describe('the start intent', () => {
  it('stamps the executor run.json pins on the journal root, and nothing for any other run', () => {
    const bot = authorizedRun('stamp-root-bot', { nodeExecutor: 'bot' });
    expect(bot.journal()).toEqual([expect.objectContaining({ type: 'runStarted', runId: 'stamp-root-bot', nodeExecutor: 'bot' })]);
    const ephemeral = authorizedRun('stamp-root-ephemeral');
    expect(ephemeral.journal()).toEqual([expect.objectContaining({ type: 'runStarted', runId: 'stamp-root-ephemeral' })]);
    expect(ephemeral.journal()[0]).not.toHaveProperty('nodeExecutor');
  });

  it('leaves an existing root as written (the journal is append-only)', () => {
    const run = authorizedRun('stamp-root-legacy', { nodeExecutor: 'bot', rootedBy: 'legacy' });
    expect(run.journal()).toHaveLength(1);
    expect(run.journal()[0]).not.toHaveProperty('nodeExecutor');
  });
});

describe('a run.json that is not this run\'s', () => {
  it('does not make the run bot-executed (the envelope must name this run directory)', async () => {
    // An unstamped root, so only run.json could say "bot"; the run.json is
    // another run's (copied into this directory).
    const source = authorizedRun('stamp-source', { nodeExecutor: 'bot', rootedBy: 'legacy' });
    const runDir = join(source.runDir, '..', 'stamp-copy');
    mkdirSync(runDir);
    for (const name of ['run.json', 'dag.json', 'spec.json', 'bots.snapshot.json']) {
      copyFileSync(join(source.runDir, name), join(runDir, name));
    }
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'stamp-copy' });
    expect(await reassignNode(runDir, { nodeId: 'a', toLarkAppId: 'cli_b', by: 'ou_initiator' }))
      .toMatchObject({ kind: 'rejected', reason: 'not-bot-run' });
    expect(await handNodeToHuman(runDir, { nodeId: 'a', reason: 'x', by: 'main_bot' }))
      .toMatchObject({ kind: 'rejected', reason: 'not-bot-run' });
    // The same files under their own run id are bot-executed (the contrast).
    expect(await handNodeToHuman(source.runDir, { nodeId: 'a', reason: 'x', by: 'main_bot' }))
      .not.toMatchObject({ reason: 'not-bot-run' });
  });
});

describe('a run whose run.json pins no bot executor', () => {
  it('is not controlled as bot-executed', async () => {
    const run = authorizedRun('stamp-ephemeral');
    expect(await reassignNode(run.runDir, { nodeId: 'a', toLarkAppId: 'cli_b', by: 'ou_initiator' }))
      .toMatchObject({ kind: 'rejected', reason: 'not-bot-run' });
    expect(await handNodeToHuman(run.runDir, { nodeId: 'a', reason: 'x', by: 'main_bot' }))
      .toMatchObject({ kind: 'rejected', reason: 'not-bot-run' });
  });
});
