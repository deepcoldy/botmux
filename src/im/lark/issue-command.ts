/**
 * `/issue` 的命令入口与卡片回调。
 *
 * 卡片渲染在 [[issue-card]]（纯数据、无副作用），这里负责取数、鉴权、跑领取流程。
 *
 * ## 谁能操作
 *
 * 两道门，都 fail-closed：
 *  1. **allowedUsers**——`/issue` 会真的领任务、建群、起 agent，不是只读命令，按 bot 的
 *     管理员名单来（与 `/skills attach` 同一套）。
 *  2. **invoker lock**——卡片带 `invoker_open_id`，只有发起那个人能点。群里别人点了不算。
 *     这条不是洁癖：平台的 claim 是按**本机 owner** 记的，不是按点击者记的。谁点都能领的
 *     话，任务会记在 owner 头上而点的人是别人，归属直接错位。
 *
 * 身份只认 `operator.*`（Lark 校验过），绝不从 `action.value` 里读——那份是卡片里带回来的，
 * 未经校验。
 */
import { logger } from '../../utils/logger.js';
import { scanMultipleProjects } from '../../services/project-scanner.js';
import { configuredWorkingDirs, expandHomePath } from '../../utils/working-dir.js';
import {
  ISSUE_ACTION_CLAIM_CANCEL,
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_DIR,
  ISSUE_ACTION_CLAIM_OPEN,
  ISSUE_ACTION_PAGE,
  ISSUE_ACTION_REFRESH,
  ISSUE_ACTION_TEAM,
  buildClaimConfirmCard,
  buildClaimResultCard,
  buildIssueBoardCard,
  claimFailureHint,
  matchRepo,
  type IssueBoardCardData,
  type IssueRowData,
  type RepoChoice,
} from './issue-card.js';
import type { CardActionData } from './card-handler.js';
import type { PlatformIssue, PlatformIssueSections } from '../../platform/issue-client.js';

export interface IssueCommandDeps {
  fetchTeams: () => Promise<{ ok: boolean; value?: Array<{ teamId: string; teamName: string }>; reason?: string }>;
  fetchIssues: (teamId: string) => Promise<{ ok: boolean; value?: PlatformIssueSections; reason?: string }>;
  /** 跑 [[issue-claim-flow]]。返回值直接喂给结果卡。 */
  runClaim: (args: {
    issue: PlatformIssue;
    teamId: string;
    larkAppId: string;
    workingDir: string;
    invokerOpenId: string;
  }) => Promise<
    | { ok: true; chatId: string; chatName: string; shareLink?: string }
    | { ok: false; stage: string; reason: string }
  >;
  /** 该 bot 的管理员 open_id 名单（`resolvedAllowedUsers`）。 */
  allowedUsers: (larkAppId: string) => string[];
  /** 该 bot 配置的工作目录（未展开 `~`）。 */
  workingDirs: (larkAppId: string) => string[];
  /** 跑 [[issue-release]] 的 `releaseIssue`。按锚点释放，锚点由调用方从当前会话推出来。 */
  runRelease: (anchorId: string) => Promise<TerminalResult>;
  /** 跑 [[issue-release]] 的 `completeIssue`（验收完成）。与释放同形，只是目标态不同。 */
  runDone: (anchorId: string) => Promise<TerminalResult>;
  /** 跑 [[issue-status-view]]。只读，用来渲染 `/issue status` 卡片。 */
  runStatus: (anchorId: string) => Promise<
    | { ok: true; card: string }
    | { ok: false; reason: 'no_binding' }
  >;
}

/**
 * 释放 / 验收完成的共同返回形状。
 *
 * `bindState` 只在 `already_released` 时有意义：三个终态（void / released / done）要说的话
 * 完全不同——"作废了"、"早就释放过了"、"已经验收完成了"——糊成一句人会以为自己记错了。
 */
export type TerminalResult =
  | { ok: true; issueId: string; alreadyReleasedOnPlatform: boolean }
  | {
      ok: false;
      reason: 'no_binding' | 'already_released' | 'platform';
      detail?: string;
      bindState?: string;
      /** 平台明确拒绝且重试无意义（凭证失效 / issue 被删或归档）。措辞必须换掉"稍后再试"。 */
      permanent?: boolean;
    };

/** 命令入口的返回：card 是卡片 JSON 字符串，直接喂 `sessionReply(..., 'interactive')`。 */
export type IssueCardResult = { card: string } | { toast: { type: 'error' | 'info'; content: string } };

