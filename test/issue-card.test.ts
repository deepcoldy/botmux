import { describe, it, expect } from 'vitest';
import {
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_OPEN,
  buildClaimConfirmCard,
  buildClaimResultCard,
  buildIssueBoardCard,
  escapeLarkMd,
  truncateDisplay,
  buildIssueKickoffCard,
  buildIssueDeliveryCard,
  buildIssueStatusCard,
  claimFailureHint,
  matchRepo,
  rankRepos,
  type IssueBoardCardData,
  type RepoChoice,
} from '../src/im/lark/issue-card.js';

// 候选来自 scanMultipleProjects：仓库名 + 路径 + 分支，而不是 workingDirs 原值。
// 实测过 workingDirs 常常只配了一个工作区父目录，直接拿来当候选会选中工作区根目录。
const REPOS: RepoChoice[] = [
  { name: 'botmux', path: '/root/claude-code-workspace/botmux', branch: 'master' },
  { name: 'botmux-platform', path: '/root/claude-code-workspace/botmux-platform', branch: 'master' },
  { name: 'other-repo', path: '/root/work/other-repo', branch: 'dev' },
];

describe('仓库标签 → 本地仓库', () => {
  it('按仓库名精确命中', () => {
    expect(matchRepo('botmux', REPOS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('大小写与首尾空白不影响命中', () => {
    expect(matchRepo('  BotMux  ', REPOS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('空格/连字符差异可归一（"botmux 平台" 这类标签的现实写法）', () => {
    expect(matchRepo('botmux platform', REPOS)).toBe('/root/claude-code-workspace/botmux-platform');
    expect(matchRepo('botmux_platform', REPOS)).toBe('/root/claude-code-workspace/botmux-platform');
  });

  // 猜错仓库 = agent 在错误的地方动手，代价远大于让人多点一下下拉。
  it('匹配不上就返回 undefined，绝不模糊猜一个', () => {
    expect(matchRepo('完全不相干的仓库', REPOS)).toBeUndefined();
    expect(matchRepo('bot', REPOS)).toBeUndefined(); // 前缀不算命中
    expect(matchRepo(undefined, REPOS)).toBeUndefined();
    expect(matchRepo('   ', REPOS)).toBeUndefined();
  });

  it('没有可选仓库时返回 undefined，不抛', () => {
    expect(matchRepo('botmux', [])).toBeUndefined();
  });
});

function board(over: Partial<IssueBoardCardData> = {}): IssueBoardCardData {
  return {
    teamId: 't1',
    teamName: 'Botmux Origin',
    teams: [{ teamId: 't1', teamName: 'Botmux Origin' }],
    sections: {
      needsAttention: [],
      todo: [{ issueId: 'iss-1', title: '修一个 bug', repoLabel: 'botmux', stateRev: 3 }],
      inProgress: [],
      inReview: [],
      done: [],
    },
    page: 0,
    ...over,
  };
}

describe('看板卡片', () => {
  it('待领取的每一行都带领取按钮，并把 stateRev 一起带回', () => {
    const card = JSON.parse(buildIssueBoardCard(board()));
    const btn = JSON.stringify(card).includes(ISSUE_ACTION_CLAIM_OPEN);
    expect(btn).toBe(true);
    // stateRev 必须随卡片往返：领取时作为 expectedStateRev，别人先改过就 409
    expect(JSON.stringify(card)).toContain('"stateRev":"3"');
  });

  it('单团队时不渲染切换下拉，多团队时渲染', () => {
    expect(buildIssueBoardCard(board())).not.toContain('切换团队');
    const multi = board({ teams: [{ teamId: 't1', teamName: 'A' }, { teamId: 't2', teamName: 'B' }] });
    expect(buildIssueBoardCard(multi)).toContain('切换团队');
  });

  it('待领取为空时给出说明而不是空白', () => {
    const empty = board({ sections: { ...board().sections, todo: [] } });
    expect(buildIssueBoardCard(empty)).toContain('没有待领取的任务');
  });

  it('超过一页才出翻页按钮，首页上一页置灰', () => {
    const many = board({
      sections: {
        ...board().sections,
        todo: Array.from({ length: 7 }, (_, i) => ({ issueId: `i${i}`, title: `t${i}`, stateRev: 1 })),
      },
    });
    const card = JSON.parse(buildIssueBoardCard(many));
    const flat = JSON.stringify(card);
    expect(flat).toContain('上一页');
    expect(flat).toContain('1/2');
    // 一页只放 5 条
    expect((flat.match(/issue_claim_open/g) ?? []).length).toBe(5);
  });

  it('页码越界被夹回合法范围，不抛也不出空页', () => {
    const card = buildIssueBoardCard(board({ page: 99 }));
    expect(card).toContain('修一个 bug');
  });
});

describe('领取确认卡片', () => {
  it('匹配到目录时预选，并说明是自动匹配的', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1',
      issueId: 'iss-1',
      title: '修一个 bug',
      repoLabel: 'botmux',
      stateRev: 3,
      repos: REPOS,
      selectedDir: '/root/claude-code-workspace/botmux',
    });
    expect(card).toContain('已自动匹配');
    // 下拉显示仓库名 + 分支（同名 worktree 靠分支区分），而不是一串绝对路径
    expect(card).toContain('botmux (master)');
    expect(card).toContain(ISSUE_ACTION_CLAIM_CONFIRM);
    expect(JSON.parse(card).elements.some((e: any) => JSON.stringify(e).includes('"initial_option":"/root/claude-code-workspace/botmux"'))).toBe(true);
  });

  it('没匹配上时明确要求手动选择', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', repoLabel: '未知仓库', stateRev: 1, repos: REPOS,
    });
    expect(card).toContain('未匹配到本地仓库，请手动选择');
  });

  // 扫不到仓库就领，agent 起来也不知道在哪动手；与其领了再报错，不如这里就拦住。
  it('工作目录下扫不到仓库 → 不给确认按钮，直接说明原因', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', stateRev: 1, repos: [],
    });
    expect(card).toContain('没有扫到任何仓库');
    expect(card).not.toContain(ISSUE_ACTION_CLAIM_CONFIRM);
  });
});

