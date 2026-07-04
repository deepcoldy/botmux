/**
 * v3-blocked.test.ts — blocked/failed 两档 + 自报契约 + resultSchema + retry 的
 * 核心语义测试（blocked/resultSchema 设计稿 §6 测试计划）。
 *
 * 按 codex 拍的边界，blocked 基础语义和 resultSchema（opt-in 子能力）拆成两组
 * describe；golden 锁「无 resultSchema 的 goal.txt 不含 result.json 契约」。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { validateDag, DagValidationError, DEFAULT_NODE_TIMEOUT_SEC, MAX_NODE_TIMEOUT_SEC } from '../src/workflows/v3/dag.js';
import { decideNext } from '../src/workflows/v3/orchestrator.js';
import { appendEvent, readJournal, type StoredEvent } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import {
  runWorkflow,
  classifyTerminal,
  validateResult,
  nextAttemptIdFor,
  latestAttemptIdFor,
  renderGoalFile,
  readGoalAsk,
  type V3RuntimeDeps,
} from '../src/workflows/v3/runtime.js';
import { requestV3Retry, reconcileV3PendingGates, blockedInfoFor } from '../src/workflows/v3/daemon-run.js';
import { birthRun, readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'v3-blocked-'));
}

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

function product(outputDir: string, name: string, content: string): Manifest['files'][number] {
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

/** Permissive structural validator stub: reads the manifest file as-is. */
const passthroughValidator: ValidateManifest = async (manifestPath) => {
  try {
    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(manifestPath, 'utf-8'),
    ) as Manifest;
    return { ok: true, manifest };
  } catch {
    return { ok: false, problems: ['manifest missing'] };
  }
};

function depsWith(runNode: RunNode): V3RuntimeDeps {
  return { runNode, validateManifest: passthroughValidator, resolveBotSnapshot };
}

const ONE_NODE = {
  runId: 'blocked-001',
  nodes: [{ id: 'work', type: 'goal', goal: '干活', depends: [], inputs: [] }],
};

// ─── classifyTerminal（纯函数）────────────────────────────────────────────────

describe('classifyTerminal', () => {
  it('契约性失败 → blocked；基建/否决 → failed', () => {
    expect(classifyTerminal('manifestInvalid')).toBe('blocked');
    expect(classifyTerminal('resultInvalid')).toBe('blocked');
    expect(classifyTerminal('workerError')).toBe('failed');
    expect(classifyTerminal('timeout')).toBe('failed');
    expect(classifyTerminal('gateRejected')).toBe('failed');
    expect(classifyTerminal('cancelled')).toBe('failed');
  });

  it('自报 fail：retryable=false → failed；true/缺省 → blocked', () => {
    expect(classifyTerminal('workerError', { selfReportedFail: true, retryable: false })).toBe('failed');
    expect(classifyTerminal('workerError', { selfReportedFail: true, retryable: true })).toBe('blocked');
    expect(classifyTerminal('workerError', { selfReportedFail: true })).toBe('blocked');
  });
});

