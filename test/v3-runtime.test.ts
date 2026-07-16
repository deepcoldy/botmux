/**
 * v3-runtime.test.ts
 *
 * v3 runtime 主循环集成测试 —— 跑设计稿 §4 的最小闭环 research→summarize，
 * 用 codex 的【真实】manifest validator（readAndValidateManifest）+ stub runNode
 * （写真实 manifest 文件）。验证：调度循环 / 文件 IPC 契约 / inputs.json 相对转绝对 /
 * journal 事件流 / fail-fast。不 spawn 真实 CLI（那条 seam 由 ephemeral-pool 自测 +
 * 后续 daemon e2e 覆盖）。
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { runWorkflow, revisitBudgetStatus, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';
import { requestRevisitGrant } from '../src/workflows/v3/daemon-run.js';
import { materialize } from '../src/workflows/v3/state.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import {
  createFileGate,
  writePendingWait,
  readWait,
  resolveWait,
  resolveWaitOnce,
  listPendingWaits,
  waitPath,
  waitsDir,
} from '../src/workflows/v3/human-gate.js';
import {
  GOAL_ENV,
  V3_SUPPORTED_CLIS,
  isV3SupportedCli,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';

const TWO_NODE = {
  runId: 'demo-001',
  nodes: [
    { id: 'research', type: 'goal', goal: '调研 X', depends: [], inputs: [] },
    { id: 'summarize', type: 'goal', goal: '写摘要', depends: ['research'], inputs: [{ from: 'research' }] },
  ],
};

// codex 的 throw-based 校验器 → 适配成 runtime 期望的 result-style（注入边界做）
const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    const manifest = await readAndValidateManifest(manifestPath, outputDir);
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
  }
};

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

/** 写一个真实产物 + 返回它的 manifest file 条目（相对 path + 真实 sha256/bytes）。 */
function product(outputDir: string, name: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, name), content);
  return {
    name,
    path: name, // 相对 outputDir
    kind: 'markdown',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: 'text/markdown',
  };
}

function jsonProduct(outputDir: string, name: string, value: unknown): Manifest['files'][number] {
  const content = JSON.stringify(value);
  writeFileSync(join(outputDir, name), content);
  return {
    name,
    path: name,
    kind: 'json',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: 'application/json',
  };
}

function writeManifest(req: Parameters<RunNode>[0], manifest: Manifest): string {
  const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(p, JSON.stringify(manifest));
  return p;
}

