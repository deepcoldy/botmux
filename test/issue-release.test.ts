import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeIssue, releaseIssue, type ReleaseDeps } from '../src/services/issue-release.js';
import {
  createBinding,
  enqueueDesiredStatus,
  getBinding,
  listOutbox,
  updateBinding,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-release-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ANCHOR = 'oc_task';
const CLAIM = 'c'.repeat(32);

function seedBinding(over: Parameters<typeof updateBinding>[2] = {}) {
  createBinding(dataDir, {
    anchorId: ANCHOR,
    larkAppId: 'cli_worker',
    scope: 'chat',
    issueId: 'iss-1',
    teamId: 't1',
    platformBaseUrl: 'https://platform.example',
    claimId: CLAIM,
    claimEpoch: 3,
    chatId: ANCHOR,
  });
  return updateBinding(dataDir, ANCHOR, { bindState: 'bound', platformStateRev: 7, ...over })!;
}

function issue(over: Record<string, unknown> = {}) {
  return { _id: 'iss-1', stateRev: 8, claim: { claimId: CLAIM, lastSourceSeq: 1 }, ...over } as any;
}

function deps(over: Partial<ReleaseDeps> = {}) {
  const writeStatus = vi.fn(async () => ({ ok: true as const, value: { issue: issue() } }) as any);
  const fetchIssue = vi.fn(async () => issue());
  const base: ReleaseDeps = { dataDir, writeStatus, fetchIssue, ...over };
  return { d: base, writeStatus: base.writeStatus as any, fetchIssue: base.fetchIssue as any };
}

describe('顺利路径', () => {
  it('回写 open 成功 → binding 转 released，平台参数取自 binding', async () => {
    seedBinding();
    const { d, writeStatus } = deps();
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, issueId: 'iss-1', alreadyReleasedOnPlatform: false });
    expect(writeStatus).toHaveBeenCalledWith(
      'iss-1',
      expect.objectContaining({ status: 'open', claimId: CLAIM, claimEpoch: 3, expectedStateRev: 7 }),
    );
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('released');
  });

  // 释放的 sourceSeq 必须走 enqueueDesiredStatus 分配：自己编号迟早会撞上平台的
  // `sourceSeq <= lastSourceSeq` 静默去重，那种失败回 200 却什么都没改。
  it('sourceSeq 由发件箱分配，不是写死的', async () => {
    seedBinding();
    // 先占掉 1、2 号，模拟这条 binding 之前已经回写过
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_progress');
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_review');
    const { d, writeStatus } = deps();
    await releaseIssue(d, ANCHOR);
    const seq = writeStatus.mock.calls[0][1].sourceSeq;
    expect(seq).toBeGreaterThan(1);
    expect(listOutbox(dataDir, ANCHOR).every((row) => row.sourceSeq <= seq)).toBe(true);
  });

  it('发件箱那一行标 done，不会留着被将来的 pump 重发', async () => {
    seedBinding();
    await releaseIssue(deps().d, ANCHOR);
    expect(listOutbox(dataDir, ANCHOR).filter((r) => r.state !== 'done')).toEqual([]);
  });
});

describe('没什么可释放的', () => {
  it('锚点上没有 binding', async () => {
    expect(await releaseIssue(deps().d, 'oc_不存在')).toMatchObject({ ok: false, reason: 'no_binding' });
  });

  it('已经释放过 → 幂等，不再打平台', async () => {
    seedBinding({ bindState: 'released' });
    const { d, writeStatus } = deps();
    expect(await releaseIssue(d, ANCHOR)).toMatchObject({ ok: false, reason: 'already_released' });
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it('binding 已作废（bind 被平台拒过）→ 同样不打平台', async () => {
    seedBinding({ bindState: 'void' });
    const { d, writeStatus } = deps();
    expect(await releaseIssue(d, ANCHOR)).toMatchObject({ ok: false, reason: 'already_released' });
    expect(writeStatus).not.toHaveBeenCalled();
  });
});

describe('平台拒绝时不能自说自话', () => {
  // 平台还认为这台机器持有，本机就必须继续这么认。抢先置 released 会让 issue 卡在
  // in_progress 直到 lease 过期，期间谁也领不走，而本机以为已经放手了。
  it('网络失败 → binding 原样不动', async () => {
    seedBinding();
    const { d } = deps({ writeStatus: async () => ({ ok: false, reason: 'network', error: 'ETIMEDOUT' }) as any });
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'platform' });
    if (!r.ok && r.reason === 'platform') expect(r.detail).toContain('ETIMEDOUT');
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('bound');
  });

  it('失败的行退回 pending，将来 pump 还能重投', async () => {
    seedBinding();
    const { d } = deps({ writeStatus: async () => ({ ok: false, reason: 'server', status: 503, error: 'unavailable' }) as any });
    await releaseIssue(d, ANCHOR);
    expect(listOutbox(dataDir, ANCHOR).map((r) => r.state)).toEqual(['pending']);
  });
});

