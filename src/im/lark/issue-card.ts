/**
 * Issue Board 卡片：`/issue` 的飞书原生入口。
 *
 * 三个视图，同一张卡片就地切换（不新发消息，避免刷屏）：
 *   看板 board  → 点「领取」→ 确认 confirm（选仓库）→ 点「确认领取」→ 结果 result
 *
 * 领取由**你 @ 的那个 bot** 承接：`larkAppId` 就是承接方，不需要再选。想让别的 bot 干，
 * 就去 @ 它发 `/issue`。少一次选择，语义也天然。
 *
 * 仓库不新造配置：候选来自 `scanMultipleProjects(configuredWorkingDirs(bot))` —— 现有仓库
 * 选择卡片用的同一套扫描。注意**不能**直接用 `workingDirs` 原值：实测发现它常常配的是一个
 * 工作区父目录（`~/claude-code-workspace`）而不是仓库列表，直接拿来当候选，选中的会是工作区
 * 根目录，等于让 agent 在错误的位置动手。扫描一层才拿得到真正的仓库和 worktree。
 *
 * 平台只存展示用的 `targetRepoLabel`，这里按仓库名做一次匹配把它预选上，匹配不上就让人在
 * 下拉里挑——不拦人，也不猜。
 *
 * Security（沿用 groups-card 的约定）：
 *  - `action.value` 不经 Lark 校验，**绝不**从里面读身份字段；调用者身份只认 operator.*
 *  - 权限门在命令入口和每次回调都要跑一遍
 *
 * 只吃纯数据，不反向依赖 store / platform client，避免循环依赖。
 */

import type { Locale } from '../../i18n/index.js';

export const ISSUE_ACTION_REFRESH = 'issue_refresh' as const;
export const ISSUE_ACTION_PAGE = 'issue_page' as const;
export const ISSUE_ACTION_TEAM = 'issue_team' as const;
export const ISSUE_ACTION_CLAIM_OPEN = 'issue_claim_open' as const;
export const ISSUE_ACTION_CLAIM_DIR = 'issue_claim_dir' as const;
export const ISSUE_ACTION_CLAIM_CONFIRM = 'issue_claim_confirm' as const;
export const ISSUE_ACTION_CLAIM_CANCEL = 'issue_claim_cancel' as const;

/** 一页放几条。看板是给人扫的，多了反而看不动；和 groups-card 保持一致。 */
const PAGE_SIZE = 5;

/** 「需要关注」最多铺几条。见 buildIssueBoardCard 里为什么必须封顶。 */
const ATTENTION_PREVIEW = 3;

/** Lark 的 select_static 选项数上限（与 groups-card 的 JUMP_PAGE_MAX_OPTIONS 同源）。
 *  实测一个工作区能扫出 58 个仓库/worktree，不截断会直接超限。 */
const MAX_REPO_OPTIONS = 50;

export interface IssueRowData {
  issueId: string;
  title: string;
  repoLabel?: string;
  /** CAS 基线，随卡片往返——领取时要拿它做 expectedStateRev。 */
  stateRev: number;
  /** 已被领取时展示领取人；本机领的还会有 chatId。 */
  claimedByName?: string;
  chatId?: string;
}

export interface IssueBoardCardData {
  teamId: string;
  teamName: string;
  teams: Array<{ teamId: string; teamName: string }>;
  sections: {
    needsAttention: IssueRowData[];
    todo: IssueRowData[];
    inProgress: IssueRowData[];
    inReview: IssueRowData[];
    done: IssueRowData[];
  };
  /** todo 段的页码（只有待领取需要翻页，其它段是概览计数）。 */
  page: number;
  /**
   * 发起人的 `ou_*`。会被打进**每一个** action.value，回调时与 Lark 校验过的
   * operator.open_id 比对——群里别人点了不算。
   *
   * 不是洁癖：平台的 claim 按**本机 owner** 记，不按点击者记。谁点都能领的话，任务记在
   * owner 头上而实际点的是别人，归属直接错位。
   */
  invokerOpenId: string;
}

/** 一个可选仓库。来自 project-scanner 的 `ProjectInfo`，只取卡片用得到的三个字段。 */
export interface RepoChoice {
  name: string;
  path: string;
  branch?: string;
}