/**
 * 卡片回调的返回。**结构与命令入口不同**：Lark 的 callback 响应要求
 * `card: { type: 'raw', data: <对象> }`，直接回一个 JSON 字符串会被判非法，
 * 客户端报 `code 200672`（实测踩过：卡片能发出来，但一点按钮就报错）。
 */
export type IssueCardCallbackResult =
  | { card: { type: 'raw'; data: Record<string, unknown> } }
  | { toast: { type: 'error' | 'info'; content: string } };

function toast(content: string): IssueCardResult {
  return { toast: { type: 'error', content } };
}

/** 把内部统一产出的卡片字符串包成 Lark 回调要的信封。 */
function asCallback(r: IssueCardResult): IssueCardCallbackResult {
  if ('toast' in r) return r;
  return { card: { type: 'raw', data: JSON.parse(r.card) as Record<string, unknown> } };
}

/** 平台 issue → 卡片行。只留卡片用得到的字段，别把整个 doc 塞进 action.value。 */
function toRow(i: PlatformIssue): IssueRowData {
  return {
    issueId: i._id,
    title: i.title,
    ...(i.targetRepoLabel ? { repoLabel: i.targetRepoLabel } : {}),
    stateRev: i.stateRev,
    ...(i.claim?.name ? { claimedByName: i.claim.name } : {}),
  };
}

/**
 * 扫出该 bot 可选的仓库。
 *
 * 不能直接用 `workingDirs`：它常常配的是一个工作区父目录（`~/claude-code-workspace`），
 * 直接当候选，选中的会是工作区根目录。扫一层才拿得到真正的仓库和 worktree。
 */
export function reposFor(larkAppId: string, deps: IssueCommandDeps): RepoChoice[] {
  const dirs = configuredWorkingDirs({ workingDirs: deps.workingDirs(larkAppId) }).map(expandHomePath);
  if (!dirs.length) return [];
  try {
    return scanMultipleProjects(dirs, 3, { includeWorktrees: true }).map((p) => ({
      name: p.name,
      path: p.path,
      ...(p.branch ? { branch: p.branch } : {}),
    }));
  } catch (e) {
    // 扫描失败不该让整个命令挂掉：回落到空候选，确认卡会说明"没扫到仓库"。
    logger.warn(`[issue] 扫描仓库失败: ${String((e as Error)?.message ?? e)}`);
    return [];
  }
}

async function buildBoard(
  larkAppId: string,
  deps: IssueCommandDeps,
  opts: { teamId?: string; page?: number; invokerOpenId: string },
): Promise<IssueCardResult> {
  const teams = await deps.fetchTeams();
  if (!teams.ok || !teams.value) {
    return toast(teams.reason === 'unbound' ? '本机还没有绑定 botmux 平台' : `拉取团队失败：${teams.reason}`);
  }
  if (!teams.value.length) return toast('你不在任何 botmux 平台团队里');

  const teamId = opts.teamId && teams.value.some((t) => t.teamId === opts.teamId) ? opts.teamId : teams.value[0].teamId;
  const team = teams.value.find((t) => t.teamId === teamId)!;
  const issues = await deps.fetchIssues(teamId);
  if (!issues.ok || !issues.value) return toast(`拉取任务失败：${issues.reason}`);

  const s = issues.value;
  const data: IssueBoardCardData = {
    teamId,
    teamName: team.teamName,
    teams: teams.value,
    sections: {
      needsAttention: (s.needsAttention ?? []).map(toRow),
      todo: (s.todo ?? []).map(toRow),
      inProgress: (s.inProgress ?? []).map(toRow),
      inReview: (s.inReview ?? []).map(toRow),
      done: (s.done ?? []).map(toRow),
    },
    page: opts.page ?? 0,
    invokerOpenId: opts.invokerOpenId,
  };
  return { card: buildIssueBoardCard(data) };
}

/** `/issue`（裸）→ 看板卡片。 */
export async function handleIssueCommand(
  larkAppId: string,
  senderOpenId: string | undefined,
  deps: IssueCommandDeps,
): Promise<IssueCardResult> {
  if (!senderOpenId) return toast('无法识别操作者身份');
  const admins = deps.allowedUsers(larkAppId);
  if (!admins.length) return toast('这个 bot 还没有配置管理员');
  if (!admins.includes(senderOpenId)) return toast('只有管理员可以操作 Issue Board');
  return buildBoard(larkAppId, deps, { invokerOpenId: senderOpenId });
}

