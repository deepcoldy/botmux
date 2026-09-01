import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLockSync } from '../src/utils/file-lock.js';
import {
  buildLocalTaskRef,
  claimNextOutboxRow,
  clearClaimIntent,
  createBinding,
  enqueueDesiredStatus,
  failOutboxRow,
  findActiveBindingByIssue,
  findBindingByClaimId,
  getBinding,
  getClaimIntent,
  listClaimIntents,
  listDanglingClaimIntents,
  listOutbox,
  pruneOutbox,
  recordClaimIntent,
  removeBinding,
  resetInflightToPending,
  settleOutboxRow,
  updateBinding,
  updateClaimIntent,
  type CreateBindingInput,
} from '../src/services/issue-board-store.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-board-store-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function seed(over: Partial<CreateBindingInput> = {}): CreateBindingInput {
  return {
    anchorId: 'oc_group1',
    larkAppId: 'cli_app',
    scope: 'chat',
    issueId: 'iss-1',
    teamId: 't1',
    platformBaseUrl: 'https://platform.example',
    claimId: 'c-random-1',
    claimEpoch: 1,
    ...over,
  };
}

describe('localTaskRef', () => {
  // 协议要求 bind（带 localTaskRef）先于 activate，而 botmux 的 session id 要等 kickoff
  // 把 bot @ 起来之后才产生——所以锚点只能是建群/发 seed 就已存在的 chatId / rootMessageId。
  it('与 botmux 自己的 sessionKey 同源，anchor 在前、appId 在后', async () => {
    const { sessionKey } = await import('../src/core/types.js');
    expect(buildLocalTaskRef('oc_group1', 'cli_app')).toBe(sessionKey('oc_group1', 'cli_app'));
    expect(buildLocalTaskRef('oc_group1', 'cli_app')).toBe('oc_group1::cli_app');
    // 话题模式锚在 rootMessageId 上；om_/oc_ 两个地址空间不会碰撞
    expect(buildLocalTaskRef('om_root1', 'cli_app')).toBe('om_root1::cli_app');
  });
});

describe('bindings', () => {
  it('新建后可按 anchorId / claimId / issueId 查到，sourceSeq 从 1 起', () => {
    const b = createBinding(dataDir, seed());
    expect(b.bindState).toBe('pending');
    expect(b.nextSourceSeq).toBe(1);
    expect(getBinding(dataDir, 'oc_group1')?.issueId).toBe('iss-1');
    expect(findBindingByClaimId(dataDir, 'c-random-1')?.anchorId).toBe('oc_group1');
    expect(findActiveBindingByIssue(dataDir, 'iss-1')?.anchorId).toBe('oc_group1');
  });

  // 类型上已经不给传，这条守的是「将来别改回 pass-through」：手拼拼反了不会当场报错，
  // 要等平台 bind 与崩溃恢复的重确认对不上、held 会话被判 claim_mismatch 才暴露。
  it('localTaskRef 由 anchorId + larkAppId 内生，不接受调用方传入', () => {
    const b = createBinding(dataDir, seed({ anchorId: 'om_root9', larkAppId: 'cli_other' }));
    expect(b.localTaskRef).toBe(buildLocalTaskRef('om_root9', 'cli_other'));
    expect(b.localTaskRef).toBe('om_root9::cli_other');
    // 即便调用方硬塞（绕过类型）也不生效
    const forced = createBinding(
      dataDir,
      {
        ...seed({ anchorId: 'oc_g3', claimId: 'c-3', issueId: 'iss-3' }),
        localTaskRef: 'cli_app::oc_g3', // 顺序拼反的老写法
      } as CreateBindingInput,
    );
    expect(forced.localTaskRef).toBe('oc_g3::cli_app');
  });

  // 领取重试必须幂等：否则一次网络重试就会多建一个群、多起一个会话。
  it('同 claimId 重入返回既有 binding，不新建第二条', () => {
    const first = createBinding(dataDir, seed());
    const again = createBinding(dataDir, seed({ anchorId: 'oc_group2' }));
    expect(again.anchorId).toBe(first.anchorId);
    expect(getBinding(dataDir, 'oc_group2')).toBeNull();
  });

  it('void 的 binding 不再算作该 issue 的活跃绑定', () => {
    createBinding(dataDir, seed());
    updateBinding(dataDir, 'oc_group1', { bindState: 'void' });
    expect(findActiveBindingByIssue(dataDir, 'iss-1')).toBeNull();
    expect(findBindingByClaimId(dataDir, 'c-random-1')).not.toBeNull(); // 反查仍能拿到，供对账
  });

  // 终态有两个（void / released），漏改任何一处判断都会让已释放的 issue 仍被当成已领取：
  // 重领被拦、回写继续发，而且全程不报错。
  it('released 的 binding 同样不再算活跃', () => {
    createBinding(dataDir, seed());
    updateBinding(dataDir, 'oc_group1', { bindState: 'released' });
    expect(findActiveBindingByIssue(dataDir, 'iss-1')).toBeNull();
    expect(findBindingByClaimId(dataDir, 'c-random-1')).not.toBeNull();
  });

  it('updateBinding 不动 anchorId/createdAt，removeBinding 删得掉', () => {
    const b = createBinding(dataDir, seed());
    const p = updateBinding(dataDir, 'oc_group1', { bindState: 'bound', chatId: 'oc_x' });
    expect(p?.bindState).toBe('bound');
    expect(p?.chatId).toBe('oc_x');
    expect(p?.createdAt).toBe(b.createdAt);
    expect(removeBinding(dataDir, 'oc_group1')).toBe(true);
    expect(removeBinding(dataDir, 'oc_group1')).toBe(false);
  });

  it('损坏的 bindings 文件不抛异常，按空表处理', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dataDir, 'issue-bindings.json'), '{ this is not json');
    expect(getBinding(dataDir, 'oc_group1')).toBeNull();
    expect(() => createBinding(dataDir, seed())).not.toThrow();
  });
});