export interface ClaimConfirmCardData {
  teamId: string;
  issueId: string;
  title: string;
  repoLabel?: string;
  stateRev: number;
  /** 扫出来的候选仓库。空数组时不给确认按钮并说明原因。 */
  repos: RepoChoice[];
  /** 当前选中的仓库路径（首次进入由 matchRepo 预选）。 */
  selectedDir?: string;
  /** 见 IssueBoardCardData.invokerOpenId。 */
  invokerOpenId: string;
}

export type ClaimResultCardData =
  | { ok: true; title: string; chatId: string; chatName: string; shareLink?: string }
  | { ok: false; title: string; stage: string; reason: string; hint?: string };

/**
 * 把平台的展示标签匹配到本机某个仓库，返回它的路径。
 *
 * 平台只有 `targetRepoLabel`（"botmux"、"botmux 平台"…），是给人看的，没有路径。这里做的
 * 是**预选**不是决定：匹配上就把下拉默认值设好省一次点击，匹配不上返回 undefined，让人自己
 * 在下拉里挑。刻意不做模糊匹配——猜错仓库会让 agent 在错误的地方动手，代价远大于多点一下。
 *
 * 优先精确命中仓库名，再退一步允许去掉空格/下划线/连字符后相等（"botmux 平台" 这种带空格
 * 的标签能对上 `botmux-platform`）。前缀不算命中：`bot` 不该选中 `botmux`。
 */
export function matchRepo(label: string | undefined, repos: RepoChoice[]): string | undefined {
  if (!label) return undefined;
  const want = label.trim().toLowerCase();
  if (!want) return undefined;
  const exact = repos.find((r) => r.name.toLowerCase() === want);
  if (exact) return exact.path;
  const norm = (s: string) => s.replace(/[\s_-]+/g, '');
  return repos.find((r) => norm(r.name.toLowerCase()) === norm(want))?.path;
}

/**
 * 按与标签的相关度给候选仓库排序并截断到 Lark 的选项上限。
 *
 * 与 {@link matchRepo} 分工明确：那个决定**选中谁**（严格，宁缺毋滥），这个只决定**先显示
 * 谁**（宽松，含子串即可）。排序永远不会替人做选择，所以这里放宽是安全的——而不放宽的话，
 * 标签没精确命中时人得在几十个仓库里自己翻，实测一个工作区能扫出 58 个。
 *
 * 截断是必要的：超过上限 Lark 会拒绝或静默丢弃。被截掉的部分由调用方在卡片上说明，
 * 不能让人以为"没有就是不存在"。
 */
