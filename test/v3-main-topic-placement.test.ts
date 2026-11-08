/**
 * Placement of a bot-executed run's goal nodes (design 2026-11-03 §5.1, §5.2,
 * D2, P1, P4): the `placement` field, the three hard rules checked by code
 * after the Architect, at approve-dag and on every runtime edit (and on a
 * blocked-card reassignment), the Architect prompt / notes and the Gate-2
 * lines. Real host commands, real planner, real run-edit and reassignment
 * over temp run dirs; the Architect worker, probes and names are fakes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DagValidationError, validateDag, type V3Dag } from '../src/workflows/v3/dag.js';
import { v3NodePlacement, v3PlacementProblems } from '../src/workflows/v3/placement.js';
import { parseV3DagPatch, planV3DagRevision } from '../src/workflows/v3/dag-revision.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';
import type { StoredEvent, V3Event } from '../src/workflows/v3/event-contract.js';
import { materialize } from '../src/workflows/v3/state.js';
import { applyV3RunEdit } from '../src/workflows/v3/run-edit.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce, readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import { reassignNode } from '../src/workflows/v3/external-control.js';
import {
  v3BotExecutorTargets,
  v3MainTopicAvailability,
  v3TargetPlacementProblems,
  resolveV3NodeExecutor,
  type V3BotEligibilityProbe,
} from '../src/workflows/v3/node-executor-mode.js';
import { buildArchitectGoal, runArchitect } from '../src/workflows/v3/architect.js';
import { parseV3AssignmentReasons, parseV3PlacementReasons } from '../src/workflows/v3/bot-assignment.js';
import {
  cmdWorkflowHost,
  hostApproveSpec,
  hostNew,
  hostSpecFinalize,
  type ArchitectDeps,
  type WorkflowHostCommandDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState, type RunChatBinding } from '../src/workflows/v3/grill-state.js';
import { GOAL_ENV, SPEC_SCHEMA_VERSION, type Manifest } from '../src/workflows/v3/contract.js';
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
const goal = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra });
const dagOf = (nodes: unknown[]): V3Dag => validateDag({ schemaVersion: 2, runId: 'p', nodes });

describe('the placement field', () => {
  it('keeps only "main"; an authored "topic" (or nothing) serializes as a node that never had the field', () => {
    const dag = dagOf([goal('a', { placement: 'main' }), goal('b', { placement: 'topic' }), goal('c')]);
    expect(dag.nodes.map((node) => node.placement)).toEqual(['main', undefined, undefined]);
    expect(JSON.stringify(dagOf([goal('b', { placement: 'topic' })]))).toBe(JSON.stringify(dagOf([goal('b')])));
    expect(dag.nodes.map(v3NodePlacement)).toEqual(['main', 'topic', 'topic']);
  });

  it.each([
    ['an unknown value', [goal('a', { placement: 'thread' })], /placement must be "topic" or "main"/],
    ['a host node', [{ id: 'h', type: 'host', executor: 'feishu-send', depends: [], inputs: [], input: {}, humanGate: { prompt: 'p' }, placement: 'main' }], /host node "h"\.placement/],
    ['a loop node', [{
      id: 'l', type: 'loop', depends: [], inputs: [], maxIterations: 2, placement: 'main',
      body: { nodes: [goal('w', { resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })] },
      exit: { node: 'w', when: { path: 'result.ok', equals: true } },
    }], /loop node "l"\.placement|"l"\.placement is not supported/],
    ['a loop body node', [{
      id: 'l', type: 'loop', depends: [], inputs: [], maxIterations: 2,
      body: { nodes: [goal('w', { placement: 'main', resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })] },
      exit: { node: 'w', when: { path: 'result.ok', equals: true } },
    }], /body node "w"\.placement/],
  ])('is refused on %s', (_label, nodes, problem) => {
    expect(() => dagOf(nodes)).toThrow(DagValidationError);
    try { dagOf(nodes); } catch (err) { expect((err as DagValidationError).problems.join('\n')).toMatch(problem); }
  });
});

describe('the hard rules (§5.2)', () => {
  const executorOf = (bots: Record<string, string>) => (id: string) => bots[id] ?? MAIN;

  it('rule 1: two main-topic nodes of one bot must be ordered', () => {
    const parallel = dagOf([goal('a', { placement: 'main' }), goal('b', { placement: 'main' })]);
    const problems = v3PlacementProblems({ dag: parallel, mainLarkAppId: MAIN, executorOf: executorOf({ a: 'cli_x', b: 'cli_x' }), nameOf: () => '测试Bot' });
    expect(problems).toEqual([expect.objectContaining({ rule: 1, nodeIds: ['a', 'b'], larkAppId: 'cli_x' })]);
    expect(problems[0]!.message).toMatch(/^落点硬规则 1：.*测试Bot/);
    // Ordered through an intermediate node (transitive ancestor): fine.
    const chained = dagOf([goal('a', { placement: 'main' }), goal('mid', { depends: ['a'] }), goal('b', { placement: 'main', depends: ['mid'] })]);
    expect(v3PlacementProblems({ dag: chained, mainLarkAppId: MAIN, executorOf: executorOf({ a: 'cli_x', b: 'cli_x' }) })).toEqual([]);
    // Different bots, or one of them in a node topic: fine.
    expect(v3PlacementProblems({ dag: parallel, mainLarkAppId: MAIN, executorOf: executorOf({ a: 'cli_x', b: 'cli_y' }) })).toEqual([]);
    const oneTopic = dagOf([goal('a', { placement: 'main' }), goal('b')]);
    expect(v3PlacementProblems({ dag: oneTopic, mainLarkAppId: MAIN, executorOf: executorOf({ a: 'cli_x', b: 'cli_x' }) })).toEqual([]);
  });

  it('rule 2: the main bot\'s own main-topic nodes run in the main session, so they must be ordered too', () => {
    const parallel = dagOf([goal('a', { placement: 'main' }), goal('b', { placement: 'main' })]);
    const problems = v3PlacementProblems({ dag: parallel, mainLarkAppId: MAIN, executorOf: () => MAIN });
    expect(problems).toEqual([expect.objectContaining({ rule: 2 })]);
    expect(problems[0]!.message).toMatch(/^落点硬规则 2：.*主会话/);
  });

  it('rule 3: no main topic, no main placement — naming the reason', () => {
    const dag = dagOf([goal('a', { placement: 'main' })]);
    const problems = v3PlacementProblems({
      dag, mainLarkAppId: MAIN, executorOf: () => MAIN,
      mainTopic: { available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' },
    });
    expect(problems).toEqual([expect.objectContaining({ rule: 3, nodeIds: ['a'] })]);
    expect(problems[0]!.message).toMatch(/^落点硬规则 3：.*整群一个会话/);
    expect(v3PlacementProblems({ dag, mainLarkAppId: MAIN, executorOf: () => MAIN, mainTopic: { available: true } })).toEqual([]);
  });

  it('the main topic is available only when the main session is that topic\'s own session (P4)', () => {
    const binding: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root', sessionId: 's1' };
    expect(v3MainTopicAvailability(binding, { scope: 'thread', rootMessageId: 'om_root' })).toEqual({ available: true });
    expect(v3MainTopicAvailability(binding, { scope: 'chat', rootMessageId: 'oc_g' })).toMatchObject({ available: false, why: expect.stringContaining('整群一个会话') });
    expect(v3MainTopicAvailability(binding, undefined)).toMatchObject({ available: false });
    expect(v3MainTopicAvailability({ ...binding, rootMessageId: undefined }, { scope: 'thread' })).toMatchObject({ available: false, why: expect.stringContaining('主话题根') });
    expect(v3MainTopicAvailability({ ...binding, chatType: 'p2p' }, { scope: 'thread', rootMessageId: 'om_root' })).toMatchObject({ available: false });
  });
});

// ─── Runtime edits ───────────────────────────────────────────────────────

const KNOWN = new Map<string, BotSnapshot>([
  ['', { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
  ['cli_x', { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
]);
let ts = 0;
const ev = (event: V3Event): StoredEvent => ({ ts: ++ts, ...event }) as StoredEvent;
const running = (nodeId: string): StoredEvent[] => [
  ev({ type: 'nodeDispatched', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001` }),
];
function plan(dag: V3Dag, events: StoredEvent[], patch: unknown) {
  return planV3DagRevision({
    dag, approvedDag: dag, events: [ev({ type: 'runStarted', runId: 'p' }), ...events],
    snap: materialize([ev({ type: 'runStarted', runId: 'p' }), ...events]),
    patch: parseV3DagPatch(patch), knownBots: KNOWN, readProducts: () => undefined,
  });
}

describe('runtime edits (§13.2, §13.4)', () => {
  it('updateNode may move a node that has not started, and refuses one that has', () => {
    const dag = dagOf([goal('a', { bot: 'cli_x' }), goal('b', { bot: 'cli_x', depends: ['a'] })]);
    const moved = plan(dag, [], { ops: [{ op: 'updateNode', nodeId: 'b', set: { placement: 'main' } }] });
    expect(moved.ok && moved.plan.dag.nodes.find((node) => node.id === 'b')?.placement).toBe('main');
    const started = plan(dag, running('a'), { ops: [{ op: 'updateNode', nodeId: 'a', set: { placement: 'main' } }] });
    expect(started).toMatchObject({ ok: false });
    expect(!started.ok && started.problems.join('\n')).toMatch(/already started — its placement cannot change/);
    // Re-stating the placement it already has is no move.
    const same = plan(dag, running('a'), { ops: [{ op: 'updateNode', nodeId: 'a', set: { placement: 'topic', goal: 'new' } }] });
    expect(same.ok).toBe(true);
  });

  it('a placement-only change redoes nothing and keeps a waiting gate\'s approval', () => {
    const dag = dagOf([goal('a', { bot: 'cli_x', humanGate: { prompt: 'ok?' } })]);
    const waiting = [
      ev({ type: 'gateDispatched', nodeId: 'a', instanceId: 'a#001', waitId: 'a#001-gate' }),
    ];
    expect(materialize([ev({ type: 'runStarted', runId: 'p' }), ...waiting]).nodes.get('a')?.status).toBe('gateWaiting');
    const planned = plan(dag, waiting, { ops: [{ op: 'updateNode', nodeId: 'a', set: { placement: 'main' } }] });
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(planned.plan.effects?.supersede ?? []).toEqual([]);
    // A change of the work itself does void the approval (the contrast).
    const work = plan(dag, waiting, { ops: [{ op: 'updateNode', nodeId: 'a', set: { goal: 'other' } }] });
    expect(work.ok && work.plan.effects?.supersede).toEqual([expect.objectContaining({ nodeId: 'a', waitId: 'a#001-gate' })]);
  });

  it('every edit is checked against rules 1 and 2, naming the rule', () => {
    const dag = dagOf([goal('a', { bot: 'cli_x', placement: 'main' }), goal('b', { bot: 'cli_x', placement: 'main', depends: ['a'] })]);
    const unordered = plan(dag, [], { ops: [{ op: 'setDepends', nodeId: 'b', depends: [], inputs: [] }] });
    expect(!unordered.ok && unordered.problems.join('\n')).toMatch(/落点硬规则 1/);
    const added = plan(dag, [], { ops: [
      { op: 'addNode', node: goal('c', { placement: 'main' }) },
      { op: 'addNode', node: goal('d', { placement: 'main' }) },
    ] });
    expect(!added.ok && added.problems.join('\n')).toMatch(/落点硬规则 2/);
    const reassigned = plan(dagOf([goal('a', { bot: 'cli_x', placement: 'main' }), goal('b', { placement: 'main' })]), [],
      { ops: [{ op: 'reassign', nodeId: 'b', bot: 'cli_x' }] });
    expect(!reassigned.ok && reassigned.problems.join('\n')).toMatch(/落点硬规则 1/);
  });
});

function seedBotRun(nodes: unknown[]): { base: string; runDir: string } {
  const base = tempDir('v3-placement-run-');
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
    chatBinding: { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', sessionId: 's1' },
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    nodeExecutor: 'bot',
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'r', nodeExecutor: 'bot' });
  return { base, runDir };
}

describe('workflow edit and rule 3', () => {
  const editRun = (base: string, patch: unknown, mainTopic?: Parameters<typeof applyV3RunEdit>[0]['mainTopic']) => applyV3RunEdit({
    baseDir: base, runId: 'r', patch, baseRevision: 1,
    caller: { openId: 'ou_owner', origin: 'human' },
    resolveNewBotSnapshot: () => { throw new Error('no new bots'); },
    ...(mainTopic ? { mainTopic } : {}),
  });

  it('moving a node into the main topic needs a main topic; an unknown one is refused, not guessed', () => {
    const { base } = seedBotRun([goal('a', { bot: 'cli_x' }), goal('b', { bot: 'cli_x', depends: ['a'] })]);
    const patch = { ops: [{ op: 'updateNode', nodeId: 'b', set: { placement: 'main' } }] };
    const chatWide = editRun(base, patch, { available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' });
    expect(chatWide).toMatchObject({ kind: 'invalid', problems: [expect.stringMatching(/落点硬规则 3：.*整群一个会话/)] });
    expect(editRun(base, patch)).toMatchObject({ kind: 'invalid', problems: [expect.stringMatching(/落点硬规则 3/)] });
    expect(editRun(base, patch, { available: true })).toMatchObject({ kind: 'applied' });
  });

  it('an edit that does not move anything into the main topic does not need it', () => {
    const { base } = seedBotRun([goal('a', { bot: 'cli_x', placement: 'main' }), goal('b', { bot: 'cli_x', depends: ['a'] })]);
    expect(editRun(base, { ops: [{ op: 'updateNode', nodeId: 'b', set: { goal: 'changed' } }] }))
      .toMatchObject({ kind: 'applied' });
  });
});

describe('blocked-card reassignment of a main-topic node', () => {
  it('is refused when the new bot already has a concurrent main-topic node (rule 1)', async () => {
    const { runDir } = seedBotRun([goal('a', { bot: 'cli_x', placement: 'main' }), goal('b', { placement: 'main' })]);
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeBlocked', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001', errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', recovery: 'retry' } as never);
    const outcome = await reassignNode(runDir, { nodeId: 'b', toLarkAppId: 'cli_x', by: 'ou_owner', requireBlocked: true });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'placement-conflict', detail: expect.stringMatching(/落点硬规则 1/) });
    expect(readJournal(journal).some((event) => event.type === 'nodeReassigned')).toBe(false);
  });
});

// ─── Gate-2 targets / Saved Workflow ──────────────────────────────────────

describe('frozen targets carry placement (approve-dag and Saved Workflow runs)', () => {
  const snapshots = new Map<string, BotSnapshot>([['', { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' } as BotSnapshot]]);

  it('rules 1–3 hold over the targets alone', () => {
    const targets = v3BotExecutorTargets(dagOf([goal('a', { placement: 'main' }), goal('b', { placement: 'main' })]), snapshots);
    expect(targets.map((target) => target.placement)).toEqual(['main', 'main']);
    expect(v3TargetPlacementProblems({ targets, orchestratorAppId: MAIN, mainTopic: { available: true } }).join('\n')).toMatch(/落点硬规则 2/);
    const ordered = v3BotExecutorTargets(dagOf([goal('a', { placement: 'main' }), goal('b', { placement: 'main', depends: ['a'] })]), snapshots);
    expect(v3TargetPlacementProblems({ targets: ordered, orchestratorAppId: MAIN, mainTopic: { available: true } })).toEqual([]);
    expect(v3TargetPlacementProblems({ targets: ordered, orchestratorAppId: MAIN, mainTopic: { available: false, why: 'x' } }).join('\n')).toMatch(/落点硬规则 3/);
  });

  it('a Saved Workflow run whose placements break a rule is refused before any live probe', async () => {
    const probe = vi.fn((): V3BotEligibilityProbe => { throw new Error('must not probe'); });
    const out = await resolveV3NodeExecutor({
      policy: {
        switchMode: 'bot', multiTopicEnabled: true, probe, nameOf: (id) => id,
        mainTopic: () => ({ available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' }),
      },
      binding: { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root' },
      targetsFor: () => v3BotExecutorTargets(dagOf([goal('a', { placement: 'main' })]), snapshots),
    });
    expect(out).toMatchObject({ kind: 'refused', message: expect.stringMatching(/落点硬规则 3/) });
    expect(probe).not.toHaveBeenCalled();
  });
});

// ─── Architect and Gate-2 ─────────────────────────────────────────────────

const BOTS = [
  { larkAppId: MAIN, larkAppSecret: 's', name: 'main', cliId: 'claude-code' },
  { larkAppId: 'cli_x', larkAppSecret: 's', name: 'x', cliId: 'claude-code' },
] as any[];
const NAMES: Record<string, string> = { [MAIN]: '主Bot', cli_x: '文档Bot' };
const GROUP: RunChatBinding = { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', sessionId: 's1' };
const okProbe: V3BotEligibilityProbe = {
  isConfigured: () => true, isDaemonOnline: () => true, inChat: async () => 'yes',
  opensTopicSessions: async () => 'yes', ensureGrant: async () => {},
};

function specApproved(): { base: string; runDir: string } {
  const base = tempDir('wf-placement-');
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

function fakeArchitect(nodes: unknown[], notes: string) {
  const goals: string[] = [];
  const run: ArchitectDeps['runArchitect'] = async (input) => runArchitect({
    ...input,
    runNode: async (req) => {
      goals.push(req.node.goal);
      const files = [
        product(req.outputDir, 'dag.json', JSON.stringify({ schemaVersion: 2, runId: input.runId, nodes })),
        product(req.outputDir, 'architect-notes.md', notes),
      ];
      const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'ok', files }));
      return { status: 'ok', manifestPath };
    },
  });
  return { run, goals };
}

const NOTES = [
  '## Bot assignments',
  '- collect → cli_x: 文档Bot 擅长整理',
  '- summary → cli_main: 汇总给主话题看',
  '## Placements',
  '- collect → topic: 要抓数据，过程消息多',
  '- summary → main: 一步汇总，结果给主话题里的人看',
].join('\n');

async function host(sub: 'architect' | 'approve-dag', base: string, extra: Partial<WorkflowHostCommandDeps>) {
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
      botDisplayName: () => (id: string) => NAMES[id] ?? id,
      botRole: () => () => undefined,
      ...extra,
    });
    return { output: log.mock.calls.flat().join('\n'), errors: error.mock.calls.flat().join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previousExitCode ?? 0;
  }
}

describe('Architect (P1) and Gate-2', () => {
  const NODES = [goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, placement: 'main', depends: ['collect'] })];

  it('the bot-run prompt carries the placement criteria and rules; a run on temporary workers gets the old prompt byte for byte', async () => {
    const { base } = specApproved();
    const worker = fakeArchitect(NODES, NOTES);
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability: () => ({ available: true }) });
    const prompt = worker.goals[0]!;
    expect(prompt).toContain('"placement": "main"');
    expect(prompt).toContain('## Placements');
    expect(prompt).toContain('Hard rules');
    // Without the bot assignment (temporary workers) nothing of it appears.
    const legacy = buildArchitectGoal('/s.md', '/s.json');
    expect(legacy).not.toMatch(/placement|Placements/);
  });

  it('a run whose main session is chat-wide is told to use node topics only', async () => {
    const { base } = specApproved();
    const worker = fakeArchitect([goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, depends: ['collect'] })], NOTES);
    await host('architect', base, {
      runArchitect: worker.run,
      mainTopicAvailability: () => ({ available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' }),
    });
    expect(worker.goals[0]).toContain('no usable main topic');
    expect(worker.goals[0]).not.toContain('## Placements');
  });

  it('a dag breaking a hard rule goes back to the Architect with the rule named', async () => {
    const { base, runDir } = specApproved();
    const parallel = [goal('collect', { bot: MAIN, placement: 'main' }), goal('summary', { bot: MAIN, placement: 'main' })];
    const worker = fakeArchitect(parallel, NOTES);
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability: () => ({ available: true }) });
    const state = readGrillState(runDir)!;
    expect(state.status).toBe('spec_approved');
    expect(state.problems?.join('\n')).toMatch(/落点硬规则 2/);
  });

  it('Gate-2 lines name each node\'s placement and its reason; approve-dag freezes the run', async () => {
    const { base, runDir } = specApproved();
    const worker = fakeArchitect(NODES, NOTES);
    const mainTopicAvailability = () => ({ available: true as const });
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability });
    const { output } = await host('approve-dag', base, { mainTopicAvailability });
    const lines = output.split('\n');
    expect(lines).toContain('- collect → 文档Bot（claude-code，节点话题）：文档Bot 擅长整理；落点理由：要抓数据，过程消息多');
    expect(lines).toContain('- summary → 主Bot（claude-code，主 Bot 自己，主话题）：汇总给主话题看；落点理由：一步汇总，结果给主话题里的人看');
    expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope: { nodeExecutor: 'bot' } });
  });

  it('a run whose nodes all open topics keeps its Gate-2 lines as before (no placement named)', async () => {
    const { base } = specApproved();
    const topicOnly = [goal('collect', { bot: 'cli_x' }), goal('summary', { bot: MAIN, depends: ['collect'] })];
    const worker = fakeArchitect(topicOnly, NOTES);
    const mainTopicAvailability = () => ({ available: true as const });
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability });
    const lines = (await host('approve-dag', base, { mainTopicAvailability })).output.split('\n');
    expect(lines).toContain('执行方式：节点交给群里的 Bot 执行（每个节点开一个节点话题）');
    expect(lines).toContain('- collect → 文档Bot（claude-code）：文档Bot 擅长整理');
    expect(lines).toContain('- summary → 主Bot（claude-code，主 Bot 自己）：汇总给主话题看');
  });

  it('approve-dag refuses placements the main topic cannot host (rule 3), publishing nothing', async () => {
    const { base, runDir } = specApproved();
    const worker = fakeArchitect(NODES, NOTES);
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability: () => ({ available: true }) });
    await expect(host('approve-dag', base, {
      mainTopicAvailability: () => ({ available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' }),
    })).rejects.toThrow(/落点硬规则 3/);
    expect(readRunEnvelope(runDir).kind).toBe('missing');
  });

  it('the notes\' placement section is read apart from the bot assignments', () => {
    expect([...parseV3PlacementReasons(NOTES)]).toEqual([
      ['collect', { placement: 'topic', reason: '要抓数据，过程消息多' }],
      ['summary', { placement: 'main', reason: '一步汇总，结果给主话题里的人看' }],
    ]);
    expect([...parseV3AssignmentReasons(NOTES).keys()]).toEqual(['collect', 'summary']);
  });
});

// ─── Joins that do not wait for every source (#2806 review) ─────────────

describe('a one_success / quorum join does not order its sources before it (§5.2 rules 1–2)', () => {
  // c (topic); a (main, cli_x); b (main, cli_x, one_success over [c, a]):
  // b may start (and a be cancelled as the early-release loser) while a runs.
  const JOIN = (rule: unknown = 'one_success') => [
    goal('c', { bot: 'cli_x' }),
    goal('a', { bot: 'cli_x', placement: 'main' }),
    goal('b', { bot: 'cli_x', placement: 'main', depends: ['c', 'a'], triggerRule: rule }),
  ];
  const GATED = [
    goal('a', {
      bot: 'cli_x', placement: 'main',
      resultSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['go', 'stop'] } }, required: ['decision'] },
    }),
    goal('b', { bot: 'cli_x', placement: 'main', depends: [{ from: 'a', when: { path: 'result.decision', equals: 'go' } }] }),
    goal('z', { bot: 'cli_x', depends: [{ from: 'a', when: { path: 'result.decision', equals: 'stop' } }] }),
  ];
  const snapshots = new Map<string, BotSnapshot>([
    ['', { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
    ['cli_x', { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
  ]);
  const problemsOf = (nodes: unknown[]) => v3PlacementProblems({
    dag: dagOf(nodes), mainLarkAppId: MAIN, executorOf: (id) => (dagOf(nodes).nodes.find((n) => n.id === id)?.bot ?? MAIN),
  });

  it('the plain check refuses it, saying which join breaks the order; quorum likewise; through an intermediate join too', () => {
    const problems = problemsOf(JOIN());
    expect(problems).toEqual([expect.objectContaining({ rule: 1, nodeIds: ['a', 'b'] })]);
    expect(problems[0]!.message).toContain('b 的触发规则是 one_success，a 不一定先于它结束');
    expect(problemsOf(JOIN({ quorum: 1 }))[0]?.message).toContain('b 的触发规则是 quorum 1');
    const viaJoin = [
      goal('c', { bot: 'cli_x' }),
      goal('a', { bot: 'cli_x', placement: 'main' }),
      goal('j', { bot: 'cli_x', depends: ['c', 'a'], triggerRule: 'one_success' }),
      goal('b', { bot: 'cli_x', placement: 'main', depends: ['j'] }),
    ];
    expect(problemsOf(viaJoin)[0]?.message).toContain('j 的触发规则是 one_success，a 不一定先于它结束');
  });

  it('an all_success join — conditional edges included — still orders them', () => {
    expect(problemsOf(JOIN('all_success'))).toEqual([]);
    expect(problemsOf(GATED)).toEqual([]);
  });

  it('a join that needs every source — one_success over one, quorum equal to the in-degree — orders them like all_success', () => {
    const single = [
      goal('a', { bot: 'cli_x', placement: 'main' }),
      goal('b', { bot: 'cli_x', placement: 'main', depends: ['a'], triggerRule: 'one_success' }),
    ];
    expect(problemsOf(single)).toEqual([]);
    expect(problemsOf(JOIN({ quorum: 2 }))).toEqual([]);
    for (const nodes of [single, JOIN({ quorum: 2 })]) {
      expect(v3TargetPlacementProblems({ targets: v3BotExecutorTargets(dagOf(nodes), snapshots), orchestratorAppId: MAIN, mainTopic: { available: true } }))
        .toEqual([]);
    }
    // One short of the in-degree still lets it start while a runs.
    expect(problemsOf(JOIN({ quorum: 1 }))).toHaveLength(1);
  });

  it('a long main-topic chain is checked in one pass, not once per pair', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => goal(`n${i}`, {
      bot: 'cli_x', placement: 'main', ...(i > 0 ? { depends: [`n${i - 1}`] } : {}),
    }));
    // Every pair is ordered. Rebuilding the reachability per pair took ~8.5s
    // here; one pass takes milliseconds — the bound leaves a wide margin.
    const startedAt = performance.now();
    const targets = v3BotExecutorTargets(dagOf(nodes), snapshots);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(targets.every((target) => target.unorderedAncestors === undefined)).toBe(true);
    expect(targets.at(-1)?.ancestors).toHaveLength(149);
    expect(v3TargetPlacementProblems({ targets, orchestratorAppId: MAIN, mainTopic: { available: true } })).toEqual([]);
  });

  it('approve-dag / Saved Workflow targets refuse it too (and accept the all_success forms)', async () => {
    const targets = v3BotExecutorTargets(dagOf(JOIN()), snapshots);
    expect(targets.find((t) => t.nodeId === 'b')?.ancestors).toEqual([]);
    const refused = v3TargetPlacementProblems({ targets, orchestratorAppId: MAIN, mainTopic: { available: true } });
    expect(refused.join('\n')).toMatch(/落点硬规则 1.*b 的触发规则是 one_success，a 不一定先于它结束/);
    for (const nodes of [JOIN('all_success'), GATED]) {
      expect(v3TargetPlacementProblems({ targets: v3BotExecutorTargets(dagOf(nodes), snapshots), orchestratorAppId: MAIN, mainTopic: { available: true } }))
        .toEqual([]);
    }
    const probe = vi.fn((): V3BotEligibilityProbe => { throw new Error('must not probe'); });
    const out = await resolveV3NodeExecutor({
      policy: { switchMode: 'bot', multiTopicEnabled: true, probe, nameOf: (id) => id, mainTopic: () => ({ available: true }) },
      binding: { larkAppId: MAIN, chatId: 'oc_g', chatType: 'group', rootMessageId: 'om_root' },
      targetsFor: () => v3BotExecutorTargets(dagOf(JOIN()), snapshots),
    });
    expect(out).toMatchObject({ kind: 'refused', message: expect.stringMatching(/落点硬规则 1/) });
  });

  it('a runtime edit that turns the join into one_success is refused', () => {
    const dag = dagOf(JOIN('all_success'));
    const planned = plan(dag, [], { ops: [{ op: 'setDepends', nodeId: 'b', depends: ['c', 'a'], inputs: [], triggerRule: 'one_success' }] });
    expect(!planned.ok && planned.problems.join('\n')).toMatch(/落点硬规则 1.*one_success/);
  });

  it('a blocked-card reassignment that would put both on one bot is refused', async () => {
    const { runDir } = seedBotRun([
      goal('c', { bot: 'cli_x' }),
      goal('a', { bot: 'cli_x', placement: 'main' }),
      goal('b', { placement: 'main', depends: ['c', 'a'], triggerRule: 'one_success' }),
    ]);
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, { type: 'nodeBlocked', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001', errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', recovery: 'retry' } as never);
    expect(await reassignNode(runDir, { nodeId: 'b', toLarkAppId: 'cli_x', by: 'ou_owner', requireBlocked: true }))
      .toMatchObject({ kind: 'rejected', reason: 'placement-conflict', detail: expect.stringMatching(/one_success/) });
  });

  it('the Architect gets it back, and approve-dag refuses it, naming the join', async () => {
    const { base, runDir } = specApproved();
    const worker = fakeArchitect(JOIN(), NOTES);
    await host('architect', base, { runArchitect: worker.run, mainTopicAvailability: () => ({ available: true }) });
    expect(readGrillState(runDir)!.problems?.join('\n')).toMatch(/落点硬规则 1.*b 的触发规则是 one_success/);

    // approve-dag over a dag that reached dag_ready some other way.
    const second = specApproved();
    const ok = fakeArchitect(JOIN('all_success'), NOTES);
    await host('architect', second.base, { runArchitect: ok.run, mainTopicAvailability: () => ({ available: true }) });
    const state = readGrillState(second.runDir)!;
    expect(state.status).toBe('dag_ready');
    writeFileSync(state.dagPath!, JSON.stringify({ schemaVersion: 2, runId: 'r', nodes: JOIN() }));
    await expect(host('approve-dag', second.base, { mainTopicAvailability: () => ({ available: true }) }))
      .rejects.toThrow(/落点硬规则 1.*one_success/s);
    expect(readRunEnvelope(second.runDir).kind).toBe('missing');
  });
});

describe('board projection (§5.5, §12.2)', () => {
  it('a main-topic node shows its placement and, once handed off, when and what to look for', () => {
    const { runDir } = seedBotRun([goal('a', { bot: 'cli_x' }), goal('b', { bot: 'cli_x', placement: 'main', depends: ['a'] })]);
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'nodeDispatched', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001', nodeExecutor: 'bot' });
    appendEvent(journal, {
      type: 'nodeHandoffPrepared', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001',
      targetLarkAppId: 'cli_x', placement: 'main', revision: 1, idempotency: { handoff: 'u1' }, preparedAt: 1,
    });
    appendEvent(journal, {
      type: 'nodeHandoffSent', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001',
      handoffMessageId: 'om_h', sentAt: 1_700_000_000_000, acceptDeadlineAt: 1_700_000_020_000,
    });
    const view = projectRun('r', runDir);
    const a = view.nodes.find((node) => node.id === 'a')!;
    const b = view.nodes.find((node) => node.id === 'b')!;
    expect(a.placement).toBeUndefined();
    expect(b.placement).toBe('main');
    expect(b.handoff).toEqual({ placement: 'main', at: 1_700_000_000_000, title: '【工作流任务】周报 · b（第 1 次）' });
    // Accepted into a busy session's queue: the board says so (§5.5).
    appendEvent(journal, {
      type: 'nodeHandoffAccepted', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001',
      sessionId: 's', acceptedAt: 1_700_000_001_000, deadlineAt: 1_700_009_000_000, startPending: true,
    });
    expect(projectRun('r', runDir).nodes.find((node) => node.id === 'b')!.handoff).toMatchObject({ queued: true });
    appendEvent(journal, {
      type: 'nodeHandoffStarted', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001',
      startedAt: 1_700_000_002_000, deadlineAt: 1_700_000_602_000,
    });
    expect(projectRun('r', runDir).nodes.find((node) => node.id === 'b')!.handoff).not.toHaveProperty('queued');
  });
});
