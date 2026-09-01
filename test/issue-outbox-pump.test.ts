import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pumpOnce, startIssueOutboxPump } from '../src/services/issue-outbox-pump.js';
import {
  claimNextOutboxRow,
  createBinding,
  enqueueDesiredStatus,
  getBinding,
  listOutbox,
  resetInflightToPending,
  updateBinding,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-pump-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const CLAIM = 'c'.repeat(32);

function seed(anchorId = 'oc_task', issueId = 'iss-1', claimId = CLAIM) {
  createBinding(dataDir, {
    anchorId,
    larkAppId: 'cli_worker',
    scope: 'chat',
    issueId,
    teamId: 't1',
    platformBaseUrl: 'https://p.example',
    claimId,
    claimEpoch: 3,
    chatId: anchorId,
  });
  return updateBinding(dataDir, anchorId, { bindState: 'bound', platformStateRev: 7 })!;
}

function issue(over: Record<string, unknown> = {}) {
  return { _id: 'iss-1', status: 'in_progress', stateRev: 8, claim: { claimId: CLAIM, lastSourceSeq: 1 }, ...over } as any;
}

function writer(over: any = {}) {
  return {
    writeStatus: vi.fn(async () => ({ ok: true as const, value: { issue: issue() } })),
    fetchIssue: vi.fn(async () => issue()),
    ...over,
  };
}

describe('重投积压的回写', () => {
  // 这是整个泵存在的理由：在它之前，失败的 in_progress 就永远躺在发件箱里，
  // 5 分钟后平台把任务打成 needs_attention，而那是单向门。
  it('把 pending 行发出去', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer();
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(1);
    expect(w.writeStatus).toHaveBeenCalledWith('iss-1', expect.objectContaining({ status: 'in_progress' }));
    expect(listOutbox(dataDir, 'oc_task').every((r) => r.state === 'done')).toBe(true);
  });

  it('没有待发行时一次平台调用都不发', async () => {
    seed();
    const w = writer();
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(w.writeStatus).not.toHaveBeenCalled();
  });

  // 终态 binding 的 issue 已经不归本机管，发过去只会被平台拒。
  it('跳过已释放/作废的 binding', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    updateBinding(dataDir, 'oc_task', { bindState: 'released' });
    const w = writer();
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(w.writeStatus).not.toHaveBeenCalled();
  });

  // 退避未到期的行不该被提前重发，否则退避形同虚设。
  it('尊重 nextRetryAt 退避', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer({ writeStatus: vi.fn(async () => ({ ok: false, reason: 'network', error: 'ETIMEDOUT' })) });
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(w.writeStatus).toHaveBeenCalledTimes(1);
    // 立刻再跑一轮：还在退避窗口里，不该再打平台
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(w.writeStatus).toHaveBeenCalledTimes(1);
  });

  // 同一 issue 要求 sourceSeq 单调到达，一轮多发只会让顺序乱掉被平台静默丢弃。
  // 两条同时待发是真实存在的：一条发送中崩溃（inflight）→ 又排了一条（pending）→
  // 重启解卡把 inflight 退回 pending，于是同一 binding 有两条 pending。
  it('每个 binding 每轮只发一条，且按 sourceSeq 从小到大', async () => {
    seed();
    const first = enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress')!;
    claimNextOutboxRow(dataDir, 'oc_task'); // 发送中崩溃
    const second = enqueueDesiredStatus(dataDir, 'oc_task', 'in_review')!;
    resetInflightToPending(dataDir);
    expect(listOutbox(dataDir, 'oc_task').filter((r) => r.state === 'pending')).toHaveLength(2);
    expect(second.sourceSeq).toBeGreaterThan(first.sourceSeq);

    const w = writer();
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(1);
    expect(w.writeStatus).toHaveBeenCalledTimes(1);
    expect(w.writeStatus).toHaveBeenCalledWith('iss-1', expect.objectContaining({ sourceSeq: first.sourceSeq }));

    // 下一轮才轮到第二条
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(1);
    expect(w.writeStatus).toHaveBeenLastCalledWith('iss-1', expect.objectContaining({ sourceSeq: second.sourceSeq }));
  });

  it('多个 binding 各发各的', async () => {
    seed('oc_a', 'iss-1', 'a'.repeat(32));
    seed('oc_b', 'iss-2', 'b'.repeat(32));
    enqueueDesiredStatus(dataDir, 'oc_a', 'in_progress');
    enqueueDesiredStatus(dataDir, 'oc_b', 'in_progress');
    expect(await pumpOnce({ dataDir, writer: writer() as any })).toBe(2);
  });
});

