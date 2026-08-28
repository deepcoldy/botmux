import { describe, it, expect, vi } from 'vitest';
import {
  handleIssueCardAction,
  handleIssueCommand,
  handleIssueDone,
  handleIssueRelease,
  handleIssueStatus,
  reposFor,
  type IssueCommandDeps,
} from '../src/im/lark/issue-command.js';
import { describeProjectDir, scanMultipleProjects } from '../src/services/project-scanner.js';
import {
  ISSUE_ACTION_CLAIM_CANCEL,
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_DIR,
  ISSUE_ACTION_CLAIM_OPEN,
  ISSUE_ACTION_PAGE,
  ISSUE_ACTION_TEAM,
} from '../src/im/lark/issue-card.js';

vi.mock('../src/services/project-scanner.js', () => ({
  describeProjectDir: vi.fn(() => null),
  scanMultipleProjects: vi.fn(() => []),
}));

const APP = 'cli_worker';
const ME = 'ou_admin';
const ISSUE = {
  _id: 'iss-1',
  title: '修一个 bug',
  stateRev: 3,
  targetRepoLabel: 'botmux',
} as any;

function deps(over: Partial<IssueCommandDeps> = {}) {
  const runClaim = vi.fn(async () => ({ ok: true as const, chatId: 'oc_new', chatName: 'g #abcd', shareLink: 'https://l' }));
  const runRelease = vi.fn(async () => ({ ok: true as const, issueId: 'iss-1', alreadyReleasedOnPlatform: false }));
  const runDone = vi.fn(async () => ({ ok: true as const, issueId: 'iss-1', alreadyReleasedOnPlatform: false }));
  const runStatus = vi.fn(async () => ({ ok: true as const, card: '{"elements":[]}' }));
  const base: IssueCommandDeps = {
    runRelease,
    runDone,
    runStatus,
    fetchTeams: async () => ({ ok: true, value: [{ teamId: 't1', teamName: 'A' }, { teamId: 't2', teamName: 'B' }] }),
    fetchIssues: async () => ({
      ok: true,
      value: { needsAttention: [], todo: [ISSUE], inProgress: [], inReview: [], done: [] } as any,
    }),
    runClaim,
    allowedUsers: () => [ME],
    workingDirs: () => [],
    defaultWorkingDir: () => undefined,
    ...over,
  };
  return {
    d: base,
    runClaim,
    runRelease: base.runRelease as any,
    runDone: base.runDone as any,
    runStatus: base.runStatus as any,
  };
}

function cb(value: Record<string, string>, operator = ME, option?: string) {
  return {
    operator: { open_id: operator },
    action: { value, ...(option ? { option } : {}) },
  } as any;
}

describe('命令入口权限', () => {
  it('管理员可以拿到看板卡片', async () => {
    const r = await handleIssueCommand(APP, ME, deps().d);
    expect('card' in r).toBe(true);
  });

  // /issue 会真的领任务、建群、起 agent，不是只读命令。
  it('非管理员被拒', async () => {
    const r = await handleIssueCommand(APP, 'ou_stranger', deps().d);
    expect(r).toMatchObject({ toast: { content: '只有管理员可以操作 Issue Board' } });
  });

  it('拿不到操作者身份时拒绝（fail-closed）', async () => {
    const r = await handleIssueCommand(APP, undefined, deps().d);
    expect('toast' in r).toBe(true);
  });

  it('bot 没配管理员时拒绝，而不是放行所有人', async () => {
    const r = await handleIssueCommand(APP, ME, deps({ allowedUsers: () => [] }).d);
    expect(r).toMatchObject({ toast: { content: '这个 bot 还没有配置管理员' } });
  });

  it('未绑定平台时给出可读原因', async () => {
    const r = await handleIssueCommand(APP, ME, deps({ fetchTeams: async () => ({ ok: false, reason: 'unbound' }) }).d);
    expect(r).toMatchObject({ toast: { content: '本机还没有绑定 botmux 平台' } });
  });

  it('不在任何团队时说清楚，而不是渲染一张空卡', async () => {
    const r = await handleIssueCommand(APP, ME, deps({ fetchTeams: async () => ({ ok: true, value: [] }) }).d);
    expect(r).toMatchObject({ toast: { content: '你不在任何 botmux 平台团队里' } });
  });
});

