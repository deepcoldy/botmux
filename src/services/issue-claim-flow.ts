/**
 * 拉群领取：把一个平台 issue 变成一个飞书群 + 一个跑着的 CLI 会话。
 *
 * 顺序在 [[issue-board-store]] 文件头定死，这里是它的可执行版本：
 *
 *   1. platform claim
 *   2. recordClaimIntent      ← 立刻。claim 已成功而意图未落盘时崩溃 = 丢 claimId
 *   3. createGroupWithBots    ← **held**：不传 kickoffBot/kickoffPrompt，群里没有 agent 在跑
 *   4. onChatCreated → createBinding + 回填意图   ← durable boundary
 *   5. platform bind(localTaskRef)
 *   6. kickoff（@bot）→ activate                  ← 到这一步 daemon 才真的起会话
 *   7. clearClaimIntent       ← 必须晚于 binding 落盘
 *
 * 每一步都可能崩，且崩了都不该产生「群在跑但平台不知道」或「平台以为在跑但本机没有」的
 * 不一致。这里的做法是：**任何一步失败都不回滚已完成的持久化**，而是把状态留在可对账的
 * 形态上（意图在 / binding pending / binding void），交给启动对账收拾。回滚才是危险的
 * ——撤销远端副作用本身也会失败，只会把状态搅得更不可辨认。
 *
 * 依赖全部注入：单测里不碰真实飞书、不打真实平台。
 */
import { randomBytes } from 'node:crypto';
import type { CreateGroupOpts, CreateGroupResult } from './group-creator.js';
import type { IssueClientResult, PlatformIssue } from '../platform/issue-client.js';
import { buildIssueKickoffCard } from '../im/lark/issue-card.js';
import {
  buildLocalTaskRef,
  clearClaimIntent,
  createBinding,
  findActiveBindingByIssue,
  getBinding,
  recordClaimIntent,
  updateBinding,
  updateClaimIntent,
  type IssueBinding,
  type IssueStatus,
} from './issue-board-store.js';
import { projectStatus } from './issue-status-writer.js';

/**
 * 群名里带的领取标记。对账时靠它把「平台上有 claim、本地没有 binding」的孤儿群认回来
 * ——本地意图是一条腿，这个标记是另一条腿，少哪条都会留下认不出的群。
 *
 * 只取前 8 位十六进制（32 bit）：群名是给人看的，不该被一串 32 字符的随机数占满；
 * 同时在手可数的候选群里，32 bit 足以唯一定位。
 */
export function claimMarker(claimId: string): string {
  return `#${claimId.slice(0, 8)}`;
}

export function matchesClaimMarker(groupName: string, claimId: string): boolean {
  return groupName.includes(claimMarker(claimId));
}

/** 群名长度上限。与本仓其它建群点一致（command-handler 的 MAX_NAME / FORK_MAX_NAME）。 */
const GROUP_NAME_MAX = 50;

/**
 * 拼领取群名：`<标题> #<claimId 前 8 位>`，**标题被截、标记一定完整**。
 *
 * 不截的话飞书自己会截，而它从尾部截——先吃掉的正是尾部那个 `#claimId` 标记，也就是双通道
 * 反查的一条腿。那条腿断了不会报错：对账时只是"这个群不像是任何一次领取的"，然后被当成
 * 无主群跳过。宁可标题短一点。
 *
 * 标记放尾部而不是挪到前面：群列表里先看到的应该是任务在说什么，一串十六进制不配占开头。
 * 长度自己控住了，位置就不再是风险。
 */
export function claimGroupName(title: string, claimId: string): string {
  const marker = claimMarker(claimId);
  const room = GROUP_NAME_MAX - marker.length - 1; // 1 = 中间那个空格
  const trimmed = title.trim();
  const head = trimmed.length > room ? `${trimmed.slice(0, Math.max(0, room - 1))}…` : trimmed;
  return `${head} ${marker}`;
}

/**
 * 平台上这条 issue 的详情深链。
 *
 * 路由形状来自平台前端：tab 在 hash（`#issues`）、详情在 query（`?issue=<id>`），见
 * platform 仓 `frontend/src/App.tsx` 的 Tabs 与 `IssueBoard.tsx` 的 `openDetail`。
 * 拼不出来（平台地址为空/非法）就返回 undefined，卡片少一个按钮而已，不该因此报错。
 */
