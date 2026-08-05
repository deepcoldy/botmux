import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findActiveBindingForSession,
  reportIssueInReview,
  type ReportDeps,
} from '../src/services/issue-report.js';
import {
  createBinding,
  enqueueDesiredStatus,
  getBinding,
  listOutbox,
  updateBinding,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-report-'));
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
  return {
    _id: 'iss-1',
    status: 'in_review',
    stateRev: 8,
    claim: { claimId: CLAIM, lastSourceSeq: 1 },
    ...over,
  } as any;
}

function deps(over: Partial<ReportDeps> = {}) {
  const writeStatus = vi.fn(async () => ({ ok: true as const, value: { issue: issue() } }) as any);
  const fetchIssue = vi.fn(async () => issue());
  const base: ReportDeps = { dataDir, writeStatus, fetchIssue, ...over };
  return { d: base, writeStatus: base.writeStatus as any, fetchIssue: base.fetchIssue as any };
}

describe('findActiveBindingForSession', () => {
  it('按 rootMessageId / chatId 命中活跃 binding', () => {
    seedBinding();
    expect(findActiveBindingForSession(dataDir, { rootMessageId: ANCHOR })?.issueId).toBe('iss-1');
    expect(findActiveBindingForSession(dataDir, { chatId: ANCHOR })?.issueId).toBe('iss-1');
  });

  it('released / 无 binding → null', () => {
    seedBinding({ bindState: 'released' });
    expect(findActiveBindingForSession(dataDir, { chatId: ANCHOR })).toBeNull();
    expect(findActiveBindingForSession(dataDir, { chatId: 'oc_other' })).toBeNull();
  });
});

describe('顺利路径', () => {
  it('回写 in_review 成功，binding 仍 bound', async () => {
    seedBinding();
    const { d, writeStatus } = deps();
    const r = await reportIssueInReview(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, issueId: 'iss-1', alreadyInReview: false });
    expect(writeStatus).toHaveBeenCalledWith(
      'iss-1',
      expect.objectContaining({
        status: 'in_review',
        claimId: CLAIM,
        claimEpoch: 3,
        expectedStateRev: 7,
      }),
    );
    expect(getBinding(dataDir, ANCHOR)?.bindState).toBe('bound');
    expect(getBinding(dataDir, ANCHOR)?.lastSyncedStatus).toBe('in_review');
  });

  it('sourceSeq 由发件箱分配', async () => {
    seedBinding();
    enqueueDesiredStatus(dataDir, ANCHOR, 'in_progress');
    const { d, writeStatus } = deps();
    await reportIssueInReview(d, ANCHOR);
    // enqueueDesiredStatus 合并：pending in_progress 被 in_review 覆盖，seq 仍是新分配的
    const seq = writeStatus.mock.calls[0][1].sourceSeq;
    expect(seq).toBeGreaterThanOrEqual(1);
    expect(listOutbox(dataDir, ANCHOR).every((row) => row.state === 'done' || row.sourceSeq <= seq)).toBe(true);
  });

  it('发件箱标 done', async () => {
    seedBinding();
    await reportIssueInReview(deps().d, ANCHOR);
    expect(listOutbox(dataDir, ANCHOR).filter((r) => r.state !== 'done')).toEqual([]);
  });

  it('已是 in_review → 幂等成功，不再打平台', async () => {
    seedBinding({ lastSyncedStatus: 'in_review' });
    const { d, writeStatus } = deps();
    const r = await reportIssueInReview(d, ANCHOR);
    expect(r).toMatchObject({ ok: true, alreadyInReview: true });
    expect(writeStatus).not.toHaveBeenCalled();
  });
});

describe('失败路径', () => {
  it('无 binding', async () => {
    expect(await reportIssueInReview(deps().d, 'oc_nope')).toMatchObject({ ok: false, reason: 'no_binding' });
  });

  it('binding 已释放', async () => {
    seedBinding({ bindState: 'released' });
    expect(await reportIssueInReview(deps().d, ANCHOR)).toMatchObject({ ok: false, reason: 'not_active' });
  });

  it('平台拒绝 → 本地不改 lastSynced，可重试', async () => {
    seedBinding();
    const { d, writeStatus } = deps({
      writeStatus: vi.fn(async () => ({ ok: false, reason: 'server', status: 500, error: 'boom' }) as any),
    });
    const r = await reportIssueInReview(d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'platform' });
    expect(getBinding(dataDir, ANCHOR)?.lastSyncedStatus).not.toBe('in_review');
    expect(listOutbox(dataDir, ANCHOR).some((row) => row.state === 'pending')).toBe(true);
    expect(writeStatus).toHaveBeenCalled();
  });

  // 与 release 相反：释放时"claim 已不在本机"正是想要的结果，交付时它意味着这次汇报
  // 根本没写上去。单列 detached 而不是 platform —— 重试也不会好，得让人去平台上看。
  it('409 且 claim 已易主 → detached，不假装交付成功', async () => {
    seedBinding();
    const { d } = deps({
      writeStatus: vi.fn(async () => ({ ok: false, reason: 'conflict', status: 409, error: 'stale' }) as any),
      fetchIssue: vi.fn(async () =>
        issue({ claim: { claimId: 'other-claim', lastSourceSeq: 9 }, status: 'in_progress', stateRev: 20 }),
      ),
    });
    const r = await reportIssueInReview(d, ANCHOR);
    expect(r).toMatchObject({ ok: false, reason: 'detached' });
    expect(getBinding(dataDir, ANCHOR)?.lastSyncedStatus).not.toBe('in_review');
  });

  it('409 后 stateRev 过期重发成功', async () => {
    seedBinding();
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'conflict', status: 409, error: 'rev' })
      .mockResolvedValueOnce({ ok: true, value: { issue: issue({ stateRev: 11 }) } });
    const fetchIssue = vi.fn(async () =>
      issue({ status: 'in_progress', stateRev: 10, claim: { claimId: CLAIM, lastSourceSeq: 0 } }),
    );
    const r = await reportIssueInReview({ dataDir, writeStatus, fetchIssue }, ANCHOR);
    expect(r).toMatchObject({ ok: true, alreadyInReview: false });
    expect(writeStatus).toHaveBeenCalledTimes(2);
    expect(writeStatus.mock.calls[1][1].expectedStateRev).toBe(10);
  });
});
