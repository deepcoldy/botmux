/**
 * v3-engine.test.ts
 *
 * 下一代 workflow（v3）引擎纯逻辑测试：dag 校验/拓扑、orchestrator 决策、
 * journal append/replay、state 物化与 checkpoint 读写。全部纯逻辑 + 临时目录
 * IO，不 spawn worker、不碰飞书、不依赖 codex 的 ephemeral-pool/manifest。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateDag,
  loadDag,
  topologicalOrder,
  isGoalNode,
  DagValidationError,
  type V3Dag,
} from '../src/workflows/v3/dag.js';
import { decideNext, findSinks, type V3RunState, type V3EdgeRunState } from '../src/workflows/v3/orchestrator.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { materialize, writeState, readState } from '../src/workflows/v3/state.js';

// ── 测试夹具 ──────────────────────────────────────────────────────────────

/** research → summarize 的两节点 DAG（设计稿 §4 的最小闭环）。 */
const TWO_NODE: unknown = {
  runId: 'demo-001',
  nodes: [
    { id: 'research', type: 'goal', goal: '调研 X', depends: [], inputs: [] },
    { id: 'summarize', type: 'goal', goal: '写摘要', depends: ['research'], inputs: [{ from: 'research' }] },
  ],
};

// ── dag 校验 ────────────────────────────────────────────────────────────────

describe('validateDag', () => {
  it('接受合法 DAG 并填默认值', () => {
    const dag = validateDag(TWO_NODE);
    expect(dag.runId).toBe('demo-001');
    expect(dag.nodes).toHaveLength(2);
    expect(dag.nodes[0]!.humanGate).toBeNull(); // 未给 → 归一为 null
    expect(isGoalNode(dag.nodes[0]!)).toBe(true);
  });

  it('一次性吐出全部问题', () => {
    let err: DagValidationError | undefined;
    try {
      validateDag({ runId: 'bad id!', nodes: [{ id: 'a', type: 'goal', goal: '', depends: [], inputs: [] }] });
    } catch (e) {
      err = e as DagValidationError;
    }
    expect(err).toBeInstanceOf(DagValidationError);
    // runId 非法 + goal 为空，两个问题都在
    expect(err!.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('拒绝 type:host（MVP 未实现执行器）', () => {
    expect(() => validateDag({ runId: 'r', nodes: [{ id: 'a', type: 'host', depends: [], inputs: [] }] }))
      .toThrow(/host/);
  });

  it('拒绝 depends 指向不存在的节点', () => {
    expect(() => validateDag({ runId: 'r', nodes: [{ id: 'a', type: 'goal', goal: 'g', depends: ['ghost'], inputs: [] }] }))
      .toThrow(/unknown node "ghost"/);
  });

  it('拒绝 inputs.from 不在 depends 里', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: [], inputs: [{ from: 'a' }] },
      ],
    })).toThrow(/must also be in depends/);
  });

  it('拒绝重复节点 id', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
      ],
    })).toThrow(/duplicate node id "a"/);
  });

  it('拒绝环', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: ['b'], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: ['a'], inputs: [] },
      ],
    })).toThrow(/cycle/);
  });
});