describe('outbox 去重合并', () => {
  beforeEach(() => createBinding(dataDir, seed()));

  it('首次投影排一条 pending，sourceSeq=1 且 binding 计数器前进', () => {
    const row = enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    expect(row?.sourceSeq).toBe(1);
    expect(row?.state).toBe('pending');
    expect(getBinding(dataDir, 'oc_group1')?.nextSourceSeq).toBe(2);
  });

  it('重复投影同一目标 → 不新增行', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')).toBeNull();
    expect(listOutbox(dataDir, 'oc_group1')).toHaveLength(1);
  });

  // 离线期间 30s 一次 tick 会反复投影。若每次追加，恢复后会把一串过时中间态依次发出去，
  // 最新状态还排在队尾——这正是设计里去重合并要解决的问题。
  it('pending 行被就地覆盖为最新目标，不产生一串中间态', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_review');
    const done = enqueueDesiredStatus(dataDir, 'oc_group1', 'done');
    const rows = listOutbox(dataDir, 'oc_group1');
    expect(rows).toHaveLength(1);
    expect(rows[0].targetStatus).toBe('done');
    expect(done?.sourceSeq).toBe(3); // 每次覆盖都重分配序号，保持单调
    expect(getBinding(dataDir, 'oc_group1')?.nextSourceSeq).toBe(4);
  });

  it('已发出（inflight）之后再投影新目标 → 追加新行而不是覆盖', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    claimNextOutboxRow(dataDir, 'oc_group1');
    const next = enqueueDesiredStatus(dataDir, 'oc_group1', 'in_review');
    expect(next).not.toBeNull();
    expect(listOutbox(dataDir, 'oc_group1')).toHaveLength(2);
  });

  it('desired 与已同步状态相同 → 不排队', () => {
    updateBinding(dataDir, 'oc_group1', { lastSyncedStatus: 'in_progress' });
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')).toBeNull();
  });

  it('void 的 binding 不再排队回写', () => {
    updateBinding(dataDir, 'oc_group1', { bindState: 'void' });
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')).toBeNull();
  });

  it('expectedStateRev 缺省取 binding 上记录的平台 stateRev', () => {
    updateBinding(dataDir, 'oc_group1', { platformStateRev: 7 });
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')?.expectedStateRev).toBe(7);
    // 显式传入时以传入为准
    claimNextOutboxRow(dataDir, 'oc_group1');
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'done', { expectedStateRev: 9 })?.expectedStateRev).toBe(9);
  });
});

