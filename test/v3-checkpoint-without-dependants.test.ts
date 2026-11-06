/**
 * A checkpoint nothing depends on (design 2026-11-03 §13.6): the main bot is
 * only woken while the run goes on, so a checkpoint that is the last node to
 * finish ends the run without anybody looking at it. Bot-executed runs refuse
 * it where a flow is written — after the Architect (which gets the refusal
 * back and fixes its DAG), at approval (approve-dag, Saved Workflow and
 * Dashboard targets) and on runtime edits — never where an existing run is
 * read. Real host commands, real planner and run-edit over temp run dirs; the
 * Architect worker and probes are fakes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDag, type V3Dag } from '../src/workflows/v3/dag.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';
import { GOAL_ENV, SPEC_SCHEMA_VERSION, type Manifest } from '../src/workflows/v3/contract.js';
import { applyV3RunEdit, projectV3RunStatus } from '../src/workflows/v3/run-edit.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import {
  resolveV3NodeExecutor,
  v3BotExecutorTargets,
  v3TargetPlacementProblems,
  type V3BotEligibilityProbe,
} from '../src/workflows/v3/node-executor-mode.js';
import { runArchitect } from '../src/workflows/v3/architect.js';
import {
  cmdWorkflowHost,
  hostApproveSpec,
  hostNew,
  hostReviseDag,
  hostSpecFinalize,
  type ArchitectDeps,
  type WorkflowHostCommandDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const MAIN = 'cli_main';
const REFUSAL = '检查点后面没有节点，主 Bot 不会被叫来；去掉这个标记，或在后面加一个汇总节点';
const goal = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra });
const dagOf = (nodes: unknown[]): V3Dag => validateDag({ schemaVersion: 2, runId: 'r', nodes });

/** `collect` is a checkpoint and the last node: nothing depends on it. */
const SINK = [goal('summary', { bot: MAIN }), goal('collect', { bot: 'cli_x', checkpoint: true, depends: ['summary'] })];
/** The same checkpoint with a summary node after it. */
const FIXED = [goal('collect', { bot: 'cli_x', checkpoint: true }), goal('summary', { bot: MAIN, depends: ['collect'] })];

// ─── Approval targets (approve-dag, Saved Workflow, Dashboard commit) ─────