type Toast = { toast: { type: 'error' | 'info'; content: string } };

function info(content: string): Toast {
  return { toast: { type: 'info', content } };
}
function err(content: string): Toast {
  return { toast: { type: 'error', content } };
}

/** 管理员门。三个群内命令共用；通过时返回 undefined。 */
function adminGate(larkAppId: string, senderOpenId: string | undefined, deps: IssueCommandDeps): Toast | undefined {
  if (!senderOpenId) return err('无法识别操作者身份');
  const admins = deps.allowedUsers(larkAppId);
  if (!admins.length) return err('这个 bot 还没有配置管理员');
  if (!admins.includes(senderOpenId)) return err('只有管理员可以操作 Issue Board');
  return undefined;
}

/**
 * 依次试锚点，返回第一个「不是 no_binding」的结果。
 *
 * 锚点候选按 [[core/types]] 的 `sessionAnchorId` 语义给：拉群会话锚在 chatId、话题会话锚在
 * rootMessageId。调用方两个都传、这里依次试——比让调用方先判 scope 简单，两个地址空间
 * （`oc_` / `om_`）不会撞，试错没有歧义。
 *
 * 只要有一个锚点给出了非 no_binding 的结果就停：继续试下去会把真实失败盖成"没有领取记录"。
 */
async function tryAnchors<R extends { ok: boolean; reason?: string }>(
  anchorCandidates: Array<string | undefined>,
  run: (anchorId: string) => Promise<R>,
): Promise<R | undefined> {
  let last: R | undefined;
  for (const anchorId of anchorCandidates.filter((a): a is string => !!a)) {
    last = await run(anchorId);
    if (last.ok || last.reason !== 'no_binding') break;
  }
  return last;
}

/** 三个终态 bindState 各自的说法。糊成一句「已结束」人会以为自己记错了。 */
function terminalHint(bindState: string | undefined): string {
  if (bindState === 'done') return '这条任务已经验收完成（done），平台上已经终结了。';
  if (bindState === 'void') return '这条领取此前被平台拒绝、已作废，无需再操作。';
  return '这条领取此前就已经释放了，无需重复操作。';
}

/**
 * `/issue release` → 释放当前会话领取的那个 issue，退回平台「待领取」。
 *
 * 在**领取时建出来的那个群里**发。返回文本而不是卡片：这是个一次性动作，结果就一句话，
 * 发张卡反而重。
 */
export async function handleIssueRelease(
  larkAppId: string,
  senderOpenId: string | undefined,
  anchorCandidates: Array<string | undefined>,
  deps: IssueCommandDeps,
): Promise<Toast> {
  const denied = adminGate(larkAppId, senderOpenId, deps);
  if (denied) return denied;

  const last = await tryAnchors(anchorCandidates, deps.runRelease);
  if (!last) return err('拿不到当前会话的锚点，无法定位领取记录');

  if (last.ok) {
    logger.info(`[issue] 释放成功 issue=${last.issueId} platform_already=${last.alreadyReleasedOnPlatform}`);
    return info(
      last.alreadyReleasedOnPlatform
        ? '✅ 已释放。平台上这条任务此前就已经不归本机了（可能被回收或已被别人领走），本机记录已同步。\n\n群和会话都还在，需要的话自己停会话或退群。'
        : '✅ 已释放，任务已退回平台「待领取」，别人可以领了。\n\n群和会话都还在，**不会自动解散**——里面的对话记录还留着，要停会话发 `/stop`。',
    );
  }
  if (last.reason === 'no_binding') return err('这个会话没有领取任何平台任务，没什么可释放的。');
  if (last.reason === 'already_released') return info(terminalHint(last.bindState));

  logger.warn(`[issue] 释放失败 detail=${last.detail} permanent=${last.permanent === true}`);
  // 劝人重试之前先看这次失败是不是永久性的：401/403/404 再发一百次也一样，那句"稍后再试"
  // 会让人一直重试到放弃，而真正该做的是去平台上看这条任务还在不在。
  return err(
    last.permanent
      ? `❌ 释放失败：${last.detail}\n\n平台明确拒绝了，重试也不会好转（凭证失效、或这条任务已被删除/归档）。去平台上确认这条任务的状态。`
      : `❌ 释放失败：${last.detail}\n\n本机记录保持不变（平台仍认为这台机器持有），稍后可以再发一次 \`/issue release\`。`,
  );
}

