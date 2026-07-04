import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { driveV3Run, resolveV3GateClick, reconcileV3PendingGates, createV3GateRunner, type V3DaemonRunDeps } from '../src/workflows/v3/daemon-run.js';
import { birthRun, writeGrillState, readGrillState } from '../src/workflows/v3/grill-state.js';
import { resolveWait, readWait, writePendingWait } from '../src/workflows/v3/human-gate.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import type { RunNode } from '../src/workflows/v3/contract.js';

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

/** Birth a run + write an approved dag.json + point grill state at it. */
function seedApprovedRun(base: string, runId: string, opts: { binding?: typeof BINDING } = {}): string {
  const { runDir } = birthRun({ goal: 'g', baseDir: base, runId, chatBinding: opts.binding });
  const dagPath = join(runDir, 'dag.json');
  writeFileSync(dagPath, JSON.stringify(gateDag(runId)));
  const state = readGrillState(runDir)!;
  writeGrillState(runDir, { ...state, status: 'dag_approved', dagPath });
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

  it('无 grill state（runId 不存在）→ 抛错', async () => {
    const base = freshBase();
    try {
      const { deps } = stubDeps(base);
      await expect(driveV3Run('ghost', deps)).rejects.toThrow(/no grill state/);
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
      const { runDir } = birthRun({ goal: 'g', baseDir: base, runId, chatBinding: BINDING });
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

  it('有 phantom running 节点的 run → 不动（dangling-attempt 恢复留给 fencing backlog）', () => {
    const base = freshBase();
    try {
      const runDir = seedApprovedRun(base, 'phantom', { binding: BINDING });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: 'phantom' } as any);
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'deploy', attemptId: 'deploy/attempts/001' } as any);
      const recs = reconcileV3PendingGates(base);
      expect(recs.find((r) => r.runId === 'phantom')).toBeUndefined();
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
      // 坏 grill.state 的 run：readGrillState 返回 undefined（不抛），仍能补 wait + repost（只是 binding 为空）
      const corrupt = recs.find((r) => r.runId === 'corrupt');
      expect(corrupt).toBeTruthy();
      expect(corrupt!.binding).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('createV3GateRunner — in-flight 锁 + coldAttach 顺序', () => {
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
      expect(postCalls).toBe(1); // 只有第一次 drive 发了卡
      release();
      await p1;
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