describe('结果卡片', () => {
  it('成功时给群名与进群按钮', () => {
    const card = buildClaimResultCard({ ok: true, title: 'x', chatId: 'oc_1', chatName: 'x #abcd1234', shareLink: 'https://applink' });
    expect(card).toContain('已领取');
    expect(card).toContain('进入群');
    expect(card).toContain('https://applink');
  });

  it('没有分享链接时不渲染空按钮', () => {
    const card = buildClaimResultCard({ ok: true, title: 'x', chatId: 'oc_1', chatName: 'g' });
    expect(card).not.toContain('进入群');
  });

  // 不同阶段的补救方式完全不同，把阶段说出来才有用。
  it('失败时点明阶段与原因，并给对应的下一步提示', () => {
    const card = buildClaimResultCard({
      ok: false, title: 'x', stage: 'activate', reason: '发消息失败', hint: claimFailureHint('activate'),
    });
    expect(card).toContain('activate');
    expect(card).toContain('发消息失败');
    expect(card).toContain('可以直接在群里 @ 它，不必重新领取');
  });

  it('四个阶段都有各自的提示，未知阶段不编造', () => {
    for (const s of ['claim', 'group', 'bind', 'activate']) {
      expect(claimFailureHint(s)).toBeTruthy();
    }
    expect(claimFailureHint('无此阶段')).toBeUndefined();
  });
});

describe('候选排序与截断', () => {
  const many: RepoChoice[] = Array.from({ length: 58 }, (_, i) => ({
    name: `repo-${String(i).padStart(2, '0')}`,
    path: `/w/repo-${String(i).padStart(2, '0')}`,
  }));

  // Lark 的 select_static 有 50 个选项上限，实测一个工作区能扫出 58 个仓库。
  it('超过 50 个候选时截断，并报告被截掉多少', () => {
    const { options, truncated } = rankRepos(undefined, many);
    expect(options).toHaveLength(50);
    expect(truncated).toBe(8);
  });

  it('未超上限时不截断', () => {
    const { options, truncated } = rankRepos('botmux', REPOS);
    expect(options).toHaveLength(3);
    expect(truncated).toBe(0);
  });

  // 排序只决定「先显示谁」，不决定「选中谁」——所以这里可以放宽到子串。
  it('精确 > 归一化相等 > 含子串 > 其余，且不改变 matchRepo 的严格性', () => {
    const repos: RepoChoice[] = [
      { name: 'zzz', path: '/z' },
      { name: 'botmux-platform', path: '/p' },
      { name: 'botmux', path: '/b' },
    ];
    expect(rankRepos('botmux', repos).options.map((r) => r.name)).toEqual(['botmux', 'botmux-platform', 'zzz']);
    // 排序把 botmux-platform 排到了前面，但 matchRepo 仍然只认精确/归一命中
    expect(matchRepo('botmux', repos)).toBe('/b');
    expect(matchRepo('botmu', repos)).toBeUndefined();
  });

  it('无标签时按名字稳定排序，不随输入顺序抖动', () => {
    const a = rankRepos(undefined, [{ name: 'b', path: '/b' }, { name: 'a', path: '/a' }]);
    const b = rankRepos(undefined, [{ name: 'a', path: '/a' }, { name: 'b', path: '/b' }]);
    expect(a.options.map((r) => r.name)).toEqual(b.options.map((r) => r.name));
  });

  it('卡片上会说明被截断，不让人以为下拉里没有就是不存在', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'i', title: 'x', stateRev: 1, repos: many,
    });
    expect(card).toContain('另有 8 个未显示');
  });

  // 预选项被截断挤掉时，initial_option 会落空、下拉显示为未选。
  it('预选项不在截断后的选项里时，回落到第一个可选项', () => {
    const card = JSON.parse(buildClaimConfirmCard({
      teamId: 't1', issueId: 'i', title: 'x', stateRev: 1, repos: many, selectedDir: '/w/repo-57',
    }));
    const flat = JSON.stringify(card);
    expect(flat).not.toContain('"initial_option":"/w/repo-57"');
    expect(flat).toContain('"initial_option":"/w/repo-00"');
  });
});