describe('topologicalOrder', () => {
  it('依赖在前，且同层按 id 确定性排序', () => {
    const dag = validateDag({
      runId: 'r',
      nodes: [
        { id: 'c', type: 'goal', goal: 'g', depends: ['a', 'b'], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
      ],
    });
    // a、b 无依赖 → 按 id 升序在前；c 依赖二者 → 最后
    expect(topologicalOrder(dag)).toEqual(['a', 'b', 'c']);
  });
});

// ── orchestrator 决策 ────────────────────────────────────────────────────────

describe('decideNext', () => {
  const dag: V3Dag = validateDag(TWO_NODE);

  it('空状态：只派根节点，依赖未就绪的不派（首派带 #001 实例）', () => {
    const actions = decideNext(dag, new Map());
    expect(actions).toEqual([{ kind: 'dispatchWork', nodeId: 'research', instanceId: 'research#001' }]);
  });

  it('根节点 done 后派下游', () => {
    const state: V3RunState = new Map([['research', { status: 'done' }]]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'dispatchWork', nodeId: 'summarize', instanceId: 'summarize#001' }]);
  });

  it('运行中节点不重复派', () => {
    const state: V3RunState = new Map([['research', { status: 'running' }]]);
    expect(decideNext(dag, state)).toEqual([]);
  });

  it('全部 done → 整 run 成功', () => {
    const state: V3RunState = new Map([
      ['research', { status: 'done' }],
      ['summarize', { status: 'done' }],
    ]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'completeRunSucceeded' }]);
  });

  it('fail-fast：任一节点失败 → 整 run 失败', () => {
    const state: V3RunState = new Map([['research', { status: 'failed' }]]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'completeRunFailed', failedNodeId: 'research' }]);
  });

  it('回溯重派：节点 pending + 有 superseded 实例 → dispatchWork 带 next instanceId', () => {
    // 回溯把 research#001 刷新后,节点回 pending;重派应得 research#002（约束4）。
    const state: V3RunState = new Map([['research', { status: 'pending' }]]);
    const instances: V3RunState = new Map([['research#001', { status: 'superseded' }]]);
    expect(decideNext(dag, state, new Map(), new Map(), instances)).toEqual([
      { kind: 'dispatchWork', nodeId: 'research', instanceId: 'research#002' },
    ]);
  });

  it('首次派发(instances 为空) → 带 #001（instance 是真正运行节点,首派也是实例）', () => {
    expect(decideNext(dag, new Map(), new Map(), new Map(), new Map())).toEqual([
      { kind: 'dispatchWork', nodeId: 'research', instanceId: 'research#001' },
    ]);
  });

  it('humanGate：先派 gate，approved 后派 work', () => {
    const gated = validateDag({
      runId: 'g',
      nodes: [{ id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [], humanGate: { prompt: '批？' } }],
    });
    expect(decideNext(gated, new Map())).toEqual([{ kind: 'dispatchGate', nodeId: 'a', instanceId: 'a#001' }]);
    // gate 已批准（gateCleared）→ 派 work
    const cleared: V3RunState = new Map([['a', { status: 'pending', gateCleared: true }]]);
    expect(decideNext(gated, cleared)).toEqual([{ kind: 'dispatchWork', nodeId: 'a', instanceId: 'a#001' }]);
  });

  it('findSinks 找到末端节点', () => {
    expect(findSinks(dag)).toEqual(['summarize']);
  });

  it('回溯不复用旧条件边 verdict（verdict 绑 source effective instance）', () => {
    const branch = validateDag({
      runId: 'b',
      nodes: [
        { id: 'judge', type: 'goal', goal: 'j', depends: [], inputs: [],
          resultSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['pass', 'fail'] } }, required: ['decision'] } },
        { id: 'pass', type: 'goal', goal: 'p', depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'pass' } }], inputs: [] },
      ],
    });
    // judge 旧实例 #001 的条件边 verdict=active 仍在 edges 里。
    const edges: V3EdgeRunState = new Map([['judge#001->pass', { active: true, sourceAttemptId: 'judge#001/attempts/001' }]]);
    // judge 被回溯刷新：effective 现在是 #002（新实例已成功）。
    const state: V3RunState = new Map([['judge', { status: 'done', effectiveInstanceId: 'judge#002' }]]);
    // pass 的 readiness 必须查 `judge#002->pass`（未解析）→ 重新 resolveEdge，
    // 绝不复用 `judge#001->pass` 的 active verdict（菲菲 review #2）。
    expect(decideNext(branch, state, new Map(), edges)).toEqual([{ kind: 'resolveEdge', from: 'judge', to: 'pass' }]);
  });

  it('条件边 unresolved → 先 resolveEdge，不派下游', () => {
    const branch = validateDag({
      runId: 'branch',
      nodes: [
        {
          id: 'judge',
          type: 'goal',
          goal: 'judge',
          depends: [],
          inputs: [],
          resultSchema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['pass', 'fail'] } },
            required: ['decision'],
          },
        },
        {
          id: 'pass',
          type: 'goal',
          goal: 'pass',
          depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'pass' } }],
          inputs: [],
        },
      ],
    });
    expect(decideNext(branch, new Map([['judge', { status: 'done' }]]))).toEqual([
      { kind: 'resolveEdge', from: 'judge', to: 'pass' },
    ]);
  });

  it('条件分叉：active 路运行，inactive 路 skipped，并级联到 all_success sink', () => {
    const branch = validateDag({
      runId: 'branch',
      nodes: [
        {
          id: 'judge',
          type: 'goal',
          goal: 'judge',
          depends: [],
          inputs: [],
          resultSchema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['pass', 'fail'] } },
            required: ['decision'],
          },
        },
        {
          id: 'pass',
          type: 'goal',
          goal: 'pass',
          depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'pass' } }],
          inputs: [],
        },
        {
          id: 'fail',
          type: 'goal',
          goal: 'fail',
          depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'fail' } }],
          inputs: [],
        },
        { id: 'sink', type: 'goal', goal: 'sink', depends: ['fail'], inputs: [] },
      ],
    });
    const state: V3RunState = new Map([['judge', { status: 'done' }]]);
    const edges = new Map([
      ['judge->pass', { active: true, sourceAttemptId: 'judge/attempts/001' }],
      ['judge->fail', { active: false, sourceAttemptId: 'judge/attempts/001' }],
    ]);
    expect(decideNext(branch, state, new Map(), edges)).toEqual([
      { kind: 'skipNode', nodeId: 'fail', detail: expect.stringContaining('edgeInactive') },
      { kind: 'dispatchWork', nodeId: 'pass', instanceId: 'pass#001' },
    ]);

    const afterSkip: V3RunState = new Map([
      ['judge', { status: 'done' }],
      ['pass', { status: 'done' }],
      ['fail', { status: 'skipped' }],
    ]);
    expect(decideNext(branch, afterSkip, new Map(), edges)).toEqual([
      { kind: 'skipNode', nodeId: 'sink', detail: expect.stringContaining('sourceSkipped') },
    ]);
  });

  it('one_success / quorum 在全部入边已定后判定，并携带 omitted inputs', () => {
    const joins = validateDag({
      runId: 'joins',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', depends: [], inputs: [] },
        { id: 'b', type: 'goal', goal: 'b', depends: [], inputs: [] },
        { id: 'c', type: 'goal', goal: 'c', depends: [], inputs: [] },
        {
          id: 'any',
          type: 'goal',
          goal: 'any',
          depends: ['a', 'b', 'c'],
          triggerRule: 'one_success',
          inputs: [{ from: 'a' }, { from: 'b' }, { from: 'c' }],
        },
        {
          id: 'q',
          type: 'goal',
          goal: 'q',
          depends: ['a', 'b', 'c'],
          triggerRule: { quorum: 2 },
          inputs: [],
        },
      ],
    });
    const oneActive: V3RunState = new Map([
      ['a', { status: 'done' }],
      ['b', { status: 'skipped' }],
      ['c', { status: 'skipped' }],
    ]);
    expect(decideNext(joins, oneActive)).toEqual([
      {
        kind: 'dispatchWork',
        nodeId: 'any',
        instanceId: 'any#001',
        omitted: [
          { from: 'b', reason: 'sourceSkipped' },
          { from: 'c', reason: 'sourceSkipped' },
        ],
      },
      { kind: 'skipNode', nodeId: 'q', detail: expect.stringContaining('quorum') },
    ]);
  });

  it('带 humanGate 的节点若 trigger 不满足则 skipped，不派 gate', () => {
    const gated = validateDag({
      runId: 'gated-skip',
      nodes: [
        { id: 'source', type: 'goal', goal: 's', depends: [], inputs: [] },
        {
          id: 'deploy',
          type: 'goal',
          goal: 'd',
          depends: ['source'],
          inputs: [],
          humanGate: { prompt: 'approve?' },
        },
      ],
    });
    expect(decideNext(gated, new Map([['source', { status: 'skipped' }]]))).toEqual([
      { kind: 'skipNode', nodeId: 'deploy', detail: expect.stringContaining('sourceSkipped') },
    ]);
  });

  it('全 sink skipped → workflow-level failed，不伪造 failedNodeId', () => {
    const branch = validateDag({
      runId: 'all-skipped',
      nodes: [
        { id: 'judge', type: 'goal', goal: 'judge', depends: [], inputs: [] },
        { id: 'a', type: 'goal', goal: 'a', depends: ['judge'], inputs: [] },
        { id: 'b', type: 'goal', goal: 'b', depends: ['judge'], inputs: [] },
      ],
    });
    const state: V3RunState = new Map([
      ['judge', { status: 'done' }],
      ['a', { status: 'skipped' }],
      ['b', { status: 'skipped' }],
    ]);
    expect(decideNext(branch, state)).toEqual([{
      kind: 'completeRunFailed',
      reason: 'allSinksSkipped',
      detail: '2 skipped, 0 cancelled',
    }]);
  });
});

