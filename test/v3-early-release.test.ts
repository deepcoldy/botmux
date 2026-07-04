import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { validateDag } from '../src/workflows/v3/dag.js';
import { decideNext, type V3RunState } from '../src/workflows/v3/orchestrator.js';
import { appendEvent, readJournal, type StoredEvent } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { runWorkflow, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import { writePendingWait, readWait } from '../src/workflows/v3/human-gate.js';
import { resolveV3GateClick } from '../src/workflows/v3/daemon-run.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    const manifest = await readAndValidateManifest(manifestPath, outputDir);
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
  }
};

function st(entries: Record<string, string>): V3RunState {
  return new Map(Object.entries(entries).map(([k, v]) => [k, { status: v as never }]));
}

function fileProduct(outputDir: string, name: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, name), content);
  return {
    name,
    path: name,
    kind: 'markdown',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: 'text/markdown',
  };
}

function writeManifest(req: Parameters<RunNode>[0], manifest: Manifest): string {
  const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(p, JSON.stringify(manifest));
  return p;
}

describe('v3 early-release / loser cancellation', () => {
  it('one_success 有一票成功时提前 dispatch，并取消不再需要的 running loser', () => {
    const dag = validateDag({
      runId: 'early-one',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a' },
        { id: 'b', type: 'goal', goal: 'b' },
        { id: 'c', type: 'goal', goal: 'c' },
        {
          id: 'merge',
          type: 'goal',
          goal: 'merge',
          depends: ['a', 'b', 'c'],
          triggerRule: 'one_success',
          inputs: [{ from: 'a' }, { from: 'b' }, { from: 'c' }],
        },
      ],
    });

    expect(decideNext(dag, st({ a: 'done', b: 'running', c: 'running' }))).toEqual([
      {
        kind: 'dispatchWork',
        nodeId: 'merge',
        instanceId: 'merge#001',
        omitted: [{ from: 'b', reason: 'earlyRelease' }, { from: 'c', reason: 'earlyRelease' }],
      },
      { kind: 'cancelNode', nodeId: 'b', byNodeId: 'merge', detail: 'early-release loser for "merge"' },
      { kind: 'cancelNode', nodeId: 'c', byNodeId: 'merge', detail: 'early-release loser for "merge"' },
    ]);
  });

  it('防级联误杀：candidate 仍被带活输入的 all_success downstream 需要时不取消', () => {
    const dag = validateDag({
      runId: 'no-cascade-kill',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a' },
        { id: 'b', type: 'goal', goal: 'b' },
        { id: 'c', type: 'goal', goal: 'c' },
        { id: 'merge', type: 'goal', goal: 'merge', depends: ['a', 'b'], triggerRule: 'one_success' },
        { id: 'needsB', type: 'goal', goal: 'needs b and c', depends: ['b', 'c'] },
      ],
    });

    const actions = decideNext(dag, st({ a: 'done', b: 'running', c: 'running' }));
    expect(actions).toContainEqual({ kind: 'dispatchWork', nodeId: 'merge', instanceId: 'merge#001', omitted: [{ from: 'b', reason: 'earlyRelease' }] });
    expect(actions.some((a) => a.kind === 'cancelNode' && a.nodeId === 'b')).toBe(false);
  });

  it('irrelevant blocked loser 不触发 fail-fast，也不会卡住成功判定', () => {
    const dag = validateDag({
      runId: 'irrelevant-blocked',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a' },
        { id: 'b', type: 'goal', goal: 'b' },
        { id: 'merge', type: 'goal', goal: 'merge', depends: ['a', 'b'], triggerRule: 'one_success' },
      ],
    });

    expect(decideNext(dag, st({ a: 'done', b: 'blocked', merge: 'done' }))).toEqual([
      { kind: 'completeRunSucceeded' },
    ]);
  });

  it('materialize: nodeCancelled 后同 attempt 的迟到 settle 被压制', () => {
    const events: StoredEvent[] = [
      { ts: 1, type: 'runStarted', runId: 'cancel-replay' },
      { ts: 2, type: 'nodeDispatched', nodeId: 'b', attemptId: 'b/attempts/001' },
      {
        ts: 3,
        type: 'nodeCancelled',
        nodeId: 'b',
        attemptId: 'b/attempts/001',
        reason: 'earlyReleaseLoser',
        byNodeId: 'merge',
      },
      { ts: 4, type: 'nodeFailed', nodeId: 'b', attemptId: 'b/attempts/001', errorClass: 'workerError' },
    ];

    expect(materialize(events).nodes.get('b')?.status).toBe('cancelled');
  });

  it('materialize: 取消 A#001 不压制 A#002 的成功(instance 化 cancel)', () => {
    const events: StoredEvent[] = [
      { ts: 1, type: 'runStarted', runId: 'cancel-instance' },
      { ts: 2, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001' },
      { ts: 3, type: 'nodeCancelled', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', reason: 'earlyReleaseLoser', byNodeId: 'm' },
      // 回溯后重生的 A#002 正常成功 —— 旧 A#001 的 cancel 不能把它压成 cancelled。
      { ts: 4, type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#002', attemptId: 'A#002/attempts/001' },
      { ts: 5, type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#002', attemptId: 'A#002/attempts/001', manifestPath: '/tmp/m.json' },
    ];
    const snap = materialize(events);
    expect(snap.instances.get('A#001')?.status).toBe('cancelled');
    expect(snap.instances.get('A#002')?.status).toBe('done');
    expect(snap.nodes.get('A')?.status).toBe('done'); // 节点视图 = 当前 effective A#002
  });

  it('runtime: 三路赛马 one_success，赢家发车，败者 abort 后失败不污染终态', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-early-runtime-'));
    try {
      const dag = validateDag({
        runId: 'race-runtime',
        nodes: [
          { id: 'a', type: 'goal', goal: 'winner' },
          { id: 'b', type: 'goal', goal: 'loser b' },
          { id: 'c', type: 'goal', goal: 'loser c' },
          {
            id: 'merge',
            type: 'goal',
            goal: 'merge first result',
            depends: ['a', 'b', 'c'],
            triggerRule: 'one_success',
            inputs: [{ from: 'a' }, { from: 'b' }, { from: 'c' }],
          },
        ],
      });
      const aborted: string[] = [];
      let mergeInputs: GoalInputs | undefined;
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'b' || req.node.id === 'c') {
          return new Promise((resolve) => {
            req.cancelSignal?.addEventListener('abort', () => {
              aborted.push(req.node.id);
              const file = fileProduct(req.outputDir, 'cancelled.md', 'cancelled loser');
              const manifestPath = writeManifest(req, {
                schemaVersion: 1,
                status: 'fail',
                summary: 'cancelled loser',
                error: { code: 'CANCELLED', message: 'aborted after early-release', retryable: false },
                files: [file],
              });
              resolve({ status: 'fail', manifestPath });
            }, { once: true });
          });
        }
        if (req.node.id === 'merge') {
          mergeInputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
        }
        const file = fileProduct(req.outputDir, `${req.node.id}.md`, `# ${req.node.id}`);
        const manifestPath = writeManifest(req, {
          schemaVersion: 1,
          status: 'ok',
          summary: `done ${req.node.id}`,
          files: [file],
        });
        return { status: 'ok', manifestPath };
      };

      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot } satisfies V3RuntimeDeps,
        { baseDir: base, globalConcurrency: 4, perBotConcurrency: 4, perCliConcurrency: 4 },
      );

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(aborted.sort()).toEqual(['b', 'c']);
      expect(mergeInputs?.inputs.map((i) => i.from)).toEqual(['a']);
      expect(mergeInputs?.omitted).toEqual([
        { from: 'b', reason: 'earlyRelease' },
        { from: 'c', reason: 'earlyRelease' },
      ]);
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      expect(events.filter((e) => e.type === 'nodeCancelled').map((e) => e.nodeId).sort()).toEqual(['b', 'c']);
      expect(events.some((e) => e.type === 'runFailed')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancelled gateWaiting loser 的旧审批卡点击 stale，不消费 wait / 不写 gateResolved', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-gate-cancel-'));
    try {
      const runId = 'gate-cancel';
      const runDir = join(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, { type: 'gateDispatched', nodeId: 'review', waitId: 'review-gate' });
      writePendingWait(runDir, { waitId: 'review-gate', nodeId: 'review', prompt: 'approve?' });
      appendEvent(journalPath, {
        type: 'nodeCancelled',
        nodeId: 'review',
        reason: 'earlyReleaseLoser',
        byNodeId: 'merge',
      });

      expect(resolveV3GateClick(base, runId, { waitId: 'review-gate', selected: 'approve', by: 'ou_user' }))
        .toEqual({ kind: 'stale-run', reason: 'stale-node' });
      expect(readWait(runDir, 'review-gate')?.status).toBe('pending');
      expect(readJournal(journalPath).some((e) => e.type === 'gateResolved')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
