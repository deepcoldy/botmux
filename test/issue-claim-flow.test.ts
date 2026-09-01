import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimGroupName,
  claimIssueIntoGroup,
  claimMarker,
  issueDetailUrl,
  matchesClaimMarker,
  type ClaimFlowDeps,
} from '../src/services/issue-claim-flow.js';
import {
  createBinding,
  getBinding,
  getClaimIntent,
  listBindings,
  listClaimIntents,
  listDanglingClaimIntents,
  listOutbox,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-claim-flow-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ISSUE = { _id: 'iss-1', title: '修一个 bug', stateRev: 1, targetRepoLabel: 'botmux' };
const ARGS = {
  issue: ISSUE,
  teamId: 't1',
  larkAppId: 'cli_worker',
  creatorLarkAppId: 'cli_creator',
  ownerUnionIds: ['on_alice'],
  workingDir: '/w/botmux',
  kickoffPrompt: '接手这个 issue',
};

/** 记录调用序列的假依赖；每一步都能单独打成失败。 */
function deps(over: Partial<ClaimFlowDeps> = {}) {
  const calls: string[] = [];
  const groupOpts: any[] = [];
  const base: ClaimFlowDeps = {
    dataDir,
    platformBaseUrl: 'https://platform.example',
    newClaimId: () => 'c'.repeat(32),
    claim: async () => {
      calls.push('claim');
      return { ok: true, value: { claim: { claimEpoch: 3 }, issue: { ...ISSUE, stateRev: 2 } } } as any;
    },
    bind: async () => {
      calls.push('bind');
      return { ok: true, value: { issue: { ...ISSUE, stateRev: 3 } } } as any;
    },
    createGroup: async (opts) => {
      calls.push('createGroup');
      groupOpts.push(opts);
      opts.onChatCreated?.('oc_new');
      return { ok: true, chatId: 'oc_new' } as any;
    },
    activate: async () => {
      calls.push('activate');
      return 'om_kickoff';
    },
    writeStatus: async (_id, a) => {
      calls.push(`status:${a.status}`);
      return { ok: true, value: { issue: { ...ISSUE, status: a.status, stateRev: 4, claim: { lastSourceSeq: a.sourceSeq } } } } as any;
    },
    fetchIssue: async () => ({ ...ISSUE, stateRev: 4, claim: { claimId: 'c'.repeat(32) } }) as any,
    ...over,
  };
  return { d: base, calls, groupOpts };
}

describe('领取标记', () => {
  it('取 claimId 前 8 位，能从群名反查', () => {
    const id = 'abcdef0123456789abcdef0123456789';
    expect(claimMarker(id)).toBe('#abcdef01');
    expect(matchesClaimMarker(`修一个 bug ${claimMarker(id)}`, id)).toBe(true);
    expect(matchesClaimMarker('修一个 bug #deadbeef', id)).toBe(false);
  });
});

describe('顺利路径', () => {
  it('按 claim→建群→bind→activate 的顺序走完，意图退休、binding 转 bound', async () => {
    const { d, calls } = deps();
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claim', 'createGroup', 'bind', 'activate', 'status:in_progress']);
    if (!r.ok) return;
    expect(r.chatId).toBe('oc_new');
    expect(r.kickoffMessageId).toBe('om_kickoff');
    expect(r.binding.bindState).toBe('bound');
    expect(r.binding.localTaskRef).toBe('oc_new::cli_worker');
    expect(r.binding.platformStateRev).toBe(4);
    // 意图只在窗口期存在，走完就该清掉
    expect(listClaimIntents(dataDir)).toEqual([]);
  });

  // 平台 bind 之后给 5 分钟 activation 租约，到期还停在 claimed 就被 sweeper 打成
  // needs_attention(claim_activate_timeout)——那是条单向门，回不到在跑也交付不了。
  // 「开工即写 in_progress」就是拆这颗引信，所以它必须有独立用例盯着。
  it('activate 之后立刻把 issue 推到 in_progress（拆掉 activation lease 引信）', async () => {
    const { d, calls } = deps();
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(calls.indexOf('status:in_progress')).toBeGreaterThan(calls.indexOf('activate'));
    expect(getBinding(dataDir, 'oc_new')?.lastSyncedStatus).toBe('in_progress');
    expect(listOutbox(dataDir, 'oc_new').every((row) => row.state === 'done')).toBe(true);
  });

  // 回写失败不该推翻已经建好的群和绑定：行留在发件箱里，pump 会重投。
  it('in_progress 回写失败仍算领取成功，行留在发件箱待重投', async () => {
    const errors: string[] = [];
    const { d } = deps({
      writeStatus: async () => ({ ok: false, reason: 'server', status: 503, error: 'boom' }) as any,
      onStatusError: (e) => errors.push(e),
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(errors.join()).toMatch(/boom/);
    expect(getBinding(dataDir, 'oc_new')?.bindState).toBe('bound');
    expect(listOutbox(dataDir, 'oc_new').some((row) => row.state === 'pending')).toBe(true);
  });

  // held 是「群已建、binding 未写」那个窗口的唯一兜底：没 kickoff 就没有 agent 在跑。
  it('建群必须是 held —— 不传 kickoffBot/kickoffPrompt', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, ARGS);
    expect(groupOpts[0].kickoffBotLarkAppId).toBeUndefined();
    expect(groupOpts[0].kickoffPrompt).toBeUndefined();
  });

  // 平台把 claim.agent 原样渲染在 issue 详情里，传 appId 的话看板上只有一串 cli_xxx，
  // 谁在干这活完全看不出来。
  function spyClaimAgent(): { d: ClaimFlowDeps; seen: any[] } {
    const seen: any[] = [];
    const { d } = deps({
      claim: async (_id, a) => {
        seen.push(a);
        return { ok: true, value: { claim: { claimEpoch: 3 }, issue: { ...ISSUE, stateRev: 2 } } } as any;
      },
    });
    return { d, seen };
  }

  it('上送平台的 agent 用展示名', async () => {
    const { d, seen } = spyClaimAgent();
    await claimIssueIntoGroup(d, { ...ARGS, agentLabel: 'claude-loopy' });
    expect(seen[0].agent).toBe('claude-loopy');
  });

  it('拿不到展示名时回落到 appId，不会漏传', async () => {
    const { d, seen } = spyClaimAgent();
    await claimIssueIntoGroup(d, ARGS);
    expect(seen[0].agent).toBe('cli_worker');
  });

  // 平台详情页拿 localTaskRef（`oc_xxx::cli_xxx`）当"绑定"那一行的值显示，等于给人看一串
  // ID。群名 + applink 让人认得出、点得进。
  it('bind 时一并上送群名与群分享链接', async () => {
    const seen: any[] = [];
    const { d } = deps({
      createGroup: async (opts) => {
        opts.onChatCreated?.('oc_new');
        return { ok: true, chatId: 'oc_new', shareLink: 'https://applink.feishu.cn/x' } as any;
      },
      bind: async (_id, a) => {
        seen.push(a);
        return { ok: true, value: { issue: { ...ISSUE, stateRev: 3 } } } as any;
      },
    });
    await claimIssueIntoGroup(d, ARGS);
    expect(seen[0].localTaskLabel).toBe(`修一个 bug ${claimMarker('c'.repeat(32))}`);
    expect(seen[0].localTaskUrl).toBe('https://applink.feishu.cn/x');
  });

  // 分享链接是 best-effort 拿的，拿不到不能连群名一起丢，更不能因此让 bind 失败。
  it('拿不到分享链接时仍上送群名，只是没有深链', async () => {
    const seen: any[] = [];
    const { d } = deps({
      bind: async (_id, a) => {
        seen.push(a);
        return { ok: true, value: { issue: { ...ISSUE, stateRev: 3 } } } as any;
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(seen[0].localTaskLabel).toContain('修一个 bug');
    expect(seen[0].localTaskUrl).toBeUndefined();
  });

  it('群名带 claimId 标记，人被按 union_id 拉进来', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, ARGS);
    expect(groupOpts[0].name).toContain(claimMarker('c'.repeat(32)));
    expect(groupOpts[0].ownerUnionIds).toEqual(['on_alice']);
    expect(groupOpts[0].larkAppIds).toContain('cli_worker');
  });

  // 不传 bindWorkingDir 的话，人在卡片里选的仓库根本不生效——会话会起在 bot 的默认目录，
  // agent 在错误的仓库动手且毫无报错。
  it('选中的仓库必须作为 bindWorkingDir 绑到新群上', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, ARGS);
    expect(groupOpts[0].bindWorkingDir).toBe('/w/botmux');
  });
});