describe('frozen targets', () => {
  const snapshots = new Map<string, BotSnapshot>([
    ['', { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
    ['cli_x', { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
    [MAIN, { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
  ]);
  const check = (nodes: unknown[]) => v3TargetPlacementProblems({
    targets: v3BotExecutorTargets(dagOf(nodes), snapshots), orchestratorAppId: MAIN, mainTopic: { available: true },
  });

  it('refuse a checkpoint nothing depends on, naming the node; one with a dependant passes', () => {
    expect(check(SINK)).toEqual([`节点 collect：${REFUSAL}`]);
    expect(check(FIXED)).toEqual([]);
  });

  it('count any top-level dependant: a loop or a conditional edge after it is enough', () => {
    const loop = {
      id: 'l', type: 'loop', depends: ['collect'], inputs: [], maxIterations: 2,
      body: { nodes: [goal('v', { resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })] },
      exit: { node: 'v', when: { path: 'result.ok', equals: true } },
    };
    expect(check([goal('collect', { checkpoint: true }), loop])).toEqual([]);
    const judged = goal('collect', {
      checkpoint: true, resultSchema: { type: 'object', properties: { go: { type: 'boolean' } }, required: ['go'] },
    });
    expect(check([judged, goal('next', { depends: [{ from: 'collect', when: { path: 'result.go', equals: true } }] })])).toEqual([]);
  });

  it('a Saved Workflow run with one is refused before any live probe', async () => {
    const probe = vi.fn((): V3BotEligibilityProbe => { throw new Error('must not probe'); });
    const out = await resolveV3NodeExecutor({
      policy: { switchMode: 'bot', multiTopicEnabled: true, probe, nameOf: (id) => id, mainTopic: () => ({ available: true }) },
      binding: { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root' },
      targetsFor: () => v3BotExecutorTargets(dagOf(SINK), snapshots),
    });
    expect(out).toMatchObject({ kind: 'refused', message: expect.stringContaining(`节点 collect：${REFUSAL}`) });
    expect(probe).not.toHaveBeenCalled();
    // On temporary workers the mark does nothing: nothing to refuse.
    const ephemeral = await resolveV3NodeExecutor({
      policy: { switchMode: 'ephemeral', multiTopicEnabled: true, probe, nameOf: (id) => id },
      binding: { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root' },
      targetsFor: () => v3BotExecutorTargets(dagOf(SINK), snapshots),
    });
    expect(ephemeral.kind).toBe('ephemeral');
  });
});

// ─── Architect and approve-dag ─────────────────────────────────────────────

const BOTS = [
  { larkAppId: MAIN, larkAppSecret: 's', name: 'main', cliId: 'claude-code' },
  { larkAppId: 'cli_x', larkAppSecret: 's', name: 'x', cliId: 'claude-code' },
] as any[];
const GROUP: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', sessionId: 's1' };
const okProbe: V3BotEligibilityProbe = {
  isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
  opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
};
const NOTES = [
  '## Bot assignments',
  '- collect → cli_x: 整理',
  '- summary → cli_main: 汇总',
  '## Placements',
  '- collect → topic: 过程多',
  '- summary → topic: 过程多',
].join('\n');

function specApproved(): { base: string; runDir: string } {
  const base = tempDir('wf-cp-sink-');
  const { runDir, runId } = hostNew({ goal: 'g', baseDir: base, runId: 'r', chatBinding: GROUP });
  writeFileSync(join(runDir, 'spec.md'), `# Spec\n\`\`\`json\n${JSON.stringify({
    schemaVersion: SPEC_SCHEMA_VERSION, runId, title: '周报', requirement: 'r',
    nodes: ['collect', 'summary'].map((sketchId) => ({ sketchId, goal: sketchId, input_needs: [], expected_outputs: ['o'], acceptance: 'ok', risk_gate: false, unknowns: [] })),
  })}\n\`\`\`\n`);
  expect(hostSpecFinalize(runDir).ok).toBe(true);
  hostApproveSpec(runDir);
  return { base, runDir };
}

function product(outputDir: string, path: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, path), content);
  return {
    name: path, path, kind: path.endsWith('.json') ? 'json' : 'markdown', bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), mime: path.endsWith('.json') ? 'application/json' : 'text/markdown',
  };
}

/** An Architect worker that writes `attempts[i]` on its i-th run (the last
 *  one from then on) and records every goal (prompt) it was given. */
function fakeArchitect(...attempts: unknown[][]) {
  const goals: string[] = [];
  const run: ArchitectDeps['runArchitect'] = async (input) => runArchitect({
    ...input,
    runNode: async (req) => {
      goals.push(req.node.goal);
      const nodes = attempts[Math.min(goals.length, attempts.length) - 1];
      const files = [
        product(req.outputDir, 'dag.json', JSON.stringify({ schemaVersion: 2, runId: input.runId, nodes })),
        product(req.outputDir, 'architect-notes.md', NOTES),
      ];
      const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'ok', files }));
      return { status: 'ok', manifestPath };
    },
  });
  return { run, goals };
}

async function host(sub: 'architect' | 'approve-dag', base: string, extra: Partial<WorkflowHostCommandDeps> = {}) {
  const previousExitCode = process.exitCode;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cmdWorkflowHost(sub, ['r', '--base-dir', base], {
      loadBots: () => BOTS,
      resolveChatBinding: () => GROUP,
      nodeExecutorSwitch: () => 'bot',
      multiTopicEnabled: () => true,
      botEligibilityProbe: () => okProbe,
      botDisplayName: () => (id: string) => id,
      botRole: () => () => undefined,
      mainTopicAvailability: () => ({ available: true }),
      ...extra,
    });
    return { output: log.mock.calls.flat().join('\n'), errors: error.mock.calls.flat().join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previousExitCode ?? 0;
  }
}

describe('the Architect', () => {
  it('gets the refusal back in its next prompt and fixes the DAG itself; the fixed DAG is accepted', async () => {
    const { base, runDir } = specApproved();
    const worker = fakeArchitect(SINK, FIXED);

    await host('architect', base, { runArchitect: worker.run });
    const refused = readGrillState(runDir)!;
    expect(refused.status).toBe('spec_approved');
    expect(refused.problems).toContain(`节点 collect：${REFUSAL}`);
    expect(worker.goals[0]).not.toContain('Previous attempt');

    await host('architect', base, { runArchitect: worker.run });
    expect(worker.goals).toHaveLength(2);
    // The second attempt is told exactly what the host refused.
    expect(worker.goals[1]).toContain(JSON.stringify(`节点 collect：${REFUSAL}`));
    const accepted = readGrillState(runDir)!;
    expect(accepted.status).toBe('dag_ready');
    expect(accepted.problems).toBeUndefined();

    // A later attempt (after revise-dag) is not told about the old refusal.
    hostReviseDag(runDir);
    await host('architect', base, { runArchitect: worker.run });
    expect(worker.goals[2]).not.toContain('Previous attempt');
  });

  it('a run on temporary workers is not checked (the mark does nothing there)', async () => {
    const { base, runDir } = specApproved();
    const worker = fakeArchitect(SINK);
    await host('architect', base, { runArchitect: worker.run, nodeExecutorSwitch: () => 'ephemeral' });
    expect(readGrillState(runDir)!.status).toBe('dag_ready');
  });
});

describe('approve-dag', () => {
  it('refuses a checkpoint nothing depends on, publishing nothing; accepts it once something follows it', async () => {
    const { base, runDir } = specApproved();
    await host('architect', base, { runArchitect: fakeArchitect(FIXED).run });
    const state = readGrillState(runDir)!;
    expect(state.status).toBe('dag_ready');
    // A DAG that reached dag_ready some other way (edited on disk).
    writeFileSync(state.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: SINK }));
    await expect(host('approve-dag', base)).rejects.toThrow(`节点 collect：${REFUSAL}`);
    expect(readRunEnvelope(runDir).kind).toBe('missing');

    writeFileSync(state.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: FIXED }));
    await host('approve-dag', base);
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeExecutor: 'bot' } });
  });

  it('on temporary workers approves it as before', async () => {
    const { base, runDir } = specApproved();
    await host('architect', base, { runArchitect: fakeArchitect(SINK).run, nodeExecutorSwitch: () => 'ephemeral' });
    await host('approve-dag', base, { nodeExecutorSwitch: () => 'ephemeral' });
    const envelope = readRunEnvelope(runDir);
    expect(envelope.kind).toBe('ok');
    expect(envelope.kind === 'ok' && 'nodeExecutor' in envelope.envelope ? envelope.envelope.nodeExecutor : undefined).toBeUndefined();
  });
});