// 群里唯一能看到"agent 在干什么"的东西。见 issue-claim-flow 的「开工播报」那组用例。
describe('开工播报卡', () => {
  const base = { title: '修一个 bug', workingDir: '/w/botmux', issueId: 'iss-1' };

  it('没有正文时明说，而不是留一块空白', () => {
    expect(buildIssueKickoffCard(base)).toContain('没有填写详细描述');
  });

  // 任务正文可能很长，整段贴进来会把群第一屏占满。
  it('长正文截断并留省略号', () => {
    const card = buildIssueKickoffCard({ ...base, body: 'x'.repeat(900) });
    expect(card).toContain('…');
    expect(card.length).toBeLessThan(1200);
  });

  it('有平台地址就给按钮，没有就不给（少个按钮而已，不该报错）', () => {
    expect(buildIssueKickoffCard({ ...base, issueUrl: 'https://p/?issue=iss-1#issues' }))
      .toContain('在平台上查看');
    expect(buildIssueKickoffCard(base)).not.toContain('在平台上查看');
  });
});

// 平台 /status 只收状态不收正文，所以交付说明只能落在群里，见 buildIssueDeliveryCard 的注释。
describe('交付播报卡', () => {
  const base = { issueId: 'iss-1', title: '修一个 bug', report: '改了 A 和 B，跑过测试。' };

  it('带上交付说明正文', () => {
    const flat = buildIssueDeliveryCard(base);
    expect(flat).toContain('已交付，等待验收');
    expect(flat).toContain('改了 A 和 B');
  });

  // 重复交付时若还说"已交付"，验收的人会以为交了两次。
  it('平台上已是待验收时换措辞', () => {
    const flat = buildIssueDeliveryCard({ ...base, alreadyInReview: true });
    expect(flat).toContain('已经是待验收状态');
    expect(flat).not.toContain('已交付，等待验收');
  });

  it('超长交付说明截断', () => {
    const flat = buildIssueDeliveryCard({ ...base, report: 'x'.repeat(4000) });
    expect(flat).toContain('…');
    expect(flat.length).toBeLessThan(2000);
  });

  it('交付说明为空时不留空块', () => {
    const flat = buildIssueDeliveryCard({ ...base, report: '   \n  ' });
    expect(flat).toContain('已交付，等待验收');
    expect(flat).toContain('iss-1');
  });

  // report 正文是 agent 自由书写的，直接塞进 lark_md 会被解释成标记。
  it('转义正文里的 lark_md，防止越权渲染', () => {
    const flat = buildIssueDeliveryCard({ ...base, report: '搞定了 </font><at user_id="all"></at>' });
    expect(flat).not.toContain('<at user_id=');
    expect(flat).toContain('&lt;at');
  });

  it('有平台地址才给验收按钮', () => {
    expect(buildIssueDeliveryCard({ ...base, issueUrl: 'https://p/?issue=iss-1#issues' })).toContain('去平台验收');
    expect(buildIssueDeliveryCard(base)).not.toContain('去平台验收');
  });
});

