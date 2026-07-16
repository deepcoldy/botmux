import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createV3GateRunner,
  driveV3Run,
  preflightV3RunStart,
  reconcileV3PendingGates,
  requestRevisitGrant,
  requestV3RunCancel,
  requestV3LoopGrant,
  requestV3Retry,
  resolveV3GateClick,
  type V3DaemonRunDeps,
} from '../src/workflows/v3/daemon-run.js';
import { birthRun, writeGrillState, readGrillState } from '../src/workflows/v3/grill-state.js';
import { resolveWait, readWait, waitPath, writePendingWait } from '../src/workflows/v3/human-gate.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import type { RunNode } from '../src/workflows/v3/contract.js';
import {
  armV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
} from '../src/workflows/v3/worker-fence.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
} from '../src/workflows/v3/run-envelope.js';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'v3-daemon-run-'));
}

const BINDING = { larkAppId: 'cli_test', chatId: 'oc_chat', rootMessageId: 'om_root' };

/** A 1-node DAG whose only node carries a humanGate. */
function gateDag(runId: string) {
  return {
    runId,
    nodes: [
      { id: 'deploy', type: 'goal', goal: '部署', depends: [], inputs: [], humanGate: { prompt: '批准部署？' } },
    ],
  };
}

function hostGateDag(runId: string) {
  return {
    runId,
    nodes: [{
      id: 'send',
      type: 'host',
      executor: 'feishu-send',
      input: {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        content: 'trusted payload',
      },
      depends: [],
      inputs: [],
      humanGate: { prompt: 'Approve trusted send?' },
    }],
  };
}

/** Birth a run + write an approved dag.json + point grill state at it. */
function seedApprovedRun(base: string, runId: string, opts: { binding?: typeof BINDING } = {}): string {
  const { runDir } = birthRun({ goal: 'g', baseDir: base, runId, chatBinding: opts.binding });
  const dagPath = join(runDir, 'dag.json');
  writeFileSync(dagPath, JSON.stringify(gateDag(runId)));
  const state = readGrillState(runDir)!;
  writeGrillState(runDir, { ...state, status: 'dag_approved', dagPath });
  return runDir;
}

function seedApprovedHostRun(base: string, runId: string): string {
  const { runDir } = birthRun({ goal: 'g', baseDir: base, runId, chatBinding: BINDING });
  const dagPath = join(runDir, 'dag.json');
  writeFileSync(dagPath, JSON.stringify(hostGateDag(runId)));
  const state = readGrillState(runDir)!;
  writeGrillState(runDir, { ...state, status: 'dag_approved', dagPath });
  return runDir;
}