// ─── Runtime edits and existing runs ──────────────────────────────────────

function seedRun(nodes: unknown[], nodeExecutor?: 'bot'): { base: string; runDir: string } {
  const base = tempDir('v3-cp-sink-run-');
  const runDir = join(base, 'r');
  mkdirSync(runDir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('dag.json', { schemaVersion: 2, runId: 'r', nodes });
  write('spec.json', {
    schemaVersion: 1, runId: 'r', title: '周报', requirement: 'r',
    nodes: [{ sketchId: 'a', goal: 'g', input_needs: [], expected_outputs: ['o'], acceptance: 'ok', risk_gate: false, unknowns: [] }],
  });
  write('bots.snapshot.json', {
    '': { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' },
    cli_x: { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/w' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId: 'r', createdAt: '2026-11-05T00:00:00.000Z', authorizedAt: '2026-11-05T00:01:00.000Z',
    authorizedByOpenId: 'ou_owner',
    chatBinding: GROUP,
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    ...(nodeExecutor ? { nodeExecutor } : {}),
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'r', ...(nodeExecutor ? { nodeExecutor } : {}) });
  return { base, runDir };
}

const edit = (base: string, ops: unknown[]) => applyV3RunEdit({
  baseDir: base, runId: 'r', patch: { ops }, baseRevision: 1,
  caller: { openId: 'ou_owner', origin: 'human' },
  resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
});

describe('workflow edit', () => {
  const FLOW = [goal('a', { bot: 'cli_x', checkpoint: true }), goal('b', { bot: 'cli_x', depends: ['a'] }), goal('c', { bot: 'cli_x' })];

  it('refuses removing a checkpoint\'s only dependant, or rewiring it away', () => {
    const { base } = seedRun(FLOW, 'bot');
    expect(edit(base, [{ op: 'removeNode', nodeId: 'b' }])).toEqual({ kind: 'invalid', problems: [`节点 a：${REFUSAL}`] });
    expect(edit(base, [{ op: 'setDepends', nodeId: 'b', depends: ['c'], inputs: [] }]))
      .toEqual({ kind: 'invalid', problems: [`节点 a：${REFUSAL}`] });
    // Removing the mark with it, or adding another dependant first, is fine.
    expect(edit(base, [
      { op: 'addNode', node: goal('d', { bot: 'cli_x', depends: ['a'] }) },
      { op: 'removeNode', nodeId: 'b' },
    ])).toMatchObject({ kind: 'applied' });
  });

  it('refuses marking a node nothing depends on; marking one with a dependant applies', () => {
    const { base } = seedRun(FLOW, 'bot');
    expect(edit(base, [{ op: 'updateNode', nodeId: 'c', set: { checkpoint: true } }]))
      .toEqual({ kind: 'invalid', problems: [`节点 c：${REFUSAL}`] });
    expect(edit(base, [{ op: 'addNode', node: goal('e', { bot: 'cli_x', checkpoint: true }) }]))
      .toEqual({ kind: 'invalid', problems: [`节点 e：${REFUSAL}`] });
    expect(edit(base, [
      { op: 'updateNode', nodeId: 'c', set: { checkpoint: true } },
      { op: 'addNode', node: goal('f', { bot: 'cli_x', depends: ['c'] }) },
    ])).toMatchObject({ kind: 'applied' });
  });

  it('a checkpoint that already completed may lose its dependants (the main bot reviewing it drops the rest)', () => {
    const { base, runDir } = seedRun(FLOW, 'bot');
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', manifestPath: join(runDir, 'm.json') });
    expect(edit(base, [{ op: 'removeNode', nodeId: 'b' }])).toMatchObject({ kind: 'applied' });
  });

  it('but a completed one that an edit redoes (itself, or downstream of a rerun) must have a dependant again', () => {
    const { base, runDir } = seedRun([goal('u', { bot: 'cli_x' }), goal('a', { bot: 'cli_x', checkpoint: true, depends: ['u'] }), goal('b', { bot: 'cli_x', depends: ['a'] })], 'bot');
    const journal = join(runDir, 'journal.ndjson');
    for (const nodeId of ['u', 'a']) {
      appendEvent(journal, { type: 'nodeDispatched', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001`, nodeExecutor: 'bot' });
      appendEvent(journal, { type: 'nodeSucceeded', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001`, manifestPath: join(runDir, 'm.json') });
    }
    for (const rerunOf of ['a', 'u']) {
      expect(edit(base, [{ op: 'removeNode', nodeId: 'b' }, { op: 'rerunNode', nodeId: rerunOf }]))
        .toEqual({ kind: 'invalid', problems: [`节点 a：${REFUSAL}`] });
    }
  });

  it('a run on temporary workers is not checked', () => {
    const { base } = seedRun(FLOW);
    expect(edit(base, [{ op: 'removeNode', nodeId: 'b' }])).toMatchObject({ kind: 'applied' });
  });

  // ── Terminal checkpoints in the rerun cone: only a node the edit really
  // re-dispatches (the rerun cone's supersede finds a live effective
  // instance) can complete again and needs a dependant. ──

  /**
   * `u → c(checkpoint)`, `o` independent, `j` joins `[c, o]` with one_success.
   * `u`/`o` finish; `j` is released by `o` and the losing source `c` is
   * cancelled as an early-release loser. `c`'s only dependant is `j`.
   * Without dispatch the cancel carries no instance and `c` stays a node that
   * was never dispatched (the skipped variant here is that no-instance shape;
   * a skipped node that KEEPS an instance via a same-instance retry has its
   * own case below).
   */
  function seedEarlyReleaseRun(opts: { c: 'cancelled-with-instance' | 'cancelled-no-instance' | 'skipped' }): { base: string; runDir: string } {
    const { base, runDir } = seedRun([
      goal('u', { bot: 'cli_x' }),
      goal('c', { bot: 'cli_x', checkpoint: true, depends: ['u'] }),
      goal('o', { bot: 'cli_x' }),
      goal('j', { bot: 'cli_x', depends: ['c', 'o'], triggerRule: 'one_success' }),
    ], 'bot');
    const journal = join(runDir, 'journal.ndjson');
    for (const nodeId of ['u', 'o']) {
      appendEvent(journal, { type: 'nodeDispatched', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001`, nodeExecutor: 'bot' });
      appendEvent(journal, { type: 'nodeSucceeded', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001`, manifestPath: join(runDir, 'm.json') });
    }
    if (opts.c === 'cancelled-with-instance') {
      appendEvent(journal, { type: 'nodeDispatched', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', nodeExecutor: 'bot' });
    }
    // j is dispatched early on o's success; the losing source is then settled
    // (cancelled with its running instance, or skipped before dispatch).
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'j', instanceId: 'j#001', attemptId: 'j#001/attempts/001', nodeExecutor: 'bot' });
    if (opts.c === 'skipped') {
      appendEvent(journal, { type: 'nodeSkipped', nodeId: 'c', reason: 'triggerRuleUnsatisfied', detail: 'probe' });
    } else {
      appendEvent(journal, opts.c === 'cancelled-with-instance'
        ? { type: 'nodeCancelled', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', reason: 'earlyReleaseLoser', byNodeId: 'j' }
        : { type: 'nodeCancelled', nodeId: 'c', reason: 'earlyReleaseLoser', byNodeId: 'j' });
    }
    return { base, runDir };
  }

  /** After the edit, the supersede effects the journal records and c's
   *  materialized node state. */
  function revisedState(base: string, runDir: string) {
    const events = readJournal(join(runDir, 'journal.ndjson'));
    const revised = [...events].reverse().find((event) => event.type === 'dagRevised') as
      | { effects?: { supersede?: Array<{ nodeId: string }> } }
      | undefined;
    return { supersede: revised?.effects?.supersede ?? [], state: materialize(events).nodes.get('c')?.status };
  }

  it('refuses a cancelled-with-instance sink the rerun cone revives (early-release loser)', () => {
    const { base } = seedEarlyReleaseRun({ c: 'cancelled-with-instance' });
    expect(edit(base, [
      { op: 'removeNode', nodeId: 'j' },
      { op: 'rerunNode', nodeId: 'u' },
    ])).toEqual({ kind: 'invalid', problems: [`节点 c：${REFUSAL}`] });
  });

  it('allows a cancelled sink outside the rerun cone to lose its dependant (nothing re-dispatches it)', () => {
    const { base, runDir } = seedEarlyReleaseRun({ c: 'cancelled-with-instance' });
    expect(edit(base, [{ op: 'removeNode', nodeId: 'j' }])).toMatchObject({ kind: 'applied' });
    const after = revisedState(base, runDir);
    expect(after.supersede.some((item) => item.nodeId === 'c')).toBe(false);
    expect(after.state).toBe('cancelled');
  });

  it('a cancelled sink with no instance in the cone is allowed and stays cancelled (no false refusal)', () => {
    const { base, runDir } = seedEarlyReleaseRun({ c: 'cancelled-no-instance' });
    expect(edit(base, [
      { op: 'removeNode', nodeId: 'j' },
      { op: 'rerunNode', nodeId: 'u' },
    ])).toMatchObject({ kind: 'applied' });
    const after = revisedState(base, runDir);
    expect(after.supersede.some((item) => item.nodeId === 'c')).toBe(false);
    expect(after.state).toBe('cancelled');
  });

  it('a skipped sink in the cone is allowed and stays skipped (it was never dispatched)', () => {
    const { base, runDir } = seedEarlyReleaseRun({ c: 'skipped' });
    expect(edit(base, [
      { op: 'removeNode', nodeId: 'j' },
      { op: 'rerunNode', nodeId: 'u' },
    ])).toMatchObject({ kind: 'applied' });
    const after = revisedState(base, runDir);
    expect(after.supersede.some((item) => item.nodeId === 'c')).toBe(false);
    expect(after.state).toBe('skipped');
  });

  it('refuses a skipped-with-instance sink the cone revives (blocked retried on its instance, then skipped)', () => {
    // Plain chain u → c(checkpoint) → j: c's only dependant is j. c ran,
    // blocked, was re-queued on the SAME instance (resetGate retry) and then
    // skipped before re-dispatch: the node view is skipped but keeps
    // effectiveInstanceId, so a cone supersede revives it exactly like the
    // cancelled-with-instance case.
    const { base, runDir } = seedRun([
      goal('u', { bot: 'cli_x' }),
      goal('c', { bot: 'cli_x', checkpoint: true, depends: ['u'] }),
      goal('j', { bot: 'cli_x', depends: ['c'] }),
    ], 'bot');
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'u', instanceId: 'u#001', attemptId: 'u#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId: 'u', instanceId: 'u#001', attemptId: 'u#001/attempts/001', manifestPath: join(runDir, 'm.json') });
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeBlocked', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', errorClass: 'other' });
    appendEvent(journal, {
      type: 'nodeRetryRequested', nodeId: 'c', instanceId: 'c#001',
      previousAttemptId: 'c#001/attempts/001', nextAttemptId: 'c#001/attempts/001',
      reason: 'blockedRetry', resetGate: true,
    });
    appendEvent(journal, { type: 'nodeSkipped', nodeId: 'c', reason: 'triggerRuleUnsatisfied', detail: 'probe' });
    expect(materialize(readJournal(journal)).nodes.get('c'))
      .toMatchObject({ status: 'skipped', effectiveInstanceId: 'c#001' });
    expect(edit(base, [
      { op: 'removeNode', nodeId: 'j' },
      { op: 'rerunNode', nodeId: 'u' },
    ])).toEqual({ kind: 'invalid', problems: [`节点 c：${REFUSAL}`] });
    // Outside the cone it stays exempt: nothing re-dispatches it.
    const { base: base2, runDir: runDir2 } = seedRun([
      goal('u', { bot: 'cli_x' }),
      goal('c', { bot: 'cli_x', checkpoint: true, depends: ['u'] }),
      goal('j', { bot: 'cli_x', depends: ['c'] }),
    ], 'bot');
    const journal2 = join(runDir2, 'journal.ndjson');
    appendEvent(journal2, { type: 'nodeDispatched', nodeId: 'u', instanceId: 'u#001', attemptId: 'u#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal2, { type: 'nodeSucceeded', nodeId: 'u', instanceId: 'u#001', attemptId: 'u#001/attempts/001', manifestPath: join(runDir2, 'm.json') });
    appendEvent(journal2, { type: 'nodeDispatched', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal2, { type: 'nodeBlocked', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', errorClass: 'other' });
    appendEvent(journal2, {
      type: 'nodeRetryRequested', nodeId: 'c', instanceId: 'c#001',
      previousAttemptId: 'c#001/attempts/001', nextAttemptId: 'c#001/attempts/001',
      reason: 'blockedRetry', resetGate: true,
    });
    appendEvent(journal2, { type: 'nodeSkipped', nodeId: 'c', reason: 'triggerRuleUnsatisfied', detail: 'probe' });
    expect(edit(base2, [{ op: 'removeNode', nodeId: 'j' }])).toMatchObject({ kind: 'applied' });
    const after = revisedState(base2, runDir2);
    expect(after.supersede.some((item) => item.nodeId === 'c')).toBe(false);
    expect(after.state).toBe('skipped');
  });
});

describe('a run approved before the rule, with a checkpoint nothing depends on', () => {
  const OLD = [goal('a', { bot: 'cli_x', checkpoint: true }), goal('p', { bot: 'cli_x' })];

  it('still loads, replays and shows its status, and an unrelated edit still applies', () => {
    const { base, runDir } = seedRun(OLD, 'bot');
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', manifestPath: join(runDir, 'm.json') });
    expect(materialize(readJournal(journal)).nodes.get('a')?.status).toBe('done');
    const status = projectV3RunStatus(base, 'r');
    expect(status.nodes.map((node) => [node.id, node.status])).toEqual([['a', 'done'], ['p', 'pending']]);
    expect(projectRun('r', runDir).nodes.map((node) => node.id)).toEqual(['a', 'p']);
    // It already completed: nothing left to wake about, edits go on.
    expect(edit(base, [{ op: 'updateNode', nodeId: 'p', set: { goal: 'changed' } }])).toMatchObject({ kind: 'applied' });
  });

  it('one that has not completed yet: an edit must fix it (drop the mark or add a dependant) to apply', () => {
    const { base } = seedRun(OLD, 'bot');
    expect(projectV3RunStatus(base, 'r').nodes.map((node) => node.status)).toEqual(['pending', 'pending']);
    expect(edit(base, [{ op: 'updateNode', nodeId: 'p', set: { goal: 'changed' } }]))
      .toEqual({ kind: 'invalid', problems: [`节点 a：${REFUSAL}`] });
    expect(edit(base, [
      { op: 'updateNode', nodeId: 'p', set: { goal: 'changed' } },
      { op: 'updateNode', nodeId: 'a', set: { checkpoint: null } },
    ])).toMatchObject({ kind: 'applied' });
  });
});