// 这张卡的价值不是"报个状态"，而是把本机与平台的**不一致**摆出来——那三种情况平时都是静默的。
describe('现状卡', () => {
  const base = {
    issueId: 'iss-1',
    bindState: 'bound',
    pendingWrites: 0,
    platform: { title: '修一个 bug', status: 'in_progress' },
    claimMine: true,
  };

  it('状态用人话，不出现 in_review 这种内部词', () => {
    const flat = buildIssueStatusCard({ ...base, platform: { title: 'x', status: 'in_review' } });
    expect(flat).toContain('待验收');
    expect(flat).not.toContain('in_review');
  });

  it('本地绑定状态也翻成人话', () => {
    expect(buildIssueStatusCard({ ...base, bindState: 'done' })).toContain('已验收完成');
    expect(buildIssueStatusCard({ ...base, bindState: 'released' })).toContain('已释放');
  });

  // 领取被收走后群里继续干的活没人收，这是最该被看见的一条。
  it('claim 不归本机时顶格警告', () => {
    const flat = buildIssueStatusCard({ ...base, claimMine: false });
    expect(flat).toContain('已经不归本机');
  });

  it('claim 仍在本机时不警告', () => {
    expect(buildIssueStatusCard(base)).not.toContain('已经不归本机');
  });

  // 拉不到 ≠ 不存在：findIssueById 的 null 覆盖网络失败与已归档两种，不能替人下结论。
  it('拉不到平台状态时说"拉不到"，不说"任务不存在"', () => {
    const flat = buildIssueStatusCard({ issueId: 'iss-1', bindState: 'bound', pendingWrites: 0 });
    expect(flat).toContain('拉不到');
    expect(flat).not.toContain('不存在');
  });

  it('有积压回写时说明有几条、后台会重投', () => {
    const flat = buildIssueStatusCard({ ...base, pendingWrites: 2 });
    expect(flat).toContain('2');
    expect(flat).toContain('重投');
    expect(buildIssueStatusCard(base)).not.toContain('重投');
  });

  it('需要关注时把原因翻成人话', () => {
    const flat = buildIssueStatusCard({
      ...base,
      platform: { title: 'x', status: 'needs_attention', attentionReason: 'claim_activate_timeout' },
    });
    expect(flat).toContain('需要关注');
    expect(flat).toContain('5 分钟内没有开工回写');
  });

  // 平台上的标题/领取人都是人自由填的，同样会被 lark_md 击穿。
  it('转义平台来的文本', () => {
    const flat = buildIssueStatusCard({
      ...base,
      platform: { title: '</font><at user_id="all"></at>', status: 'in_progress', claimAgent: 'a`b' },
    });
    expect(flat).not.toContain('<at user_id=');
    expect(flat).toContain('&lt;at');
  });

  it('有平台地址才给按钮', () => {
    expect(buildIssueStatusCard({ ...base, issueUrl: 'https://p/?issue=iss-1#issues' })).toContain('在平台上查看');
    expect(buildIssueStatusCard(base)).not.toContain('在平台上查看');
  });
});

function renderBoard(sections: any = {}, page = 0) {
  return buildIssueBoardCard(board({
    sections: { needsAttention: [], todo: [], inProgress: [], inReview: [], done: [], ...sections },
    page,
  }));
}
const row = (n: number, title = `任务${n}`, repoLabel?: string) => ({
  issueId: `i${n}`, title, stateRev: 1, ...(repoLabel ? { repoLabel } : {}),
});
describe('长标题', () => {
  // 按 length 截会让中英文标题在卡上宽窄差一倍；行右边还挂着「领取」按钮，超了就换行。
  it('按显示宽度截断，CJK 算两列', () => {
    expect(truncateDisplay('abcdefghij', 5)).toBe('abcde…');
    expect(truncateDisplay('一二三四五', 4)).toBe('一二…');
    expect(truncateDisplay('短', 10)).toBe('短');
  });

  it('看板行里的超长标题被截，不会整段铺进卡片', () => {
    const flat = renderBoard({ todo: [row(1, '很长的标题'.repeat(20))] });
    expect(flat).toContain('…');
    expect(flat.length).toBeLessThan(2000);
  });
});

