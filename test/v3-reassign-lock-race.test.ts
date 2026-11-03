/**
 * Engine reassignment racing a dispatch (design §9.2, review M17): a
 * reassignment planned while the node is idle must refuse once a concurrent
 * drive dispatched it before the reassignment took the journal lock.
 *
 * The race is injected at the journal lock itself (a pass-through mock that
 * runs a hook just before the real lock), so it does not depend on which
 * objects the engine reads its bots from — it holds both on a run whose bot
 * set is only the approval's and on one a flow revision added a bot to.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lock = vi.hoisted(() => ({ beforeNext: undefined as undefined | (() => void) }));

vi.mock('../src/workflows/v3/journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflows/v3/journal.js')>();
  const withJournalMutationSync: typeof actual.withJournalMutationSync = (journalPath, fn) => {
    const hook = lock.beforeNext;
    lock.beforeNext = undefined;
    hook?.();
    return actual.withJournalMutationSync(journalPath, fn);
  };
  return { ...actual, withJournalMutationSync };
});

import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { createV3GateRunner } from '../src/workflows/v3/daemon-run.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { reassignNode } from '../src/workflows/v3/external-control.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import { FakeExecutor } from './helpers/v3-external-harness.js';

const OWNER = 'ou_owner';
const BINDING = { larkAppId: 'cli_main', chatId: 'oc_chat', chatType: 'group' as const, rootMessageId: 'om_root', ownerOpenId: OWNER };
const SNAPSHOTS = {
  cli_a: { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/tmp' },
  cli_b: { larkAppId: 'cli_b', cliId: 'claude-code', workingDir: '/tmp' },
};
const BOTS = [
  { larkAppId: 'cli_main', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_b', cliId: 'claude-code', workingDir: '/tmp' },
  { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' },
] as never[];

const bases: string[] = [];
afterEach(() => {
  lock.beforeNext = undefined;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** A bot run where `write` is out on cli_a and `spare` (cli_b, after write) waits. */
async function runWithIdleSpare(runId: string) {
  const base = mkdtempSync(join(tmpdir(), 'v3-reassign-race-'));
  bases.push(base);
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), {
    schemaVersion: 2, runId,
    nodes: [
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_a', depends: [], inputs: [] },
      { id: 'spare', type: 'goal', goal: 'spare', bot: 'cli_b', depends: ['write'], inputs: [] },
    ],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1, runId, title: 'race', requirement: 'r',
    nodes: [{ sketchId: 'write', goal: 'write', input_needs: [], expected_outputs: ['r.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), SNAPSHOTS);
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-01T08:00:00.000Z', authorizedAt: '2026-11-01T08:01:00.000Z',
    chatBinding: BINDING, authorizedByOpenId: OWNER,
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
    nodeExecutor: 'bot',
  }));
  const executor = new FakeExecutor();
  await createV3GateRunner({
    baseDir: base,
    loadBots: () => BOTS,
    makeRunNode: () => async () => { throw new Error('bot mode never spawns a worker'); },
    externalExecutor: executor,
    now: () => 10_000,
    postCard: async () => {},
    scheduleWake: () => {},
  }).drive(runId);
  return { base, runDir, executor, journalPath: join(runDir, 'journal.ndjson') };
}

describe('a reassignment planned while idle refuses an attempt dispatched before its lock (M17)', () => {
  it.each([
    ['the approval\'s bot set only', false],
    ['a bot a flow revision added', true],
  ])('on a run with %s', async (_label, withAddedBot) => {
    const run = await runWithIdleSpare(withAddedBot ? 'race-added' : 'race-frozen');
    let target = 'cli_a';
    if (withAddedBot) {
      expect(applyV3RunEdit({
        baseDir: run.base, runId: 'race-added', baseRevision: 1,
        patch: [{ op: 'addNode', node: { id: 'publish', type: 'goal', goal: 'publish', bot: 'cli_x', depends: ['spare'], inputs: [] } }],
        caller: { openId: OWNER, origin: 'human' },
        resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'claude-code', workingDir: '/tmp' }),
      })).toMatchObject({ kind: 'applied' });
      target = 'cli_x';
    }
    // A concurrent drive dispatches `spare` after the engine planned, before it locks.
    lock.beforeNext = () => {
      appendEvent(run.journalPath, {
        type: 'nodeDispatched', nodeId: 'spare', instanceId: 'spare#001', attemptId: 'spare#001/attempts/001', nodeExecutor: 'bot',
      });
    };
    const outcome = await reassignNode(run.runDir, { nodeId: 'spare', toLarkAppId: target, by: OWNER }, {
      nodeExecutor: 'bot',
      executor: run.executor,
    });
    expect(lock.beforeNext).toBeUndefined();
    expect(outcome).toEqual({ kind: 'rejected', reason: 'stale-attempt' });
    expect(readJournal(run.journalPath).some((event) => event.type === 'nodeReassigned')).toBe(false);
    expect(run.executor.stops).toEqual([]);
  });
});