export function rankRepos(
  label: string | undefined,
  repos: RepoChoice[],
  limit: number = MAX_REPO_OPTIONS,
): { options: RepoChoice[]; truncated: number } {
  const want = (label ?? '').trim().toLowerCase();
  const norm = (s: string) => s.replace(/[\s_-]+/g, '');
  const score = (r: RepoChoice): number => {
    if (!want) return 3;
    const n = r.name.toLowerCase();
    if (n === want) return 0;
    if (norm(n) === norm(want)) return 1;
    if (norm(n).includes(norm(want)) || norm(want).includes(norm(n))) return 2;
    return 3;
  };
  const sorted = [...repos].sort((a, b) => {
    const d = score(a) - score(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return { options: sorted.slice(0, limit), truncated: Math.max(0, sorted.length - limit) };
}

function h(content: string): any {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/**
 * lark_md 文本位消毒。issue 的标题/正文/仓库标签都是**人在平台上自由填的**，直接拼进
 * lark_md 会被标签与强调语法击穿：一个 `<font>` 或 `</font><at …>` 就能改掉整张卡的观感，
 * 一个落单的反引号能让后面半张卡变成代码块。
 *
 * 转义顺序抄 [[brand-template]] 的 `safeText`（那是仓库里唯一做对的一份）：**反斜杠必须最先**
 * ——否则 `\*` 里的反斜杠自成偶数对，让紧跟的 `*` 重新变回有效强调。groups-card 等 5 处旧
 * 拷贝都缺这一步，这里不跟着抄错。
 */
export function escapeLarkMd(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/**
 * 行内代码块的安全渲染。
 *
 * **不能**拿 `escapeLarkMd` 往代码块里塞：它给 `_` `*` 这些加反斜杠，而反斜杠在代码块里是
 * **字面量**——`iss_f93d7d54…` 会显示成 `iss\_f93d7d54…`，人照着复制走的是错的任务 id。
 * 代码块里唯一能击穿它的是反引号本身（换行同理，会把块撑破），去掉这两样就够。
 */
function code(s: string): string {
  return `\`${s.replace(/[`\r\n]+/g, '')}\``;
}

/**
 * 按**显示宽度**截断（CJK 算两列），不是按字符数。
 *
 * 按 `length` 截会让中英文两种标题在卡片上宽窄差一倍：30 个汉字铺满两行，30 个字母才半行。
 * 看板每行右边还挂着「领取」按钮，正文列本来就窄，超了就换行、按钮被挤到下一行，一排下来
 * 参差不齐。
 */
export function truncateDisplay(s: string, maxWidth: number): string {
  const width = (ch: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1);
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = width(ch);
    if (w + cw > maxWidth) return `${out}…`;
    w += cw;
    out += ch;
  }
  return out;
}

/** 标题在看板行里的最大显示宽度。右边挂着「领取」按钮，正文列没有整行那么宽。 */
const BOARD_TITLE_WIDTH = 34;
/** 仓库标签的最大显示宽度。它是次要信息，不该跟标题抢地方。 */
const REPO_LABEL_WIDTH = 20;

/**
 * 仓库标签的呈现：灰色小字，不是反引号包的行内代码。
 *
 * 行内代码在飞书里是带底色的等宽块，视觉重量比标题还大——一眼看过去先看到仓库名再看到任务，
 * 主次颠倒。灰字是本仓卡片里次要元信息的既有写法（见 groups-card 的 chatId/appId 后缀）。
 */
function repoTag(label: string): string {
  return `　<font color="grey">${escapeLarkMd(truncateDisplay(label, REPO_LABEL_WIDTH))}</font>`;
}

function pageOf<T>(rows: T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: rows.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE), page: p, pages };
}