describe('lark_md 消毒', () => {
  // 标题/正文/仓库标签都是人在平台上自由填的，直接拼进 lark_md 会被标签和强调语法击穿。
  it('标签与强调字符都被中和', () => {
    expect(escapeLarkMd('<font color="red">x</font>')).not.toContain('<font');
    expect(escapeLarkMd('*粗* _斜_ `码`')).toBe('\\*粗\\* \\_斜\\_ \\`码\\`');
    expect(escapeLarkMd('a\nb')).toBe('a b');
  });

  // 反斜杠必须最先转义，否则 `\*` 里的反斜杠自成偶数对，让紧跟的 * 重新变回有效强调。
  it('反斜杠先转义，不给强调留逃逸口', () => {
    expect(escapeLarkMd('\\*x*')).toBe('\\\\\\*x\\*');
  });

  it('恶意标题进不了看板卡的渲染层', () => {
    const flat = renderBoard({ todo: [row(1, '</font><at user_id="all">')] });
    expect(flat).not.toContain('<at ');
    expect(flat).toContain('&lt;');
  });
});

describe('仓库标签样式', () => {
  // 行内代码在飞书里是带底色的等宽块，比标题还抢眼，主次颠倒。
  it('用灰字而不是反引号包的行内代码', () => {
    const flat = renderBoard({ todo: [row(1, '修个 bug', 'botmux平台')] });
    expect(flat).toContain('<font color=\\"grey\\">botmux平台</font>'.replace(/\\\\/g, '\\'));
    expect(flat).not.toContain('`botmux平台`');
  });
});

describe('需要关注段封顶', () => {
  // 原来是无条件全量铺开：积压几十条就会把卡片撑爆，并把待领取挤出屏幕。
  it('只铺前几条，其余折成计数', () => {
    const flat = renderBoard({ needsAttention: Array.from({ length: 30 }, (_, i) => row(i)) });
    expect(flat).toContain('另有 27 条');
    expect(flat).not.toContain('任务29');
  });

  it('条数不超上限时不显示"另有"', () => {
    const flat = renderBoard({ needsAttention: [row(1)] });
    expect(flat).not.toContain('另有');
  });
});

describe('待领取翻页', () => {
  it('超过一页才出翻页按钮，页码显示 当前/总数', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(i));
    expect(renderBoard({ todo: many })).toContain('1/3');
    expect(renderBoard({ todo: [row(1)] })).not.toContain('上一页');
  });

  it('页码越界时夹回有效范围，不会渲染空页', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(i));
    const flat = renderBoard({ todo: many }, 99);
    expect(flat).toContain('3/3');
    expect(flat).toContain('任务11');
  });
});

// 任务 id 是人要照着复制的东西。escapeLarkMd 给 `_` 加反斜杠，而反斜杠在代码块里是字面量，
// 复制走的就成了 `iss\_f93d…` —— 错的 id。
describe('行内代码块', () => {
  const ID = 'iss_f93d7d54f212da8f27f9014a';

  it('任务 id 不被反斜杠转义', () => {
    for (const flat of [
      buildIssueStatusCard({ issueId: ID, bindState: 'bound', pendingWrites: 0 }),
      buildIssueDeliveryCard({ issueId: ID, report: 'x' }),
      buildIssueKickoffCard({ title: 't', workingDir: '/w/a_b', issueId: ID }),
    ]) {
      expect(flat).toContain(ID);
      expect(flat).not.toContain('iss\\\\_');
    }
  });

  // 代码块里唯一能击穿它的是反引号：漏掉的话后面半张卡会变成代码块。
  it('反引号被去掉，卡片结构不被击穿', () => {
    const flat = buildIssueStatusCard({ issueId: 'a`b`c', bindState: 'bound', pendingWrites: 0 });
    const line = JSON.parse(flat).elements.map((e: any) => e.text?.content ?? '').find((c: string) => c.includes('平台任务'));
    expect(line).toContain('`abc`');
  });
});

describe('现状卡：已放弃的回写', () => {
  const base = { issueId: 'iss-1', bindState: 'bound', pendingWrites: 0 };

  it('报出条数与错误，并说明重试不会好', () => {
    const flat = buildIssueStatusCard({ ...base, failedWrites: 1, lastFailure: 'forbidden: revoked' });
    expect(flat).toContain('已放弃重投');
    expect(flat).toContain('revoked');
    expect(flat).toContain('重试不会好转');
  });

  it('没有判死行时不出现这一段', () => {
    expect(buildIssueStatusCard(base)).not.toContain('已放弃重投');
    expect(buildIssueStatusCard({ ...base, failedWrites: 0 })).not.toContain('已放弃重投');
  });

  // 错误原文里可能带平台回传的任意文本。
  it('错误原文被转义', () => {
    const flat = buildIssueStatusCard({ ...base, failedWrites: 1, lastFailure: '</font><at user_id="all"></at>' });
    expect(flat).not.toContain('<at user_id=');
  });
});