// kickoff prompt 是内部投递的，群里一个字都看不到；新建的群又是普通群、默认 reply mode
// 不是 shared，handleBotAdded 的 seed 也不发。没有这张卡，人进群只看到一个空群，直到
// agent 干完才有第一条消息——实测反馈就是"找不到他已经开始工作了"。
describe('开工播报', () => {
  function withAnnounce(over: Partial<ClaimFlowDeps> = {}) {
    const sent: Array<{ chatId: string; card: any }> = [];
    const { d, calls } = deps({
      announce: async (chatId, card) => {
        calls.push('announce');
        sent.push({ chatId, card: JSON.parse(card) });
      },
      ...over,
    });
    return { d, sent, calls };
  }

  it('bind 成功后、activate 之前发到新群里', async () => {
    const { d, sent, calls } = withAnnounce();
    await claimIssueIntoGroup(d, ARGS);
    // 先播报再激活：agent 的输出要跟在任务说明后面，顺序读起来才对
    expect(calls).toEqual(['claim', 'createGroup', 'bind', 'announce', 'activate', 'status:in_progress']);
    expect(sent[0].chatId).toBe('oc_new');
  });

  it('卡片摊开 agent 拿到的东西：标题、正文、目录、任务 id', async () => {
    const { d, sent } = withAnnounce();
    await claimIssueIntoGroup(d, { ...ARGS, issue: { ...ISSUE, body: '复现步骤：点两下就炸' } });
    const text = JSON.stringify(sent[0].card);
    expect(text).toContain('修一个 bug');
    expect(text).toContain('复现步骤：点两下就炸');
    expect(text).toContain('/w/botmux');
    expect(text).toContain('iss-1');
    // 释放入口只在这张卡上露出来，不写人根本不知道有这个命令
    expect(text).toContain('/issue release');
  });

  // 播报纯展示，不该有能力弄砸一次已经 bind 成功的领取。
  it('播报失败不影响领取结果，只走旁路报告', async () => {
    const errs: string[] = [];
    const { d } = deps({
      announce: async () => {
        throw new Error('lark 限流');
      },
      onAnnounceError: (r) => errs.push(r),
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(errs).toEqual(['lark 限流']);
  });

  it('不注入 announce 时整条流程照常走完', async () => {
    const { d, calls } = deps();
    expect((await claimIssueIntoGroup(d, ARGS)).ok).toBe(true);
    expect(calls).not.toContain('announce');
  });
});

describe('平台任务深链', () => {
  it('按平台前端的路由形状拼：tab 在 hash、详情在 query', () => {
    expect(issueDetailUrl('https://p.example', 'iss-1')).toBe('https://p.example/?issue=iss-1#issues');
    expect(issueDetailUrl('https://p.example/', 'iss-1')).toBe('https://p.example/?issue=iss-1#issues');
  });

  it('id 会被转义，拼不出合法地址时返回 undefined 而不是抛', () => {
    expect(issueDetailUrl('https://p.example', 'a b&c')).toContain('issue=a%20b%26c');
    expect(issueDetailUrl('', 'iss-1')).toBeUndefined();
    expect(issueDetailUrl('不是地址', 'iss-1')).toBeUndefined();
  });
});

describe('失败留下的状态必须可对账', () => {
  it('claim 失败 → 本地一片干净，重试安全', async () => {
    const { d, calls } = deps({ claim: async () => ({ ok: false, reason: 'conflict' }) as any });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'claim', reason: 'conflict' });
    expect(calls).toEqual([]);
    expect(listClaimIntents(dataDir)).toEqual([]);
    expect(listBindings(dataDir)).toEqual([]);
  });

  // 这是设计里最危险的窗口：平台已 claim、群还没有。意图必须留在盘上，否则 claimId 丢了。
  it('建群抛错 → 意图仍在盘上（悬空），claimId 没丢', async () => {
    const { d } = deps({
      createGroup: async () => {
        throw new Error('lark 5xx');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'group', reason: 'lark 5xx', claimId: 'c'.repeat(32) });
    const dangling = listDanglingClaimIntents(dataDir);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].issueId).toBe('iss-1');
    expect(dangling[0].anchorId).toBeUndefined(); // 群没建出来，anchor 自然没有
  });

  // 群建出来了但后续步骤炸：onChatCreated 已经把 binding 和 anchor 落盘，群认得回来。
  it('建群中途炸（onChatCreated 已跑）→ binding 与 anchor 都在，群不会变孤儿', async () => {
    const { d } = deps({
      createGroup: async (opts) => {
        opts.onChatCreated?.('oc_half');
        throw new Error('邀人超时');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'group' });
    expect(getBinding(dataDir, 'oc_half')?.bindState).toBe('pending');
    expect(getClaimIntent(dataDir, 'c'.repeat(32))?.anchorId).toBe('oc_half');
  });

  it('bind 被平台拒 → binding 置 void，不删（群还在，要留得下痕迹）', async () => {
    const { d, calls } = deps({ bind: async () => ({ ok: false, reason: 'conflict' }) as any });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'bind', reason: 'conflict', chatId: 'oc_new' });
    expect(getBinding(dataDir, 'oc_new')?.bindState).toBe('void');
    expect(calls).not.toContain('activate'); // 没 bind 成就绝不能激活
  });

  it('activate 失败 → binding 已 bound，重试激活即可，不必重建群', async () => {
    const { d } = deps({
      activate: async () => {
        throw new Error('发消息失败');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'activate', chatId: 'oc_new' });
    expect(getBinding(dataDir, 'oc_new')?.bindState).toBe('bound');
    // 意图还没清——activate 没完成，领取流程还没走完
    expect(getClaimIntent(dataDir, 'c'.repeat(32))).not.toBeNull();
  });
});

