/**
 * Runtime flow revisions — engine half (design §13.2–§13.5): patch parsing,
 * the §13.4 node-state rules, the §13.5 confirmation classification, the
 * revision fold / digest-verified effective DAG, and how replay folds the
 * revision effects into node state.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDag, type V3Dag } from '../src/workflows/v3/dag.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';
import type { StoredEvent, V3Event } from '../src/workflows/v3/event-contract.js';
import { materialize } from '../src/workflows/v3/state.js';
import { decideNext } from '../src/workflows/v3/orchestrator.js';
import { revisitBudgetStatus } from '../src/workflows/v3/core-control.js';
import { DEFAULT_REVISIT_BUDGET_PER_RUN } from '../src/workflows/v3/dag.js';
import {
  foldV3Revisions,
  loadEffectiveV3Dag,
  parseV3DagPatch,
  planV3DagRevision,
  v3RevisionDigest,
  v3RevisionFilePaths,
  V3DagPatchError,
  V3RevisionIntegrityError,
  v3RevisitBudgetEpoch,
  v3PendingProposalHolds,
  v3ApprovedBotScope,
  type V3DoneNodeProducts,
} from '../src/workflows/v3/dag-revision.js';

const RUN = 'rev-run';
const KNOWN = new Map<string, BotSnapshot>([
  ['cli_a', { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/w' } as BotSnapshot],
  ['alias_b', { larkAppId: 'cli_b', cliId: 'codex', workingDir: '/w' } as BotSnapshot],
]);

let ts = 0;
const ev = (event: V3Event): StoredEvent => ({ ts: ++ts, ...event }) as StoredEvent;
const started = (): StoredEvent[] => [ev({ type: 'runStarted', runId: RUN })];

function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, bot: 'cli_a', depends: [], inputs: [], ...extra };
}

function dagOf(nodes: Array<Record<string, unknown>>): V3Dag {
  return validateDag({ schemaVersion: 2, runId: RUN, nodes });
}

const running = (nodeId: string, n = 1): StoredEvent[] => [
  ev({ type: 'nodeDispatched', nodeId, instanceId: `${nodeId}#00${n}`, attemptId: `${nodeId}#00${n}/attempts/001` }),
];
const done = (nodeId: string): StoredEvent[] => [
  ...running(nodeId),
  ev({ type: 'nodeSucceeded', nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001`, manifestPath: `/m/${nodeId}` }),
];

function plan(
  dag: V3Dag,
  events: StoredEvent[],
  patch: unknown,
  opts: { approved?: V3Dag; products?: Record<string, V3DoneNodeProducts> } = {},
) {
  return planV3DagRevision({
    dag,
    approvedDag: opts.approved ?? dag,
    events,
    snap: materialize(events),
    patch: parseV3DagPatch(patch),
    knownBots: KNOWN,
    readProducts: (nodeId) => opts.products?.[nodeId],
  });
}

function products(files: string[], result?: Record<string, unknown>): V3DoneNodeProducts {
  return {
    manifest: {
      schemaVersion: 1,
      status: 'ok',
      summary: '',
      files: files.map((path) => ({ name: path, path, kind: 'file', bytes: 1, sha256: 'x', mime: 'text/plain' })),
    } as V3DoneNodeProducts['manifest'],
    manifestPath: '/m',
    attemptId: 'src#001/attempts/001',
    instanceId: 'src#001',
    ...(result ? { result } : {}),
  };
}

describe('patch format', () => {
  it('accepts an op array or { ops, note } and rejects unknown ops, keys and fields', () => {
    expect(parseV3DagPatch([{ op: 'rerunNode', nodeId: 'a' }]).ops).toHaveLength(1);
    expect(parseV3DagPatch({ ops: [{ op: 'removeNode', nodeId: 'a' }], note: ' why ' }).note).toBe('why');
    const bad = [
      { ops: [] },
      { ops: [{ op: 'renameNode', nodeId: 'a' }] },
      { ops: [{ op: 'removeNode', nodeId: 'a', extra: 1 }] },
      { ops: [{ op: 'updateNode', nodeId: 'a', set: { depends: [] } }] },
      { ops: [{ op: 'updateNode', nodeId: 'a', set: { bot: 'x' } }] },
      { ops: [{ op: 'reassign', nodeId: '../x', bot: 'b' }] },
      { ops: [{ op: 'rerunNode', nodeId: 'a' }], unknown: true },
    ];
    for (const patch of bad) expect(() => parseV3DagPatch(patch)).toThrow(V3DagPatchError);
  });
});

describe('§13.4 node-state rules', () => {
  it('not started: everything allowed and nothing to invalidate', () => {
    const dag = dagOf([goal('a'), goal('b', { depends: ['a'] })]);
    const result = plan(dag, started(), [
      { op: 'updateNode', nodeId: 'b', set: { goal: 'new b' } },
      { op: 'setDepends', nodeId: 'b', depends: [] },
      { op: 'reassign', nodeId: 'a', bot: 'cli_b' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toMatchObject({ changed: ['b'], dependsChanged: ['b'], reassigned: [{ nodeId: 'a', to: 'alias_b' }] });
    expect(result.plan.reasons).toEqual([]);
    expect(result.plan.effects.supersede).toBeUndefined();
    // larkAppId of an approved bot is normalized to its frozen selector.
    expect(result.plan.dag.nodes.find((node) => node.id === 'a')?.bot).toBe('alias_b');
  });

  it('gate waiting: a definition change voids the pending gate; rewiring is refused', () => {
    const dag = dagOf([goal('g', { humanGate: { prompt: 'ok?' } })]);
    const events = [...started(), ev({ type: 'gateDispatched', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' })];
    const changed = plan(dag, events, [{ op: 'updateNode', nodeId: 'g', set: { goal: 'changed' } }]);
    expect(changed.ok && changed.plan.effects.supersede).toEqual([{ nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' }]);
    const rewired = plan(dag, events, [{ op: 'setDepends', nodeId: 'g', depends: [] }]);
    expect(rewired.ok).toBe(false);
  });

  it('running: change / reassign supersede the live attempt, remove cancels it, rewiring is refused', () => {
    const dag = dagOf([goal('a')]);
    const events = [...started(), ...running('a')];
    const changed = plan(dag, events, [{ op: 'updateNode', nodeId: 'a', set: { goal: 'x' } }]);
    expect(changed.ok && changed.plan.effects.supersede).toEqual([{ nodeId: 'a', instanceId: 'a#001' }]);
    const moved = plan(dag, events, [{ op: 'reassign', nodeId: 'a', bot: 'cli_b' }]);
    expect(moved.ok && moved.plan.effects).toMatchObject({
      supersede: [{ nodeId: 'a', instanceId: 'a#001' }],
      assign: [{ nodeId: 'a', from: 'cli_a', to: 'cli_b' }],
    });
    const twoNodes = dagOf([goal('a'), goal('z')]);
    const removed = plan(twoNodes, events, [{ op: 'removeNode', nodeId: 'a' }]);
    expect(removed.ok && removed.plan.effects.cancel).toEqual([
      { nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001' },
    ]);
    expect(plan(dag, events, [{ op: 'setDepends', nodeId: 'a', depends: [] }]).ok).toBe(false);
  });

  it('blocked: a change alone leaves it blocked; reassign or rerunNode retries it (run reopens); remove cancels', () => {
    const dag = dagOf([goal('a', { humanGate: { prompt: 'ok?' } }), goal('z')]);
    const events = [
      ...started(),
      ...running('a'),
      ev({ type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', errorClass: 'resultInvalid', errorCode: 'X' }),
      ev({ type: 'runBlocked', blockedNodeId: 'a' }),
    ];
    const definitionOnly = plan(dag, events, [{ op: 'updateNode', nodeId: 'a', set: { goal: 'fixed' } }]);
    if (!definitionOnly.ok) throw new Error(definitionOnly.problems.join('; '));
    expect(definitionOnly.plan.effects.supersede).toBeUndefined();
    expect(definitionOnly.plan.retries).toEqual([]);

    const changedAndRerun = plan(dag, events, [
      { op: 'updateNode', nodeId: 'a', set: { goal: 'fixed' } },
      { op: 'rerunNode', nodeId: 'a' },
    ]);
    if (!changedAndRerun.ok) throw new Error(changedAndRerun.problems.join('; '));
    expect(changedAndRerun.plan.retries).toEqual([
      { nodeId: 'a', instanceId: 'a#001', previousErrorClass: 'resultInvalid', previousErrorCode: 'X' },
    ]);
    expect(changedAndRerun.plan.effects.retry).toEqual([{ nodeId: 'a', instanceId: 'a#001' }]);
    const moved = plan(dag, events, [{ op: 'reassign', nodeId: 'a', bot: 'cli_b' }]);
    expect(moved.ok && moved.plan.retries).toEqual([expect.objectContaining({ nodeId: 'a' })]);
    expect(moved.ok && moved.plan.effects.supersede).toBeUndefined();
    const removed = plan(dag, events, [{ op: 'removeNode', nodeId: 'a' }]);
    expect(removed.ok && removed.plan.effects.cancel).toEqual([{ nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001' }]);
    expect(plan(dag, events, [{ op: 'setDepends', nodeId: 'a', depends: [] }]).ok).toBe(false);

    // Replayed with the retry the editor appends: the run reopens and the
    // same instance re-dispatches (its gate was never passed, so gate first).
    const after = [
      ...events,
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
      }),
      ev({
        type: 'nodeRetryRequested', nodeId: 'a', instanceId: 'a#001', previousAttemptId: 'a#001/attempts/001',
        nextAttemptId: 'a#001/attempts/002', reason: 'blockedRetry',
      }),
    ];
    const snap = materialize(after);
    expect(snap.runStatus).toBe('running');
    expect(decideNext(changedAndRerun.plan.dag, snap.nodes, snap.loops, snap.edges, snap.instances))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'dispatchGate', nodeId: 'a', instanceId: 'a#001' })]));
  });

  it('a blocked output-contract violation re-runs only together with a definition change', () => {
    const dag = dagOf([goal('a')]);
    const events = [
      ...started(),
      ...running('a'),
      ev({
        type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001',
        errorClass: 'artifactContractInvalid', errorCode: 'OUTPUT_CONTRACT_VIOLATION', recovery: 'reviseWorkflow',
      }),
    ];
    expect(plan(dag, events, [{ op: 'rerunNode', nodeId: 'a' }]).ok).toBe(false);
    expect(plan(dag, events, [
      { op: 'updateNode', nodeId: 'a', set: { goal: 'write the declared outputs' } },
      { op: 'rerunNode', nodeId: 'a' },
    ]).ok).toBe(true);
  });

  it('done: only rerunNode (revisit semantics over the downstream cone, revisit budget) or new downstream nodes', () => {
    const dag = dagOf([goal('a'), goal('b', { depends: ['a'] })]);
    const events = [...started(), ...done('a'), ...running('b')];
    expect(plan(dag, events, [{ op: 'updateNode', nodeId: 'a', set: { goal: 'x' } }]).ok).toBe(false);
    expect(plan(dag, events, [{ op: 'removeNode', nodeId: 'a' }]).ok).toBe(false);
    const rerun = plan(dag, events, [{ op: 'rerunNode', nodeId: 'a' }]);
    expect(rerun.ok && rerun.plan.effects).toMatchObject({
      rerun: ['a'],
      supersede: [{ nodeId: 'a', instanceId: 'a#001' }, { nodeId: 'b', instanceId: 'b#001' }],
    });
    const added = plan(dag, events, [{ op: 'addNode', node: goal('c', { depends: ['a'] }) }], {
      products: { a: products(['out.md']) },
    });
    expect(added.ok).toBe(true);
  });

  it('rerunNode spends the revisit budget: a second rerun of the same node is refused until granted', () => {
    const dag = dagOf([goal('a')]);
    const first = plan(dag, [...started(), ...done('a')], [{ op: 'rerunNode', nodeId: 'a' }]);
    if (!first.ok) throw new Error('first rerun should plan');
    const after = [
      ...started(),
      ...done('a'),
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '重做 1',
        by: 'ou_i', effects: first.plan.effects,
      }),
      ...running('a', 2),
      ev({ type: 'nodeSucceeded', nodeId: 'a', instanceId: 'a#002', attemptId: 'a#002/attempts/001', manifestPath: '/m/a2' }),
    ];
    expect(revisitBudgetStatus(after, 'a', 'a').ok).toBe(false);
    const second = plan(dag, after, [{ op: 'rerunNode', nodeId: 'a' }]);
    expect(second.ok).toBe(false);
    const epoch = v3RevisitBudgetEpoch(after, 'a', 'pair');
    expect(!second.ok && second.rerunBudget).toEqual({ nodeId: 'a', tier: 'pair', epoch });
    // Refused again while still exhausted: same exhaustion, same epoch.
    const third = plan(dag, after, [{ op: 'rerunNode', nodeId: 'a' }]);
    expect(!third.ok && third.rerunBudget?.epoch).toBe(epoch);
    after.push(ev({ type: 'revisitBudgetGranted', sourceNodeId: 'a', toNodeId: 'a', by: 'ou_i' }));
    expect(v3RevisitBudgetEpoch(after, 'a', 'pair')).not.toBe(epoch);
    expect(plan(dag, after, [{ op: 'rerunNode', nodeId: 'a' }]).ok).toBe(true);
  });

  it('a grant moves only the epoch of the exhaustion it can lift', () => {
    const base = [...started()];
    const epochs = (events: StoredEvent[]) => ({
      aPair: v3RevisitBudgetEpoch(events, 'a', 'pair'),
      bPair: v3RevisitBudgetEpoch(events, 'b', 'pair'),
      aRun: v3RevisitBudgetEpoch(events, 'a', 'run'),
      bRun: v3RevisitBudgetEpoch(events, 'b', 'run'),
    });
    const e0 = epochs(base);
    // a's own pair grant: lifts a's pair tier only.
    const pairA = [...base, ev({ type: 'revisitBudgetGranted', sourceNodeId: 'a', toNodeId: 'a', by: 'ou_i' })];
    const e1 = epochs(pairA);
    expect(e1.aPair).not.toBe(e0.aPair);
    expect([e1.bPair, e1.aRun, e1.bRun]).toEqual([e0.bPair, e0.aRun, e0.bRun]);
    // A run-wide grant (e.g. clicked on b's card): lifts every node's run
    // tier, never a node's own spent pair tier.
    const runWide = [...pairA, ev({ type: 'revisitBudgetGranted', by: 'ou_i' })];
    const e2 = epochs(runWide);
    expect(e2.aRun).not.toBe(e1.aRun);
    expect(e2.bRun).not.toBe(e1.bRun);
    expect([e2.aPair, e2.bPair]).toEqual([e1.aPair, e1.bPair]);
  });

  it('skipped / cancelled nodes cannot change and their ids cannot be reused', () => {
    const dag = dagOf([goal('a'), goal('s')]);
    const events = [...started(), ev({ type: 'nodeSkipped', nodeId: 's', reason: 'triggerRuleUnsatisfied' })];
    expect(plan(dag, events, [{ op: 'updateNode', nodeId: 's', set: { goal: 'x' } }]).ok).toBe(false);
    expect(plan(dag, events, [{ op: 'reassign', nodeId: 's', bot: 'cli_b' }]).ok).toBe(false);
    const removedEarlier = dagOf([goal('a')]);
    expect(plan(removedEarlier, events, [{ op: 'addNode', node: goal('s') }]).ok).toBe(false);
  });

  it('a running loop keeps its body; only maxIterations may change (or the whole loop is removed)', () => {
    const loop = {
      id: 'l', type: 'loop', maxIterations: 2, depends: [], inputs: [],
      body: { nodes: [goal('w', { resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })] },
      exit: { node: 'w', when: { path: 'result.ok', equals: true } },
    };
    const dag = dagOf([loop, goal('after', { depends: ['l'] })]);
    const events = [
      ...started(),
      ev({ type: 'loopStarted', loopId: 'l' }),
      ev({ type: 'loopIterationStarted', loopId: 'l', iteration: 1 }),
      ev({ type: 'nodeDispatched', nodeId: 'l.i001.w', attemptId: 'l.i001.w/attempts/001', loop: { loopId: 'l', iteration: 1, bodyNodeId: 'w' } }),
    ];
    expect(plan(dag, events, [{ op: 'updateNode', nodeId: 'l', set: { body: loop.body } }]).ok).toBe(false);
    const budget = plan(dag, events, [{ op: 'updateNode', nodeId: 'l', set: { maxIterations: 4 } }]);
    expect(budget.ok && budget.plan.reasons).toEqual(['budgetExpanded']);
    const removed = plan(dag, events, [
      { op: 'removeNode', nodeId: 'l' },
      { op: 'setDepends', nodeId: 'after', depends: [] },
    ]);
    expect(removed.ok && removed.plan.effects.cancel).toEqual([
      { nodeId: 'l' },
      { nodeId: 'l.i001.w', attemptId: 'l.i001.w/attempts/001' },
    ]);
  });

  it('a host node whose external effect is in flight cannot change', () => {
    const host = {
      id: 'send', type: 'host', executor: 'feishu-send', depends: [], inputs: [],
      input: { larkAppId: { $ref: 'context.larkAppId' }, chatId: { $ref: 'context.chatId' }, content: 'hi' },
      humanGate: { prompt: 'send?', options: ['approve', 'reject'], approveOptions: ['approve'] },
    };
    const dag = dagOf([host]);
    const events = [
      ...started(),
      ev({
        type: 'hostEffectIntent', nodeId: 'send', instanceId: 'send#001', attemptId: 'send#001/attempts/001',
        executor: 'feishu-send', provider: 'p', inputRef: { path: 'x', sha256: 's', bytes: 1 }, inputHash: 'h',
        idempotencyKey: 'k', idempotencyTtlMs: 1, approvalDigest: 'd',
      }),
    ];
    expect(plan(dag, events, [{ op: 'removeNode', nodeId: 'send' }]).ok).toBe(false);
  });

  it('wiring onto a done node must reference products present in its manifest', () => {
    const dag = dagOf([goal('src', { outputs: { report: { path: 'report.md', kind: 'markdown' } } })]);
    const events = [...started(), ...done('src')];
    const patch = [{ op: 'addNode', node: goal('next', { depends: ['src'], inputs: [{ from: 'src', output: 'report' }] }) }];
    expect(plan(dag, events, patch, { products: { src: products(['other.md']) } }).ok).toBe(false);
    expect(plan(dag, events, patch, { products: { src: products(['report.md']) } }).ok).toBe(true);
  });

  it('a new conditional edge from a done node is resolved once, at apply time', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const dag = dagOf([goal('src', { resultSchema: schema })]);
    const events = [...started(), ...done('src')];
    const result = plan(dag, events, [
      { op: 'addNode', node: goal('yes', { depends: [{ from: 'src', when: { path: 'result.ok', equals: true } }] }) },
      { op: 'addNode', node: goal('no', { depends: [{ from: 'src', when: { path: 'result.ok', equals: false } }] }) },
    ], { products: { src: products(['result.json'], { ok: true }) } });
    expect(result.ok && result.plan.edges.map((edge) => [edge.to, edge.active])).toEqual([['yes', true], ['no', false]]);
  });
});

describe('§13.5 confirmation categories', () => {
  const base = () => dagOf([
    goal('a', { timeoutSec: 600 }),
    goal('g', { humanGate: { prompt: 'ok?', approvers: ['ou_x'] } }),
  ]);
  const reasonsOf = (patch: unknown, dag = base(), approved?: V3Dag): string[] => {
    const result = plan(dag, started(), patch, approved ? { approved } : {});
    if (!result.ok) throw new Error(result.problems.join('; '));
    return result.plan.reasons;
  };

  it('direct: goal/outputs edits, approved-bot reassign, removing or rewiring not-started nodes, adding a gate', () => {
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'a', set: { goal: 'better' } }])).toEqual([]);
    expect(reasonsOf([{ op: 'reassign', nodeId: 'a', bot: 'alias_b' }])).toEqual([]);
    expect(reasonsOf([{ op: 'removeNode', nodeId: 'a' }])).toEqual([]);
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'a', set: { humanGate: { prompt: 'check' } } }])).toEqual([]);
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'g', set: { humanGate: { prompt: 'reworded', approvers: ['ou_x'] } } }])).toEqual([]);
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'a', set: { timeoutSec: 300 } }])).toEqual([]);
  });

  it('new bot', () => {
    expect(reasonsOf([{ op: 'reassign', nodeId: 'a', bot: 'cli_new' }])).toEqual(['newBot']);
    expect(reasonsOf([{ op: 'addNode', node: goal('c', { bot: 'cli_new' }) }])).toEqual(['newBot']);
  });

  it('host node added or changed', () => {
    const host = {
      id: 'send', type: 'host', executor: 'feishu-send', depends: [], inputs: [],
      input: { larkAppId: { $ref: 'context.larkAppId' }, chatId: { $ref: 'context.chatId' }, content: 'hi' },
      humanGate: { prompt: 'send?', options: ['approve', 'reject'], approveOptions: ['approve'] },
    };
    expect(reasonsOf([{ op: 'addNode', node: host }])).toEqual(['hostNode']);
    const withHost = dagOf([goal('a'), host]);
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'send', set: { input: { ...host.input, content: 'bye' } } }], withHost))
      .toEqual(['hostNode']);
  });

  it('gate removed or relaxed — including deleting a node whose gate was not passed yet', () => {
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'g', set: { humanGate: null } }])).toEqual(['gateRelaxed']);
    expect(reasonsOf([{ op: 'removeNode', nodeId: 'g' }])).toEqual(['gateRelaxed']);
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'g', set: { humanGate: { prompt: 'ok?', approvers: [] } } }]))
      .toEqual(['gateRelaxed']);
  });

  it('budget expanded: timeout above the approved value, loop iterations, or more than twice the approved node count', () => {
    expect(reasonsOf([{ op: 'updateNode', nodeId: 'a', set: { timeoutSec: 900 } }])).toEqual(['budgetExpanded']);
    const many = Array.from({ length: 3 }, (_, i) => ({ op: 'addNode', node: goal(`n${i}`) }));
    expect(reasonsOf(many)).toEqual(['budgetExpanded']);
    expect(reasonsOf(many.slice(0, 2))).toEqual([]);
  });
});

describe('review regressions (engine)', () => {
  it('P3-7: raising a loop BODY node timeout is a budget expansion', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const body = (timeoutSec: number) => ({ nodes: [goal('w', { timeoutSec, resultSchema: schema })] });
    const loop = (timeoutSec: number) => ({
      id: 'l', type: 'loop', maxIterations: 2, depends: [], inputs: [],
      body: body(timeoutSec), exit: { node: 'w', when: { path: 'result.ok', equals: true } },
    });
    const dag = dagOf([loop(60)]);
    const raised = plan(dag, started(), [{ op: 'updateNode', nodeId: 'l', set: { body: body(14_000) } }]);
    expect(raised.ok && raised.plan.reasons).toEqual(['budgetExpanded']);
    const lowered = plan(dag, started(), [{ op: 'updateNode', nodeId: 'l', set: { body: body(30) } }]);
    expect(lowered.ok && lowered.plan.reasons).toEqual([]);
  });

  it('P1: a definition change on a blocked node whose gate was passed drops that approval (regate)', () => {
    const dag = dagOf([goal('g', { humanGate: { prompt: 'ship?' } })]);
    const events = [
      ...started(),
      ev({ type: 'gateDispatched', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' }),
      ev({ type: 'gateResolved', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate', resolution: 'approved', by: 'ou_i' }),
      ...running('g'),
      ev({ type: 'nodeBlocked', nodeId: 'g', instanceId: 'g#001', attemptId: 'g#001/attempts/001', errorClass: 'workerError' }),
      ev({ type: 'runBlocked', blockedNodeId: 'g' }),
    ];
    const changed = plan(dag, events, [{ op: 'updateNode', nodeId: 'g', set: { goal: 'DELETE PROD' } }]);
    if (!changed.ok) throw new Error(changed.problems.join('; '));
    expect(changed.plan.effects.regate).toEqual([{ nodeId: 'g', instanceId: 'g#001' }]);
    expect(changed.plan.retries).toEqual([]);
    // Any later retry — here a plain operator retry — re-asks the gate on a
    // fresh instance instead of running the new goal on the old approval.
    const after = [
      ...events,
      ev({ type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou_i', effects: changed.plan.effects }),
      ev({ type: 'nodeRetryRequested', nodeId: 'g', instanceId: 'g#001', previousAttemptId: 'g#001/attempts/001', nextAttemptId: 'g#001/attempts/002', reason: 'blockedRetry' }),
    ];
    const snap = materialize(after);
    expect(snap.runStatus).toBe('running');
    expect(decideNext(changed.plan.dag, snap.nodes, snap.loops, snap.edges, snap.instances))
      .toEqual([{ kind: 'dispatchGate', nodeId: 'g', instanceId: 'g#002' }]);
    // A pure reassign keeps the approval (existing reassign semantics).
    const moved = plan(dag, events, [{ op: 'reassign', nodeId: 'g', bot: 'cli_b' }]);
    expect(moved.ok && moved.plan.effects.regate).toBeUndefined();
  });

  it('(b) removing the node the run is blocked on unblocks it; removing another blocked node does not', () => {
    const blockedPair = [
      ...started(),
      ...running('a'),
      ...running('c'),
      ev({ type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', errorClass: 'workerError' }),
      ev({ type: 'nodeBlocked', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', errorClass: 'workerError' }),
      ev({ type: 'runBlocked', blockedNodeId: 'a' }),
    ];
    const cancelOf = (nodeId: string) => ev({
      type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '-1 节点', by: 'ou',
      effects: { cancel: [{ nodeId, instanceId: `${nodeId}#001`, attemptId: `${nodeId}#001/attempts/001` }] },
    });
    // Another blocked node is still in the way: no unblock → re-block churn.
    expect(materialize([...blockedPair, cancelOf('c')])).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'a' });
    // The blocker itself is gone: the run reopens (and re-decides).
    expect(materialize([...blockedPair, cancelOf('a')])).toMatchObject({ runStatus: 'running' });
    // A non-blocker blocked node, and it was the last blocked one.
    const single = [
      ...started(),
      ...running('c'),
      ev({ type: 'nodeBlocked', nodeId: 'c', instanceId: 'c#001', attemptId: 'c#001/attempts/001', errorClass: 'workerError' }),
      ev({ type: 'runBlocked', blockedNodeId: 'x' }),
    ];
    expect(materialize([...single, cancelOf('c')]).runStatus).toBe('running');
    // A revision that removes nothing never reopens a blocked run.
    expect(materialize([...started(), ev({ type: 'runBlocked', blockedNodeId: 'x' }), ev({
      type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
    })]).runStatus).toBe('blocked');
    expect(materialize([...single, ev({
      type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
    })]).runStatus).toBe('blocked');
  });

  it('a rerun also spends the RUN-wide revisit budget', () => {
    const reruns = Array.from({ length: DEFAULT_REVISIT_BUDGET_PER_RUN }, (_, i) => ev({
      type: 'dagRevised', revision: i + 2, baseRevision: i + 1, sha256: 's', patchSha256: 'p', summary: '重做 1', by: 'ou',
      effects: { rerun: [`n${i}`] },
    }));
    const status = revisitBudgetStatus([...started(), ...reruns], 'fresh', 'fresh');
    expect(status).toMatchObject({ ok: false, tier: 'run' });
  });
});

describe('revision fold and the effective DAG', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function writeRevision(runDir: string, revision: number, dag: V3Dag): { sha256: string; patchSha256: string } {
    const paths = v3RevisionFilePaths(runDir, revision);
    mkdirSync(join(runDir, 'dag-revisions'), { recursive: true });
    const bytes = `${JSON.stringify(dag, null, 2)}\n`;
    writeFileSync(paths.dag, bytes);
    const patch = `${JSON.stringify({ revision, ops: [{ op: 'addNode', node: { id: 'b' } }], by: 'ou_i' })}\n`;
    writeFileSync(paths.patch, patch);
    return { sha256: v3RevisionDigest(bytes), patchSha256: v3RevisionDigest(patch) };
  }

  it('without revisions the authorized DAG is returned as-is and no file is read', () => {
    const base = dagOf([goal('a')]);
    const effective = loadEffectiveV3Dag('/nonexistent', base, started());
    expect(effective.dag).toBe(base);
    expect(effective.revision).toBe(1);
  });

  it('applies revisions in journal order and fails closed on a digest mismatch', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'v3-rev-fold-'));
    dirs.push(runDir);
    const base = dagOf([goal('a')]);
    const second = dagOf([goal('a'), goal('b')]);
    const digests = writeRevision(runDir, 2, second);
    const events = [
      ...started(),
      ev({ type: 'dagRevised', revision: 2, baseRevision: 1, ...digests, summary: '+1 节点', by: 'ou_i' }),
    ];
    const effective = loadEffectiveV3Dag(runDir, base, events);
    expect(effective.revision).toBe(2);
    expect(effective.dag.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    const genuine = readFileSync(v3RevisionFilePaths(runDir, 2).dag);
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, `${JSON.stringify(dagOf([goal('a'), goal('evil')]), null, 2)}\n`);
    expect(() => loadEffectiveV3Dag(runDir, base, events)).toThrow(V3RevisionIntegrityError);
    // The patch (who changed what) is pinned too (§13.3).
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, genuine);
    writeFileSync(v3RevisionFilePaths(runDir, 2).patch, '{"by":"ou_someone_else","ops":[]}\n');
    expect(() => loadEffectiveV3Dag(runDir, base, events)).toThrow(V3RevisionIntegrityError);
  });

  it('rejects a broken chain: wrong base, reused number, approval of an unknown proposal', () => {
    const revised = (revision: number, baseRevision: number, approval?: { by: string; proposedBy: string }) =>
      ev({ type: 'dagRevised', revision, baseRevision, sha256: 's', patchSha256: 'p', summary: 'x', by: 'ou', ...(approval ? { approval } : {}) });
    expect(() => foldV3Revisions([revised(2, 3)])).toThrow(V3RevisionIntegrityError);
    expect(() => foldV3Revisions([revised(2, 1), revised(2, 2)])).toThrow(V3RevisionIntegrityError);
    expect(() => foldV3Revisions([revised(2, 1, { by: 'ou_i', proposedBy: 'ou_o' })])).toThrow(V3RevisionIntegrityError);
  });

  it('a pending proposal whose base moved on is stale even if its rejection was never journaled', () => {
    const history = foldV3Revisions([
      ev({ type: 'dagRevisionProposed', revision: 2, baseRevision: 1, sha256: 's2', patchSha256: 'p2', summary: 'x', by: 'ou_o', reasons: ['callerNotInitiator'], touched: ['a'] }),
      ev({ type: 'dagRevised', revision: 3, baseRevision: 1, sha256: 's3', patchSha256: 'p3', summary: 'y', by: 'ou_i' }),
    ]);
    expect(history.current).toBe(3);
    expect(history.pending).toBeUndefined();
    expect(history.records.find((record) => record.revision === 2)?.rejected?.reason).toBe('stale');
  });
});

describe('replay folds revision effects', () => {
  it('a superseded running instance re-dispatches fresh and its late settle is ignored', () => {
    const dag = dagOf([goal('a')]);
    const events = [
      ...started(),
      ...running('a'),
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
        effects: { supersede: [{ nodeId: 'a', instanceId: 'a#001' }] },
      }),
      ev({ type: 'nodeSucceeded', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', manifestPath: '/late' }),
    ];
    const snap = materialize(events);
    expect(snap.nodes.get('a')).toEqual({ status: 'pending' });
    expect(snap.instances.get('a#001')?.status).toBe('superseded');
    expect(decideNext(dag, snap.nodes, snap.loops, snap.edges, snap.instances))
      .toEqual([expect.objectContaining({ kind: 'dispatchWork', nodeId: 'a', instanceId: 'a#002' })]);
  });

  it('a voided gate can no longer be resolved by a late click', () => {
    const events = [
      ...started(),
      ev({ type: 'gateDispatched', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' }),
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
        effects: { supersede: [{ nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' }] },
      }),
      ev({ type: 'gateResolved', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate', resolution: 'approved', by: 'ou' }),
    ];
    const snap = materialize(events);
    expect(snap.nodes.get('g')).toEqual({ status: 'pending' });
    expect(snap.instances.get('g#001')?.status).toBe('superseded');
  });

  it('removing the blocked node reopens a blocked run and its late settle stays audit-only', () => {
    const events = [
      ...started(),
      ...running('a'),
      ev({ type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001', errorClass: 'resultInvalid' }),
      ev({ type: 'runBlocked', blockedNodeId: 'a' }),
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '-1 节点', by: 'ou',
        effects: { cancel: [{ nodeId: 'a', instanceId: 'a#001', attemptId: 'a#001/attempts/001' }] },
      }),
    ];
    const snap = materialize(events);
    expect(snap.runStatus).toBe('running');
    expect(snap.nodes.get('a')?.status).toBe('cancelled');
  });

  it('a revision after a durable cancel request is audit-only', () => {
    const events = [
      ...started(),
      ...running('a'),
      ev({ type: 'runCancelRequested', cancelRequestId: 'c1', by: 'ou' }),
      ev({
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: 'x', by: 'ou',
        effects: { supersede: [{ nodeId: 'a', instanceId: 'a#001' }] },
      }),
    ];
    expect(materialize(events).nodes.get('a')?.status).toBe('running');
  });
});

describe('approved scope and proposal holds (shared by edits, answers and 改派)', () => {
  it('the approved scope is the frozen snapshots plus revision-approved bots; frozen wins a clash', () => {
    const frozen = new Map([['cli_a', { larkAppId: 'cli_a', cliId: 'claude-code', workingDir: '/w' }]]);
    const additions = new Map([
      ['cli_x', { larkAppId: 'cli_x', cliId: 'codex', workingDir: '/x' }],
      ['cli_a', { larkAppId: 'cli_a', cliId: 'other', workingDir: '/elsewhere' }],
    ]);
    const scope = v3ApprovedBotScope(frozen as never, additions as never);
    expect([...scope.keys()]).toEqual(['cli_a', 'cli_x']);
    expect(scope.get('cli_a')).toEqual(frozen.get('cli_a'));
  });

  it('a pending proposal holds the nodes it touches, and every body node of a touched loop', () => {
    const events = [
      ...started(),
      ev({ type: 'nodeDispatched', nodeId: 'l.i001.w', attemptId: 'l.i001.w/attempts/001', loop: { loopId: 'l', iteration: 1, bodyNodeId: 'w' } }),
      ev({ type: 'dagRevisionProposed', revision: 2, baseRevision: 1, sha256: 's2', patchSha256: 'p2', summary: 'x', by: 'ou_o', reasons: ['callerNotInitiator'], touched: ['a', 'l'] }),
    ];
    expect(v3PendingProposalHolds(events, 'a')).toBe(true);
    expect(v3PendingProposalHolds(events, 'l.i001.w')).toBe(true);
    expect(v3PendingProposalHolds(events, 'b')).toBe(false);
    // Decided → nothing held.
    expect(v3PendingProposalHolds([...events, ev({ type: 'dagRevisionRejected', revision: 2, by: 'ou_i', reason: 'rejected' })], 'a')).toBe(false);
  });
});