/** 看板视图。只有「待领取」列出可操作的行，其余段给计数——卡片要能一眼扫完。 */
export function buildIssueBoardCard(data: IssueBoardCardData, _locale?: Locale): string {
  const s = data.sections;
  const { slice, page, pages } = pageOf(s.todo, data.page);
  const elements: any[] = [];

  elements.push(h(`**📋 ${data.teamName}**`));
  if (data.teams.length > 1) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '切换团队' },
          initial_option: data.teamId,
          options: data.teams.map((t) => ({
            text: { tag: 'plain_text', content: t.teamName },
            value: t.teamId,
          })),
          value: { action: ISSUE_ACTION_TEAM, invoker_open_id: data.invokerOpenId },
        },
      ],
    });
  }
  elements.push({ tag: 'hr' });

  if (s.needsAttention.length) {
    elements.push(h(`🔴 **需要关注 (${s.needsAttention.length})**`));
    // 必须封顶：这一段原来是无条件全量铺开的，团队里积压几十条 needs_attention 就会把整张
    // 卡撑爆（飞书对卡片元素数与总长度都有上限，超了直接发不出去），而且把下面的待领取挤到
    // 屏幕外。它只是提醒，不是操作区，列几条足够。
    for (const r of s.needsAttention.slice(0, ATTENTION_PREVIEW)) {
      elements.push(h(`　${escapeLarkMd(truncateDisplay(r.title, BOARD_TITLE_WIDTH))}`));
    }
    const restAttention = s.needsAttention.length - ATTENTION_PREVIEW;
    if (restAttention > 0) elements.push(h(`　<font color="grey">…另有 ${restAttention} 条</font>`));
  }

  elements.push(h(`⚪️ **待领取 (${s.todo.length})**`));
  if (!slice.length) {
    elements.push(h('　_没有待领取的任务_'));
  }
  for (const r of slice) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `　${escapeLarkMd(truncateDisplay(r.title, BOARD_TITLE_WIDTH))}${r.repoLabel ? repoTag(r.repoLabel) : ''}`,
      },
      extra: {
        tag: 'button',
        text: { tag: 'plain_text', content: '领取' },
        type: 'primary',
        value: {
          action: ISSUE_ACTION_CLAIM_OPEN,
          invoker_open_id: data.invokerOpenId,
          teamId: data.teamId,
          issueId: r.issueId,
          // stateRev 随卡片往返：领取时作为 expectedStateRev，别人先改过就会 409，
          // 好过拿一个卡片渲染那一刻的陈旧值去覆盖。
          stateRev: String(r.stateRev),
        },
      },
    });
  }

  elements.push(
    h(`🔵 **进行中 (${s.inProgress.length})**　🟡 **待验收 (${s.inReview.length})**　✅ **已完成 (${s.done.length})**`),
  );

  const actions: any[] = [];
  if (pages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '‹ 上一页' },
      disabled: page <= 0,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page - 1) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${page + 1}/${pages}` },
      disabled: true,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '下一页 ›' },
      disabled: page >= pages - 1,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page + 1) },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🔄 刷新' },
    value: { action: ISSUE_ACTION_REFRESH, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page) },
  });
  elements.push({ tag: 'action', actions });

  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 领取确认视图：选仓库 + 确认/取消。就地替换看板，不新发卡片。 */
export function buildClaimConfirmCard(data: ClaimConfirmCardData, _locale?: Locale): string {
  const elements: any[] = [];
  elements.push(h(`**领取「${escapeLarkMd(truncateDisplay(data.title, 60))}」**`));

  const base = {
    invoker_open_id: data.invokerOpenId,
    teamId: data.teamId,
    issueId: data.issueId,
    stateRev: String(data.stateRev),
  };

  if (!data.repos.length) {
    // 扫不到仓库就领，agent 起来也不知道该在哪动手——与其领了再报错，不如在这里说清楚。
    elements.push(h('⚠️ 在这个 bot 的工作目录下没有扫到任何仓库，无法领取。'));
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回' },
          value: { action: ISSUE_ACTION_CLAIM_CANCEL, ...base },
        },
      ],
    });
    return JSON.stringify({ config: { wide_screen_mode: true }, elements });
  }

  const { options, truncated } = rankRepos(data.repoLabel, data.repos);
  // 选中项必须在选项里，否则 initial_option 落空、下拉显示为未选。
  const selected =
    data.selectedDir && options.some((r) => r.path === data.selectedDir)
      ? data.selectedDir
      : options[0].path;
  elements.push(
    h(
      data.repoLabel
        ? `平台标注仓库${repoTag(data.repoLabel)}${data.selectedDir ? '　（已自动匹配）' : '　（未匹配到本地仓库，请手动选择）'}`
        : '平台未标注仓库，请选择工作仓库',
    ),
  );
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择仓库' },
        initial_option: selected,
        // 下拉里显示仓库名 + 分支，比一串绝对路径好认——同名 worktree 靠分支区分。
        options: options.map((r) => ({
          text: { tag: 'plain_text', content: r.branch ? `${r.name} (${r.branch})` : r.name },
          value: r.path,
        })),
        value: { action: ISSUE_ACTION_CLAIM_DIR, ...base },
      },
    ],
  });
  elements.push(h(`　\`${selected}\``));
  if (truncated > 0) {
    // 说清楚被截了，别让人以为"下拉里没有就是不存在"。
    elements.push(h(`_候选较多，仅列出最相关的 ${options.length} 个（另有 ${truncated} 个未显示）_`));
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '确认领取' },
        type: 'primary',
        value: { action: ISSUE_ACTION_CLAIM_CONFIRM, ...base, dir: selected },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '取消' },
        value: { action: ISSUE_ACTION_CLAIM_CANCEL, ...base },
      },
    ],
  });
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 结果视图。失败时**明说失败在哪一步**——不同阶段的补救方式完全不同（见 issue-claim-flow）。 */
export function buildClaimResultCard(data: ClaimResultCardData, _locale?: Locale): string {
  const elements: any[] = [];
  if (data.ok) {
    elements.push(h(`✅ **已领取「${escapeLarkMd(truncateDisplay(data.title, 60))}」**`));
    elements.push(h(`群：${escapeLarkMd(data.chatName)}`));
    if (data.shareLink) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '进入群' },
            type: 'primary',
            url: data.shareLink,
            value: {},
          },
        ],
      });
    }
    return JSON.stringify({ config: { wide_screen_mode: true }, elements });
  }
  elements.push(h(`❌ **领取「${escapeLarkMd(truncateDisplay(data.title, 60))}」失败**`));
  elements.push(h(`失败在：\`${escapeLarkMd(data.stage)}\`　原因：\`${escapeLarkMd(data.reason)}\``));
  if (data.hint) elements.push(h(data.hint));
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