describe('重复领取', () => {
  // 同 issue 两个群 = 两个 agent 同时开工，平台只认最后一次 claim，另一个群变孤儿。
  it('同 issue 已有活跃 binding → 连 claim 都不发', async () => {
    createBinding(dataDir, {
      anchorId: 'oc_old',
      larkAppId: 'cli_worker',
      scope: 'chat',
      issueId: 'iss-1',
      teamId: 't1',
      platformBaseUrl: 'https://platform.example',
      claimId: 'old-claim',
      claimEpoch: 1,
    });
    const { d, calls } = deps();
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'claim', reason: 'already_claimed_locally' });
    expect(calls).toEqual([]); // 不白占一次平台代次
    if (!r.ok && r.stage === 'claim') expect(r.alreadyLocal?.anchorId).toBe('oc_old');
  });
});

// 不自己截的话飞书会从尾部截，先吃掉的正是尾部那个 #claimId 标记——而那是双通道反查的
// 一条腿，断了不会报错，只会让对账认不出这个群。
describe('群名长度', () => {
  const ID = 'abcdef0123456789abcdef0123456789';

  it('长标题被截，标记完整保留', () => {
    const name = claimGroupName('很长的标题'.repeat(20), ID);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.endsWith(claimMarker(ID))).toBe(true);
    expect(matchesClaimMarker(name, ID)).toBe(true);
    expect(name).toContain('…');
  });

  it('短标题原样保留，不画蛇添足', () => {
    expect(claimGroupName('修一个 bug', ID)).toBe(`修一个 bug ${claimMarker(ID)}`);
  });

  it('标题只有空白也拼得出可反查的群名', () => {
    const name = claimGroupName('   ', ID);
    expect(matchesClaimMarker(name, ID)).toBe(true);
  });

  it('实际建群用的就是这个名字', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, { ...ARGS, issue: { ...ISSUE, title: '很长的标题'.repeat(20) } });
    expect(groupOpts[0].name.length).toBeLessThanOrEqual(50);
    expect(matchesClaimMarker(groupOpts[0].name, 'c'.repeat(32))).toBe(true);
  });
});
