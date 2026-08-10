/**
 * 把 [[issue-command]] 声明的依赖接到真实实现上。
 *
 * 单独一个文件是为了让 issue-command 保持可测：那边只认接口，真实的平台客户端、建群服务、
 * bot 注册表都在这里装配。card-handler 与 command-handler 都从这里取。
 */
import { config } from '../../config.js';
import { effectiveBotDisplayName, getBot } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';
import { readPlatformBinding } from '../../platform/binding.js';
import {
  bindIssue,
  claimIssue,
  fetchIssues,
  fetchTeams,
  findIssueById,
  writeIssueStatus,
} from '../../platform/issue-client.js';
import { claimIssueIntoGroup, issueDetailUrl } from '../../services/issue-claim-flow.js';
import { completeIssue, releaseIssue } from '../../services/issue-release.js';
import { describeIssue } from '../../services/issue-status-view.js';
import { createGroupWithBots } from '../../services/group-creator.js';
import { buildIssueStatusCard } from './issue-card.js';
import { sendMessage } from './client.js';
import type { IssueCommandDeps, TerminalResult } from './issue-command.js';

/**
 * kickoff 正文。写给 agent 看，所以要把它开工需要的一切都说全：干什么、在哪干、
 * 做完怎么交付。
 *
 * 最后那句 `botmux report` 不是客套：它是**本机唯一**会把 issue 推到 in_review 的信号
 * （见 [[issue-status-projector]] 的计划）。不写进 kickoff，agent 干完了平台也不知道。
 */
export function buildKickoffPrompt(args: {
  title: string;
  body?: string;
  workingDir: string;
  issueId: string;
}): string {
  return [
    `请接手这个任务：**${args.title}**`,
    '',
    args.body?.trim() ? args.body.trim() : '_（这条任务没有填写详细描述）_',
    '',
    `工作目录：\`${args.workingDir}\``,
    `平台任务 ID：\`${args.issueId}\``,
    '',
    '完成后执行 `botmux report` 交付，我会据此把任务状态推到「待验收」。',
  ].join('\n');
}

/**
 * 激活会话（把 held 群变成真的在跑的会话）。
 *
 * ⚠️ **不能用「让 worker bot 在群里 @ 自己」实现**——飞书不会把一个应用自己发的消息推回给
 * 它自己（见 event-dispatcher 里那段注释：无 receive-all scope 的应用收不到自己发的消息），
 * 所以那条 @ 永远不会变成一次 daemon 事件。`createGroupWithBots` 的 kickoff 能work，是因为它
 * 由**另一个** bot 代发（它显式拒绝 `creator_cannot_kickoff_self`）。
 *
 * 而我们这里 creator 与 worker 是同一个 bot（「你 @ 谁谁就接手」），所以代发那条路也走不通。
 *
 * 正解是**根本不发消息**：botmux 自己就是 daemon，直接内部建会话即可——`autoStartOnGroupJoin`
 * 走的就是这条路（daemon.ts `handleBotAdded`），全程没有任何 @。这也跟 held 模型天然契合：
 * 群先建好、什么都不跑，等我们决定激活时再起会话。
 *
 * 该入口目前还没有从 daemon 暴露出来，所以这里由调用方注入。没注入时领取会**干净地停在
 * activate 阶段**——按 issue-claim-flow 的约定，此时 binding 已 bound、群已就绪，补一次
 * 激活即可，不必重领。宁可这样，也不要塞一个「看起来发出去了其实永远不触发」的实现。
 */
export type ActivateSession = (args: {
  chatId: string;
  larkAppId: string;
  prompt: string;
  workingDir: string;
}) => Promise<string>;

/**
 * daemon 在启动时把内部建会话入口注册进来。
 *
 * 用模块级注册而不是让 card-handler 直接 import daemon：daemon 是顶层编排，反向依赖它
 * 会成环。注册前领取会干净地停在 activate 阶段（见 ActivateSession 的注释）。
 */
let registeredActivate: ActivateSession | undefined;

export function setIssueActivate(fn: ActivateSession): void {
  registeredActivate = fn;
}