export interface IssueKickoffCardData {
  title: string;
  body?: string;
  workingDir: string;
  issueId: string;
  /** 平台任务详情深链。拿不到平台地址时省略，卡片只是少一个按钮。 */
  issueUrl?: string;
}

/** 正文摘要长度。够看清要干什么，又不至于把整个群第一屏占满。 */
const KICKOFF_BODY_MAX = 400;

/**
 * 开工播报：领取建群后**发在任务群里**的第一条消息。
 *
 * 为什么必须有这么一张卡：kickoff prompt 是**内部投递**的（daemon 直接建会话，见
 * [[issue-command-deps]] 的 ActivateSession），它不经过飞书，群里一个字都看不到。而新建的
 * 群是普通群、默认 reply mode 不是 shared，`handleBotAdded` 的那条 seed 也不会发。两下一
 * 叠，群从建好到 agent 吐出第一段输出之间**完全是空的**——人进群只看到一个空群，不知道
 * agent 有没有开始干、在干什么、在哪个仓库干。实测反馈就是「找不到他已经开始工作了，
 * 干完了才汇报一下」。
 *
 * 所以这张卡要把「agent 现在拿到的是什么」原样摊开：任务标题、正文、工作目录、平台任务
 * 深链。它同时也是释放入口的说明书——不写在这里，人根本不知道 `/issue release` 存在。
 */
export function buildIssueKickoffCard(data: IssueKickoffCardData, _locale?: Locale): string {
  const elements: any[] = [];
  elements.push(h(`🚀 **已开工：${escapeLarkMd(truncateDisplay(data.title, 60))}**`));

  const body = data.body?.trim();
  if (body) {
    const excerpt = body.length > KICKOFF_BODY_MAX ? `${body.slice(0, KICKOFF_BODY_MAX)}…` : body;
    // 正文是人在平台上自由填的，同样要消毒——一个落单的反引号能让后面半张卡变成代码块。
    // 这里保留换行（正文本来就是多行），所以按行转义后再拼回去。
    elements.push(h(excerpt.split('\n').map(escapeLarkMd).join('\n')));
  } else {
    elements.push(h('_这条任务没有填写详细描述_'));
  }

  elements.push({ tag: 'hr' });
  elements.push(h(`📁 工作目录　${code(data.workingDir)}`));
  elements.push(h(`🔖 平台任务　${code(data.issueId)}`));

  if (data.issueUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '在平台上查看' },
          url: data.issueUrl,
          value: {},
        },
      ],
    });
  }

  elements.push({ tag: 'hr' });
  // 这三个命令只在这里露出来。不写的话人根本不知道它们存在，遇事只能去平台上 force-detach。
  elements.push(
    h(
      '_做完会自动汇报。本群可用：`/issue status` 看现状 · `/issue done` 验收完成 ·'
      + ' `/issue release` 退回「待领取」（群都不会解散）。_',
    ),
  );
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

export interface IssueDeliveryCardData {
  title?: string;
  issueId: string;
  /** agent 执行 `botmux report` 时写的交付说明。 */
  report: string;
  issueUrl?: string;
  /** 重复交付（平台上已经是待验收）时措辞不同，别让人以为交付了两次。 */
  alreadyInReview?: boolean;
}

/** 交付说明的展示上限。完整正文在会话里本来就有，这里只是给验收的人一个摘要。 */
const DELIVERY_REPORT_MAX = 1200;