describe('runWorkflow — research→summarize 最小闭环', () => {
  it('happy path：两节点成功 + inputs.json 相对转绝对 + journal 完整', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-ok-'));
    try {
      let summarizeSawResearch = false;
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'summarize') {
          // 下游能从 inputs.json 拿到上游产物的绝对路径并 Read
          const inputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
          const fromResearch = inputs.inputs.find((i) => i.from === 'research');
          summarizeSawResearch = !!fromResearch && isAbsolute(fromResearch.path)
            && readFileSync(fromResearch.path, 'utf-8').includes('RESEARCH-PRODUCT');
        }
        const content = `# ${req.node.id}\nRESEARCH-PRODUCT`;
        const file = product(req.outputDir, 'out.md', content);
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: `done ${req.node.id}`, files: [file],
        });
        return { status: 'ok', manifestPath };
      };

      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(validateDag(TWO_NODE), deps, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      if (outcome.reason !== 'terminal') throw new Error('expected terminal outcome');
      expect(summarizeSawResearch).toBe(true);

      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      expect(events.filter((e) => e.type === 'nodeSucceeded').map((e) => (e as any).nodeId).sort())
        .toEqual(['research', 'summarize']);
      expect(events.some((e) => e.type === 'runSucceeded')).toBe(true);

      const inputs = JSON.parse(
        readFileSync(join(outcome.runDir, 'summarize#001', 'attempts', '001', 'inputs.json'), 'utf-8'),
      ) as GoalInputs;
      expect(inputs.inputs).toHaveLength(1);
      expect(isAbsolute(inputs.inputs[0]!.path)).toBe(true);
      expect(inputs.inputs[0]!.path).toContain(join('research#001', 'attempts', '001', 'work', 'out.md'));

      // goal.txt carries the user goal + the full execution/manifest contract
      // (it is NOT the bare goal string) so the short `/goal` command can just
      // point the agent here without tripping TUI paste-detection.
      const goalFile = readFileSync(join(outcome.runDir, 'research#001', 'attempts', '001', 'goal.txt'), 'utf-8');
      expect(goalFile).toContain('调研 X');                         // the user goal
      expect(goalFile).toContain(GOAL_ENV.MANIFEST_PATH);           // contract references the manifest env
      expect(goalFile).toContain('"schemaVersion": 1');             // rendered manifest shape
      expect(goalFile).toContain('markdown | json | text');         // file-kind enum from contract.ts
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('fail-fast：research 进程失败 → 整 run 失败，summarize 不派', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-fail-'));
    try {
      const runNode: RunNode = async (req) => {
        // 写一个 fail manifest（带 error）模拟节点自报失败
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'fail', summary: 'boom',
          error: { code: 'E_RESEARCH', message: '调研失败' }, files: [],
        });
        return { status: 'fail', manifestPath };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(validateDag(TWO_NODE), deps, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'failed' });
      if (outcome.reason !== 'terminal') throw new Error('expected terminal outcome');
      expect(outcome.failedNodeId).toBe('research');

      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      const failed = events.find((e) => e.type === 'nodeFailed') as any;
      expect(failed.nodeId).toBe('research');
      expect(failed.message).toContain('E_RESEARCH'); // 优先展示 manifest.error
      // summarize 从未被派（无依赖满足）
      expect(events.some((e) => e.type === 'nodeDispatched' && (e as any).nodeId === 'summarize')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('manifest 非法（绝对 path 越权）→ manifestInvalid → blocked（两档语义升级）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-bad-'));
    try {
      const runNode: RunNode = async (req) => {
        // 进程 ok 但 manifest 写了绝对路径 —— codex validator 必须拒
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'x',
          files: [{ name: 'p', path: '/etc/passwd', kind: 'text', bytes: 1, sha256: 'x', mime: 'text/plain' }],
        });
        return { status: 'ok', manifestPath };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(validateDag(TWO_NODE), deps, { baseDir: base });

      // blocked/failed 两档（blocked 设计稿 §5）：agent 写坏 manifest = 契约性
      // 失败，重跑可能修好 → blocked（可 retry），不再折成 failed。
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      if (outcome.reason !== 'terminal') throw new Error('expected terminal outcome');
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      const blocked = events.find((e) => e.type === 'nodeBlocked') as any;
      expect(blocked.nodeId).toBe('research');
      expect(blocked.errorClass).toBe('manifestInvalid');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runWorkflow — Saved Workflow parameter isolation', () => {
  it('delivers only explicitly referenced values to each node', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-param-isolation-'));
    try {
      const dag = validateDag({
        runId: 'param-isolation',
        nodes: [
          {
            id: 'authorized',
            type: 'goal',
            goal: 'Fetch ${params.customer} for ${context.chatId}',
            depends: [],
            inputs: [],
          },
          {
            id: 'unrelated',
            type: 'goal',
            goal: 'Produce an unrelated summary',
            depends: [],
            inputs: [],
          },
        ],
      });
      const seen: Record<string, GoalInputs> = {};
      const runNode: RunNode = async (req) => {
        seen[req.node.id] = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
        const file = product(req.outputDir, 'out.md', `# ${req.node.id}`);
        return {
          status: 'ok',
          manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'done', files: [file],
          }),
        };
      };

      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        {
          baseDir: base,
          resolvedWorkflowData: {
            params: { customer: 'customer-private-value', unused: 'must-not-leak' },
            context: { chatId: 'oc_private', initiatorOpenId: 'ou_private' },
          },
        },
      );

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const authorizedInput = seen.authorized!.inputs.find((item) => item.from === 'workflow');
      expect(authorizedInput).toBeTruthy();
      expect(JSON.parse(readFileSync(authorizedInput!.path, 'utf-8'))).toEqual({
        params: { customer: 'customer-private-value' },
        context: { chatId: 'oc_private' },
      });
      expect(seen.unrelated!.inputs.some((item) => item.from === 'workflow')).toBe(false);
      const unrelatedAttempt = join(base, dag.runId, 'unrelated#001', 'attempts', '001');
      expect(() => readFileSync(join(unrelatedAttempt, 'workflow-inputs.json'), 'utf-8')).toThrow();
      expect(readFileSync(join(unrelatedAttempt, 'goal.txt'), 'utf-8')).not.toContain('customer-private-value');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runWorkflow — model override reaches the worker snapshot', () => {
  it('envelope-backed run uses frozen snapshots and never rewrites authorized artifacts', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-pinned-'));
    try {
      const dag = validateDag({
        runId: 'pinned-001',
        nodes: [{ id: 'work', type: 'goal', goal: 'work', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      mkdirSync(runDir, { recursive: true });
      const dagBytes = '{"authorized":"dag bytes"}\n';
      const botBytes = '{"authorized":"bot bytes"}\n';
      writeFileSync(join(runDir, 'dag.json'), dagBytes);
      writeFileSync(join(runDir, 'bots.snapshot.json'), botBytes);

      const runNode: RunNode = async (req) => {
        expect(req.botSnapshot.workingDir).toBe('/frozen');
        const file = product(req.outputDir, 'out.md', 'done');
        return {
          status: 'ok',
          manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'done', files: [file],
          }),
        };
      };
      const deps: V3RuntimeDeps = {
        runNode,
        validateManifest,
        resolveBotSnapshot: () => { throw new Error('must not resolve live bot'); },
      };
      const outcome = await runWorkflow(dag, deps, {
        baseDir: base,
        authorizedArtifacts: true,
        frozenBotSnapshots: new Map([['', {
          larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/frozen',
        }]]),
      });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(readFileSync(join(runDir, 'dag.json'), 'utf-8')).toBe(dagBytes);
      expect(readFileSync(join(runDir, 'bots.snapshot.json'), 'utf-8')).toBe(botBytes);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('node model override is applied without changing the workflow-wide bypass posture', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-cap-'));
    try {
      const seen: Record<string, BotSnapshot> = {};
      const runNode: RunNode = async (req) => {
        seen[req.node.id] = req.botSnapshot;
        const file = product(req.outputDir, 'out.md', `# ${req.node.id}`);
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'done', files: [file],
        });
        return { status: 'ok', manifestPath };
      };
      const fullPowerResolve = (): BotSnapshot => ({
        larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/tmp', model: 'base-model',
      });
      const dag = validateDag({
        runId: 'cap-001',
        nodes: [
          { id: 'base', type: 'goal', goal: 'base model', depends: [], inputs: [] },
          { id: 'redirected', type: 'goal', goal: 'different model', depends: [], inputs: [], override: { model: 'node-model' } },
        ],
      });
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot: fullPowerResolve };
      const outcome = await runWorkflow(dag, deps, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });

      expect(seen['redirected']?.model).toBe('node-model');
      expect(seen['base']?.model).toBe('base-model');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runWorkflow — edge activation', () => {
  const branchDag = (decision: 'pass' | 'fail' | 'rework') => validateDag({
    runId: `branch-${decision}`,
    nodes: [
      {
        id: 'judge',
        type: 'goal',
        goal: 'judge',
        depends: [],
        inputs: [],
        resultSchema: {
          type: 'object',
          properties: { decision: { type: 'string', enum: ['pass', 'fail', 'rework'] } },
          required: ['decision'],
        },
      },
      {
        id: 'pass',
        type: 'goal',
        goal: 'pass branch',
        depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'pass' } }],
        inputs: [],
      },
      {
        id: 'fail',
        type: 'goal',
        goal: 'fail branch',
        depends: [{ from: 'judge', when: { path: 'result.decision', equals: 'fail' } }],
        inputs: [],
      },
      {
        id: 'merge',
        type: 'goal',
        goal: 'merge taken branch',
        depends: ['pass', 'fail'],
        triggerRule: 'one_success',
        inputs: [{ from: 'pass' }, { from: 'fail' }],
      },
    ],
  });

  it('二选一分叉：edgeResolved journal → inactive branch skipped → merge receives omitted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-edge-'));
    try {
      let mergeInputs: GoalInputs | undefined;
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'judge') {
          const result = jsonProduct(req.outputDir, 'result.json', { decision: 'pass' });
          const manifestPath = writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'decision pass', files: [result],
          });
          return { status: 'ok', manifestPath };
        }
        if (req.node.id === 'merge') {
          mergeInputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
        }
        const file = product(req.outputDir, `${req.node.id}.md`, `# ${req.node.id}`);
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: `done ${req.node.id}`, files: [file],
        });
        return { status: 'ok', manifestPath };
      };

      const outcome = await runWorkflow(branchDag('pass'), { runNode, validateManifest, resolveBotSnapshot }, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      const resolved = events.filter((e) => e.type === 'edgeResolved').map((e) => ({
        from: e.from, to: e.to, active: e.active, sourceAttemptId: e.sourceAttemptId,
      })).sort((a, b) => a.to.localeCompare(b.to));
      expect(resolved).toEqual([
        { from: 'judge', to: 'fail', active: false, sourceAttemptId: 'judge#001/attempts/001' },
        { from: 'judge', to: 'pass', active: true, sourceAttemptId: 'judge#001/attempts/001' },
      ]);
      expect(events.some((e) => e.type === 'nodeSkipped' && e.nodeId === 'fail')).toBe(true);
      expect(events.some((e) => e.type === 'nodeDispatched' && e.nodeId === 'fail')).toBe(false);
      expect(events.some((e) => e.type === 'nodeSucceeded' && e.nodeId === 'merge')).toBe(true);
      expect(mergeInputs?.inputs.map((i) => i.from)).toEqual(['pass']);
      expect(mergeInputs?.omitted).toEqual([{ from: 'fail', reason: 'sourceSkipped' }]);
      const mergeGoal = readFileSync(join(outcome.runDir, 'merge#001', 'attempts', '001', 'goal.txt'), 'utf-8');
      expect(mergeGoal).toContain('omitted');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('全 sink skipped → runFailed(reason=allSinksSkipped)，不伪造 failedNodeId', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-all-skipped-'));
    try {
      const dag = validateDag({
        runId: 'all-skipped',
        nodes: branchDag('rework').nodes.filter((n) => n.id !== 'merge'),
      });
      const runNode: RunNode = async (req) => {
        const result = jsonProduct(req.outputDir, 'result.json', { decision: 'rework' });
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'decision rework', files: [result],
        });
        return { status: 'ok', manifestPath };
      };

      const outcome = await runWorkflow(dag, { runNode, validateManifest, resolveBotSnapshot }, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'failed', failureReason: 'allSinksSkipped' });
      if (outcome.reason !== 'terminal') throw new Error('expected terminal outcome');
      expect(outcome.failedNodeId).toBeUndefined();
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      const runFailed = events.find((e) => e.type === 'runFailed');
      expect(runFailed).toMatchObject({ type: 'runFailed', reason: 'allSinksSkipped' });
      expect((runFailed as { failedNodeId?: string } | undefined)?.failedNodeId).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('已 journal 的 edgeResolved 可恢复推进，不重读 source result.json', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-edge-resume-'));
    try {
      const dag = validateDag({
        runId: 'resume-edge',
        nodes: [
          {
            id: 'judge',
            type: 'goal',
            goal: 'judge',
            depends: [],
            inputs: [],
            resultSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['pass'] } },
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
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const manifestPath = join(runDir, 'judge', 'attempts', '001', 'manifest.json');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, {
        type: 'nodeSucceeded',
        nodeId: 'judge',
        attemptId: 'judge/attempts/001',
        manifestPath,
      });
      appendEvent(journalPath, {
        type: 'edgeResolved',
        from: 'judge',
        to: 'pass',
        sourceAttemptId: 'judge/attempts/001',
        active: true,
      });

      let passRan = false;
      const runNode: RunNode = async (req) => {
        passRan = req.node.id === 'pass';
        const file = product(req.outputDir, 'pass.md', '# pass');
        const outManifest = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'pass', files: [file],
        });
        return { status: 'ok', manifestPath: outManifest };
      };

      const outcome = await runWorkflow(dag, { runNode, validateManifest, resolveBotSnapshot }, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(passRan).toBe(true);
      const events = readJournal(journalPath);
      expect(events.filter((e) => e.type === 'edgeResolved')).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runWorkflow — humanGate suspend mode', () => {
  it('suspend 模式：派 gate 后写 pending wait 并返回 awaitingGate；批准后 redrive 继续跑 work', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-gate-'));
    try {
      const dag = validateDag({
        runId: 'gate-run',
        nodes: [{
          id: 'deploy',
          type: 'goal',
          goal: 'deploy',
          depends: [],
          inputs: [],
          humanGate: { prompt: '批准部署？' },
        }],
      });
      let runNodeCalls = 0;
      const runNode: RunNode = async (req) => {
        runNodeCalls++;
        const file = product(req.outputDir, 'deploy.md', '# deployed');
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'deployed', files: [file],
        });
        return { status: 'ok', manifestPath };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };

      const first = await runWorkflow(dag, deps, { baseDir: base, gateMode: 'suspend' });

      expect(first).toEqual({
        reason: 'awaitingGate',
        runDir: join(base, 'gate-run'),
        pendingWaits: [{
          nodeId: 'deploy',
          waitId: 'deploy#001-gate',
          prompt: '批准部署？',
          options: ['approve', 'reject'],
          approveOptions: ['approve'],
          approvers: [],
        }],
      });
      expect(runNodeCalls).toBe(0);
      expect(readWait(first.runDir, 'deploy#001-gate')).toMatchObject({
        status: 'pending',
        nodeId: 'deploy',
        prompt: '批准部署？',
      });
      let events = readJournal(join(first.runDir, 'journal.ndjson'));
      expect(events.some((e) => e.type === 'gateDispatched' && e.nodeId === 'deploy')).toBe(true);
      expect(events.some((e) => e.type === 'nodeDispatched' && e.nodeId === 'deploy')).toBe(false);

      resolveWait(first.runDir, 'deploy#001-gate', 'approved', 'ou_reviewer');
      appendEvent(join(first.runDir, 'journal.ndjson'), {
        type: 'gateResolved',
        nodeId: 'deploy',
        waitId: 'deploy#001-gate',
        resolution: 'approved',
        by: 'ou_reviewer',
      });

      const second = await runWorkflow(dag, deps, { baseDir: base, gateMode: 'suspend' });
      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(runNodeCalls).toBe(1);
      events = readJournal(join(second.runDir, 'journal.ndjson'));
      expect(events.some((e) => e.type === 'nodeSucceeded' && e.nodeId === 'deploy')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('suspend 模式：并发 work 先 settle，之后才返回 awaitingGate', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-gate-par-'));
    try {
      const dag = validateDag({
        runId: 'gate-parallel',
        nodes: [
          {
            id: 'approval',
            type: 'goal',
            goal: 'approval',
            depends: [],
            inputs: [],
            humanGate: { prompt: '批准？' },
          },
          { id: 'research', type: 'goal', goal: 'research', depends: [], inputs: [] },
        ],
      });
      const runNode: RunNode = async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const file = product(req.outputDir, 'research.md', '# facts');
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'facts', files: [file],
        });
        return { status: 'ok', manifestPath };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };

      const outcome = await runWorkflow(dag, deps, { baseDir: base, gateMode: 'suspend', globalConcurrency: 2 });

      expect(outcome).toMatchObject({ reason: 'awaitingGate' });
      if (outcome.reason !== 'awaitingGate') throw new Error('expected awaitingGate outcome');
      expect(outcome.pendingWaits).toEqual([{
        nodeId: 'approval',
        waitId: 'approval#001-gate',
        prompt: '批准？',
        options: ['approve', 'reject'],
        approveOptions: ['approve'],
        approvers: [],
      }]);
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      expect(events.some((e) => e.type === 'nodeSucceeded' && e.nodeId === 'research')).toBe(true);
      expect(readWait(outcome.runDir, 'approval#001-gate')?.status).toBe('pending');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('默认 blocking 模式保持 CLI/dev 语义：resolveGate 批准后同一次 run 继续执行', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-gate-block-'));
    try {
      const dag = validateDag({
        runId: 'gate-block',
        nodes: [{
          id: 'deploy',
          type: 'goal',
          goal: 'deploy',
          depends: [],
          inputs: [],
          humanGate: { prompt: '批准部署？' },
        }],
      });
      const runNode: RunNode = async (req) => {
        const file = product(req.outputDir, 'deploy.md', '# deployed');
        const manifestPath = writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'deployed', files: [file],
        });
        return { status: 'ok', manifestPath };
      };
      const resolveGate = createFileGate({
        awaitDecision: async () => ({ resolution: 'approved', by: 'ou_cli' }),
      });
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot, resolveGate };

      const outcome = await runWorkflow(dag, deps, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(readWait(outcome.runDir, 'deploy#001-gate')).toMatchObject({ status: 'approved', by: 'ou_cli' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('blocking 模式 gateResolved 事件带 instanceId（对齐 gateDispatched）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-gate-inst-'));
    try {
      const dag = validateDag({
        runId: 'gate-inst',
        nodes: [{ id: 'deploy', type: 'goal', goal: 'deploy', depends: [], inputs: [], humanGate: { prompt: '批准？' } }],
      });
      const runNode: RunNode = async (req) => {
        const file = product(req.outputDir, 'out.md', '# ok');
        return { status: 'ok', manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'ok', files: [file] }) };
      };
      const resolveGate = createFileGate({ awaitDecision: async () => ({ resolution: 'approved', by: 'ou_cli' }) });
      const outcome = await runWorkflow(dag, { runNode, validateManifest, resolveBotSnapshot, resolveGate }, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });

      // The gateResolved journal event MUST carry instanceId. Without it, state.ts
      // takes the legacy per-node branch (set by nodeId) instead of the
      // effective-instance-guarded branch, so a late gate resolve after a revisit
      // re-dispatched a new instance would overwrite the node view and pollute it.
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      const dispatched = events.find((e) => e.type === 'gateDispatched') as any;
      const resolved = events.find((e) => e.type === 'gateResolved') as any;
      expect(dispatched?.instanceId).toBe('deploy#001');
      expect(resolved?.instanceId).toBe('deploy#001');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('materialize：旧 instance 的 gateResolved 迟到不污染新 instance 的 node view', () => {
    // D#001 gate waiting → revisit supersedes it & re-dispatches D#002 (now the
    // effective instance, also gateWaiting) → the OLD D#001 gate resolves LATE.
    // Because the event carries instanceId, state.ts only mirrors to the node view
    // when it's the effective instance — so node D stays on D#002/gateWaiting and is
    // NOT flipped to pending by D#001's stale approval.
    const snap = materialize([
      { ts: 1, type: 'nodeDispatched', nodeId: 'D', instanceId: 'D#001', attemptId: 'D#001/attempts/001' },
      { ts: 2, type: 'gateDispatched', nodeId: 'D', instanceId: 'D#001', waitId: 'D#001-gate' },
      { ts: 3, type: 'nodeInstanceSuperseded', nodeId: 'D', instanceId: 'D#001', byNodeId: 'X', reason: 'revisit' },
      { ts: 4, type: 'nodeDispatched', nodeId: 'D', instanceId: 'D#002', attemptId: 'D#002/attempts/001' },
      { ts: 5, type: 'gateDispatched', nodeId: 'D', instanceId: 'D#002', waitId: 'D#002-gate' },
      { ts: 6, type: 'gateResolved', nodeId: 'D', instanceId: 'D#001', waitId: 'D#001-gate', resolution: 'approved', by: 'ou_x' },
    ]);
    expect(snap.nodes.get('D')?.effectiveInstanceId).toBe('D#002');
    expect(snap.nodes.get('D')?.status).toBe('gateWaiting'); // NOT polluted to 'pending'
    expect(snap.instances.get('D#002')?.status).toBe('gateWaiting');
    expect(snap.instances.get('D#001')?.status).toBe('pending'); // the stale instance itself did resolve
  });
});