describe('409 的两种含义', () => {
  it('只是 stateRev 过期 → 拿新基线重发同一条行（sourceSeq 不变）', async () => {
    seedBinding();
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'conflict', status: 409, error: 'state_rev_conflict' })
      .mockResolvedValueOnce({ ok: true, value: { issue: issue({ stateRev: 12 }) } });
    const { d } = deps({ writeStatus: writeStatus as any });
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, alreadyReleasedOnPlatform: false });
    expect(writeStatus).toHaveBeenCalledTimes(2);
    expect(writeStatus.mock.calls[0][1].expectedStateRev).toBe(7);
    expect(writeStatus.mock.calls[1][1].expectedStateRev).toBe(8); // fetchIssue 的新基线
    // 上一次没被应用，复用序号是安全的；换号反而会让平台的单调判重变复杂。
    expect(writeStatus.mock.calls[1][1].sourceSeq).toBe(writeStatus.mock.calls[0][1].sourceSeq);
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('released');
  });

  // 「我想撒手但平台一直拒绝我」的死结：claim 已被 force-detach / 过期 / 被别人领走。
  // 平台早就释放了，这里只要把本地补记上，否则人只能去手改 JSON。
  it('claim 已经不是本机的 → 认定平台侧早已释放，本地补记 released', async () => {
    seedBinding();
    const writeStatus = vi.fn(async () => ({ ok: false, reason: 'conflict', status: 409, error: 'claim_mismatch' }) as any);
    const { d } = deps({
      writeStatus,
      fetchIssue: async () => issue({ stateRev: 20, claim: { claimId: '别人的', lastSourceSeq: 9 } }),
    });
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, alreadyReleasedOnPlatform: true });
    expect(writeStatus).toHaveBeenCalledTimes(1); // 不再白撞第二次
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('released');
  });

  it('查不到 issue（已归档等）→ 不猜，报失败让人去平台看', async () => {
    seedBinding();
    const { d } = deps({
      writeStatus: async () => ({ ok: false, reason: 'conflict', status: 409, error: 'state_rev_conflict' }) as any,
      fetchIssue: async () => null,
    });
    expect(await releaseIssue(d, ANCHOR)).toMatchObject({ ok: false, reason: 'platform' });
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('bound');
  });
});

describe('崩溃重入', () => {
  // 「平台先行、本地后写」的写序留下的可恢复形态：open 已经发成功（lastSyncedStatus 为
  // open），但改 binding 之前进程没了。再发一次必须能把本地那一半补完。
  it('平台已回写成功、本地没改完 → 重入直接补完本地', async () => {
    seedBinding({ lastSyncedStatus: 'open' });
    const { d, writeStatus } = deps();
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, alreadyReleasedOnPlatform: true });
    expect(writeStatus).not.toHaveBeenCalled();
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('released');
  });

  // 反过来：有别的回写正在 inflight 时不能插队，平台侧要求同一 issue 的 sourceSeq 单调到达。
  it('另有 inflight 回写 → 明确让人稍后重试，而不是乱序发出去', async () => {
    seedBinding();
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_progress');
    // 手动把它推成 inflight（模拟正在发送中）
    const { claimNextOutboxRow } = await import('../src/services/issue-board-store.js');
    claimNextOutboxRow(dataDir, ANCHOR);
    const { d, writeStatus } = deps();
    const r = await releaseIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'platform' });
    if (!r.ok && r.reason === 'platform') expect(r.detail).toContain('outbox_busy');
    expect(writeStatus).not.toHaveBeenCalled();
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('bound');
  });
});

describe('释放之后', () => {
  // released 是终态：再投影状态只会被平台按 claim 不匹配拒掉，本地就不该再排队。
  it('不再接受新的状态回写', async () => {
    seedBinding();
    await releaseIssue(deps().d, ANCHOR);
    expect(enqueueDesiredStatus(dataDir, ANCHOR, 'done')).toBeNull();
  });

  // 释放的全部意义就是"别人能领了"；本机自己也应该能重新领。
  it('同一个 issue 可以重新领取（旧 binding 不再算活跃）', async () => {
    seedBinding();
    await releaseIssue(deps().d, ANCHOR);
    expect(() =>
      createBinding(dataDir, {
        anchorId: 'oc_new',
        larkAppId: 'cli_worker',
        scope: 'chat',
        issueId: 'iss-1',
        teamId: 't1',
        platformBaseUrl: 'https://platform.example',
        claimId: 'd'.repeat(32),
        claimEpoch: 4,
      }),
    ).not.toThrow();
  });
});

// 验收完成与释放共用 settleTerminal，所以这里只钉住"不一样的那部分"：目标态、本地终态、
// 以及平台拒绝时不能悄悄把本地改掉。
describe('验收完成', () => {
  it('回写 done 成功 → binding 转 done', async () => {
    seedBinding();
    const { d, writeStatus } = deps();
    const r = await completeIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, issueId: 'iss-1' });
    expect(writeStatus).toHaveBeenCalledWith('iss-1', expect.objectContaining({ status: 'done' }));
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('done');
  });

  // 平台先行、本地后写：平台没点头就动本地，会出现"本机以为完成了、平台还挂着"的分裂。
  it('平台拒绝 → 本地保持 bound，可重试', async () => {
    seedBinding();
    const { d } = deps({
      writeStatus: vi.fn(async () => ({ ok: false, reason: 'conflict', status: 409, error: 'invalid_transition' }) as any),
    });
    const r = await completeIssue(d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'platform' });
    expect(String((r as any).detail)).toMatch(/invalid_transition/);
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('bound');
  });

  // done 会被平台清 claim，这条领取就此终结——再释放是没有意义的操作，得拦住并说清楚。
  it('完成之后不能再释放，且能看出终态是 done', async () => {
    seedBinding();
    await completeIssue(deps().d, ANCHOR);
    const r = await releaseIssue(deps().d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'already_released' });
    expect((r as any).binding.bindState).toBe('done');
  });

  it('已完成的 binding 不再算活跃，同一 issue 可以重新领', async () => {
    seedBinding();
    await completeIssue(deps().d, ANCHOR);
    expect(() =>
      createBinding(dataDir, {
        anchorId: 'oc_new',
        larkAppId: 'cli_worker',
        scope: 'chat',
        issueId: 'iss-1',
        teamId: 't1',
        platformBaseUrl: 'https://platform.example',
        claimId: 'e'.repeat(32),
        claimEpoch: 5,
      }),
    ).not.toThrow();
  });
});