function seedSavedDefinitionRun(
  base: string,
  runId: string,
  opts: {
    binding?: typeof BINDING;
    resolvedContext?: Record<string, string>;
  } = {},
): string {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'dag.json'), `${JSON.stringify(gateDag(runId))}\n`);
  writeFileSync(join(runDir, 'spec.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    title: 'saved gate',
    requirement: 'deploy safely',
    nodes: [{
      sketchId: 'deploy',
      goal: '部署',
      input_needs: [],
      expected_outputs: ['result'],
      acceptance: 'done',
      risk_gate: true,
      unknowns: [],
    }],
  })}\n`);
  writeFileSync(join(runDir, 'bots.snapshot.json'), `${JSON.stringify({
    '': { larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/frozen/work' },
  })}\n`);
  writeFileSync(join(runDir, 'params.resolved.json'), `${JSON.stringify({
    params: {},
    context: opts.resolvedContext ?? {},
  })}\n`);
  writeFileSync(join(runDir, 'definition.snapshot.json'), `${JSON.stringify({
    schemaVersion: 1,
    workflowId: 'wf_0123456789abcdef0123456789abcdef',
    revisionId: `rev_${'a'.repeat(64)}`,
    humanVersion: 1,
  })}\n`);
  const artifacts = {
    dag: artifactRef(runDir, 'dag.json'),
    spec: artifactRef(runDir, 'spec.json'),
    botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    resolvedParams: artifactRef(runDir, 'params.resolved.json'),
    definitionSnapshot: artifactRef(runDir, 'definition.snapshot.json'),
  };
  publishRunEnvelopeOnce(runDir, makeSavedDefinitionRunEnvelope({
    runId,
    workflowId: 'wf_0123456789abcdef0123456789abcdef',
    revisionId: `rev_${'a'.repeat(64)}`,
    humanVersion: 1,
    createdAt: '2026-07-10T08:00:00.000Z',
    authorizedAt: '2026-07-10T08:01:00.000Z',
    chatBinding: opts.binding ?? BINDING,
    artifacts,
  }));
  return runDir;
}

/** Stub deps: permissive validator + a runNode that just reports ok (gate node
 *  isn't even called until the gate clears). */
function stubDeps(base: string, overrides: Partial<V3DaemonRunDeps> = {}): {
  deps: V3DaemonRunDeps;
  postGateCard: ReturnType<typeof vi.fn>;
  onTerminal: ReturnType<typeof vi.fn>;
  runNodeCalls: () => number;
} {
  let calls = 0;
  const runNode: RunNode = async (req) => {
    calls++;
    return { status: 'ok', manifestPath: join(req.outputDir, 'manifest.json') };
  };
  const postGateCard = vi.fn(async () => {});
  const onTerminal = vi.fn(async () => {});
  const deps: V3DaemonRunDeps = {
    baseDir: base,
    loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
    makeRunNode: () => runNode,
    validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
    postGateCard,
    onTerminal,
    ...overrides,
  };
  return { deps, postGateCard, onTerminal, runNodeCalls: () => calls };
}

describe('driveV3Run — suspend gate → 发卡 → 点击 redrive', () => {
  it('Saved Workflow 无 grill 也能从 run.json 启动，并使用冻结 bot snapshot', async () => {
    const base = freshBase();
    try {
      seedSavedDefinitionRun(base, 'saved-run');
      const shared = stubDeps(base, {
        // If runtime re-resolves the live bot this unsupported CLI would fail;
        // the definition run must use bots.snapshot.json instead.
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'gemini' } as any],
      });
      const outcome = await driveV3Run('saved-run', shared.deps);
      expect(outcome.reason).toBe('awaitingGate');
      expect(shared.postGateCard).toHaveBeenCalledTimes(1);
      expect(shared.postGateCard.mock.calls[0]![0]).toEqual(BINDING);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('首跑撞 gate → 返回 awaitingGate + postGateCard 一次（runNode 不被调）', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'gate-run', { binding: BINDING });
      const { deps, postGateCard, onTerminal, runNodeCalls } = stubDeps(base);

      const outcome = await driveV3Run('gate-run', deps);

      expect(outcome.reason).toBe('awaitingGate');
      expect(postGateCard).toHaveBeenCalledTimes(1);
      const [binding, gate, runId] = postGateCard.mock.calls[0]!;
      expect(binding).toEqual(BINDING);
      expect(gate).toMatchObject({ nodeId: 'deploy', waitId: 'deploy#001-gate', prompt: '批准部署？' });
      expect(runId).toBe('gate-run');
      expect(onTerminal).not.toHaveBeenCalled();
      expect(runNodeCalls()).toBe(0);
      // wait file 已被 runtime 写出（pending）
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('pending');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('点击批准（resolveWait + gateResolved）后 redrive → runNode 跑 → terminal succeeded → onTerminal', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'gate-run', { binding: BINDING });
      const shared = stubDeps(base);

      await driveV3Run('gate-run', shared.deps); // → awaitingGate

      // 模拟 card handler 点击批准：先 resolveWait，再 append gateResolved
      resolveWait(runDir, 'deploy#001-gate', 'approved', 'ou_user');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved', nodeId: 'deploy', waitId: 'deploy#001-gate', resolution: 'approved', by: 'ou_user',
      } as any);

      const outcome = await driveV3Run('gate-run', shared.deps); // redrive

      expect(outcome.reason).toBe('terminal');
      if (outcome.reason === 'terminal') expect(outcome.runStatus).toBe('succeeded');
      expect(shared.runNodeCalls()).toBe(1); // gate 清除后才真正跑节点
      expect(shared.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('driveV3Run — 错误路径', () => {
  it('Saved Workflow resolved context must match the immutable run chat binding', () => {
    const base = freshBase();
    try {
      const runDir = seedSavedDefinitionRun(base, 'saved-context-mismatch', {
        resolvedContext: { chatId: 'oc_other' },
      });
      expect(preflightV3RunStart(runDir)).toMatchObject({
        ok: false,
        error: 'run_envelope_invalid',
        detail: expect.stringContaining('context.chatId does not match run.json chatBinding'),
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('旧 dag_approved run 在首次 worker 派发前生成诚实的 legacy backfill envelope', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'legacy-approved', { binding: BINDING });
      const preflight = preflightV3RunStart(runDir);
      expect(preflight.ok).toBe(true);
      expect(readRunEnvelope(runDir).kind).toBe('missing');
      const { deps } = stubDeps(base);
      await driveV3Run('legacy-approved', deps);
      const loaded = loadAuthorizedV3Run(runDir);
      expect(loaded.envelope).toMatchObject({
        source: { kind: 'legacy_v3', original: 'grill' },
        authorization: {
          kind: 'legacy_backfill',
          basis: 'grill_dag_approved',
          integrity: 'unverifiable_before_backfill',
        },
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('awaitingGate 但无 chatBinding（非 grill 出生）→ 抛错（发不了卡）', async () => {
    const base = freshBase();
    try {
      seedApprovedRun(base, 'no-bind', {}); // 无 binding
      const { deps } = stubDeps(base);
      await expect(driveV3Run('no-bind', deps)).rejects.toThrow(/chatBinding/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('无 approved dag（dagPath 缺）→ 抛错', async () => {
    const base = freshBase();
    try {
      birthRun({ goal: 'g', baseDir: base, runId: 'no-dag', chatBinding: BINDING }); // 留在 grilling，无 dagPath
      const { deps } = stubDeps(base);
      await expect(driveV3Run('no-dag', deps)).rejects.toThrow(/no approved dag/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('dagPath 已存在但仍是 dag_ready → start 被 Gate-2 守卫拒绝且不创建 journal', async () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'not-approved', chatBinding: BINDING });
      const dagPath = join(runDir, 'dag.json');
      writeFileSync(dagPath, JSON.stringify(gateDag('not-approved')));
      const state = readGrillState(runDir)!;
      writeGrillState(runDir, { ...state, status: 'dag_ready', dagPath });

      expect(preflightV3RunStart(runDir)).toEqual({
        ok: false,
        error: 'dag_not_approved',
        status: 'dag_ready',
      });
      const { deps, runNodeCalls } = stubDeps(base);
      await expect(driveV3Run('not-approved', deps)).rejects.toThrow(/no approved dag.*dag_ready/);
      expect(runNodeCalls()).toBe(0);
      expect(existsSync(join(runDir, 'journal.ndjson'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('状态虽已 dag_approved 但 DAG 文件丢失 → preflight 明确报 approved_dag_missing', () => {
    const base = freshBase();
    try {
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId: 'missing-approved-dag', chatBinding: BINDING });
      const state = readGrillState(runDir)!;
      writeGrillState(runDir, {
        ...state,
        status: 'dag_approved',
        dagPath: join(runDir, 'missing-dag.json'),
      });
      expect(preflightV3RunStart(runDir)).toEqual({
        ok: false,
        error: 'approved_dag_missing',
        status: 'dag_approved',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('无 grill state（runId 不存在）→ 抛错', async () => {
    const base = freshBase();
    try {
      const { deps } = stubDeps(base);
      await expect(driveV3Run('ghost', deps)).rejects.toThrow(/no grill state/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('run.json 已存在但 DAG 被篡改 → fail-closed，不回退 grill/不创建 journal', async () => {
    const base = freshBase();
    try {
      const runDir = seedSavedDefinitionRun(base, 'tampered-run');
      writeFileSync(join(runDir, 'dag.json'), `${JSON.stringify(gateDag('tampered-run'), null, 2)}\n`);
      const preflight = preflightV3RunStart(runDir);
      expect(preflight).toMatchObject({ ok: false, error: 'run_envelope_invalid' });
      if (!preflight.ok) expect(preflight.detail).toContain('digest mismatch');
      const shared = stubDeps(base);
      await expect(driveV3Run('tampered-run', shared.deps)).rejects.toThrow(/authorization failed/);
      expect(shared.runNodeCalls()).toBe(0);
      expect(existsSync(join(runDir, 'journal.ndjson'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('resolveV3GateClick — 幂等 + terminal-safe（codex #5/#1/#2）', () => {
  function toAwaitingGate(base: string, runId = 'gate-run'): string {
    return seedApprovedRun(base, runId, { binding: BINDING });
  }

  it('pending → resolved；gateResolved.nodeId 取自 wait file（权威，非外部输入，codex #1）', async () => {
    const base = freshBase();
    try {
      const runDir = toAwaitingGate(base);
      await driveV3Run('gate-run', stubDeps(base).deps); // 写出 pending wait + running journal

      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'approve', by: 'ou_user' });
      expect(out).toEqual({ kind: 'resolved', resolution: 'approved' });
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('approved');
      const gr = readJournal(join(runDir, 'journal.ndjson')).find((e) => e.type === 'gateResolved') as any;
      expect(gr).toBeTruthy();
      expect(gr.resolution).toBe('approved');
      expect(gr.selected).toBe('approve');
      expect(gr.nodeId).toBe('deploy'); // = wait.nodeId（不是 caller 传的）
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('host 点击只信授权 DAG+冻结 sidecar；篡改 pending wait 会拒绝并由 cold attach 修复', async () => {
    const base = freshBase();
    try {
      const runId = 'host-wait-integrity';
      const runDir = seedApprovedHostRun(base, runId);
      const shared = stubDeps(base);
      await driveV3Run(runId, shared.deps);
      const waitId = 'send#001-host-001-gate';
      const original = readWait(runDir, waitId)!;
      expect(original.prompt).toContain('trusted payload');
      expect(original.hostApproval?.inputHash).toMatch(/^sha256:/);

      writeFileSync(waitPath(runDir, waitId), JSON.stringify({
        ...original,
        prompt: 'FORGED PAYLOAD',
      }, null, 2), { mode: 0o600 });
      expect(resolveV3GateClick(base, runId, {
        waitId,
        selected: 'approve',
        by: 'ou_user',
      })).toEqual({ kind: 'stale-run', reason: 'no-wait' });
      expect(readJournal(join(runDir, 'journal.ndjson'))
        .some((event) => event.type === 'gateResolved')).toBe(false);

      const recovered = reconcileV3PendingGates(base).find((item) => item.runId === runId)!;
      expect(recovered.resume).toBe(false);
      expect(recovered.repost).toEqual([
        expect.objectContaining({
          waitId,
          prompt: expect.stringContaining('trusted payload'),
          hostApproval: original.hostApproval,
        }),
      ]);
      expect(readWait(runDir, waitId)?.prompt).toContain('trusted payload');
      expect(readWait(runDir, waitId)?.prompt).not.toContain('FORGED PAYLOAD');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('重复点击 → already-settled（不二次 resolve / 不重复 append）', async () => {
    const base = freshBase();
    try {
      const runDir = toAwaitingGate(base);
      await driveV3Run('gate-run', stubDeps(base).deps);
      resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'approve', by: 'ou_user' });
      const before = readJournal(join(runDir, 'journal.ndjson')).filter((e) => e.type === 'gateResolved').length;

      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'reject', by: 'ou_other' });
      expect(out).toEqual({ kind: 'already-settled', status: 'approved' });
      const after = readJournal(join(runDir, 'journal.ndjson')).filter((e) => e.type === 'gateResolved').length;
      expect(after).toBe(before);
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('approved');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('approvers allowlist 不匹配 → unauthorized，不消费 wait / 不写 gateResolved', async () => {
    const base = freshBase();
    try {
      const runDir = toAwaitingGate(base);
      await driveV3Run('gate-run', stubDeps(base).deps);
      const wait = readWait(runDir, 'deploy#001-gate')!;
      writePendingWait(runDir, {
        waitId: wait.waitId,
        nodeId: wait.nodeId,
        prompt: wait.prompt,
        options: wait.options,
        approveOptions: wait.approveOptions,
        approvers: ['ou_owner'],
      });

      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'approve', by: 'ou_intruder' });

      expect(out).toEqual({ kind: 'unauthorized' });
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('pending');
      expect(readJournal(join(runDir, 'journal.ndjson')).some((e) => e.type === 'gateResolved')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('run 已 terminal → stale-run(terminal)，wait 仍 pending 不被改', async () => {
    const base = freshBase();
    try {
      const runDir = toAwaitingGate(base);
      await driveV3Run('gate-run', stubDeps(base).deps);
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' } as any);

      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'approve', by: 'ou_user' });
      expect(out).toEqual({ kind: 'stale-run', reason: 'terminal' });
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('pending');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('wait 不存在 → stale-run(no-wait)', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'gate-run', { binding: BINDING });
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'gate-run' } as any);
      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'nope-gate', selected: 'approve', by: 'u' });
      expect(out).toEqual({ kind: 'stale-run', reason: 'no-wait' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('journal 不存在 → stale-run(missing)', () => {
    const base = freshBase();
    try {
      seedApprovedRun(base, 'gate-run', { binding: BINDING });
      const out = resolveV3GateClick(base, 'gate-run', { waitId: 'deploy#001-gate', selected: 'approve', by: 'u' });
      expect(out).toEqual({ kind: 'stale-run', reason: 'missing' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('非法 runId（路径穿越）→ 抛错（codex #2 path guard）', async () => {
    const base = freshBase();
    try {
      expect(() => resolveV3GateClick(base, '../escape', { waitId: 'w', selected: 'approve', by: 'u' })).toThrow(/invalid runId/);
      await expect(driveV3Run('a/b', stubDeps(base).deps)).rejects.toThrow(/invalid runId/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('stale-card 防护:回溯后旧 A#001-gate 卡点击失效,A#002-gate 才有效', () => {
    const base = freshBase();
    try {
      const runId = 'gate-revisit';
      const runDir = seedApprovedRun(base, runId, { binding: BINDING });
      const jp = join(runDir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId });
      // A#001 派 gate → 被回溯 supersede → A#002 重新派 gate（两张独立 wait 文件）
      appendEvent(jp, { type: 'gateDispatched', nodeId: 'A', instanceId: 'A#001', waitId: 'A#001-gate' });
      writePendingWait(runDir, { waitId: 'A#001-gate', nodeId: 'A', instanceId: 'A#001', prompt: '批?' });
      appendEvent(jp, { type: 'nodeInstanceSuperseded', nodeId: 'A', instanceId: 'A#001', byNodeId: 'A', reason: 'refresh' });
      appendEvent(jp, { type: 'gateDispatched', nodeId: 'A', instanceId: 'A#002', waitId: 'A#002-gate' });
      writePendingWait(runDir, { waitId: 'A#002-gate', nodeId: 'A', instanceId: 'A#002', prompt: '批?' });

      // 旧 A#001 卡点击 → stale-node（wait.instanceId A#001 ≠ 当前 effective A#002）
      expect(resolveV3GateClick(base, runId, { waitId: 'A#001-gate', selected: 'approve', by: 'ou_user' }))
        .toEqual({ kind: 'stale-run', reason: 'stale-node' });
      expect(readWait(runDir, 'A#001-gate')?.status).toBe('pending'); // 没被消费
      // 当前 A#002 卡点击 → 正常 resolved
      expect(resolveV3GateClick(base, runId, { waitId: 'A#002-gate', selected: 'approve', by: 'ou_user' }))
        .toEqual({ kind: 'resolved', resolution: 'approved' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('requestV3RunCancel — durable idempotent mutation', () => {
  it('appends exactly one first-wins request and reuses its id on replay', () => {
    const base = freshBase();
    try {
      const runId = 'cancel-idempotent';
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });

      const first = requestV3RunCancel(base, runId, {
        by: 'ou_first',
        reason: 'user stopped the run',
      });
      expect(first.kind).toBe('requested');
      if (first.kind !== 'requested') throw new Error('expected requested');

      const replay = requestV3RunCancel(base, runId, {
        by: 'ou_second',
        reason: 'must not replace the original request',
      });
      expect(replay).toEqual({
        kind: 'already-requested',
        cancelRequestId: first.cancelRequestId,
      });

      const requests = readJournal(journalPath).filter((event) => event.type === 'runCancelRequested');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        cancelRequestId: first.cancelRequestId,
        by: 'ou_first',
        reason: 'user stopped the run',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each(['succeeded', 'failed'] as const)('does not append after a %s terminal', (status) => {
    const base = freshBase();
    try {
      const runId = `cancel-after-${status}`;
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(
        journalPath,
        status === 'succeeded'
          ? { type: 'runSucceeded' }
          : { type: 'runFailed', failedNodeId: 'deploy' },
      );

      expect(requestV3RunCancel(base, runId, { by: 'ou_user' })).toEqual({
        kind: 'already-terminal',
        status,
      });
      expect(readJournal(journalPath).some((event) => event.type === 'runCancelRequested')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports an already-cancelled run without appending another request', () => {
    const base = freshBase();
    try {
      const runId = 'cancel-already-terminal';
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, {
        type: 'runCancelRequested',
        cancelRequestId: 'cancel-original',
        by: 'ou_first',
      });
      appendEvent(journalPath, {
        type: 'runCancelled',
        cancelRequestId: 'cancel-original',
        by: 'ou_first',
      });

      expect(requestV3RunCancel(base, runId, { by: 'ou_second' })).toEqual({
        kind: 'already-cancelled',
        cancelRequestId: 'cancel-original',
      });
      expect(readJournal(journalPath).filter((event) => event.type === 'runCancelRequested')).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows cancellation from blocked because blocked is recoverable, not a true terminal', () => {
    const base = freshBase();
    try {
      const runId = 'cancel-from-blocked';
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });

      const outcome = requestV3RunCancel(base, runId, { by: 'ou_user' });
      expect(outcome.kind).toBe('requested');
      expect(readJournal(journalPath).filter((event) => event.type === 'runCancelRequested')).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('v3 mutation integrity — tamper fail-closed before side effects', () => {
  function tamperAuthorizedDag(runDir: string): void {
    const dagPath = join(runDir, 'dag.json');
    writeFileSync(dagPath, `${readFileSync(dagPath, 'utf-8')} `);
  }

  it('gate click re-verifies run.json artifacts before consuming the wait', async () => {
    const base = freshBase();
    try {
      const runId = 'tampered-gate-mutation';
      const runDir = seedSavedDefinitionRun(base, runId);
      await driveV3Run(runId, stubDeps(base).deps);
      const journalPath = join(runDir, 'journal.ndjson');
      const pendingPath = waitPath(runDir, 'deploy#001-gate');
      const journalBefore = readFileSync(journalPath, 'utf-8');
      const waitBefore = readFileSync(pendingPath, 'utf-8');

      tamperAuthorizedDag(runDir);
      expect(() => resolveV3GateClick(base, runId, {
        waitId: 'deploy#001-gate', selected: 'approve', by: 'ou_user',
      })).toThrow(/digest mismatch/);

      expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
      expect(readFileSync(pendingPath, 'utf-8')).toBe(waitBefore);
      expect(readWait(runDir, 'deploy#001-gate')?.status).toBe('pending');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('retry re-verifies run.json artifacts before answer.json or journal writes', () => {
    const base = freshBase();
    try {
      const runId = 'tampered-retry-mutation';
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, {
        type: 'nodeDispatched', nodeId: 'deploy', instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001',
      });
      appendEvent(journalPath, {
        type: 'nodeBlocked', nodeId: 'deploy', instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001', errorClass: 'manifestInvalid',
        errorCode: 'ASK_HUMAN', ask: { question: 'where?', options: ['prod'] },
      });
      appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });
      const journalBefore = readFileSync(journalPath, 'utf-8');

      tamperAuthorizedDag(runDir);
      expect(() => requestV3Retry(base, runId, {
        nodeId: 'deploy',
        expectedAttemptId: 'deploy#001/attempts/001',
        answer: { selected: 'prod', by: 'ou_user' },
      })).toThrow(/digest mismatch/);

      expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
      expect(existsSync(join(runDir, 'deploy#001/attempts/001', 'answer.json'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('host effect uncertain 禁止普通 retry，pre-intent block 则预约新 attempt 并重置 gate', () => {
    const base = freshBase();
    try {
      const commonPrepared = {
        type: 'hostInputPrepared' as const,
        nodeId: 'deploy',
        instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001',
        executor: 'feishu-send',
        provider: 'feishu-im',
        inputRef: { path: 'deploy#001/attempts/001/host-input.json', sha256: 'a'.repeat(64), bytes: 10 },
        inputHash: `sha256:${'b'.repeat(64)}`,
        idempotencyKey: 'wf3_key',
        idempotencyTtlMs: 3_600_000,
        approvalDigest: `sha256:${'c'.repeat(64)}`,
      };

      const uncertainId = 'host-uncertain-retry';
      const uncertainDir = seedSavedDefinitionRun(base, uncertainId);
      const uncertainJournal = join(uncertainDir, 'journal.ndjson');
      appendEvent(uncertainJournal, { type: 'runStarted', runId: uncertainId });
      appendEvent(uncertainJournal, commonPrepared);
      appendEvent(uncertainJournal, { ...commonPrepared, type: 'hostEffectIntent' });
      appendEvent(uncertainJournal, {
        type: 'hostEffectUncertain',
        nodeId: 'deploy',
        instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001',
        executor: 'feishu-send',
        reason: 'ttlExpired',
        errorCode: 'HOST_EFFECT_TTL_EXPIRED',
      });
      appendEvent(uncertainJournal, { type: 'runBlocked', blockedNodeId: 'deploy' });
      expect(requestV3Retry(base, uncertainId)).toEqual({
        kind: 'stale-run', reason: 'host-effect-uncertain',
      });
      expect(readJournal(uncertainJournal).some((event) => event.type === 'nodeRetryRequested')).toBe(false);

      const preIntentId = 'host-pre-intent-retry';
      const preIntentDir = seedSavedDefinitionRun(base, preIntentId);
      const preIntentJournal = join(preIntentDir, 'journal.ndjson');
      appendEvent(preIntentJournal, { type: 'runStarted', runId: preIntentId });
      appendEvent(preIntentJournal, commonPrepared);
      appendEvent(preIntentJournal, {
        type: 'nodeBlocked',
        nodeId: 'deploy',
        instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001',
        errorClass: 'resultInvalid',
        errorCode: 'HOST_INPUT_UNRECOVERABLE',
      });
      appendEvent(preIntentJournal, { type: 'runBlocked', blockedNodeId: 'deploy' });
      expect(requestV3Retry(base, preIntentId)).toMatchObject({
        kind: 'requested', nextAttemptId: 'deploy#001/attempts/002',
      });
      expect(readJournal(preIntentJournal)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeRetryRequested',
          nextAttemptId: 'deploy#001/attempts/002',
          resetGate: true,
        }),
      ]));

      const crashLeftId = 'host-crash-left-malformed-retry';
      const crashLeftDir = seedSavedDefinitionRun(base, crashLeftId);
      const crashLeftJournal = join(crashLeftDir, 'journal.ndjson');
      appendEvent(crashLeftJournal, { type: 'runStarted', runId: crashLeftId });
      // A crash can leave an invalid/partial sidecar before the prepared event.
      // The blocked verdict alone must consume 001 so operator retry reserves
      // a clean 002 instead of colliding with the bad path forever.
      appendEvent(crashLeftJournal, {
        type: 'nodeBlocked',
        nodeId: 'deploy',
        instanceId: 'deploy#001',
        attemptId: 'deploy#001/attempts/001',
        errorClass: 'resultInvalid',
        errorCode: 'HOST_INPUT_UNRECOVERABLE',
      });
      appendEvent(crashLeftJournal, { type: 'runBlocked', blockedNodeId: 'deploy' });
      expect(requestV3Retry(base, crashLeftId)).toMatchObject({
        kind: 'requested',
        previousAttemptId: 'deploy#001/attempts/001',
        nextAttemptId: 'deploy#001/attempts/002',
      });
      expect(readJournal(crashLeftJournal)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeRetryRequested',
          previousAttemptId: 'deploy#001/attempts/001',
          nextAttemptId: 'deploy#001/attempts/002',
        }),
      ]));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('loop and revisit grants re-verify artifacts before adding budget', () => {
    const base = freshBase();
    try {
      const loopRunId = 'tampered-loop-mutation';
      const loopRunDir = seedSavedDefinitionRun(base, loopRunId);
      const loopJournal = join(loopRunDir, 'journal.ndjson');
      appendEvent(loopJournal, { type: 'runStarted', runId: loopRunId });
      appendEvent(loopJournal, { type: 'loopStarted', loopId: 'fix' });
      appendEvent(loopJournal, { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 });
      appendEvent(loopJournal, {
        type: 'loopIterationDecision', loopId: 'fix', iteration: 1, decision: 'exhausted',
      });
      appendEvent(loopJournal, { type: 'runBlocked', blockedNodeId: 'fix' });
      const loopBefore = readFileSync(loopJournal, 'utf-8');
      tamperAuthorizedDag(loopRunDir);
      expect(() => requestV3LoopGrant(base, loopRunId, { by: 'ou_user' }))
        .toThrow(/digest mismatch/);
      expect(readFileSync(loopJournal, 'utf-8')).toBe(loopBefore);

      const revisitRunId = 'tampered-revisit-mutation';
      const revisitRunDir = seedSavedDefinitionRun(base, revisitRunId);
      const revisitJournal = join(revisitRunDir, 'journal.ndjson');
      appendEvent(revisitJournal, { type: 'runStarted', runId: revisitRunId });
      appendEvent(revisitJournal, {
        type: 'nodeDispatched', nodeId: 'deploy', instanceId: 'deploy#002',
        attemptId: 'deploy#002/attempts/001',
      });
      appendEvent(revisitJournal, {
        type: 'nodeBlocked', nodeId: 'deploy', instanceId: 'deploy#002',
        attemptId: 'deploy#002/attempts/001', errorClass: 'resultInvalid',
        errorCode: 'REVISIT_BUDGET_EXHAUSTED', revisitTo: 'prepare',
      });
      appendEvent(revisitJournal, { type: 'runBlocked', blockedNodeId: 'deploy' });
      const revisitBefore = readFileSync(revisitJournal, 'utf-8');
      tamperAuthorizedDag(revisitRunDir);
      expect(() => requestRevisitGrant(base, revisitRunId, {
        sourceNodeId: 'deploy', toNodeId: 'prepare', by: 'ou_user',
        expectedAttemptId: 'deploy#002/attempts/001',
      })).toThrow(/digest mismatch/);
      expect(readFileSync(revisitJournal, 'utf-8')).toBe(revisitBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('missing run.json legacy path rejects cross-run journal/DAG identity before mutation', () => {
    const base = freshBase();
    try {
      const runId = 'legacy-mutation-identity';
      const runDir = seedApprovedRun(base, runId, { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'another-run' });
      appendEvent(journalPath, { type: 'gateDispatched', nodeId: 'deploy', waitId: 'deploy-gate' });
      writePendingWait(runDir, { waitId: 'deploy-gate', nodeId: 'deploy', prompt: 'approve?' });
      const journalBefore = readFileSync(journalPath, 'utf-8');
      const waitBefore = readFileSync(waitPath(runDir, 'deploy-gate'), 'utf-8');

      expect(() => resolveV3GateClick(base, runId, {
        waitId: 'deploy-gate', selected: 'approve', by: 'ou_user',
      })).toThrow(/legacy journal identity mismatch/);
      expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
      expect(readFileSync(waitPath(runDir, 'deploy-gate'), 'utf-8')).toBe(waitBefore);

      // Correct the journal identity, then prove the approved DAG identity is
      // independently enforced as well.
      writeFileSync(journalPath, '');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, { type: 'gateDispatched', nodeId: 'deploy', waitId: 'deploy-gate' });
      writeFileSync(join(runDir, 'dag.json'), JSON.stringify(gateDag('another-run')));
      const beforeDagMismatch = readFileSync(journalPath, 'utf-8');
      expect(() => resolveV3GateClick(base, runId, {
        waitId: 'deploy-gate', selected: 'approve', by: 'ou_user',
      })).toThrow(/legacy DAG identity mismatch/);
      expect(readFileSync(journalPath, 'utf-8')).toBe(beforeDagMismatch);
      expect(readWait(runDir, 'deploy-gate')?.status).toBe('pending');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cold attach skips a tampered envelope without recreating waits or healing journal', () => {
    const base = freshBase();
    try {
      const runId = 'tampered-cold-attach';
      const runDir = seedSavedDefinitionRun(base, runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, {
        type: 'gateDispatched', nodeId: 'deploy', instanceId: 'deploy#001',
        waitId: 'deploy#001-gate',
      });
      const journalBefore = readFileSync(journalPath, 'utf-8');
      tamperAuthorizedDag(runDir);

      expect(reconcileV3PendingGates(base)).toEqual([]);
      expect(existsSync(waitPath(runDir, 'deploy#001-gate'))).toBe(false);
      expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('reconcileV3PendingGates — 重启恢复 + 原子窗口（codex #2/#3）', () => {
  /** 造一个 journal=gateWaiting 的 run（gateDispatched 已写，无 gateResolved）。 */
  function seedGateWaiting(base: string, runId = 'gw-run', binding = BINDING): string {
    const runDir = seedApprovedRun(base, runId, { binding });
    const jp = join(runDir, 'journal.ndjson');
    appendEvent(jp, { type: 'runStarted', runId } as any);
    appendEvent(jp, { type: 'gateDispatched', nodeId: 'deploy', waitId: 'deploy-gate' } as any);
    return runDir;
  }

  it('⭐ gateWaiting + wait file 缺失（append 后 write 前崩）→ 用 dag prompt 补写 pending wait + repost', () => {
    const base = freshBase();
    try {
      const runDir = seedGateWaiting(base);
      // 故意不写 wait file
      expect(readWait(runDir, 'deploy-gate')).toBeUndefined();

      const recs = reconcileV3PendingGates(base);
      const rec = recs.find((r) => r.runId === 'gw-run')!;
      expect(rec).toBeTruthy();
      expect(rec.resume).toBe(false);
      expect(rec.repost).toEqual([{
        nodeId: 'deploy',
        waitId: 'deploy-gate',
        prompt: '批准部署？',
        options: ['approve', 'reject'],
        approveOptions: ['approve'],
        approvers: [],
      }]);
      // 补写出了 pending wait（prompt 取自 dag.humanGate.prompt）
      expect(readWait(runDir, 'deploy-gate')).toMatchObject({ status: 'pending', prompt: '批准部署？' });
      expect(rec.binding).toEqual(BINDING);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('gateWaiting + wait pending → repost（不改 wait）', () => {
    const base = freshBase();
    try {
      const runDir = seedGateWaiting(base);
      writePendingWait(runDir, { waitId: 'deploy-gate', nodeId: 'deploy', prompt: '批准部署？' });

      const rec = reconcileV3PendingGates(base).find((r) => r.runId === 'gw-run')!;
      expect(rec.repost).toHaveLength(1);
      expect(rec.resume).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('gateWaiting + wait 已 resolved（resolveWait 后崩、journal 缺 gateResolved）→ heal 补 gateResolved + resume，不 repost', () => {
    const base = freshBase();
    try {
      const runDir = seedGateWaiting(base);
      writePendingWait(runDir, { waitId: 'deploy-gate', nodeId: 'deploy', prompt: '批准部署？' });
      resolveWait(runDir, 'deploy-gate', 'approved', 'ou_user'); // 模拟 resolve 了但 journal 没追上

      const rec = reconcileV3PendingGates(base).find((r) => r.runId === 'gw-run')!;
      expect(rec.repost).toHaveLength(0);
      expect(rec.resume).toBe(true);
      // journal 补上了 gateResolved
      const events = readJournal(join(runDir, 'journal.ndjson'));
      expect(events.some((e) => e.type === 'gateResolved' && (e as any).resolution === 'approved')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('terminal run（runSucceeded）→ 跳过', () => {
    const base = freshBase();
    try {
      const runDir = seedGateWaiting(base);
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' } as any);
      const recs = reconcileV3PendingGates(base);
      expect(recs.find((r) => r.runId === 'gw-run')).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('旧 terminal 仍有 open attempt → resume 只清资源，不重复 repost', () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'terminal-open', { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'terminal-open' });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', attemptId: 'peer/attempts/001' });
      appendEvent(journalPath, { type: 'runFailed', failedNodeId: 'deploy' });

      expect(reconcileV3PendingGates(base).find((r) => r.runId === 'terminal-open'))
        .toMatchObject({ resume: true, repost: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('旧 blocked 仍有 open peer → 先 resume drain，不提前 repost retry card', () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'blocked-open', { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'blocked-open' });
      appendEvent(journalPath, { type: 'nodeBlocked', nodeId: 'deploy', attemptId: 'deploy/attempts/001', errorClass: 'resultInvalid' });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', attemptId: 'peer/attempts/001' });
      appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'deploy' });

      const rec = reconcileV3PendingGates(base).find((r) => r.runId === 'blocked-open');
      expect(rec).toMatchObject({ resume: true, repost: [] });
      expect(rec?.repostBlocked).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('pending gate 与 open peer 并存 → 先 resume drain，不提前 repost gate', () => {
    const base = freshBase();
    try {
      const runDir = seedGateWaiting(base, 'gate-open');
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', attemptId: 'peer/attempts/001' });

      expect(reconcileV3PendingGates(base).find((r) => r.runId === 'gate-open'))
        .toMatchObject({ resume: true, repost: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('无 gateWaiting、无 in-flight 的 running run → resume（崩在可恢复点：retry append 后 / 首派前）', () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'plain', { binding: BINDING });
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'plain' } as any);
      const recs = reconcileV3PendingGates(base);
      const rec = recs.find((r) => r.runId === 'plain');
      expect(rec).toMatchObject({ resume: true, repost: [] });
      expect(rec!.repostBlocked).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('有 phantom running 节点的 run → resume，由统一 attempt barrier fence-drain 后重派', () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'phantom', { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'phantom' } as any);
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/001' } as any);
      const recs = reconcileV3PendingGates(base);
      expect(recs.find((r) => r.runId === 'phantom')).toMatchObject({ resume: true, repost: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('单个坏 grill.state / 非法 dir 名不拖死整个扫描（codex #3 best-effort）', () => {
    const base = freshBase();
    try {
      // 健康的 gateWaiting run
      seedGateWaiting(base, 'healthy');
      // grill.state 损坏的 run（仍有 gateWaiting journal）
      const bad = seedGateWaiting(base, 'corrupt');
      writeFileSync(join(bad, 'grill.state.json'), '{ this is not json');
      // 非法目录名（不该被当 run）
      writeFileSync(join(base, '..oops'), 'x');

      const recs = reconcileV3PendingGates(base);
      // 健康 run 照常恢复
      expect(recs.find((r) => r.runId === 'healthy')?.repost).toHaveLength(1);
      // 坏 grill.state 的 legacy run 身份无法验证：fail-closed 跳过，但
      // 单个坏目录不会阻断同一轮扫描里的健康 run。
      expect(recs.find((r) => r.runId === 'corrupt')).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('createV3GateRunner — in-flight 锁 + coldAttach 顺序', () => {
  it('two runners share a drive lease: durable cancel reaches the worker owner and commits once', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'lease-cancel', { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'lease-cancel' });
      appendEvent(journalPath, {
        type: 'gateDispatched', nodeId: 'deploy', instanceId: 'deploy#001', waitId: 'deploy#001-gate',
      });
      appendEvent(journalPath, {
        type: 'gateResolved', nodeId: 'deploy', instanceId: 'deploy#001', waitId: 'deploy#001-gate',
        resolution: 'approved', by: 'ou_user',
      });

      let workerStarted = false;
      let workerAborted = false;
      const runNode: RunNode = async (req) => {
        workerStarted = true;
        return await new Promise((resolve) => {
          const stop = (): void => {
            workerAborted = true;
            resolve({ status: 'cancelled', manifestPath: join(req.attemptDir, 'manifest.json') });
          };
          if (req.cancelSignal?.aborted) stop();
          else req.cancelSignal?.addEventListener('abort', stop, { once: true });
        });
      };
      const common = {
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => runNode,
        validateManifest: async () => ({ ok: false as const, problems: ['cancelled'] }),
        postCard: async () => {},
      };
      const runnerA = createV3GateRunner(common);
      const runnerB = createV3GateRunner(common);
      const a = runnerA.drive('lease-cancel');
      await vi.waitFor(() => expect(workerStarted).toBe(true));

      const request = requestV3RunCancel(base, 'lease-cancel', { by: 'ou_user' });
      if (request.kind !== 'requested') throw new Error(`unexpected cancel outcome ${request.kind}`);
      runnerB.cancelAndDrive('lease-cancel', request.cancelRequestId);
      await a;
      await vi.waitFor(() => {
        expect(readJournal(journalPath).filter((event) => event.type === 'runCancelled')).toHaveLength(1);
      });

      expect(workerAborted).toBe(true);
      expect(readJournal(journalPath).filter((event) => event.type === 'runCancelRequested')).toHaveLength(1);
      expect(readJournal(journalPath).filter((event) => event.type === 'runCancelled')).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancel during a slow postCard is re-folded by the lease holder before handoff', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'lease-card-cancel', { binding: BINDING });
      let cardStarted = false;
      let releaseCard: () => void = () => {};
      const card = new Promise<void>((resolve) => { releaseCard = resolve; });
      const common = {
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => (async () => ({ status: 'ok' as const, manifestPath: 'unused' })),
        validateManifest: async () => ({ ok: false as const, problems: ['unexpected'] }),
      };
      const runnerA = createV3GateRunner({
        ...common,
        postCard: async () => { cardStarted = true; await card; },
      });
      const runnerB = createV3GateRunner({ ...common, postCard: async () => {} });
      const a = runnerA.drive('lease-card-cancel');
      await vi.waitFor(() => expect(cardStarted).toBe(true));
      const request = requestV3RunCancel(base, 'lease-card-cancel', { by: 'ou_user' });
      if (request.kind !== 'requested') throw new Error(`unexpected cancel outcome ${request.kind}`);
      const b = runnerB.drive('lease-card-cancel');

      releaseCard();
      await Promise.all([a, b]);
      const events = readJournal(join(runDir, 'journal.ndjson'));
      expect(events.filter((event) => event.type === 'runCancelled')).toHaveLength(1);
      expect(events.some((event) => event.type === 'nodeCancelled' && event.nodeId === 'deploy')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('progress lifecycle hook 失败只上报，不改变 workflow 结果', async () => {
    const base = freshBase();
    try {
      seedApprovedRun(base, 'hook-run', { binding: BINDING });
      const onError = vi.fn();
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => (async () => ({ status: 'ok', manifestPath: 'm' })) as any,
        validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
        postCard: async () => {},
        onDriveBegin: async () => { throw new Error('begin transport down'); },
        onDriveEnd: async () => { throw new Error('end transport down'); },
        onError,
      });

      await expect(runner.drive('hook-run')).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError.mock.calls.map((call) => String(call[1]))).toEqual(expect.arrayContaining([
        expect.stringContaining('begin hook failed'),
        expect.stringContaining('end hook failed'),
      ]));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('drive 并发去重：第一次未完成时同 runId 第二次直接 no-op', async () => {
    const base = freshBase();
    try {
      seedApprovedRun(base, 'gate-run', { binding: BINDING });
      let postCalls = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => (async () => ({ status: 'ok', manifestPath: 'm' })) as any,
        validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
        // postCard 阻塞 → 第一次 drive 挂在这（inFlight 锁着 gate-run）
        postCard: async () => { postCalls++; await gate; },
      });
      const p1 = runner.drive('gate-run'); // 进入、awaitingGate、postCard 阻塞
      const p2 = runner.drive('gate-run'); // inFlight.has('gate-run') → 立即 no-op
      await p2; // 快速返回（被去重）
      await vi.waitFor(() => expect(postCalls).toBe(1));
      expect(postCalls).toBe(1); // 只有第一次 drive 发了卡
      release();
      await p1;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldAttach：旧 runBlocked 先清 peer close proof，再投递 retry card', async () => {
    const base = freshBase();
    try {
      const runId = 'cold-blocked-open';
      const runDir = seedApprovedRun(base, runId, { binding: BINDING });
      writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
        runId,
        nodes: [
          { id: 'blocker', type: 'goal', goal: 'blocked', depends: [], inputs: [] },
          { id: 'peer', type: 'goal', goal: 'old peer', depends: [], inputs: [] },
        ],
      }));
      const journalPath = join(runDir, 'journal.ndjson');
      const attemptId = 'peer#001/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, { type: 'nodeBlocked', nodeId: 'blocker', instanceId: 'blocker#001', attemptId: 'blocker#001/attempts/001', errorClass: 'resultInvalid' });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      const armed = armV3AttemptWorkerFence({ attemptDir, runId, attemptId });
      closeV3ArmedFenceWithoutSpawn(attemptDir, armed, 'setup_failed');
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'blocker' });

      const postBlockedCard = vi.fn(async () => {
        expect(readJournal(journalPath)).toContainEqual(expect.objectContaining({
          type: 'nodeAttemptDrained', attemptId,
        }));
      });
      const runNode = vi.fn(async () => { throw new Error('must not dispatch during cleanup'); });
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => runNode,
        validateManifest: async () => ({ ok: false as const, problems: ['unused'] }),
        postCard: async () => {},
        postBlockedCard,
      });

      await runner.coldAttach();
      await vi.waitFor(() => expect(postBlockedCard).toHaveBeenCalledTimes(1));
      expect(runNode).not.toHaveBeenCalled();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldAttach：旧 true-terminal 清 open peer，但不重复 terminal 通知', async () => {
    const base = freshBase();
    try {
      const runId = 'cold-terminal-open';
      const runDir = seedApprovedRun(base, runId, { binding: BINDING });
      writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
        runId,
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'failed', depends: [], inputs: [] },
          { id: 'peer', type: 'goal', goal: 'old peer', depends: [], inputs: [] },
        ],
      }));
      const journalPath = join(runDir, 'journal.ndjson');
      const attemptId = 'peer#001/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      appendEvent(journalPath, { type: 'runStarted', runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      const armed = armV3AttemptWorkerFence({ attemptDir, runId, attemptId });
      closeV3ArmedFenceWithoutSpawn(attemptDir, armed, 'setup_failed');
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      appendEvent(journalPath, { type: 'runFailed', failedNodeId: 'fatal' });

      const notifyTerminal = vi.fn(async () => {});
      const runNode = vi.fn(async () => { throw new Error('must not dispatch during cleanup'); });
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => runNode,
        validateManifest: async () => ({ ok: false as const, problems: ['unused'] }),
        postCard: async () => {},
        notifyTerminal,
      });

      await runner.coldAttach();
      await vi.waitFor(() => {
        expect(readJournal(journalPath)).toContainEqual(expect.objectContaining({
          type: 'nodeAttemptDrained', attemptId,
        }));
      });
      expect(runNode).not.toHaveBeenCalled();
      expect(notifyTerminal).not.toHaveBeenCalled();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldAttach：先 repost 卡再 resume drive（resolved-but-unjournaled 才 resume）', async () => {
    const base = freshBase();
    try {
      // run A：pending gate → 应 repost，不 resume
      const a = seedApprovedRun(base, 'run-a', { binding: BINDING });
      appendEvent(join(a, 'journal.ndjson'), { type: 'runStarted', runId: 'run-a' } as any);
      appendEvent(join(a, 'journal.ndjson'), { type: 'gateDispatched', nodeId: 'deploy', waitId: 'deploy-gate' } as any);
      writePendingWait(a, { waitId: 'deploy-gate', nodeId: 'deploy', prompt: 'p' });

      const posted: string[] = [];
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => (async () => ({ status: 'ok', manifestPath: 'm' })) as any,
        validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
        postCard: async (_b, gate, runId) => { posted.push(`${runId}:${gate.waitId}`); },
      });
      await runner.coldAttach();
      expect(posted).toContain('run-a:deploy-gate');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('reconcileV3PendingGates — 多 daemon owner 过滤（codex blocker #1）', () => {
  function seedGW(base: string, runId: string, larkAppId: string): string {
    const runDir = seedApprovedRun(base, runId, { binding: { ...BINDING, larkAppId } });
    const jp = join(runDir, 'journal.ndjson');
    appendEvent(jp, { type: 'runStarted', runId } as any);
    appendEvent(jp, { type: 'gateDispatched', nodeId: 'deploy', waitId: 'deploy-gate' } as any);
    writePendingWait(runDir, { waitId: 'deploy-gate', nodeId: 'deploy', prompt: 'p' });
    return runDir;
  }
  it('只返回 binding.larkAppId === ownerLarkAppId 的 run', () => {
    const base = freshBase();
    try {
      seedGW(base, 'mine', 'cli_mine');
      seedGW(base, 'theirs', 'cli_theirs');
      const mine = reconcileV3PendingGates(base, 'cli_mine');
      expect(mine.map((r) => r.runId)).toEqual(['mine']);
      const theirs = reconcileV3PendingGates(base, 'cli_theirs');
      expect(theirs.map((r) => r.runId)).toEqual(['theirs']);
      // 不传 owner → 全都扫到（单 daemon / 测试）
      expect(reconcileV3PendingGates(base).map((r) => r.runId).sort()).toEqual(['mine', 'theirs']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('createV3GateRunner — coalescing：drive 期间 click 不丢（codex blocker #2）', () => {
  it('postCard 阻塞时 resolve gate + driveDetached → release 后续 drive 到 terminal', async () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'gate-run', { binding: BINDING });
      let postCalled = false;
      let release: () => void = () => {};
      const blocked = new Promise<void>((r) => { release = r; });
      const notifyTerminal = vi.fn(async () => {});
      const runner = createV3GateRunner({
        baseDir: base,
        loadBots: () => [{ larkAppId: 'cli_test', larkAppSecret: 's', cliId: 'claude-code' } as any],
        makeRunNode: () => (async () => ({ status: 'ok', manifestPath: 'm' })) as any,
        validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
        postCard: async () => { postCalled = true; await blocked; },
        notifyTerminal,
      });

      const p1 = runner.drive('gate-run'); // → awaitingGate → postCard 阻塞（inFlight 锁着）
      for (let i = 0; i < 100 && !postCalled; i++) await new Promise((r) => setTimeout(r, 5));
      expect(postCalled).toBe(true);

      // 模拟用户点卡（gate resolve）+ 在 drive 仍 in-flight 时再 driveDetached
      resolveWait(runDir, 'deploy#001-gate', 'approved', 'ou_user');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved', nodeId: 'deploy', waitId: 'deploy#001-gate', resolution: 'approved', by: 'ou_user',
      } as any);
      runner.driveDetached('gate-run'); // in-flight → coalesce 成 rerun（不能丢）

      release(); // 解锁 postCard → 首轮 driveV3Run 收尾 → rerun loop 再跑 → gate 已清 → terminal
      await p1;

      expect(notifyTerminal).toHaveBeenCalledTimes(1); // 续跑到了 terminal（click 没被丢）
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