describe('invoker lock', () => {
  // 平台的 claim 按本机 owner 记，不按点击者记。谁点都能领的话归属就错位了。
  it('别人点同一张卡 → 拒绝，且不会触发领取', async () => {
    const { d, runClaim } = deps();
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_CONFIRM, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', dir: '/w/botmux' }, 'ou_someone_else'),
      APP,
      d,
    );
    expect(r).toMatchObject({ toast: { content: '这张卡片只有发起人能操作' } });
    expect(runClaim).not.toHaveBeenCalled();
  });

  it('卡片里没有 invoker 时拒绝（老卡片/被篡改）', async () => {
    const r = await handleIssueCardAction(cb({ action: ISSUE_ACTION_PAGE, teamId: 't1', page: '1' }), APP, deps().d);
    expect(r).toMatchObject({ toast: { content: '这张卡片只有发起人能操作' } });
  });

  // 发卡之后名单可能改了，所以每次回调都要重跑，而不是只在发卡时查一次。
  it('发起人事后被移出管理员名单 → 回调被拒', async () => {
    const { d } = deps({ allowedUsers: () => ['ou_other_admin'] });
    const r = await handleIssueCardAction(cb({ action: ISSUE_ACTION_PAGE, invoker_open_id: ME, teamId: 't1', page: '1' }), APP, d);
    expect(r).toMatchObject({ toast: { content: '只有管理员可以操作 Issue Board' } });
  });
});

describe('看板导航', () => {
  it('翻页与刷新都回看板卡片', async () => {
    const r = await handleIssueCardAction(cb({ action: ISSUE_ACTION_PAGE, invoker_open_id: ME, teamId: 't1', page: '1' }), APP, deps().d);
    expect('card' in r).toBe(true);
  });

  it('切换团队用下拉选中值，不用 value 里的旧 teamId', async () => {
    const seen: string[] = [];
    const { d } = deps({
      fetchIssues: async (teamId) => {
        seen.push(teamId);
        return { ok: true, value: { needsAttention: [], todo: [], inProgress: [], inReview: [], done: [] } as any };
      },
    });
    await handleIssueCardAction(cb({ action: ISSUE_ACTION_TEAM, invoker_open_id: ME, teamId: 't1' }, ME, 't2'), APP, d);
    expect(seen).toEqual(['t2']);
  });

  it('未知 teamId 回落到第一个团队，不炸', async () => {
    const seen: string[] = [];
    const { d } = deps({
      fetchIssues: async (teamId) => {
        seen.push(teamId);
        return { ok: true, value: { needsAttention: [], todo: [], inProgress: [], inReview: [], done: [] } as any };
      },
    });
    await handleIssueCardAction(cb({ action: ISSUE_ACTION_PAGE, invoker_open_id: ME, teamId: '不存在', page: '0' }), APP, d);
    expect(seen).toEqual(['t1']);
  });

  it('取消回到看板', async () => {
    const r = await handleIssueCardAction(cb({ action: ISSUE_ACTION_CLAIM_CANCEL, invoker_open_id: ME, teamId: 't1' }), APP, deps().d);
    expect('card' in r).toBe(true);
    expect(JSON.stringify((r as any).card.data)).toContain('待领取');
  });
});