describe('readGoalAsk', () => {
  it('accepts option asks and free-text asks', () => {
    const base = freshBase();
    try {
      const optionPath = join(base, 'option-ask.json');
      writeFileSync(optionPath, JSON.stringify({ question: '部署到哪里？', options: ['staging', 'prod'] }));
      expect(readGoalAsk(optionPath)).toEqual({ question: '部署到哪里？', options: ['staging', 'prod'] });

      const textPath = join(base, 'text-ask.json');
      writeFileSync(textPath, JSON.stringify({ question: '补充计费规则', freeText: true }));
      expect(readGoalAsk(textPath)).toEqual({ question: '补充计费规则', freeText: true });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous asks', () => {
    const base = freshBase();
    try {
      const badPath = join(base, 'bad-ask.json');
      writeFileSync(badPath, JSON.stringify({ question: '补充计费规则', freeText: true, options: ['A', 'B'] }));
      expect(readGoalAsk(badPath)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ─── materialize / orchestrator ──────────────────────────────────────────────

describe('materialize — blocked 事件折叠', () => {
  const ts = (e: object): StoredEvent => ({ ts: 1, ...(e as StoredEvent) });

  it('nodeBlocked → blocked；runBlocked → runStatus blocked + blockedNodeId', () => {
    const snap = materialize([
      ts({ type: 'runStarted', runId: 'r' }),
      ts({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ts({ type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'manifestInvalid' }),
      ts({ type: 'runBlocked', blockedNodeId: 'a' }),
    ]);
    expect(snap.nodes.get('a')?.status).toBe('blocked');
    expect(snap.runStatus).toBe('blocked');
    expect(snap.blockedNodeId).toBe('a');
  });

  it('nodeRetryRequested → 节点回 pending + attempt 预留 + run 清回 running（replay 正确性）', () => {
    const events: StoredEvent[] = [
      ts({ type: 'runStarted', runId: 'r' }),
      ts({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ts({ type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'manifestInvalid' }),
      ts({ type: 'runBlocked', blockedNodeId: 'a' }),
      ts({
        type: 'nodeRetryRequested', nodeId: 'a',
        previousAttemptId: 'a/attempts/001', nextAttemptId: 'a/attempts/002', reason: 'blockedRetry',
      }),
    ];
    const snap = materialize(events);
    expect(snap.nodes.get('a')?.status).toBe('pending');
    expect(snap.attempts.get('a')).toBe('a/attempts/002');
    expect(snap.runStatus).toBe('running');
    expect(snap.blockedNodeId).toBeUndefined();
  });
});

describe('decideNext — blocked 终态扫描', () => {
  const dag = validateDag({
    runId: 'r',
    nodes: [
      { id: 'a', type: 'goal', goal: 'g' },
      { id: 'b', type: 'goal', goal: 'g' },
    ],
  });

  it('纯 blocked → completeRunBlocked（最早 topo 序）', () => {
    const actions = decideNext(dag, new Map([['a', { status: 'blocked' as const }]]));
    expect(actions).toEqual([{ kind: 'completeRunBlocked', blockedNodeId: 'a' }]);
  });

  it('failed 优先于 blocked', () => {
    const actions = decideNext(
      dag,
      new Map([
        ['a', { status: 'blocked' as const }],
        ['b', { status: 'failed' as const }],
      ]),
    );
    expect(actions).toEqual([{ kind: 'completeRunFailed', failedNodeId: 'b' }]);
  });
});

// ─── attempt 编号（journal 派生）─────────────────────────────────────────────

describe('nextAttemptIdFor', () => {
  const ts = (e: object): StoredEvent => ({ ts: 1, ...(e as StoredEvent) });

  it('首派 = 001', () => {
    expect(nextAttemptIdFor([], 'a')).toBe('a/attempts/001');
  });

  it('blocked 重试：reservation 优先；消费后 max+1', () => {
    const events: StoredEvent[] = [
      ts({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' }),
      ts({ type: 'nodeRetryRequested', nodeId: 'a', previousAttemptId: 'a/attempts/001', nextAttemptId: 'a/attempts/002', reason: 'blockedRetry' }),
    ];
    expect(nextAttemptIdFor(events, 'a')).toBe('a/attempts/002'); // 未消费的预留
    events.push(ts({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/002' }));
    expect(nextAttemptIdFor(events, 'a')).toBe('a/attempts/003'); // 预留已消费
    expect(latestAttemptIdFor(events, 'a')).toBe('a/attempts/002');
  });
});

// ─── runtime verdict：自报契约 + blocked 不塌 ────────────────────────────────

describe('runWorkflow — blocked 终态', () => {
  it('自报 fail + retryable:true → nodeBlocked + runBlocked（outcome 不塌成 failed）', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(ONE_NODE));
    const runNode: RunNode = async (req) => {
      const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(p, JSON.stringify({
        schemaVersion: 1, status: 'fail', summary: 'auth wall',
        files: [], error: { code: 'AUTH_REQUIRED', message: '需要登录', retryable: true },
      }));
      return { status: 'ok', manifestPath: p };
    };
    const outcome = await runWorkflow(dag, depsWith(runNode), { baseDir: base });
    expect(outcome.reason).toBe('terminal');
    if (outcome.reason === 'terminal') {
      expect(outcome.runStatus).toBe('blocked');
      expect(outcome.blockedNodeId).toBe('work');
    }
    const events = readJournal(join(base, dag.runId, 'journal.ndjson'));
    const blocked = events.find((e) => e.type === 'nodeBlocked');
    expect(blocked).toMatchObject({ errorCode: 'AUTH_REQUIRED' });
    rmSync(base, { recursive: true, force: true });
  });

  it('自报 fail + retryable:false → nodeFailed（不可恢复）', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(ONE_NODE));
    const runNode: RunNode = async (req) => {
      const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(p, JSON.stringify({
        schemaVersion: 1, status: 'fail', summary: 'impossible',
        files: [], error: { code: 'IMPOSSIBLE', message: '做不了', retryable: false },
      }));
      return { status: 'ok', manifestPath: p };
    };
    const outcome = await runWorkflow(dag, depsWith(runNode), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('failed');
    rmSync(base, { recursive: true, force: true });
  });

  it('manifest 缺失（进程 ok）→ manifestInvalid → blocked', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(ONE_NODE));
    const runNode: RunNode = async (req) => ({
      status: 'ok', manifestPath: req.env[GOAL_ENV.MANIFEST_PATH]!,
    });
    const outcome = await runWorkflow(dag, depsWith(runNode), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('blocked');
    const blocked = readJournal(join(base, dag.runId, 'journal.ndjson')).find((e) => e.type === 'nodeBlocked');
    expect(blocked).toMatchObject({ errorClass: 'manifestInvalid' });
    rmSync(base, { recursive: true, force: true });
  });

  it('进程 fail（无自报）→ workerError → failed（基建错不软化）', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(ONE_NODE));
    const runNode: RunNode = async (req) => ({
      status: 'fail', manifestPath: req.env[GOAL_ENV.MANIFEST_PATH]!,
    });
    const outcome = await runWorkflow(dag, depsWith(runNode), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('failed');
    rmSync(base, { recursive: true, force: true });
  });
});

// ─── retry 全链路（防 Blocker1 回归：解锁必须是 journal 事件）─────────────────

describe('requestV3Retry + 重驱动全链路', () => {
  function seedBlockedRun(base: string, runId: string) {
    const { runDir } = birthRun({
      goal: 'g', baseDir: base, runId,
      chatBinding: { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' },
    });
    const dagPath = join(runDir, 'dag.json');
    writeFileSync(dagPath, JSON.stringify({
      runId, nodes: [{ id: 'work', type: 'goal', goal: 'g', depends: [], inputs: [] }],
    }));
    const state = readGrillState(runDir)!;
    writeGrillState(runDir, { ...state, status: 'dag_approved', dagPath });
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'work', instanceId: 'work#001', attemptId: 'work#001/attempts/001' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'work', instanceId: 'work#001', attemptId: 'work#001/attempts/001',
      errorClass: 'workerError', errorCode: 'AUTH_REQUIRED', message: '需要登录',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'work' });
    return { runDir, journalPath };
  }

  it('blocked → retry append → 重新 materialize 是 pending（不是 blocked）→ 新 attempt 002 重跑成功', async () => {
    const base = freshBase();
    const { journalPath } = seedBlockedRun(base, 'retry-001');

    const out = requestV3Retry(base, 'retry-001');
    expect(out).toMatchObject({ kind: 'requested', nodeId: 'work', nextAttemptId: 'work#001/attempts/002' });

    // 防 Blocker1 回归：fresh replay 必须得出 pending（解锁在 journal 里）。
    const snap = materialize(readJournal(journalPath));
    expect(snap.nodes.get('work')?.status).toBe('pending');
    expect(snap.runStatus).toBe('running');

    // audit 字段从 blocked 事件复制
    const retryEvent = readJournal(journalPath).find((e) => e.type === 'nodeRetryRequested');
    expect(retryEvent).toMatchObject({ previousErrorClass: 'workerError', previousErrorCode: 'AUTH_REQUIRED' });

    // 重驱动：runNode 这次成功 → 节点用预留的 002 → runSucceeded
    const dag = validateDag(JSON.parse(
      (await import('node:fs')).readFileSync(join(base, 'retry-001', 'dag.json'), 'utf-8'),
    ));
    const runNode: RunNode = async (req) => {
      expect(req.attemptId).toBe('work#001/attempts/002');
      const m: Manifest = {
        schemaVersion: 1, status: 'ok', summary: 'done',
        files: [product(req.outputDir, 'out.md', 'ok')],
      };
      const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(p, JSON.stringify(m));
      return { status: 'ok', manifestPath: p };
    };
    const outcome = await runWorkflow(dag, depsWith(runNode), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('succeeded');
    rmSync(base, { recursive: true, force: true });
  });

  it('幂等：未消费的 retry 预留上再 retry → already-requested（不双 append）', () => {
    const base = freshBase();
    const { journalPath } = seedBlockedRun(base, 'retry-002');
    expect(requestV3Retry(base, 'retry-002').kind).toBe('requested');
    expect(requestV3Retry(base, 'retry-002')).toMatchObject({ kind: 'already-requested', nodeId: 'work' });
    const retries = readJournal(journalPath).filter((e) => e.type === 'nodeRetryRequested');
    expect(retries).toHaveLength(1);
    rmSync(base, { recursive: true, force: true });
  });

  it('非 blocked run / 未知 run → stale-run', () => {
    const base = freshBase();
    expect(requestV3Retry(base, 'nope').kind).toBe('stale-run');
    rmSync(base, { recursive: true, force: true });
  });

  it('stale 旧卡（codex blocker）：001 的卡不能把 002 的 blocked 推进到 003', () => {
    const base = freshBase();
    const { journalPath } = seedBlockedRun(base, 'retry-005');
    // 001 blocked → 点卡 retry → 002 跑 → 002 又 blocked（全在同一 instance work#001 内）
    expect(requestV3Retry(base, 'retry-005', { expectedAttemptId: 'work#001/attempts/001' }).kind).toBe('requested');
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'work', instanceId: 'work#001', attemptId: 'work#001/attempts/002' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'work', instanceId: 'work#001', attemptId: 'work#001/attempts/002',
      errorClass: 'workerError', errorCode: 'AUTH_REQUIRED', message: '还是要登录',
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'work' });

    // 用 001 的旧卡点击 → stale-attempt，绝不 append 003
    const stale = requestV3Retry(base, 'retry-005', { nodeId: 'work', expectedAttemptId: 'work#001/attempts/001' });
    expect(stale).toMatchObject({ kind: 'stale-run', reason: 'stale-attempt' });
    expect(readJournal(journalPath).filter((e) => e.type === 'nodeRetryRequested')).toHaveLength(1);

    // 当前卡（002）/ CLI（不带 expectedAttemptId）仍可重试
    const fresh = requestV3Retry(base, 'retry-005', { nodeId: 'work', expectedAttemptId: 'work#001/attempts/002' });
    expect(fresh).toMatchObject({ kind: 'requested', nextAttemptId: 'work#001/attempts/003' });

    // 预留未消费期间，001 旧卡点进 pending 分支也必须 stale（不是 already-requested）
    const staleOnPending = requestV3Retry(base, 'retry-005', { nodeId: 'work', expectedAttemptId: 'work#001/attempts/001' });
    expect(staleOnPending).toMatchObject({ kind: 'stale-run', reason: 'stale-attempt' });
    // 002 的卡在预留未消费期间重复点 → already-requested（幂等）
    expect(requestV3Retry(base, 'retry-005', { nodeId: 'work', expectedAttemptId: 'work#001/attempts/002' }).kind).toBe('already-requested');
    rmSync(base, { recursive: true, force: true });
  });

  it('human-ask answer 必须属于当前 ask.options，且普通 blocked 不能注入 answer', () => {
    const base = freshBase();
    const { journalPath } = seedBlockedRun(base, 'retry-006');

    // 普通 blocked 节点没有 ask payload，不能通过伪造 ask action 注入 answer。
    const forged = requestV3Retry(base, 'retry-006', {
      nodeId: 'work',
      expectedAttemptId: 'work#001/attempts/001',
      answer: { selected: 'prod', by: 'ou_op' },
    });
    expect(forged).toMatchObject({ kind: 'stale-run', reason: 'invalid-answer' });
    expect(readJournal(journalPath).filter((e) => e.type === 'nodeRetryRequested')).toHaveLength(0);

    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'work', instanceId: 'work#001', attemptId: 'work#001/attempts/001',
      errorClass: 'manifestInvalid', errorCode: 'ASK_HUMAN', message: '部署到哪里？',
      ask: { question: '部署到哪里？', options: ['staging', 'prod'] },
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'work' });

    const invalid = requestV3Retry(base, 'retry-006', {
      nodeId: 'work',
      expectedAttemptId: 'work#001/attempts/001',
      answer: { selected: 'dev', by: 'ou_op' },
    });
    expect(invalid).toMatchObject({ kind: 'stale-run', reason: 'invalid-answer' });
    expect(readJournal(journalPath).filter((e) => e.type === 'nodeRetryRequested')).toHaveLength(0);

    const valid = requestV3Retry(base, 'retry-006', {
      nodeId: 'work',
      expectedAttemptId: 'work#001/attempts/001',
      answer: { selected: 'prod', by: 'ou_op' },
    });
    expect(valid).toMatchObject({ kind: 'requested', nextAttemptId: 'work#001/attempts/002' });
    rmSync(base, { recursive: true, force: true });
  });

  it('reconcile：blocked run 返回 repostBlocked；retry 后崩溃（running 无 in-flight）返回 resume', () => {
    const base = freshBase();
    seedBlockedRun(base, 'retry-003');
    let recs = reconcileV3PendingGates(base, 'cli_test');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.repostBlocked).toMatchObject({ nodeId: 'work', errorCode: 'AUTH_REQUIRED' });
    expect(recs[0]!.resume).toBe(false);

    // append retry（模拟点击后 daemon 在重驱动前崩溃）→ reconcile 应 resume
    requestV3Retry(base, 'retry-003');
    recs = reconcileV3PendingGates(base, 'cli_test');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.resume).toBe(true);

    // owner 过滤：别的 daemon 不碰
    expect(reconcileV3PendingGates(base, 'cli_other')).toHaveLength(0);
    rmSync(base, { recursive: true, force: true });
  });

  it('blockedInfoFor 取最新 blocked 事件', () => {
    const base = freshBase();
    const { journalPath } = seedBlockedRun(base, 'retry-004');
    const info = blockedInfoFor(readJournal(journalPath), 'work');
    expect(info).toMatchObject({ nodeId: 'work', attemptId: 'work#001/attempts/001', errorCode: 'AUTH_REQUIRED' });
    rmSync(base, { recursive: true, force: true });
  });
});

// ─── opt-in resultSchema（独立分组，codex 边界）──────────────────────────────

describe('resultSchema — dag 校验子集', () => {
  const node = (extra: object) => ({
    runId: 'r',
    nodes: [{ id: 'a', type: 'goal', goal: 'g', ...extra }],
  });

  it('合法子集通过；缺省零变化', () => {
    const dag = validateDag(node({
      resultSchema: { type: 'object', properties: { score: { type: 'number' }, tags: { type: 'array' } }, required: ['score'] },
    }));
    expect(dag.nodes[0]!.resultSchema?.required).toEqual(['score']);
    expect(validateDag(node({})).nodes[0]!.resultSchema).toBeUndefined();
  });

  it('unknown keyword / 越界类型 / required 引用未声明 / 超字段数上限 → 编排期拒', () => {
    expect(() => validateDag(node({ resultSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }))).toThrow(DagValidationError);
    expect(() => validateDag(node({ resultSchema: { type: 'object', properties: { a: { type: 'integer' } } } }))).toThrow(DagValidationError);
    expect(() => validateDag(node({ resultSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }))).toThrow(DagValidationError);
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, { type: 'string' }]));
    expect(() => validateDag(node({ resultSchema: { type: 'object', properties: tooMany } }))).toThrow(DagValidationError);
  });

  it('timeoutSec：默认 1800、超 4h 上限拒', () => {
    expect(DEFAULT_NODE_TIMEOUT_SEC).toBe(1800);
    expect(() => validateDag(node({ timeoutSec: MAX_NODE_TIMEOUT_SEC + 1 }))).toThrow(DagValidationError);
    expect(validateDag(node({ timeoutSec: 7200 })).nodes[0]!.timeoutSec).toBe(7200);
  });
});

describe('validateResult', () => {
  const SCHEMA = { type: 'object' as const, properties: { ok: { type: 'boolean' as const }, n: { type: 'number' as const } }, required: ['ok'] };

  it('缺文件 / parse 错 / 缺 required / 类型不符 / 通过', () => {
    const base = freshBase();
    expect(validateResult(join(base, 'nope.json'), SCHEMA).ok).toBe(false);

    const bad = join(base, 'bad.json');
    writeFileSync(bad, '{oops');
    expect(validateResult(bad, SCHEMA).ok).toBe(false);

    const missing = join(base, 'missing.json');
    writeFileSync(missing, JSON.stringify({ n: 1 }));
    expect(validateResult(missing, SCHEMA).problems).toContain('missing required field "ok"');

    const wrongType = join(base, 'wrong.json');
    writeFileSync(wrongType, JSON.stringify({ ok: 'yes' }));
    expect(validateResult(wrongType, SCHEMA).ok).toBe(false);

    const good = join(base, 'good.json');
    writeFileSync(good, JSON.stringify({ ok: true, n: 2, extra: 'allowed' }));
    expect(validateResult(good, SCHEMA).ok).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('runWorkflow — resultSchema 串入 verdict', () => {
  const SCHEMA_NODE = {
    runId: 'rs-001',
    nodes: [{
      id: 'work', type: 'goal', goal: 'g', depends: [], inputs: [],
      resultSchema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    }],
  };

  function okManifestRunNode(writeResult?: object, listInManifest = true): RunNode {
    return async (req) => {
      const files: Manifest['files'] = [product(req.outputDir, 'out.md', 'x')];
      if (writeResult) {
        const content = JSON.stringify(writeResult);
        writeFileSync(join(req.outputDir, 'result.json'), content);
        if (listInManifest) {
          files.push({
            name: 'result', path: 'result.json', kind: 'json',
            bytes: Buffer.byteLength(content),
            sha256: createHash('sha256').update(content).digest('hex'),
            mime: 'application/json',
          });
        }
      }
      const m: Manifest = { schemaVersion: 1, status: 'ok', summary: 's', files };
      const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
      writeFileSync(p, JSON.stringify(m));
      return { status: 'ok', manifestPath: p };
    };
  }

  it('result.json 合规 → succeeded', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(SCHEMA_NODE));
    const outcome = await runWorkflow(dag, depsWith(okManifestRunNode({ verdict: 'pass' })), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('succeeded');
    rmSync(base, { recursive: true, force: true });
  });

  it('manifest 没列 result.json → blocked/resultInvalid（绕不过 manifest 审计）', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(SCHEMA_NODE));
    const outcome = await runWorkflow(dag, depsWith(okManifestRunNode({ verdict: 'pass' }, false)), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('blocked');
    const blocked = readJournal(join(base, dag.runId, 'journal.ndjson')).find((e) => e.type === 'nodeBlocked');
    expect(blocked).toMatchObject({ errorClass: 'resultInvalid' });
    rmSync(base, { recursive: true, force: true });
  });

  it('result.json 违反 schema → blocked/resultInvalid', async () => {
    const base = freshBase();
    const dag = validateDag(structuredClone(SCHEMA_NODE));
    const outcome = await runWorkflow(dag, depsWith(okManifestRunNode({ wrong: 1 })), { baseDir: base });
    if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('blocked');
    rmSync(base, { recursive: true, force: true });
  });
});

// ─── golden：goal.txt 契约 ───────────────────────────────────────────────────

describe('renderGoalFile golden', () => {
  it('无 resultSchema：不含 result.json 契约段；含自报 AUTH_REQUIRED 指引', () => {
    const txt = renderGoalFile('做点事');
    expect(txt).not.toContain('result.json');
    expect(txt).not.toContain('Structured result');
    expect(txt).toContain('AUTH_REQUIRED');
    expect(txt).toContain('retryable');
    expect(txt).toContain('"from": "human"');
    expect(txt).toContain('"name": "answer"');
    expect(txt).not.toContain('human/answer');
  });

  it('有 resultSchema：含 schema JSON + result.json 列入 manifest 的要求', () => {
    const txt = renderGoalFile('做点事', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
    expect(txt).toContain('Structured result');
    expect(txt).toContain('"ok"');
    expect(txt).toContain('result.json');
  });
});

// ─── 投影：blocked 状态 + 安全不变量 ─────────────────────────────────────────

describe('ops-projection — blocked', () => {
  it('blocked 节点投出 status/errorClass/errorCode；JSON 不含 runDir 绝对路径', () => {
    const base = freshBase();
    const runId = 'proj-blocked-001';
    const runDir = join(base, runId);
    const journalPath = join(runDir, 'journal.ndjson');
    writeFileSync; // (runDir 由 appendEvent 自动建)
    appendEvent(journalPath, { type: 'runStarted', runId });
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
    appendEvent(journalPath, {
      type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001',
      errorClass: 'workerError', errorCode: 'AUTH_REQUIRED', message: `路径泄漏测试 ${runDir}`,
    });
    appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'a' });

    const view = projectRun(runId, runDir);
    expect(view.runStatus).toBe('blocked');
    expect(view.blockedNodeId).toBe('a');
    const node = view.nodes.find((n) => n.id === 'a')!;
    expect(node.status).toBe('blocked');
    expect(node.errorClass).toBe('workerError');
    expect(node.errorCode).toBe('AUTH_REQUIRED');
    // 安全不变量：自由文本 message（可能含绝对路径）不得入投影
    expect(JSON.stringify(view)).not.toContain(runDir);
    rmSync(base, { recursive: true, force: true });
  });
});