/**
 * 交付播报：`botmux report` 成功后发回任务群。
 *
 * 之所以必须发：平台的 `/status` 接口**只收状态、不收正文**（claimId/claimEpoch/sourceSeq/
 * status/expectedStateRev，没有 note 字段）。交付说明在平台上无处可放，验收的人只会看到状态
 * 变成「待验收」，完全不知道交付了什么。在补上平台侧的备注字段之前，群里是这段文字唯一
 * 能落地的地方——否则它就只是 `botmux report` 的一行 stdout，谁也看不见。
 */
export function buildIssueDeliveryCard(data: IssueDeliveryCardData, _locale?: Locale): string {
  const elements: any[] = [];
  elements.push(
    h(
      data.alreadyInReview
        ? `📮 **已经是待验收状态**${data.title ? `：${escapeLarkMd(truncateDisplay(data.title, 60))}` : ''}`
        : `✅ **已交付，等待验收**${data.title ? `：${escapeLarkMd(truncateDisplay(data.title, 60))}` : ''}`,
    ),
  );

  const body = data.report.trim();
  if (body) {
    const excerpt = body.length > DELIVERY_REPORT_MAX ? `${body.slice(0, DELIVERY_REPORT_MAX)}…` : body;
    elements.push({ tag: 'hr' });
    elements.push(h(excerpt.split('\n').map(escapeLarkMd).join('\n')));
  }

  elements.push({ tag: 'hr' });
  elements.push(h(`🔖 平台任务　${code(data.issueId)}`));
  if (data.issueUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '去平台验收' },
          type: 'primary',
          url: data.issueUrl,
          value: {},
        },
      ],
    });
  }
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 平台状态 → 人话。卡上不该出现 `in_review` 这种只有读过代码的人才懂的词。 */
const STATUS_LABEL: Record<string, string> = {
  open: '⚪️ 待领取',
  claimed: '🟣 已领取（还没开工）',
  in_progress: '🔵 进行中',
  in_review: '🟡 待验收',
  done: '✅ 已完成',
  cancelling: '🟠 取消中',
  needs_attention: '🔴 需要关注',
  reopened: '🔁 已重开',
};

/** 需要关注的原因 → 人话。不翻译的话卡上只有一串下划线命名，等于没说。 */
const ATTENTION_LABEL: Record<string, string> = {
  cancel_delivery_timeout: '取消指令迟迟没有回执',
  claim_activate_timeout: '领取后 5 分钟内没有开工回写',
  task_blocked: 'agent 报告被卡住',
  run_timeout: '运行超时',
};

/** 本地绑定状态 → 人话。终态各有各的含义，别糊成一句「已结束」。 */
const BIND_STATE_LABEL: Record<string, string> = {
  pending: '已领取，还没向平台绑定',
  bound: '已绑定，本机正持有',
  void: '绑定被平台拒绝，已作废',
  released: '已释放，任务退回平台',
  done: '已验收完成',
};

export interface IssueStatusCardData {
  issueId: string;
  bindState: string;
  /** 平台侧现状。undefined = 没拉到（网络/已归档），卡上必须说成"拉不到"而不是"没有"。 */
  platform?: {
    title: string;
    status: string;
    attentionReason?: string;
    claimAgent?: string;
    claimLabel?: string;
  };
  /** 平台上这条 claim 是否还归本机。undefined = 无法判定。 */
  claimMine?: boolean;
  /** 发件箱里还没发出去的回写条数。 */
  pendingWrites: number;
  /** 已被判死、不再重投的回写条数（平台明确拒绝）。 */
  failedWrites?: number;
  /** 最后一条判死行的错误原文。 */
  lastFailure?: string;
  /** 本机认为已同步到的状态（用于和平台对照）。 */
  lastSyncedStatus?: string;
  issueUrl?: string;
}