describe('领取', () => {
  it('只把依赖提供的仓库目录传给候选扫描器', () => {
    vi.clearAllMocks();
    vi.mocked(scanMultipleProjects).mockReturnValueOnce([{
      name: 'card-mode-repo',
      path: '/w/card-mode-repo',
      type: 'repo',
      branch: 'main',
    }]);

    const choices = reposFor(APP, deps({
      workingDirs: () => ['/w/card-mode'],
      defaultWorkingDir: () => '/w/fixed-repo',
    }).d);

    expect(scanMultipleProjects).toHaveBeenCalledWith(
      ['/w/card-mode'],
      3,
      { includeWorktrees: true },
    );
    expect(choices).toEqual([{
      name: 'card-mode-repo',
      path: '/w/card-mode-repo',
      branch: 'main',
    }]);
    expect(describeProjectDir).not.toHaveBeenCalled();
  });

  it('fixed/oncall 默认目录本身是仓库时直接生成唯一候选', () => {
    vi.clearAllMocks();
    vi.mocked(describeProjectDir).mockReturnValueOnce({ name: 'fixed-repo', branch: 'main' });

    const choices = reposFor(APP, deps({
      workingDirs: () => [],
      defaultWorkingDir: () => '/w/fixed-repo',
    }).d);

    expect(choices).toEqual([{
      name: 'fixed-repo',
      path: '/w/fixed-repo',
      branch: 'main',
    }]);
    expect(describeProjectDir).toHaveBeenCalledWith('/w/fixed-repo');
    expect(scanMultipleProjects).not.toHaveBeenCalled();
  });

  it('fixed/oncall 默认目录不是仓库时不递归扫描', () => {
    vi.clearAllMocks();
    const choices = reposFor(APP, deps({
      workingDirs: () => [],
      defaultWorkingDir: () => '/w/large-root',
    }).d);

    expect(choices).toEqual([]);
    expect(describeProjectDir).toHaveBeenCalledWith('/w/large-root');
    expect(scanMultipleProjects).not.toHaveBeenCalled();
  });

  it('打开确认卡时按标签自动匹配仓库', async () => {
    const { d } = deps({ workingDirs: () => [] });
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_OPEN, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', stateRev: '3' }),
      APP,
      d,
    );
    expect('card' in r).toBe(true);
    expect(JSON.stringify((r as any).card.data)).toContain('修一个 bug');
  });

  // 人手动选过之后，不能再被自动匹配覆盖掉。
  it('下拉切换以人选的为准', async () => {
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_DIR, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', stateRev: '3' }, ME, '/w/other'),
      APP,
      deps().d,
    );
    expect('card' in r).toBe(true);
  });

  it('确认领取会把选中的目录传给 flow', async () => {
    const { d, runClaim } = deps();
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_CONFIRM, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', dir: '/w/botmux' }),
      APP,
      d,
    );
    expect(runClaim).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/w/botmux', teamId: 't1', larkAppId: APP, invokerOpenId: ME }),
    );
    expect(JSON.stringify((r as any).card.data)).toContain('已领取');
  });

  it('没选目录不发起领取', async () => {
    const { d, runClaim } = deps();
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_CONFIRM, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1' }),
      APP,
      d,
    );
    expect(r).toMatchObject({ toast: { content: '没有选择工作仓库' } });
    expect(runClaim).not.toHaveBeenCalled();
  });

  // 卡片可能放了很久，用里面的陈旧 stateRev 只会白撞一次 409。
  it('确认时重新拉取 issue；已经不在列表里就明说', async () => {
    const { d, runClaim } = deps({
      fetchIssues: async () => ({ ok: true, value: { needsAttention: [], todo: [], inProgress: [], inReview: [], done: [] } as any }),
    });
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_CONFIRM, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', dir: '/w/x' }),
      APP,
      d,
    );
    expect(r).toMatchObject({ toast: { content: '这条任务已经不在待领取列表里了，刷新看看' } });
    expect(runClaim).not.toHaveBeenCalled();
  });

  it('领取失败时结果卡带上阶段与对应提示', async () => {
    const { d } = deps({ runClaim: async () => ({ ok: false, stage: 'activate', reason: '发消息失败' }) });
    const r = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_CLAIM_CONFIRM, invoker_open_id: ME, teamId: 't1', issueId: 'iss-1', dir: '/w/x' }),
      APP,
      d,
    );
    const card = JSON.stringify((r as any).card.data);
    expect(card).toContain('activate');
    expect(card).toContain('不必重新领取');
  });
});