/**
 * `/issue done` → 验收通过，把任务推到平台的终态。
 *
 * 这一步是**人的决策**，不是 agent 能自己走的：agent 交付只到「待验收」（[[issue-report]]），
 * 之后由人看过产出再决定完成还是打回。所以入口是群里的管理员命令，而不是 `botmux` 的某个
 * 子命令——放在 CLI 里 agent 就能自己盖章验收，那这个状态就没有意义了。
 *
 * 平台侧 `done` 会清掉 claim（`clearsClaim`），这条领取就此终结、不能再释放。
 */
export async function handleIssueDone(
  larkAppId: string,
  senderOpenId: string | undefined,
  anchorCandidates: Array<string | undefined>,
  deps: IssueCommandDeps,
): Promise<Toast> {
  const denied = adminGate(larkAppId, senderOpenId, deps);
  if (denied) return denied;

  const last = await tryAnchors(anchorCandidates, deps.runDone);
  if (!last) return err('拿不到当前会话的锚点，无法定位领取记录');

  if (last.ok) {
    logger.info(`[issue] 验收完成 issue=${last.issueId} platform_already=${last.alreadyReleasedOnPlatform}`);
    return info(
      last.alreadyReleasedOnPlatform
        ? '✅ 已标记完成。平台上这条任务此前就已经不归本机了，本机记录已同步。\n\n群和会话都还在，需要的话自己停会话或退群。'
        : '🎉 已验收完成，平台上这条任务已终结（不能再释放了）。\n\n群和会话都还在，**不会自动解散**——要停会话发 `/stop`。',
    );
  }
  if (last.reason === 'no_binding') return err('这个会话没有领取任何平台任务，没什么可验收的。');
  if (last.reason === 'already_released') return info(terminalHint(last.bindState));

  logger.warn(`[issue] 验收完成失败 detail=${last.detail} permanent=${last.permanent === true}`);
  // 平台的追赶白名单不允许 needs_attention → done。这是设计而不是故障，得说清楚下一步。
  const blocked = /invalid_transition/.test(last.detail ?? '');
  return err(
    blocked
      ? `❌ 平台拒绝了这次状态变更：${last.detail}\n\n多半是这条任务当前在「需要关注」——平台不允许从那里直接标完成。先去平台上处理（或发 \`/issue release\` 退回待领取）。`
      : last.permanent
        ? `❌ 标记完成失败：${last.detail}\n\n平台明确拒绝了，重试也不会好转（凭证失效、或这条任务已被删除/归档）。去平台上确认这条任务的状态。`
        : `❌ 标记完成失败：${last.detail}\n\n本机记录保持不变，稍后可以再发一次 \`/issue done\`。`,
  );
}

/**
 * `/issue status` → 摊开本机与平台两边的现状。
 *
 * 只读，所以**不设终态门**：这个命令的用处恰恰是在「这个群是不是已经结束了」存疑的时候
 * 回答它，把终态 binding 当成"没有绑定"是把唯一的答案藏起来。
 */
export async function handleIssueStatus(
  larkAppId: string,
  senderOpenId: string | undefined,
  anchorCandidates: Array<string | undefined>,
  deps: IssueCommandDeps,
): Promise<IssueCardResult> {
  const denied = adminGate(larkAppId, senderOpenId, deps);
  if (denied) return denied;

  const last = await tryAnchors(anchorCandidates, deps.runStatus);
  if (!last) return toast('拿不到当前会话的锚点，无法定位领取记录');
  if (!last.ok) return toast('这个会话没有领取任何平台任务。');
  return { card: last.card };
}

/** 卡片回调。所有 `issue_*` action 都走这里。 */
export async function handleIssueCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: IssueCommandDeps,
): Promise<IssueCardCallbackResult> {
  return asCallback(await handleIssueCardActionInner(data, larkAppId, deps));
}

