import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeIssue, type IssueStatusDeps } from '../src/services/issue-status-view.js';
import {
  claimNextOutboxRow,
  createBinding,
  enqueueDesiredStatus,
  failOutboxRow,
  updateBinding,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-status-view-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ANCHOR = 'oc_task';
const CLAIM = 'c'.repeat(32);

function seed(over: Parameters<typeof updateBinding>[2] = {}) {
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

function deps(fetchIssue: IssueStatusDeps['fetchIssue'] = async () => issue()): IssueStatusDeps {
  return { dataDir, fetchIssue };
}

function issue(over: Record<string, unknown> = {}) {
  return { _id: 'iss-1', title: 't', status: 'in_progress', stateRev: 8, claim: { claimId: CLAIM } , ...over } as any;
}

describe('describeIssue', () => {
  it('没有 binding → no_binding', async () => {
    expect(await describeIssue(deps(), 'oc_nope')).toMatchObject({ ok: false, reason: 'no_binding' });
  });

  // 「这个群是不是已经结束了」正是要查的问题，把终态当成"没有绑定"是把唯一的答案藏起来。
  it('终态 binding 照查，不当成没有绑定', async () => {
    seed({ bindState: 'done' });
    const r = await describeIssue(deps(), ANCHOR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.view.binding.bindState).toBe('done');
  });

  it('claim 还是本机的 → claimMine true', async () => {
    seed();
    const r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.claimMine).toBe(true);
    expect(r.view.issue?.status).toBe('in_progress');
  });

  // 被 force-detach / 租约过期 / 别人领走，都长这样：群里继续干的活没人收。
  it('claim 已易主 → claimMine false', async () => {
    seed();
    const r = await describeIssue(deps(async () => issue({ claim: { claimId: '别人的' } })), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.claimMine).toBe(false);
  });

  // 平台清了 claim（done/open/reopened）也是"不归本机"，不能因为字段缺失就当成还在。
  it('平台已清掉 claim → claimMine false', async () => {
    seed();
    const r = await describeIssue(deps(async () => issue({ claim: undefined, status: 'done' })), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.claimMine).toBe(false);
  });

  // findIssueById 的 null 同时覆盖「网络失败」与「已归档」，无法区分——绝不能替人下结论。
  it('拉不到平台 → claimMine 留空（无法判定），不猜成 false', async () => {
    seed();
    const r = await describeIssue(deps(async () => null), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.issue).toBeNull();
    expect(r.view.claimMine).toBeUndefined();
  });

  it('统计发件箱里还没发出去的回写（pending + inflight）', async () => {
    seed();
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_progress');
    let r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.pendingWrites).toBe(1);

    claimNextOutboxRow(dataDir, ANCHOR); // 发送中也算没发出去
    r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.pendingWrites).toBe(1);
  });

  it('没有积压时为 0', async () => {
    seed();
    const r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.pendingWrites).toBe(0);
  });

  it('只读：不排队、不改 binding', async () => {
    const before = seed();
    const fetchIssue = vi.fn(async () => issue());
    await describeIssue({ dataDir, fetchIssue }, ANCHOR);
    const r = await describeIssue({ dataDir, fetchIssue }, ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.binding.bindState).toBe(before.bindState);
    expect(r.view.binding.nextSourceSeq).toBe(before.nextSourceSeq);
    expect(r.view.pendingWrites).toBe(0);
  });
});

// 判死的行不在 pendingWrites 里。不单独报出来，界面上一声不吭就等于"已经同步好了"，
// 而那次状态变更永远不会到平台——给了 fatal 就得给能看见它的地方。
describe('已放弃的回写', () => {
  function failRow(err = 'forbidden: revoked') {
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_review');
    const row = claimNextOutboxRow(dataDir, ANCHOR)!;
    failOutboxRow(dataDir, row.writeId, err, { fatal: true });
  }

  it('单独计数并带出最后一条错误，且不混进 pendingWrites', async () => {
    seed();
    failRow();
    const r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.failedWrites).toBe(1);
    expect(r.view.pendingWrites).toBe(0);
    expect(r.view.lastFailure).toMatch(/revoked/);
  });

  it('没有判死行时为 0，也不给 lastFailure', async () => {
    seed();
    const r = await describeIssue(deps(), ANCHOR);
    if (!r.ok) throw new Error('unreachable');
    expect(r.view.failedWrites).toBe(0);
    expect(r.view.lastFailure).toBeUndefined();
  });
});