describe('释放', () => {
  it('管理员在任务群里释放 → 成功，并说明群不会自动解散', async () => {
    const { d, runRelease } = deps();
    const r = await handleIssueRelease(APP, ME, ['oc_task', 'om_root'], d);
    expect(runRelease).toHaveBeenCalledWith('oc_task');
    expect(r.toast.type).toBe('info');
    expect(r.toast.content).toContain('不会自动解散');
  });

  // 释放会真的改平台状态，和 /issue 同一道门。
  it('非管理员被拒，且不触发释放', async () => {
    const { d, runRelease } = deps();
    const r = await handleIssueRelease(APP, 'ou_stranger', ['oc_task'], d);
    expect(r.toast).toMatchObject({ type: 'error', content: '只有管理员可以操作 Issue Board' });
    expect(runRelease).not.toHaveBeenCalled();
  });

  it('拿不到操作者身份时拒绝（fail-closed）', async () => {
    const { d, runRelease } = deps();
    expect((await handleIssueRelease(APP, undefined, ['oc_task'], d)).toast.type).toBe('error');
    expect(runRelease).not.toHaveBeenCalled();
  });

  // 拉群会话锚在 chatId、话题会话锚在 rootMessageId，两个都要试得到。
  it('第一个锚点没有绑定时继续试第二个', async () => {
    const runRelease = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'no_binding' })
      .mockResolvedValueOnce({ ok: true, issueId: 'iss-1', alreadyReleasedOnPlatform: false });
    const { d } = deps({ runRelease: runRelease as any });
    const r = await handleIssueRelease(APP, ME, ['oc_task', 'om_root'], d);
    expect(runRelease.mock.calls.map((c) => c[0])).toEqual(['oc_task', 'om_root']);
    expect(r.toast.type).toBe('info');
  });

  // 真实失败不能被后一个锚点的 "no_binding" 盖成「没有领取记录」——那会让人以为不用管。
  it('第一个锚点释放失败时就地停下，不继续试', async () => {
    const runRelease = vi.fn(async () => ({ ok: false, reason: 'platform', detail: 'network: ETIMEDOUT' }) as any);
    const { d } = deps({ runRelease });
    const r = await handleIssueRelease(APP, ME, ['oc_task', 'om_root'], d);
    expect(runRelease).toHaveBeenCalledTimes(1);
    expect(r.toast.type).toBe('error');
    expect(r.toast.content).toContain('ETIMEDOUT');
    expect(r.toast.content).toContain('本机记录保持不变');
  });

  it('这个会话根本没领过任务 → 说清楚而不是报错', async () => {
    const { d } = deps({ runRelease: async () => ({ ok: false, reason: 'no_binding' }) as any });
    const r = await handleIssueRelease(APP, ME, ['oc_task'], d);
    expect(r.toast.content).toContain('没有领取任何平台任务');
  });

  it('平台侧此前已释放 → 提示已同步，措辞不同于正常释放', async () => {
    const { d } = deps({ runRelease: async () => ({ ok: true, issueId: 'iss-1', alreadyReleasedOnPlatform: true }) as any });
    const r = await handleIssueRelease(APP, ME, ['oc_task'], d);
    expect(r.toast.type).toBe('info');
    expect(r.toast.content).toContain('此前就已经不归本机');
  });

  it('一个锚点都没有时不静默成功', async () => {
    const { d, runRelease } = deps();
    const r = await handleIssueRelease(APP, ME, [undefined, undefined], d);
    expect(r.toast.type).toBe('error');
    expect(runRelease).not.toHaveBeenCalled();
  });

  // 三个终态说的是三件不同的事，糊成一句「已结束」人会以为自己记错了。
  it('已是终态时按 bindState 分别措辞', async () => {
    const say = async (bindState: string) => {
      const { d } = deps({ runRelease: async () => ({ ok: false, reason: 'already_released', bindState }) as any });
      return (await handleIssueRelease(APP, ME, ['oc_task'], d)).toast.content;
    };
    expect(await say('done')).toContain('验收完成');
    expect(await say('void')).toContain('作废');
    expect(await say('released')).toContain('已经释放');
  });
});