export function issueDetailUrl(platformBaseUrl: string, issueId: string): string | undefined {
  const base = (platformBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return undefined;
  try {
    new URL(base);
  } catch {
    return undefined;
  }
  return `${base}/?issue=${encodeURIComponent(issueId)}#issues`;
}

export interface ClaimFlowDeps {
  dataDir: string;
  platformBaseUrl: string;
  claim: (
    issueId: string,
    args: { claimId: string; agent?: string; repoLabel?: string; expectedStateRev: number },
  ) => Promise<IssueClientResult<{ claim: { claimEpoch: number }; issue: PlatformIssue }>>;
  bind: (
    issueId: string,
    args: {
      claimId: string;
      localTaskRef: string;
      expectedStateRev: number;
      localTaskLabel?: string;
      localTaskUrl?: string;
    },
  ) => Promise<IssueClientResult<{ issue: PlatformIssue }>>;
  createGroup: (opts: CreateGroupOpts) => Promise<CreateGroupResult>;
  /**
   * 往新群里发开工播报（[[issue-card]] 的 `buildIssueKickoffCard`）。
   *
   * **best-effort**：失败只记日志，绝不让领取失败——它是给人看的，不是协议的一环。
   * 不传就不播报（单测里默认不传）。
   */
  announce?: (chatId: string, card: string) => Promise<void>;
  /** 播报失败时的旁路（生产接 logger；不注入就静默）。 */
  onAnnounceError?: (reason: string) => void;
  /** in_progress 回写失败时的旁路（同上）。失败不推翻领取，但必须留下痕迹。 */
  onStatusError?: (reason: string) => void;
  /** 发 kickoff（@ 目标 bot）把会话激活。返回 messageId。 */
  activate: (chatId: string, botLarkAppId: string, prompt: string) => Promise<string>;
  /**
   * 激活成功后把平台状态推到 `in_progress`。
   *
   * **必填，不是可选**：平台的 activation lease 只扫 `status=claimed`（5 分钟），不回写
   * in_progress 的话 sweeper 会把任务打成 `needs_attention(claim_activate_timeout)`，而
   * 那个状态**回不去**——平台只放行 `task_blocked` 恢复成 in_progress，超时的只能
   * open/reopened（都清 claim），群里的活就废了。做成可选依赖的话，漏传不会有任何报错，
   * 引信就这么静默装回去了；宁可编译期逼调用方给。
   *
   * 与 fetchIssue 一起构成 [[issue-status-writer]] 的 `StatusWriterDeps`，回写走那边的
   * `projectStatus`——sourceSeq 分配、串行、409 对账、退避只实现一次。
   */
  writeStatus: (
    issueId: string,
    args: {
      claimId: string;
      claimEpoch: number;
      sourceSeq: number;
      status: IssueStatus;
      expectedStateRev: number;
    },
  ) => Promise<IssueClientResult<{ issue: PlatformIssue }>>;
  /** 撞 409 时判断「平台还认不认这个 claim」。见 issue-status-writer。 */
  fetchIssue: (teamId: string, issueId: string) => Promise<PlatformIssue | null>;
  newClaimId?: () => string;
  now?: () => number;
}

export interface ClaimFlowArgs {
  /** `body` 只进开工播报（平台侧允许为空），所以这里放宽成可选。 */
  issue: Pick<PlatformIssue, '_id' | 'title' | 'stateRev' | 'targetRepoLabel'> & { body?: string };
  teamId: string;
  /** 由哪个 bot 承接这个 issue —— 决定 localTaskRef 的 appId 段与 kickoff 目标。 */
  larkAppId: string;
  /**
   * 上送平台 `claim.agent` 的展示名。平台把这个值原样渲染在 issue 详情里，所以必须是**人能
   * 认出来的名字**（`claude-loopy`），不是 `cli_xxx` ——早先直接传 larkAppId，看板上只能看到
   * 一串 appId，谁在干这活完全看不出来。缺省回落到 larkAppId，保证总有值。
   */
  agentLabel?: string;
  /** 建群者（通常是 dashboard 所属的那个 bot）。 */
  creatorLarkAppId: string;
  /** 一并拉进群的其它 bot。 */
  peerLarkAppIds?: string[];
  /** 把人按 union_id 拉进群（open_id 是 app-scoped 的，跨 bot 不通用）。 */
  ownerUnionIds?: string[];
  /**
   * agent 干活的目录。会作为 `bindWorkingDir` 绑到新群上（oncall 绑定），**必须传**——
   * 不传的话人在卡片里选的仓库根本不会生效，会话会起在 bot 的默认目录里，
   * 等于让 agent 在错误的仓库动手，而且没有任何报错。
   */
  workingDir: string;
  kickoffPrompt: string;
}

export type ClaimFlowResult =
  | { ok: true; binding: IssueBinding; chatId: string; kickoffMessageId: string }
  /** 领取本身没成功，本地没有留下任何痕迹，重试是安全的。 */
  | { ok: false; stage: 'claim'; reason: string; alreadyLocal?: IssueBinding }
  /** 已 claim 但群没建成：意图在盘上，对账会接手（释放 claim 或补建）。 */
  | { ok: false; stage: 'group'; reason: string; claimId: string }
  /** 群建好了、binding 也落盘了，但 bind 被平台拒 → binding 置 void，群留给人处理。 */
  | { ok: false; stage: 'bind'; reason: string; binding: IssueBinding; chatId: string }
  /** 前面全成，只差 kickoff。binding 已 bound，重试 activate 即可，不必重建群。 */
  | { ok: false; stage: 'activate'; reason: string; binding: IssueBinding; chatId: string };

export async function claimIssueIntoGroup(
  deps: ClaimFlowDeps,
  args: ClaimFlowArgs,
): Promise<ClaimFlowResult> {
  const newClaimId = deps.newClaimId ?? (() => randomBytes(16).toString('hex'));
  const now = deps.now ?? Date.now;

  // 先查本地：同一个 issue 已经有活跃 binding 就直接拦住。放到 store 里抛也拦得住，
  // 但那是最后一道；在这里挡住可以连平台 claim 都不发，不白占一次代次。
  const existing = findActiveBindingByIssue(deps.dataDir, args.issue._id);
  if (existing) {
    return { ok: false, stage: 'claim', reason: 'already_claimed_locally', alreadyLocal: existing };
  }

  // ── 1. claim ──────────────────────────────────────────────────────────────
  const claimId = newClaimId();
  const claimed = await deps.claim(args.issue._id, {
    claimId,
    agent: args.agentLabel || args.larkAppId,
    ...(args.issue.targetRepoLabel ? { repoLabel: args.issue.targetRepoLabel } : {}),
    expectedStateRev: args.issue.stateRev,
  });
  if (!claimed.ok) return { ok: false, stage: 'claim', reason: claimed.reason };
  const claimEpoch = claimed.value.claim.claimEpoch;
  let stateRev = claimed.value.issue.stateRev;

  // ── 2. 意图落盘（早于任何建群动作）──────────────────────────────────────
  recordClaimIntent(
    deps.dataDir,
    {
      claimId,
      issueId: args.issue._id,
      teamId: args.teamId,
      claimEpoch,
      platformBaseUrl: deps.platformBaseUrl,
      platformStateRev: stateRev,
      larkAppId: args.larkAppId,
      scope: 'chat',
    },
    now(),
  );

  // ── 3~4. 建群（held）+ onChatCreated 里写 binding ────────────────────────
  //
  // 群名带 claimId 标记，与本地意图构成双通道反查。
  // 刻意**不传** kickoffBotLarkAppId/kickoffPrompt：群里没有 bot 被 @ 起来，daemon 不会
  // 创建会话。这是「群已建、binding 未写」那个窗口的兜底——孤儿群里没有 agent 在跑。
  let binding: IssueBinding | null = null;
  let chatId = '';
  let shareLink: string | undefined;
  const groupName = claimGroupName(args.issue.title, claimId);
  const botIds = Array.from(new Set([args.larkAppId, ...(args.peerLarkAppIds ?? [])]));
  try {
    const group = await deps.createGroup({
      creatorLarkAppId: args.creatorLarkAppId,
      larkAppIds: botIds,
      name: groupName,
      bindWorkingDir: args.workingDir,
      ...(args.ownerUnionIds?.length ? { ownerUnionIds: args.ownerUnionIds } : {}),
      onChatCreated: (createdChatId: string) => {
        // 同步钩子：createGroupWithBots 返回前这两次写就已经落盘。后面的邀人/转让/
        // 分享链接都是 best-effort，就算挂住或失败，这个群也已经认得回来了。
        chatId = createdChatId;
        updateClaimIntent(deps.dataDir, claimId, { anchorId: createdChatId, chatId: createdChatId }, now());
        binding = createBinding(
          deps.dataDir,
          {
            anchorId: createdChatId,
            larkAppId: args.larkAppId,
            scope: 'chat',
            issueId: args.issue._id,
            teamId: args.teamId,
            platformBaseUrl: deps.platformBaseUrl,
            claimId,
            claimEpoch,
            chatId: createdChatId,
          },
          now(),
        );
      },
    });
    chatId = group.chatId || chatId;
    shareLink = group.shareLink ?? undefined;
  } catch (e) {
    return { ok: false, stage: 'group', reason: String((e as Error)?.message ?? e), claimId };
  }
  if (!binding || !chatId) {
    return { ok: false, stage: 'group', reason: 'chat_created_but_binding_missing', claimId };
  }
  const bound: IssueBinding = binding;

  // ── 5. bind ───────────────────────────────────────────────────────────────
  // 一并把「这个本地任务长什么样」告诉平台：localTaskRef 是机器标识（`oc_xxx::cli_xxx`），
  // 平台详情页直接渲染它等于给人看一串 ID。群名 + applink 让人一眼认出是哪个群、点一下就能
  // 进去。两个都是纯展示、可缺省（分享链接是 best-effort 拿的，拿不到就只显示群名）。
  const bindRes = await deps.bind(args.issue._id, {
    claimId,
    localTaskRef: buildLocalTaskRef(chatId, args.larkAppId),
    expectedStateRev: stateRev,
    localTaskLabel: groupName,
    ...(shareLink ? { localTaskUrl: shareLink } : {}),
  });
  if (!bindRes.ok) {
    // 平台拒绝 = 这条领取作废（issue 被回收 / 别人领走 / 代次过期）。置 void 而不是删：
    // 群还在，留着记录才知道那个群是哪次失败领取的产物。
    const voided = updateBinding(deps.dataDir, bound.anchorId, { bindState: 'void' }, now()) ?? bound;
    return { ok: false, stage: 'bind', reason: bindRes.reason, binding: voided, chatId };
  }
  stateRev = bindRes.value.issue.stateRev;
  const readyBinding =
    updateBinding(deps.dataDir, bound.anchorId, { bindState: 'bound', platformStateRev: stateRev }, now()) ?? bound;

  // ── 5.5 开工播报 ──────────────────────────────────────────────────────────
  //
  // 放在 activate **之前**：kickoff prompt 是内部投递的，群里看不到；这张卡是人进群后
  // 唯一能看到的「在干什么」。先播报，agent 的输出随后跟上，顺序读起来才对。
  // activate 万一失败，群里至少还留着任务说明，不是一个空群。
  //
  // try/catch 吞掉异常：播报纯展示，不该有能力弄砸一次已经 bind 成功的领取。
  if (deps.announce) {
    try {
      await deps.announce(
        chatId,
        buildIssueKickoffCard({
          title: args.issue.title,
          ...(args.issue.body ? { body: args.issue.body } : {}),
          workingDir: args.workingDir,
          issueId: args.issue._id,
          ...(issueDetailUrl(deps.platformBaseUrl, args.issue._id)
            ? { issueUrl: issueDetailUrl(deps.platformBaseUrl, args.issue._id)! }
            : {}),
        }),
      );
    } catch (e) {
      deps.onAnnounceError?.(String((e as Error)?.message ?? e));
    }
  }

  // ── 6. activate ───────────────────────────────────────────────────────────
  let kickoffMessageId: string;
  try {
    kickoffMessageId = await deps.activate(chatId, args.larkAppId, args.kickoffPrompt);
  } catch (e) {
    // binding 已经是 bound，平台也知道 localTaskRef，重试 activate 即可，别重建群。
    return { ok: false, stage: 'activate', reason: String((e as Error)?.message ?? e), binding: readyBinding, chatId };
  }

  // ── 6.5 投影 in_progress（拆掉平台的 activation lease 引信）──────────────
  //
  // 平台 sweeper 只扫 `status=claimed` 且租约过期的任务；进了 in_progress 就不再按 5 分钟
  // activation lease 回收。必须在 activate 成功后**立刻**推：晚一步 agent 就可能被打成
  // needs_attention(claim_activate_timeout)，而那是条单向门——之后既回不到在跑、也交付不了。
  //
  // 走 projectStatus 而不是自己拼一次发送：那边带 409 对账（bind 到 activate 之间隔着几秒，
  // 期间任何人动一下这条 issue，stateRev 就变了）。发不出去也不推翻领取——binding 已 bound、
  // 行留在发件箱里，[[issue-outbox-pump]] 会接着重投。
  const projected = await projectStatus(deps, readyBinding.anchorId, 'in_progress');
  if (!projected.ok && projected.reason === 'platform') {
    deps.onStatusError?.(projected.detail);
  }
  const finalBinding = getBinding(deps.dataDir, readyBinding.anchorId) ?? readyBinding;

  // ── 7. 意图退休（晚于 binding 落盘）───────────────────────────────────────
  clearClaimIntent(deps.dataDir, claimId);
  return { ok: true, binding: finalBinding, chatId, kickoffMessageId };
}