export function buildIssueCommandDeps(activate: ActivateSession | undefined = registeredActivate): IssueCommandDeps {
  return {
    fetchTeams: () => fetchTeams() as any,
    fetchIssues: (teamId: string) => fetchIssues(teamId) as any,

    allowedUsers: (larkAppId: string) => {
      try {
        return getBot(larkAppId).resolvedAllowedUsers ?? [];
      } catch {
        // bot 不在注册表里就当没有管理员——权限门 fail-closed，拒绝好过放行。
        return [];
      }
    },

    workingDirs: (larkAppId: string) => {
      try {
        const cfg = getBot(larkAppId).config;
        return [
          ...(cfg.workingDir ? [cfg.workingDir] : []),
          ...(cfg.workingDirs ?? []),
        ];
      } catch {
        return [];
      }
    },

    runClaim: async ({ issue, teamId, larkAppId, workingDir, invokerOpenId }) => {
      const binding = readPlatformBinding();
      if (!binding) return { ok: false, stage: 'claim', reason: 'unbound' };

      // 建群拿到的 chatId 之后要用来发 kickoff，先接住。
      let shareLink: string | undefined;
      let chatName = '';
      // bot 不在注册表里就回落到 appId——展示名拿不到不该让领取失败。
      let agentLabel: string | undefined;
      try {
        agentLabel = effectiveBotDisplayName(getBot(larkAppId));
      } catch {
        agentLabel = undefined;
      }

      const r = await claimIssueIntoGroup(
        {
          dataDir: config.session.dataDir,
          platformBaseUrl: binding.platformUrl,
          claim: (issueId, args) => claimIssue(issueId, args) as any,
          bind: (issueId, args) => bindIssue(issueId, args) as any,
          createGroup: async (opts) => {
            const res = await createGroupWithBots({
              ...opts,
              // 领取人要在群里，否则建出来的群他自己进不去。用 open_id 而不是 union_id：
              // 这里的 invoker 来自同一个 bot 的卡片回调，本来就是 app-scoped 的。
              userOpenIds: [invokerOpenId],
            });
            chatName = opts.name ?? '';
            shareLink = res.shareLink ?? undefined;
            return res;
          },
          announce: async (chatId, card) => {
            await sendMessage(larkAppId, chatId, card, 'interactive');
          },
          onAnnounceError: (reason) => logger.warn(`[issue] 开工播报失败（不影响领取）：${reason}`),
          activate: async (chatId, botLarkAppId, prompt) => {
            if (!activate) throw new Error('activate_not_wired');
            return activate({ chatId, larkAppId: botLarkAppId, prompt, workingDir });
          },
          writeStatus: (issueId, args) => writeIssueStatus(issueId, args) as any,
          fetchIssue: (teamId, issueId) => findIssueById(teamId, issueId),
          onStatusError: (reason) =>
            logger.warn(`[issue] in_progress 回写失败（领取仍成功，pump 会重投）：${reason}`),
        },
        {
          issue,
          teamId,
          larkAppId,
          creatorLarkAppId: larkAppId,
          ownerUnionIds: [],
          workingDir,
          // 平台详情页直接渲染这个值，给它人能认的名字而不是 appId。
          ...(agentLabel ? { agentLabel } : {}),
          kickoffPrompt: buildKickoffPrompt({
            title: issue.title,
            ...(issue.body ? { body: issue.body } : {}),
            workingDir,
            issueId: issue._id,
          }),
        },
      );

      if (r.ok) {
        logger.info(`[issue] 领取完成 issue=${issue._id} chat=${r.chatId} dir=${workingDir}`);
        return {
          ok: true,
          chatId: r.chatId,
          chatName: chatName || r.chatId,
          ...(shareLink ? { shareLink } : {}),
        };
      }
      return { ok: false, stage: r.stage, reason: r.reason };
    },

    runRelease: (anchorId: string) => settle(releaseIssue, anchorId),
    runDone: (anchorId: string) => settle(completeIssue, anchorId),

    runStatus: async (anchorId: string) => {
      const r = await describeIssue(
        { dataDir: config.session.dataDir, fetchIssue: (teamId, issueId) => findIssueById(teamId, issueId) },
        anchorId,
      );
      if (!r.ok) return { ok: false, reason: r.reason };
      const { binding, issue, pendingWrites, failedWrites, lastFailure, claimMine } = r.view;
      const url = issueDetailUrl(binding.platformBaseUrl, binding.issueId);
      return {
        ok: true,
        card: buildIssueStatusCard({
          issueId: binding.issueId,
          bindState: binding.bindState,
          pendingWrites,
          ...(failedWrites > 0 ? { failedWrites } : {}),
          ...(lastFailure ? { lastFailure } : {}),
          ...(binding.lastSyncedStatus ? { lastSyncedStatus: binding.lastSyncedStatus } : {}),
          ...(claimMine !== undefined ? { claimMine } : {}),
          ...(issue
            ? {
                platform: {
                  title: issue.title,
                  status: issue.status,
                  ...(issue.attentionReason ? { attentionReason: issue.attentionReason } : {}),
                  ...(issue.claim?.agent ? { claimAgent: issue.claim.agent } : {}),
                  ...(issue.claim?.localTaskLabel ? { claimLabel: issue.claim.localTaskLabel } : {}),
                },
              }
            : {}),
          ...(url ? { issueUrl: url } : {}),
        }),
      };
    },
  };
}

/** 释放与验收完成只差目标态，出参形状一致，装配也就共用一份。 */
async function settle(
  run: typeof releaseIssue,
  anchorId: string,
): Promise<TerminalResult> {
  const r = await run(
    {
      dataDir: config.session.dataDir,
      writeStatus: (issueId, args) => writeIssueStatus(issueId, args) as any,
      fetchIssue: (teamId, issueId) => findIssueById(teamId, issueId),
    },
    anchorId,
  );
  if (r.ok) {
    return { ok: true, issueId: r.issueId, alreadyReleasedOnPlatform: r.alreadyReleasedOnPlatform };
  }
  return {
    ok: false,
    reason: r.reason,
    ...(r.reason === 'platform' ? { detail: r.detail, ...(r.permanent ? { permanent: true } : {}) } : {}),
    // 终态是哪一种决定了给人的说法（作废 / 已释放 / 已完成）。
    ...(r.reason === 'already_released' ? { bindState: r.binding.bindState } : {}),
  };
}