// ── journal + state 物化 ────────────────────────────────────────────────────

describe('journal + state', () => {
  it('append → read → materialize 还原出正确快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-journal-'));
    try {
      const jp = join(dir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'demo-001' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' });
      appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: '/x/manifest.json' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'summarize', attemptId: 'summarize/attempts/001' });

      const events = readJournal(jp);
      expect(events).toHaveLength(4);
      expect(typeof events[0]!.ts).toBe('number');

      const snap = materialize(events);
      expect(snap.runStatus).toBe('running');
      expect(snap.nodes.get('research')!.status).toBe('done');
      expect(snap.nodes.get('summarize')!.status).toBe('running');
      expect(snap.attempts.get('summarize')).toBe('summarize/attempts/001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate 批准 → pending+gateCleared；拒绝 → failed', () => {
    const approved = materialize([
      { ts: 1, type: 'gateDispatched', nodeId: 'a', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'approved', selected: 'ship', by: 'u' },
    ]);
    expect(approved.nodes.get('a')).toEqual({ status: 'pending', gateCleared: true });

    const oldApproved = materialize([
      { ts: 1, type: 'gateDispatched', nodeId: 'a', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'approved', by: 'u' },
    ]);
    expect(oldApproved.nodes.get('a')).toEqual({ status: 'pending', gateCleared: true });

    const rejected = materialize([
      { ts: 1, type: 'gateDispatched', nodeId: 'a', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'rejected', by: 'u' },
    ]);
    expect(rejected.nodes.get('a')!.status).toBe('failed');
  });

  it('runFailed 记录 failedNodeId', () => {
    const snap = materialize([
      { ts: 1, type: 'nodeFailed', nodeId: 'research', attemptId: 'research/attempts/001', errorClass: 'workerError' },
      { ts: 2, type: 'runFailed', failedNodeId: 'research' },
    ]);
    expect(snap.runStatus).toBe('failed');
    expect(snap.failedNodeId).toBe('research');
  });

  it('edgeResolved first-wins + nodeSkipped + allSinksSkipped failureReason', () => {
    const snap = materialize([
      { ts: 1, type: 'edgeResolved', from: 'judge', to: 'pass', sourceAttemptId: 'judge/attempts/001', active: true },
      { ts: 2, type: 'edgeResolved', from: 'judge', to: 'pass', sourceAttemptId: 'judge/attempts/001', active: false },
      { ts: 3, type: 'nodeSkipped', nodeId: 'fail', reason: 'triggerRuleUnsatisfied', detail: 'inactive' },
      { ts: 4, type: 'runFailed', reason: 'allSinksSkipped' },
    ]);
    expect(snap.edges.get('judge->pass')).toEqual({ active: true, sourceAttemptId: 'judge/attempts/001' });
    expect(snap.nodes.get('fail')!.status).toBe('skipped');
    expect(snap.runStatus).toBe('failed');
    expect(snap.failedNodeId).toBeUndefined();
    expect(snap.failureReason).toBe('allSinksSkipped');
  });

  it('STATE checkpoint 原子写 + 读回一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-state-'));
    try {
      const sp = join(dir, 'STATE');
      const snap = materialize([
        { ts: 1, type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' },
        { ts: 2, type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: '/x' },
      ]);
      writeState(sp, snap);
      const back = readState(sp)!;
      expect(back.runStatus).toBe('running');
      expect(back.nodes.get('research')!.status).toBe('done');
      expect(back.attempts.get('research')).toBe('research/attempts/001');
      expect(back.edges).toEqual(new Map());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('STATE checkpoint roundtrip preserves edges and failureReason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-state-edge-'));
    try {
      const sp = join(dir, 'STATE');
      const snap = materialize([
        { ts: 1, type: 'edgeResolved', from: 'judge', to: 'pass', sourceAttemptId: 'judge/attempts/001', active: false },
        { ts: 2, type: 'runFailed', reason: 'allSinksSkipped' },
      ]);
      writeState(sp, snap);
      const back = readState(sp)!;
      expect(back.runStatus).toBe('failed');
      expect(back.failureReason).toBe('allSinksSkipped');
      expect(back.edges.get('judge->pass')).toEqual({ active: false, sourceAttemptId: 'judge/attempts/001' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readJournal 容忍末行截断（崩溃半写）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-torn-'));
    try {
      const jp = join(dir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'r' });
      // 模拟半写的最后一行
      appendFileSync(jp, '{"ts":2,"type":"nodeDispa');
      const events = readJournal(jp);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('runStarted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('instance 层: dispatch 带 instanceId → instances + effectiveInstanceId', () => {
    const snap = materialize([
      { ts: 1, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001' },
      { ts: 2, type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', manifestPath: '/x' },
    ]);
    expect(snap.nodes.get('A')).toEqual({ status: 'done', effectiveInstanceId: 'A#001' });
    expect(snap.instances.get('A#001')!.status).toBe('done');
    // attempts keyed by instanceId (constraint 3)
    expect(snap.attempts.get('A#001')).toBe('A#001/attempts/001');
  });

  it('instance 层: revisit supersede 把目标+下游 instance 刷新, 节点回 pending', () => {
    // A -> B -> C 首轮全成功, C#001 回溯 A → A/B/C #001 全 superseded.
    const snap = materialize([
      { ts: 1, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001' },
      { ts: 2, type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', manifestPath: '/a' },
      { ts: 3, type: 'nodeDispatched', nodeId: 'B', instanceId: 'B#001', attemptId: 'B#001/attempts/001' },
      { ts: 4, type: 'nodeSucceeded', nodeId: 'B', instanceId: 'B#001', attemptId: 'B#001/attempts/001', manifestPath: '/b' },
      { ts: 5, type: 'nodeDispatched', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001' },
      { ts: 6, type: 'nodeSucceeded', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', manifestPath: '/c' },
      { ts: 7, type: 'nodeRevisitRequested', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', toNodeId: 'A', reason: '缺信息' },
      { ts: 8, type: 'nodeInstanceSuperseded', nodeId: 'A', instanceId: 'A#001', byNodeId: 'A', reason: 'refresh' },
      { ts: 9, type: 'nodeInstanceSuperseded', nodeId: 'B', instanceId: 'B#001', byNodeId: 'A', reason: 'refresh' },
      { ts: 10, type: 'nodeInstanceSuperseded', nodeId: 'C', instanceId: 'C#001', byNodeId: 'A', reason: 'refresh' },
    ]);
    // 旧 instance 全 superseded
    expect(snap.instances.get('A#001')!.status).toBe('superseded');
    expect(snap.instances.get('B#001')!.status).toBe('superseded');
    expect(snap.instances.get('C#001')!.status).toBe('superseded');
    // 节点回 pending、effective 清空 → decideNext 会重派 #002
    expect(snap.nodes.get('A')).toEqual({ status: 'pending' });
    expect(snap.nodes.get('B')).toEqual({ status: 'pending' });
    expect(snap.nodes.get('C')).toEqual({ status: 'pending' });
  });

  it('instance 层: 重派 A#002 后 effective 指向新实例; 旧实例迟到 settle 不复活、不解冻刷新态', () => {
    const snap = materialize([
      { ts: 1, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001' },
      { ts: 2, type: 'nodeInstanceSuperseded', nodeId: 'A', instanceId: 'A#001', byNodeId: 'A', reason: 'refresh' },
      { ts: 3, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#002', attemptId: 'A#002/attempts/001' },
      // 旧实例 A#001 的迟到成功（不该把节点拉回 done，也不该把 A#001 从 superseded 变 done）
      { ts: 4, type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', manifestPath: '/stale' },
    ]);
    expect(snap.nodes.get('A')).toEqual({ status: 'running', effectiveInstanceId: 'A#002' });
    expect(snap.instances.get('A#002')!.status).toBe('running');
    // 迟到 settle 不能解冻刷新态：A#001 仍是 superseded（菲菲 review blocker 1）
    expect(snap.instances.get('A#001')!.status).toBe('superseded');
  });

  it('instance 层: gate 挂 instance — A#001 批准不污染 A#002（约束6）', () => {
    const snap = materialize([
      // A#001 的 gate 批准 → A#001 instance gateCleared
      { ts: 1, type: 'gateDispatched', nodeId: 'A', instanceId: 'A#001', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'A', instanceId: 'A#001', waitId: 'w1', resolution: 'approved', by: 'u' },
      // A#001 被回溯刷新
      { ts: 3, type: 'nodeInstanceSuperseded', nodeId: 'A', instanceId: 'A#001', byNodeId: 'A', reason: 'refresh' },
      // 新实例 A#002 的 gate 重新派发（尚未批准）
      { ts: 4, type: 'gateDispatched', nodeId: 'A', instanceId: 'A#002', waitId: 'w2' },
    ]);
    // A#001 先被批准(pending+gateCleared)再被回溯刷新 → 终态 superseded（刷新态冻结）
    expect(snap.instances.get('A#001')!.status).toBe('superseded');
    expect(snap.instances.get('A#002')!.status).toBe('gateWaiting');
    // 节点视图跟最新 effective 实例 A#002：在等审批，gateCleared 没被 A#001 的批准污染
    expect(snap.nodes.get('A')!.status).toBe('gateWaiting');
    expect(snap.nodes.get('A')!.effectiveInstanceId).toBe('A#002');
    expect(snap.nodes.get('A')!.gateCleared).toBeUndefined();
  });
});

// ── loadDag（文件 IO）─────────────────────────────────────────────────────────

describe('loadDag', () => {
  it('读不存在的文件给出清晰错误', () => {
    expect(() => loadDag('/nonexistent/dag.json')).toThrow(/cannot read dag.json/);
  });
});