/**
 * `/issue status`：本机与平台两边的现状对照。
 *
 * 卡片的重点不是"报个状态"，而是把**两边不一致**摆出来——回写卡在发件箱、claim 已经被平台
 * 收走、任务掉进需要关注，这三种情况在出问题时都是静默的，人只有主动查才看得见。所以：
 *  - claim 不归本机 → 顶格红字警告（这个群继续干下去的产出没人收）
 *  - 有待发回写 → 明说有几条、后台会重投，免得人以为状态更新丢了
 *  - 平台拉不到 → 说"拉不到"，绝不说"任务不存在"（`findIssueById` 的 null 本就无法区分二者）
 */
export function buildIssueStatusCard(data: IssueStatusCardData, _locale?: Locale): string {
  const elements: any[] = [];
  const p = data.platform;

  elements.push(h(`🔎 **任务现状**${p ? `：${escapeLarkMd(truncateDisplay(p.title, 60))}` : ''}`));

  if (data.claimMine === false) {
    elements.push(
      h('🔴 **平台上这条任务的领取已经不归本机**（被回收、租约过期或已被别人领走）。本群再干下去的产出，平台这边不会记在这条任务上。'),
    );
  }

  elements.push({ tag: 'hr' });
  if (p) {
    const status = STATUS_LABEL[p.status] ?? escapeLarkMd(p.status);
    const reason = p.attentionReason ? ATTENTION_LABEL[p.attentionReason] ?? escapeLarkMd(p.attentionReason) : undefined;
    elements.push(h(`平台状态　${status}${reason ? `　<font color="grey">（${reason}）</font>` : ''}`));
    if (p.claimAgent || p.claimLabel) {
      const who = [p.claimAgent, p.claimLabel].filter(Boolean).map((x) => escapeLarkMd(truncateDisplay(String(x), 40)));
      elements.push(h(`领取人　　<font color="grey">${who.join('　·　')}</font>`));
    }
  } else {
    // 拉不到 ≠ 不存在：findIssueById 的 null 同时covers 网络失败与已归档，不能替人下结论。
    elements.push(h('平台状态　<font color="grey">拉不到（平台不可达，或这条任务已归档）</font>'));
  }

  elements.push(
    h(
      `本机绑定　${escapeLarkMd(BIND_STATE_LABEL[data.bindState] ?? data.bindState)}`
      + (data.lastSyncedStatus ? `　<font color="grey">已同步到 ${STATUS_LABEL[data.lastSyncedStatus] ?? escapeLarkMd(data.lastSyncedStatus)}</font>` : ''),
    ),
  );

  if (data.pendingWrites > 0) {
    elements.push(
      h(`⏳ 还有 **${data.pendingWrites}** 条状态回写没发出去，后台每 30 秒重投一次（不用手动重试）。`),
    );
  }
  // 判死的行不在 pendingWrites 里。不单独报出来，界面上一声不吭就等于"已经同步好了"，
  // 而那次状态变更**永远不会**到平台——给了 fatal 就得给能看见它的地方。
  if ((data.failedWrites ?? 0) > 0) {
    elements.push(
      h(
        `❗ 有 **${data.failedWrites}** 条状态回写被平台拒绝、已放弃重投`
        + `${data.lastFailure ? `：${escapeLarkMd(truncateDisplay(data.lastFailure, 80))}` : ''}。`
        + '重试不会好转，去平台上看看这条任务还在不在、领取有没有被收回。',
      ),
    );
  }

  elements.push({ tag: 'hr' });
  elements.push(h(`🔖 平台任务　${code(data.issueId)}`));
  if (data.issueUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '在平台上查看' },
          url: data.issueUrl,
          value: {},
        },
      ],
    });
  }
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 失败阶段 → 给人的下一步提示。措辞对应 issue-claim-flow 里那张「失败留下什么」表。 */
export function claimFailureHint(stage: string): string | undefined {
  switch (stage) {
    case 'claim':
      return '本地没有留下任何痕迹，可以直接重试。';
    case 'group':
      return '平台上已经领取但群没建成。领取记录还在本机，启动对账会接手（补建群或释放领取）。';
    case 'bind':
      return '群已建好但平台拒绝了绑定（可能被回收或已被别人领走）。绑定已作废，群留着待人处理。';
    case 'activate':
      return '群和绑定都已就绪，只差把 bot 叫起来。可以直接在群里 @ 它，不必重新领取。';
    default:
      return undefined;
  }
}