describe('human-gate 文件等待存储', () => {
  it('pending → resolve 持久化 + listPendingWaits 只列未决', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-gate-'));
    try {
      writePendingWait(dir, { waitId: 'g1', nodeId: 'a', prompt: '批 a？' });
      writePendingWait(dir, { waitId: 'g2', nodeId: 'b', prompt: '批 b？' });
      expect(readWait(dir, 'g1')!.status).toBe('pending');
      expect(listPendingWaits(dir).map((w) => w.waitId).sort()).toEqual(['g1', 'g2']);

      resolveWait(dir, 'g1', 'approved', 'ou_x');
      const g1 = readWait(dir, 'g1')!;
      expect(g1.status).toBe('approved');
      expect(g1.by).toBe('ou_x');
      expect(typeof g1.resolvedAt).toBe('number');
      expect(listPendingWaits(dir).map((w) => w.waitId)).toEqual(['g2']); // 已决不再列入
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveWait 找不到等待时抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-gate-x-'));
    try {
      expect(() => resolveWait(dir, 'ghost', 'approved', 'u')).toThrow(/no pending wait/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveWaitOnce 跨进程 CAS 以第一个决议为准', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-gate-cas-'));
    try {
      writePendingWait(dir, { waitId: 'deploy#001-gate', nodeId: 'deploy', prompt: 'ship?' });
      expect(resolveWaitOnce(dir, 'deploy#001-gate', 'rejected', 'ou_first')).toMatchObject({
        changed: true,
        wait: { status: 'rejected', by: 'ou_first' },
      });
      expect(resolveWaitOnce(dir, 'deploy#001-gate', 'approved', 'ou_second')).toMatchObject({
        changed: false,
        wait: { status: 'rejected', by: 'ou_first' },
      });
      expect(readWait(dir, 'deploy#001-gate')).toMatchObject({ status: 'rejected', by: 'ou_first' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host wait 以 0600/0700 持久化，且拒绝 final/parent symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'v3-gate-private-'));
    const runDir = join(root, 'run');
    const outside = join(root, 'outside');
    mkdirSync(runDir, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    try {
      const approval = {
        attemptId: 'send#001/attempts/001',
        approvalDigest: `sha256:${'a'.repeat(64)}`,
        inputHash: `sha256:${'b'.repeat(64)}`,
      };
      writePendingWait(runDir, {
        waitId: 'send#001-host-001-gate',
        nodeId: 'send',
        instanceId: 'send#001',
        prompt: 'approve exact input',
        hostApproval: approval,
      });
      expect(statSync(waitPath(runDir, 'send#001-host-001-gate')).mode & 0o077).toBe(0);
      expect(statSync(waitsDir(runDir)).mode & 0o077).toBe(0);

      const externalFile = join(outside, 'victim.json');
      writeFileSync(externalFile, 'unchanged', { mode: 0o600 });
      symlinkSync(externalFile, waitPath(runDir, 'evil'));
      expect(() => writePendingWait(runDir, {
        waitId: 'evil', nodeId: 'send', prompt: 'x', hostApproval: approval,
      })).toThrow(/regular file/);
      expect(readFileSync(externalFile, 'utf-8')).toBe('unchanged');

      rmSync(waitsDir(runDir), { recursive: true, force: true });
      symlinkSync(outside, waitsDir(runDir));
      expect(() => writePendingWait(runDir, {
        waitId: 'escape', nodeId: 'send', prompt: 'x', hostApproval: approval,
      })).toThrow(/real directory/);
      expect(existsSync(join(outside, 'escape.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('createFileGate：决策前已 pending，决策后落盘 resolved 并返回结果', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-gate-f-'));
    try {
      let statusAtDecision: string | undefined;
      const gate = createFileGate({
        awaitDecision: async (wait) => {
          statusAtDecision = readWait(dir, wait.waitId)!.status;
          return { resolution: 'approved', by: 'ou_z' };
        },
      });
      const res = await gate({ nodeId: 'a', prompt: '批？', waitId: 'g1', runDir: dir });
      expect(res).toEqual({ resolution: 'approved', by: 'ou_z', selected: undefined });
      expect(statusAtDecision).toBe('pending');
      expect(readWait(dir, 'g1')!.status).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime CLI 白名单守卫', () => {
  it('白名单包含五个已验证 /goal 的 CLI', () => {
    expect(V3_SUPPORTED_CLIS).toEqual(['claude-code', 'codex', 'seed', 'traex', 'relay']);
    for (const cliId of V3_SUPPORTED_CLIS) expect(isV3SupportedCli(cliId)).toBe(true);
    expect(isV3SupportedCli('gemini')).toBe(false);
  });

  it('节点 bot 解析到未验证 /goal 的 CLI → run 启动即报错', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cli-guard-'));
    try {
      const deps: V3RuntimeDeps = {
        runNode: async () => ({ status: 'ok', manifestPath: '' }),
        validateManifest,
        resolveBotSnapshot: () => ({ larkAppId: 'a', cliId: 'gemini', workingDir: '/tmp' }),
      };
      await expect(runWorkflow(validateDag(TWO_NODE), deps, { baseDir: base }))
        .rejects.toThrow(/not supported by v3 goal-mode/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each(V3_SUPPORTED_CLIS)('%s CLI 放行', async (cliId) => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cli-ok-'));
    try {
      const runNode: RunNode = async (req) => {
        const file = product(req.outputDir, 'o.md', '# ok');
        const mp = writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 's', files: [file] });
        return { status: 'ok', manifestPath: mp };
      };
      const deps: V3RuntimeDeps = {
        runNode, validateManifest,
        resolveBotSnapshot: () => ({ larkAppId: 'a', cliId, workingDir: '/tmp' }),
      };
      const dag = validateDag({ runId: `cli-${cliId}`, nodes: [{ id: 'n', type: 'goal', goal: 'g', depends: [], inputs: [] }] });
      const outcome = await runWorkflow(dag, deps, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('seed CLI 放行（claude-code 家族 fork，原生 /goal）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cli-seed-'));
    try {
      const runNode: RunNode = async (req) => {
        const file = product(req.outputDir, 'o.md', '# ok');
        const mp = writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 's', files: [file] });
        return { status: 'ok', manifestPath: mp };
      };
      const deps: V3RuntimeDeps = {
        runNode, validateManifest,
        resolveBotSnapshot: () => ({ larkAppId: 'a', cliId: 'seed', workingDir: '/tmp' }),
      };
      const dag = validateDag({ runId: 'seed-run', nodes: [{ id: 'n', type: 'goal', goal: 'g', depends: [], inputs: [] }] });
      const outcome = await runWorkflow(dag, deps, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ─── 跨节点回溯 A→B→C 端到端（菲菲的精确验收）────────────────────────────────
describe('runWorkflow — 跨节点 revisit A→B→C', () => {
  it('C#001 回溯 A → A/B/C#001 全 superseded → 重生 #002 → 仅 C#002 done run 才成功; B#002 读 A#002', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-revisit-'));
    try {
      const dag = validateDag({
        runId: 'revisit-abc',
        nodes: [
          { id: 'A', type: 'goal', goal: 'a', depends: [], inputs: [] },
          { id: 'B', type: 'goal', goal: 'b', depends: ['A'], inputs: [{ from: 'A' }] },
          // C 声明可回溯到祖先 A
          { id: 'C', type: 'goal', goal: 'c', depends: ['B'], inputs: [{ from: 'B' }], revisitTo: ['A'] },
        ],
      });
      let cRuns = 0;
      let bSawAContent = '';
      let aRevisitFeedback: GoalInputs['inputs'] = [];
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'A') {
          // A#002 是回溯目标的重跑：捕获注入的 from:revisit 反馈。
          if (req.attemptId.startsWith('A#002')) {
            const inputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
            aRevisitFeedback = inputs.inputs.filter((i) => i.from === 'revisit');
          }
          // 第二次跑(A#002)产出不同内容,用来验证 B#002 读到的是新版
          const content = req.attemptId.startsWith('A#002') ? 'A-v2' : 'A-v1';
          return { status: 'ok', manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'a', files: [product(req.outputDir, 'a.md', content)],
          }) };
        }
        if (req.node.id === 'B') {
          const inputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
          const fromA = inputs.inputs.find((i) => i.from === 'A');
          if (fromA && req.attemptId.startsWith('B#002')) bSawAContent = readFileSync(fromA.path, 'utf-8');
          return { status: 'ok', manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'b', files: [product(req.outputDir, 'b.md', 'B-out')],
          }) };
        }
        // C: 首个 instance(C#001)写 result.json 请求回溯到 A；第二个(C#002)正常成功。
        cRuns++;
        if (req.attemptId.startsWith('C#001')) {
          const rj = jsonProduct(req.outputDir, 'result.json', { status: 'revisit', revisitTo: 'A', reason: '缺计费规则' });
          return { status: 'ok', manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'revisit', files: [rj],
          }) };
        }
        return { status: 'ok', manifestPath: writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'c done', files: [product(req.outputDir, 'c.md', 'C-out')],
        }) };
      };

      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(dag, deps, { baseDir: base });

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));

      // C 请求了回溯到 A
      const rr = events.find((e) => e.type === 'nodeRevisitRequested' && (e as any).toNodeId === 'A') as any;
      expect(rr).toBeDefined();
      // 协议:journal 里三个 feedback 路径都是 runDir 相对(可搬迁 + 不泄漏本机绝对路径)
      expect(isAbsolute(rr.reasonPath)).toBe(false);
      expect(isAbsolute(rr.sourceManifestPath)).toBe(false);
      expect(isAbsolute(rr.targetPreviousManifestPath)).toBe(false);
      // A/B/C 的 #001 实例全部被 supersede（刷新）
      expect(events.filter((e) => e.type === 'nodeInstanceSuperseded').map((e) => (e as any).instanceId).sort())
        .toEqual(['A#001', 'B#001', 'C#001']);
      // 重新生成 #002 三个实例
      expect(events.filter((e) => e.type === 'nodeDispatched' && (e as any).instanceId?.endsWith('#002'))
        .map((e) => (e as any).instanceId).sort()).toEqual(['A#002', 'B#002', 'C#002']);
      // 只有 C#002 成功（C#001 是 revisit,不算成功终态）
      expect(events.some((e) => e.type === 'nodeSucceeded' && (e as any).instanceId === 'C#002')).toBe(true);
      expect(events.some((e) => e.type === 'nodeSucceeded' && (e as any).instanceId === 'C#001')).toBe(false);
      // B#002 的 inputs 来自 A#002（新版产物），不是 A#001
      expect(bSawAContent).toBe('A-v2');
      // A#002(回溯目标重跑)拿到三件套 feedback:reason + 下游(C)产出 + A 自己旧产出。
      expect(aRevisitFeedback.some((i) => i.name === 'reason' && (i.preview ?? '').includes('缺计费规则'))).toBe(true);
      expect(aRevisitFeedback.some((i) => i.name.startsWith('source:'))).toBe(true); // C 的 result.json
      // previous: A#001 的旧产物 a.md(内容 'A-v1')
      const prev = aRevisitFeedback.find((i) => i.name.startsWith('previous:'));
      expect(prev).toBeDefined();
      expect(readFileSync(prev!.path, 'utf-8')).toBe('A-v1');
      // C 一共跑了 2 次（#001 回溯 + #002 成功）
      expect(cRuns).toBe(2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('buildInputs 抗旧实例迟到成功：journal 里 A 最后一条 success 是迟到的 A#001,B 仍读 A#002', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-latestale-'));
    try {
      const dag = validateDag({
        runId: 'late',
        nodes: [
          { id: 'A', type: 'goal', goal: 'a', depends: [], inputs: [] },
          { id: 'B', type: 'goal', goal: 'b', depends: ['A'], inputs: [{ from: 'A' }] },
        ],
      });
      const runDir = join(base, 'late');
      const writeA = (inst: string, content: string): string => {
        const work = join(runDir, inst, 'attempts', '001', 'work');
        mkdirSync(work, { recursive: true });
        const file = product(work, 'a.md', content);
        const mp = join(runDir, inst, 'attempts', '001', 'manifest.json');
        writeFileSync(mp, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'a', files: [file] }));
        return mp;
      };
      const m1 = writeA('A#001', 'A-v1');
      const m2 = writeA('A#002', 'A-v2');
      const jp = join(runDir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'late' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001' });
      appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', manifestPath: m1 });
      appendEvent(jp, { type: 'nodeInstanceSuperseded', nodeId: 'A', instanceId: 'A#001', byNodeId: 'A', reason: 'refresh' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'A', instanceId: 'A#002', attemptId: 'A#002/attempts/001' });
      appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#002', attemptId: 'A#002/attempts/001', manifestPath: m2 });
      // 旧 A#001 worker 迟到再写一次 success → journal 里 A 的“最后一条” success 是 A#001（nodeId-latest 会被它骗到）
      appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'A', instanceId: 'A#001', attemptId: 'A#001/attempts/001', manifestPath: m1 });

      let bSawA = '';
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'B') {
          const inputs = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
          const fromA = inputs.inputs.find((i) => i.from === 'A');
          bSawA = fromA ? readFileSync(fromA.path, 'utf-8') : '(none)';
        }
        return { status: 'ok', manifestPath: writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'b', files: [product(req.outputDir, 'b.md', 'B-out')],
        }) };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(dag, deps, { baseDir: base });
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      // 关键:按 effective instance(A#002)取产物,不被迟到的 A#001 success 污染。
      expect(bSawA).toBe('A-v2');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('回溯预算:per-pair 默认 1,第二次 C→A 回溯耗尽 → run blocked(防无限回溯)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-budget-'));
    try {
      const dag = validateDag({
        runId: 'budget-abc',
        nodes: [
          { id: 'A', type: 'goal', goal: 'a', depends: [], inputs: [] },
          { id: 'C', type: 'goal', goal: 'c', depends: ['A'], inputs: [{ from: 'A' }], revisitTo: ['A'] },
        ],
      });
      let cRuns = 0;
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'A') {
          return { status: 'ok', manifestPath: writeManifest(req, {
            schemaVersion: 1, status: 'ok', summary: 'a', files: [product(req.outputDir, 'a.md', 'A')],
          }) };
        }
        // C 每次都请求回溯到 A（永不满意）。
        cRuns++;
        const rj = jsonProduct(req.outputDir, 'result.json', { status: 'revisit', revisitTo: 'A', reason: '还是不行' });
        return { status: 'ok', manifestPath: writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'revisit', files: [rj],
        }) };
      };
      const deps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
      const outcome = await runWorkflow(dag, deps, { baseDir: base });

      // C#001 回溯(允许)→ A#002 + C#002 → C#002 再回溯(pair 1/1 耗尽)→ C#002 blocked → run blocked
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      const events = readJournal(join(outcome.runDir, 'journal.ndjson'));
      expect(events.filter((e) => e.type === 'nodeRevisitRequested').length).toBe(1); // 只放行了 1 次
      expect(events.some((e) => e.type === 'nodeBlocked' && (e as any).errorCode === 'REVISIT_BUDGET_EXHAUSTED')).toBe(true);
      expect(cRuns).toBe(2); // C#001(放行) + C#002(被预算挡下)
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('回溯预算:revisitBudgetStatus 计数 + grant 事件解锁(纯函数,不泄漏别的 pair)', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-budgetstatus-'));
    try {
      const jp = join(base, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'g' });
      appendEvent(jp, { type: 'nodeRevisitRequested', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', toNodeId: 'A' });
      expect(revisitBudgetStatus(readJournal(jp), 'C', 'A').ok).toBe(false); // pair 1/1 耗尽
      // pair grant +1（直接 append 事件,测计数,不经 requestRevisitGrant 的恢复语义）
      appendEvent(jp, { type: 'revisitBudgetGranted', sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user' });
      expect(revisitBudgetStatus(readJournal(jp), 'C', 'A').ok).toBe(true);  // 1 < 1+1
      expect(revisitBudgetStatus(readJournal(jp), 'D', 'A').ok).toBe(true);  // pair grant 不泄漏到 D→A
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('回溯预算:requestRevisitGrant 守卫 + 原子 grant+retry 恢复', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-grant-'));
    try {
      const runId = 'g';
      const jp = join(base, runId, 'journal.ndjson');
      // First event creates the historical run directory; legacy mutation
      // authorization then verifies the canonical DAG identity below.
      appendEvent(jp, { type: 'runStarted', runId });
      writeFileSync(join(base, runId, 'dag.json'), JSON.stringify({
        runId,
        nodes: [{ id: 'C', type: 'goal', goal: 'c', depends: [], inputs: [] }],
      }));
      // 造一个"卡在 REVISIT_BUDGET_EXHAUSTED"的 run:C#002 想回溯 A 但预算耗尽。
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001' });
      appendEvent(jp, { type: 'nodeRevisitRequested', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', toNodeId: 'A' });
      appendEvent(jp, {
        type: 'nodeBlocked', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001',
        errorClass: 'resultInvalid', errorCode: 'REVISIT_BUDGET_EXHAUSTED', message: 'exhausted',
      });
      appendEvent(jp, { type: 'runBlocked', blockedNodeId: 'C' });

      // 守卫:半个 pair → invalid;pair source 不是 blocked 节点 → invalid。
      expect(requestRevisitGrant(base, runId, { sourceNodeId: 'C', by: 'u' })).toEqual({ kind: 'invalid', reason: 'partial-pair' });
      expect(requestRevisitGrant(base, runId, { sourceNodeId: 'X', toNodeId: 'A', by: 'u' })).toEqual({ kind: 'invalid', reason: 'pair-source-mismatch' });
      // stale attempt → 拒绝
      expect(requestRevisitGrant(base, runId, { sourceNodeId: 'C', toNodeId: 'A', by: 'u', expectedAttemptId: 'C#002/attempts/999' }))
        .toEqual({ kind: 'stale-run', reason: 'stale-attempt' });

      // 合法 pair grant → granted + 原子 retry(C 重新派 attempts/002)
      const out = requestRevisitGrant(base, runId, { sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user', expectedAttemptId: 'C#002/attempts/001' });
      expect(out.kind).toBe('granted');
      if (out.kind !== 'granted') throw new Error('expected granted');
      expect(out.scope).toBe('pair');
      expect(out.retry).toMatchObject({ kind: 'requested', nodeId: 'C', nextAttemptId: 'C#002/attempts/002' });
      // 预算确实加了
      const events = readJournal(jp);
      expect(events.filter((e) => e.type === 'revisitBudgetGranted').length).toBe(1);
      // 幂等/新鲜度:retry 后 C 已 pending,再点 grant → not-budget-blocked,不再加预算
      expect(requestRevisitGrant(base, runId, { sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user' }))
        .toEqual({ kind: 'stale-run', reason: 'not-budget-blocked' });
      expect(readJournal(jp).filter((e) => e.type === 'revisitBudgetGranted').length).toBe(1); // 没多加
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('回溯预算:grant 已写但 retry 未写的崩溃窗口 → 不重复加预算,只补 retry(recovery-safe)', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-rt-grant-crash-'));
    try {
      const runId = 'g';
      const jp = join(base, runId, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId });
      writeFileSync(join(base, runId, 'dag.json'), JSON.stringify({
        runId,
        nodes: [{ id: 'C', type: 'goal', goal: 'c', depends: [], inputs: [] }],
      }));
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001' });
      appendEvent(jp, { type: 'nodeRevisitRequested', nodeId: 'C', instanceId: 'C#001', attemptId: 'C#001/attempts/001', toNodeId: 'A' });
      appendEvent(jp, {
        type: 'nodeBlocked', nodeId: 'C', instanceId: 'C#002', attemptId: 'C#002/attempts/001',
        errorClass: 'resultInvalid', errorCode: 'REVISIT_BUDGET_EXHAUSTED', message: 'exhausted', revisitTo: 'A',
      });
      appendEvent(jp, { type: 'runBlocked', blockedNodeId: 'C' });
      // 崩溃窗口:grant 已写(预算已 ok),但 retry 还没写 —— 节点仍 blocked。
      appendEvent(jp, { type: 'revisitBudgetGranted', sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user' });

      // 恢复点击:绝不能再 append 第二条 grant(否则一次准许变 +2),只补 retry。
      const out = requestRevisitGrant(base, runId, { sourceNodeId: 'C', toNodeId: 'A', by: 'ou_user', expectedAttemptId: 'C#002/attempts/001' });
      expect(out.kind).toBe('granted');
      const events = readJournal(jp);
      expect(events.filter((e) => e.type === 'revisitBudgetGranted').length).toBe(1); // 仍是 1,没翻倍
      expect(events.find((e) => e.type === 'nodeRetryRequested')).toMatchObject({ nodeId: 'C', nextAttemptId: 'C#002/attempts/002' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