describe('outbox 串行 pump', () => {
  beforeEach(() => createBinding(dataDir, seed()));

  // 平台要求同一 issue 的 sourceSeq 单调到达，并发发送会打乱顺序。
  it('同一 binding 已有 inflight 时不再领取下一条', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    claimNextOutboxRow(dataDir, 'oc_group1');
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_review');
    expect(claimNextOutboxRow(dataDir, 'oc_group1')).toBeNull();
  });

  it('领取会把 pending 标 inflight 并累加 attempts', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1');
    expect(row?.state).toBe('inflight');
    expect(row?.attempts).toBe(1);
  });

  it('settle 后写回 lastSyncedStatus 与 platformStateRev，且不再被领取', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 12 });
    const b = getBinding(dataDir, 'oc_group1')!;
    expect(b.lastSyncedStatus).toBe('in_progress');
    expect(b.platformStateRev).toBe(12);
    expect(claimNextOutboxRow(dataDir, 'oc_group1')).toBeNull();
  });

  // 409 对账发现 claim 已易主时用：这条行不用再发了，但平台**没有**采纳它。若照常写
  // lastSyncedStatus，下一次投影同一状态会走幂等分支直接回成功，平台却纹丝不动——静默谎报。
  it('applied:false 结算：标 done 但不写 lastSyncedStatus', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_review');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 20, applied: false });
    const b = getBinding(dataDir, 'oc_group1')!;
    expect(b.lastSyncedStatus).toBeUndefined();
    expect(b.platformStateRev).toBe(20);
    expect(listOutbox(dataDir, 'oc_group1').every((r) => r.state === 'done')).toBe(true);
  });

  it('失败退回 pending 并按退避推迟；到点后可再领', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    const t0 = 1_000_000;
    failOutboxRow(dataDir, row.writeId, 'ECONNRESET', {}, t0);
    expect(claimNextOutboxRow(dataDir, 'oc_group1', t0)).toBeNull(); // 退避未到
    const again = claimNextOutboxRow(dataDir, 'oc_group1', t0 + 10_000);
    expect(again?.attempts).toBe(2);
  });

  it('fatal 失败标 failed，不再重试', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    failOutboxRow(dataDir, row.writeId, 'machine_mismatch', { fatal: true });
    expect(claimNextOutboxRow(dataDir, 'oc_group1', Date.now() + 3_600_000)).toBeNull();
    expect(listOutbox(dataDir, 'oc_group1')[0].state).toBe('failed');
  });
});

describe('sourceSeq 跨文件写序', () => {
  // enqueue 要写两个文件（binding 的计数器 + outbox 的行），单文件原子写保不了跨文件原子性。
  // 写序必须是「先 bump 计数器、再写 outbox」：崩在中间最坏只是跳号（平台只要求单调、
  // 不要求连续）。反过来先写 outbox 的话，崩溃后计数器还停在 N，该行 settle 之后下一次
  // 投影会复用 N，平台按 `sourceSeq <= lastSourceSeq` 静默 no-op —— 新状态永远上不去。
  it('outbox 行落盘时计数器一定已经前进（不会复用序号）', () => {
    createBinding(dataDir, seed());
    const row = enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')!;
    expect(getBinding(dataDir, 'oc_group1')!.nextSourceSeq).toBe(row.sourceSeq + 1);
  });

  // 写序只保证「不再产生」污染态，救不了**已经**落在盘上的污染态（旧版本写下的、外部手改
  // 的、未来重构又把写序改回去的）。所以分配序号还要兜一层 max(计数器, outbox 见过的最大
  // seq + 1)——复用序号的后果是平台静默 no-op，太安静，不值得只靠写序的正确性来担保。
  it('计数器被污染（落后于已排出的行）时自愈：settle 后新行序号必须更大', () => {
    createBinding(dataDir, seed());
    const first = enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress')!;
    // 人为把计数器退回到崩溃窗口里的样子（旧写序会留下这种状态）
    updateBinding(dataDir, 'oc_group1', { nextSourceSeq: first.sourceSeq });

    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 3 });
    const next = enqueueDesiredStatus(dataDir, 'oc_group1', 'done')!;
    // 即便从被污染的计数器出发，新行也绝不能与已 settle 的行同号——同号会被平台静默丢弃
    expect(next.sourceSeq).toBeGreaterThan(first.sourceSeq);
  });
});

describe('串行 pump 取序', () => {
  // 失败退回的旧行（低 seq）与之后排入的新行（高 seq）会同时 pending。
  // 必须按 sourceSeq 升序发，不能靠数组下标——平台按单调判重，先发高序号会让低序号那条被丢弃。
  it('同时有多条 pending 时取 sourceSeq 最小的', () => {
    createBinding(dataDir, seed());
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const older = claimNextOutboxRow(dataDir, 'oc_group1')!; // seq 1 → inflight
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_review'); // seq 2 → pending
    failOutboxRow(dataDir, older.writeId, 'ECONNRESET', {}, 0); // seq 1 退回 pending

    const next = claimNextOutboxRow(dataDir, 'oc_group1', Date.now() + 60_000)!;
    expect(next.sourceSeq).toBe(older.sourceSeq);
  });
});