async function handleIssueCardActionInner(
  data: CardActionData,
  larkAppId: string,
  deps: IssueCommandDeps,
): Promise<IssueCardResult> {
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ── invoker lock（fail-closed）─────────────────────────────────────────
  const invokerOpenId = value.invoker_open_id;
  if (!invokerOpenId || !operatorOpenId || invokerOpenId !== operatorOpenId) {
    return toast('这张卡片只有发起人能操作');
  }
  // 每次回调都重跑权限门：发卡之后管理员名单可能已经改了。
  const admins = deps.allowedUsers(larkAppId);
  if (!admins.includes(operatorOpenId)) return toast('只有管理员可以操作 Issue Board');

  const teamId = value.teamId;

  if (action === ISSUE_ACTION_REFRESH || action === ISSUE_ACTION_PAGE || action === ISSUE_ACTION_TEAM) {
    // 团队切换的新 teamId 来自下拉的选中值，不在 value 里。
    const picked = action === ISSUE_ACTION_TEAM ? selectedOption(data) ?? teamId : teamId;
    const page = action === ISSUE_ACTION_PAGE ? Number(value.page) || 0 : 0;
    return buildBoard(larkAppId, deps, { teamId: picked, page, invokerOpenId });
  }

  if (action === ISSUE_ACTION_CLAIM_CANCEL) {
    return buildBoard(larkAppId, deps, { teamId, invokerOpenId });
  }

  if (action === ISSUE_ACTION_CLAIM_OPEN || action === ISSUE_ACTION_CLAIM_DIR) {
    const issue = await findIssue(teamId, value.issueId, deps);
    if (!issue) return toast('这条任务已经不在待领取列表里了，刷新看看');
    const repos = reposFor(larkAppId, deps);
    // 下拉切换时以人选的为准；首次打开才用标签自动匹配。
    const picked = action === ISSUE_ACTION_CLAIM_DIR ? selectedOption(data) : matchRepo(issue.targetRepoLabel, repos);
    return {
      card: buildClaimConfirmCard({
        teamId,
        issueId: issue._id,
        title: issue.title,
        ...(issue.targetRepoLabel ? { repoLabel: issue.targetRepoLabel } : {}),
        stateRev: issue.stateRev,
        repos,
        ...(picked ? { selectedDir: picked } : {}),
        invokerOpenId,
      }),
    };
  }

  if (action === ISSUE_ACTION_CLAIM_CONFIRM) {
    const workingDir = value.dir;
    if (!workingDir) return toast('没有选择工作仓库');
    // 重新拉一次而不是用卡片里的 stateRev：卡片可能已经放了很久，用陈旧的 CAS 基线
    // 只会白白撞一次 409。拉不到就说明这条已经不可领了。
    const issue = await findIssue(teamId, value.issueId, deps);
    if (!issue) return toast('这条任务已经不在待领取列表里了，刷新看看');

    const r = await deps.runClaim({ issue, teamId, larkAppId, workingDir, invokerOpenId });
    if (r.ok) {
      logger.info(`[issue] 领取成功 issue=${issue._id} chat=${r.chatId}`);
      return {
        card: buildClaimResultCard({
          ok: true,
          title: issue.title,
          chatId: r.chatId,
          chatName: r.chatName,
          ...(r.shareLink ? { shareLink: r.shareLink } : {}),
        }),
      };
    }
    logger.warn(`[issue] 领取失败 issue=${issue._id} stage=${r.stage} reason=${r.reason}`);
    return {
      card: buildClaimResultCard({
        ok: false,
        title: issue.title,
        stage: r.stage,
        reason: r.reason,
        ...(claimFailureHint(r.stage) ? { hint: claimFailureHint(r.stage)! } : {}),
      }),
    };
  }

  return toast(`未知操作：${action}`);
}

/** 从回调里取下拉选中值。Lark 在不同卡片版本下字段名不一致，两种都认。 */
function selectedOption(data: CardActionData): string | undefined {
  const opt = (data.action as { option?: unknown })?.option;
  if (typeof opt === 'string' && opt) return opt;
  const opts = (data.action as { options?: unknown })?.options;
  if (Array.isArray(opts) && typeof opts[0] === 'string' && opts[0]) return opts[0];
  return undefined;
}

/** 按 issueId 在最新的分段列表里找。平台没有「按 id 单查」的机器入口，只能从列表里捞。 */
async function findIssue(
  teamId: string,
  issueId: string | undefined,
  deps: IssueCommandDeps,
): Promise<PlatformIssue | null> {
  if (!teamId || !issueId) return null;
  const r = await deps.fetchIssues(teamId);
  if (!r.ok || !r.value) return null;
  for (const list of Object.values(r.value)) {
    const hit = (list as PlatformIssue[]).find((i) => i._id === issueId);
    if (hit) return hit;
  }
  return null;
}