describe('启动解卡', () => {
  // claimNextOutboxRow 见到 inflight 就返回 null（串行是硬约束）。进程若崩在
  // 「标了 inflight、还没记结果」之间，那一行永远停在 inflight —— 此后该 binding 的
  // 所有回写都发不出去，report/release 每次都回"稍后重试"而永远不会好。
  it('把卡死的 inflight 行退回待发', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    claimNextOutboxRow(dataDir, 'oc_task'); // 模拟发送中崩溃
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('inflight');

    // 解卡前：泵发不出任何东西（这正是永久卡死的样子）
    const before = writer();
    expect(await pumpOnce({ dataDir, writer: before as any })).toBe(0);
    expect(before.writeStatus).not.toHaveBeenCalled();

    const stop = startIssueOutboxPump({ dataDir, intervalMs: 60_000, isBound: () => false });
    stop();
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('pending');

    const after = writer();
    expect(await pumpOnce({ dataDir, writer: after as any })).toBe(1);
  });
});

describe('定时器', () => {
  async function runPumpFor(bound: boolean, w: any) {
    const stop = startIssueOutboxPump({ dataDir, intervalMs: 5, writer: w, isBound: () => bound });
    for (let i = 0; i < 60 && w.writeStatus.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    stop();
  }

  it('绑定后按周期把积压发出去', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer();
    await runPumpFor(true, w);
    expect(w.writeStatus).toHaveBeenCalledTimes(1);
  });

  // 未绑定时整个 issue 功能是关的，定时器空转只会白读文件。上一个用例证明了同样的
  // 输入在绑定时确实会发，所以这里的"没发"不是因为泵坏了。
  it('未绑定平台时不发送', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer();
    await runPumpFor(false, w);
    expect(w.writeStatus).not.toHaveBeenCalled();
  });
});

describe('claim 已不归本机', () => {
  // 平台上被 force-detach / 租约过期 / 别人领走：再打多少次都一样，必须就此结算，
  // 否则这条行会一直退避重投到天荒地老。
  it('结算掉，不无限重投', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer({
      writeStatus: vi.fn(async () => ({ ok: false, reason: 'conflict', status: 409, error: 'claim_mismatch' })),
      fetchIssue: vi.fn(async () => issue({ stateRev: 20, claim: { claimId: '别人的', lastSourceSeq: 9 } })),
    });
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(1);
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('done');
    expect(getBinding(dataDir, 'oc_task')?.bindState).toBe('bound'); // 泵不改 bindState
  });
});

// 之前 flushNextStatus 永远传 `{}`，于是 401/403/404 这些「再发一次结果不变」的失败
// 也退回 pending 无限退避重投：每 ≤5 分钟朝死端点打一发，而 /issue status 上那句
// 「N 条回写没发出去」永不清零。
describe('永久失败就此打住', () => {
  const perm = (reason: string, status: number) =>
    writer({ writeStatus: vi.fn(async () => ({ ok: false, reason, status, error: 'nope' })) });

  it('403 → 标 failed，后续轮次不再重投', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = perm('forbidden', 403);
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('failed');

    // 再跑一轮：failed 行不再被领取，一次平台调用都不该发
    expect(await pumpOnce({ dataDir, writer: w as any })).toBe(0);
    expect(w.writeStatus).toHaveBeenCalledTimes(1);
  });

  it('404 同样判死', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    await pumpOnce({ dataDir, writer: perm('client', 404) as any });
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('failed');
  });

  // 反面：可恢复的失败必须留在 pending，否则一次网络抖动就把状态永久丢了。
  it('503 / 网络失败仍退回 pending 等重投', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    await pumpOnce({ dataDir, writer: perm('server', 503) as any });
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('pending');
  });

  // 409 是竞争不是错误：对账本身可能因为网络问题没做成，判死等于扔掉一条正常的回写。
  it('409 对账失败后不判死', async () => {
    seed();
    enqueueDesiredStatus(dataDir, 'oc_task', 'in_progress');
    const w = writer({
      writeStatus: vi.fn(async () => ({ ok: false, reason: 'conflict', status: 409, error: 'rev' })),
      fetchIssue: vi.fn(async () => null), // 拉不到 → 无法判定，不猜
    });
    await pumpOnce({ dataDir, writer: w as any });
    expect(listOutbox(dataDir, 'oc_task')[0].state).toBe('pending');
  });
});