describe('一 issue 一活跃 binding', () => {
  // 写下去就是同一个 issue 两个群、两个 agent 同时开工，而平台只认最后一次 claim，
  // 另一个群会变成谁也不管的孤儿。抛在这里离原因最近。
  it('同 issue 不同 claimId → 抛错，不静默写第二条', () => {
    createBinding(dataDir, seed());
    expect(() =>
      createBinding(dataDir, seed({ anchorId: 'oc_group2', claimId: 'c-random-2' })),
    ).toThrow(/已有活跃 binding/);
    expect(getBinding(dataDir, 'oc_group2')).toBeNull();
  });

  it('旧 binding 置 void 后可以重新领取', () => {
    createBinding(dataDir, seed());
    updateBinding(dataDir, 'oc_group1', { bindState: 'void' });
    const again = createBinding(
      dataDir,
      seed({ anchorId: 'oc_group2', claimId: 'c-random-2' }),
    );
    expect(again.anchorId).toBe('oc_group2');
  });
});

describe('崩溃对账', () => {
  // 「标 inflight 后、记录响应前」崩溃的行会永久堵死该 binding 的串行 pump。
  it('启动时把 inflight 全退回 pending，pump 恢复', () => {
    createBinding(dataDir, seed());
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    claimNextOutboxRow(dataDir, 'oc_group1');
    expect(claimNextOutboxRow(dataDir, 'oc_group1')).toBeNull(); // 崩溃前的堵塞态

    expect(resetInflightToPending(dataDir)).toBe(1);
    expect(claimNextOutboxRow(dataDir, 'oc_group1')?.state).toBe('inflight');
  });

  it('没有 inflight 时不写文件、返回 0', () => {
    createBinding(dataDir, seed());
    expect(resetInflightToPending(dataDir)).toBe(0);
  });
});

describe('pruneOutbox', () => {
  it('只清 done、保留最近 N 条', () => {
    createBinding(dataDir, seed());
    for (let i = 0; i < 5; i++) {
      enqueueDesiredStatus(dataDir, 'oc_group1', i % 2 === 0 ? 'in_progress' : 'in_review');
      const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
      settleOutboxRow(dataDir, row.writeId, {});
    }
    enqueueDesiredStatus(dataDir, 'oc_group1', 'done');
    expect(pruneOutbox(dataDir, 2)).toBe(3);
    const rows = listOutbox(dataDir, 'oc_group1');
    expect(rows.filter((r) => r.state === 'done')).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(1); // 未完成的绝不清
  });
});

describe('claim 意图（补 claim 成功→建群之间的窗口）', () => {
  function intent(over: Partial<Parameters<typeof recordClaimIntent>[1]> = {}) {
    return {
      claimId: 'c-random-1',
      issueId: 'iss-1',
      teamId: 't1',
      claimEpoch: 1,
      platformBaseUrl: 'https://platform.example',
      platformStateRev: 2,
      larkAppId: 'cli_app',
      scope: 'chat' as const,
      ...over,
    };
  }

  it('记录后可按 claimId 反查，anchorId 先缺席（建群前本来就没有）', () => {
    const i = recordClaimIntent(dataDir, intent());
    expect(i.anchorId).toBeUndefined();
    expect(getClaimIntent(dataDir, 'c-random-1')?.issueId).toBe('iss-1');
  });

  // claim 本身幂等，网络重试不该在本地留下两条意图。
  it('同 claimId 重入返回既有记录', () => {
    const first = recordClaimIntent(dataDir, intent());
    const again = recordClaimIntent(dataDir, intent({ issueId: 'iss-999' }));
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.issueId).toBe('iss-1');
  });

  it('建群后回填 anchorId/chatId，claimId 与 createdAt 不被 patch 覆盖', () => {
    const first = recordClaimIntent(dataDir, intent());
    const p = updateClaimIntent(dataDir, 'c-random-1', { anchorId: 'oc_g1', chatId: 'oc_g1' });
    expect(p?.anchorId).toBe('oc_g1');
    expect(p?.createdAt).toBe(first.createdAt);
    expect(updateClaimIntent(dataDir, '不存在', { anchorId: 'x' })).toBeNull();
  });

  // 这条是整个机制的用途所在：意图在、binding 不在 = 悬空领取，对账要认领回来。
  it('悬空判定：有意图无 binding → 列出；binding 建好后不再列出', () => {
    recordClaimIntent(dataDir, intent());
    expect(listDanglingClaimIntents(dataDir).map((i) => i.claimId)).toEqual(['c-random-1']);
    createBinding(dataDir, seed());
    expect(listDanglingClaimIntents(dataDir)).toEqual([]);
  });

  it('清除只影响指定 claimId，重复清除返回 false', () => {
    recordClaimIntent(dataDir, intent());
    recordClaimIntent(dataDir, intent({ claimId: 'c-random-2', issueId: 'iss-2' }));
    expect(clearClaimIntent(dataDir, 'c-random-1')).toBe(true);
    expect(clearClaimIntent(dataDir, 'c-random-1')).toBe(false);
    expect(listClaimIntents(dataDir).map((i) => i.claimId)).toEqual(['c-random-2']);
  });

  it('损坏的 issue-claims.json 不抛，按空表处理', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dataDir, 'issue-claims.json'), 'not json at all');
    expect(listClaimIntents(dataDir)).toEqual([]);
    expect(() => recordClaimIntent(dataDir, intent())).not.toThrow();
  });
});