// 验收是**人的决策**：agent 交付只到「待验收」，标完成必须由人在群里发命令。
describe('验收完成', () => {
  it('管理员在任务群里验收 → 成功，并说明不能再释放', async () => {
    const { d, runDone } = deps();
    const r = await handleIssueDone(APP, ME, ['oc_task', 'om_root'], d);
    expect(runDone).toHaveBeenCalledWith('oc_task');
    expect(r.toast.type).toBe('info');
    expect(r.toast.content).toContain('不能再释放');
  });

  it('非管理员被拒，且不触发任何写', async () => {
    const { d, runDone } = deps();
    const r = await handleIssueDone(APP, 'ou_stranger', ['oc_task'], d);
    expect(r.toast).toMatchObject({ type: 'error', content: '只有管理员可以操作 Issue Board' });
    expect(runDone).not.toHaveBeenCalled();
  });

  // 平台的追赶白名单不允许 needs_attention → done。回一句 invalid_transition 等于没说，
  // 得告诉人为什么以及下一步干什么。
  it('平台拒绝 invalid_transition → 解释「需要关注」不能直接标完成', async () => {
    const { d } = deps({
      runDone: async () => ({ ok: false, reason: 'platform', detail: 'conflict: invalid_transition' }) as any,
    });
    const r = await handleIssueDone(APP, ME, ['oc_task'], d);
    expect(r.toast.type).toBe('error');
    expect(r.toast.content).toContain('需要关注');
    expect(r.toast.content).toContain('/issue release');
  });

  it('其它平台失败照常提示可重试', async () => {
    const { d } = deps({
      runDone: async () => ({ ok: false, reason: 'platform', detail: 'network: ETIMEDOUT' }) as any,
    });
    const r = await handleIssueDone(APP, ME, ['oc_task'], d);
    expect(r.toast.content).toContain('ETIMEDOUT');
    expect(r.toast.content).toContain('/issue done');
  });

  it('这个会话根本没领过任务 → 说清楚而不是报错', async () => {
    const { d } = deps({ runDone: async () => ({ ok: false, reason: 'no_binding' }) as any });
    expect((await handleIssueDone(APP, ME, ['oc_task'], d)).toast.content).toContain('没有领取任何平台任务');
  });

  it('第一个锚点没有绑定时继续试第二个', async () => {
    const runDone = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'no_binding' })
      .mockResolvedValueOnce({ ok: true, issueId: 'iss-1', alreadyReleasedOnPlatform: false });
    const { d } = deps({ runDone: runDone as any });
    await handleIssueDone(APP, ME, ['oc_task', 'om_root'], d);
    expect(runDone.mock.calls.map((c) => c[0])).toEqual(['oc_task', 'om_root']);
  });
});

describe('查看现状', () => {
  it('管理员在任务群里查 → 出卡片', async () => {
    const { d, runStatus } = deps();
    const r = await handleIssueStatus(APP, ME, ['oc_task', 'om_root'], d);
    expect(runStatus).toHaveBeenCalledWith('oc_task');
    expect(r).toHaveProperty('card');
  });

  // 只读也走同一道门：状态里带着领取人、平台深链这些不该外泄的东西。
  it('非管理员被拒', async () => {
    const { d, runStatus } = deps();
    const r = await handleIssueStatus(APP, 'ou_stranger', ['oc_task'], d);
    expect(r).toMatchObject({ toast: { type: 'error' } });
    expect(runStatus).not.toHaveBeenCalled();
  });

  it('没有绑定时说清楚，不出空卡', async () => {
    const { d } = deps({ runStatus: async () => ({ ok: false, reason: 'no_binding' }) as any });
    const r = await handleIssueStatus(APP, ME, ['oc_task'], d);
    expect(r).toMatchObject({ toast: { content: expect.stringContaining('没有领取任何平台任务') } });
  });
});

describe('未知 action', () => {
  it('不静默吞掉，回一个可见的错误', async () => {
    const r = await handleIssueCardAction(cb({ action: 'issue_不存在的动作', invoker_open_id: ME, teamId: 't1' }), APP, deps().d);
    expect(r).toMatchObject({ toast: { content: expect.stringContaining('未知操作') } });
  });
});

// 实测踩过：卡片能发出来，但一点按钮客户端就报 code 200672——Lark 的 callback 响应
// 要求 `card: { type:'raw', data:<对象> }`，回一个 JSON 字符串会被判非法。
describe('回调返回信封', () => {
  it('回调返回 raw 信封而不是 JSON 字符串', async () => {
    const r: any = await handleIssueCardAction(
      cb({ action: ISSUE_ACTION_PAGE, invoker_open_id: ME, teamId: 't1', page: '0' }),
      APP,
      deps().d,
    );
    expect(r.card.type).toBe('raw');
    expect(typeof r.card.data).toBe('object');
    expect(Array.isArray(r.card.data.elements)).toBe(true);
  });

  it('命令入口仍返回字符串（sessionReply 要的是 interactive 字符串）', async () => {
    const r: any = await handleIssueCommand(APP, ME, deps().d);
    expect(typeof r.card).toBe('string');
  });

  it('toast 分支两边形状一致，不被信封包装', async () => {
    const r: any = await handleIssueCardAction(cb({ action: ISSUE_ACTION_PAGE, teamId: 't1' }), APP, deps().d);
    expect(r.toast.content).toBeTruthy();
    expect(r.card).toBeUndefined();
  });
});