describe('用平台 lastSourceSeq 校准本地计数器', () => {
  beforeEach(() => createBinding(dataDir, seed()));

  // 真机 e2e 撞到过：本地计数器落后于平台已应用的序号后，之后每条回写都被平台按单调判重
  // 静默丢弃——平台回 200、本地 settle 成功、状态却永远上不去。平台是权威，settle 时校准。
  it('平台 lastSourceSeq 领先时把计数器顶上去', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 5, platformLastSourceSeq: 14 });
    expect(getBinding(dataDir, 'oc_group1')!.nextSourceSeq).toBe(15);
    // 下一条排队即领先平台，不会再被判重丢弃
    expect(enqueueDesiredStatus(dataDir, 'oc_group1', 'done')!.sourceSeq).toBe(15);
  });

  it('平台落后于本地时不回退计数器（单调只增）', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformLastSourceSeq: 0 });
    expect(getBinding(dataDir, 'oc_group1')!.nextSourceSeq).toBe(2);
  });

  it('不传 lastSourceSeq 时行为不变（老调用方不受影响）', () => {
    enqueueDesiredStatus(dataDir, 'oc_group1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 'oc_group1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 3 });
    const b = getBinding(dataDir, 'oc_group1')!;
    expect(b.nextSourceSeq).toBe(2);
    expect(b.platformStateRev).toBe(3);
  });
});

/**
 * 跨进程锁。`botmux report` 跑在 agent 的 CLI 子进程、发件箱 pump 跑在 daemon——两个真实
 * 写者。两个文件都是整份 map/数组重写，快照式 RMW 交错会让**另一条 binding 整个消失**。
 */
describe('并发写保护', () => {
  const lockTarget = () => join(dataDir, 'issue-board');

  it('正常路径下锁用完即还，不留锁文件', () => {
    createBinding(dataDir, {
      anchorId: 'oc_lock', larkAppId: 'cli_a', scope: 'chat', issueId: 'iss-lock', teamId: 't1',
      platformBaseUrl: 'https://p', claimId: 'f'.repeat(32), claimEpoch: 1,
    });
    enqueueDesiredStatus(dataDir, 'oc_lock', 'in_progress');
    expect(existsSync(`${lockTarget()}.lock`)).toBe(false);
  });

  // 别的进程持锁期间，写必须**等**（等不到就报错），绝不能拿着旧快照直接写回去。
  it('别人持锁时不会带着旧快照硬写', () => {
    createBinding(dataDir, {
      anchorId: 'oc_first', larkAppId: 'cli_a', scope: 'chat', issueId: 'iss-first', teamId: 't1',
      platformBaseUrl: 'https://p', claimId: 'a'.repeat(32), claimEpoch: 1,
    });
    withFileLockSync(lockTarget(), () => {
      // 锁不可重入：同进程里再写就是「拿不到锁」，等到超时抛错——正是我们要的"不硬写"。
      expect(() =>
        createBinding(dataDir, {
          anchorId: 'oc_second', larkAppId: 'cli_a', scope: 'chat', issueId: 'iss-second', teamId: 't1',
          platformBaseUrl: 'https://p', claimId: 'b'.repeat(32), claimEpoch: 1,
        }),
      ).toThrow(/file-lock timeout/);
    });
    // 关键断言：先写进去的那条没有被后来者的快照抹掉
    expect(getBinding(dataDir, 'oc_first')).not.toBeNull();
    expect(getBinding(dataDir, 'oc_second')).toBeNull();
  }, 15_000);
});
