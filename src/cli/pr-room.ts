import { resolve } from 'node:path';

import { loadBotConfigs, registerBot } from '../bot-registry.js';
import { argValue, argValues, firstPositional } from './arg-utils.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { validateWorkingDir } from '../core/working-dir.js';
import {
  orchestrateFederatedGroup,
  prepareFederatedGroupReviewers,
  type TeamGroupCreateResult,
} from '../dashboard/federated-group-core.js';
import { buildFederatedRoster, type AggregatedRosterBot } from '../services/federation-roster.js';
import { createGroupWithBots } from '../services/group-creator.js';
import { isInChat } from '../services/groups-store.js';
import { bindOncall } from '../services/oncall-store.js';
import { DEFAULT_TEAM_ID } from '../services/team-store.js';
import { recordTeamGroup } from '../services/team-groups-store.js';
import {
  activateWebhookLifecycleGroup,
  beginWebhookLifecycleSetupRepair,
  beginWebhookLifecycleFiring,
  completeWebhookLifecycleSetupRepair,
  failWebhookLifecycleGroup,
  isWebhookLifecycleSetupRepairCurrent,
  listWebhookLifecycleRecords,
  markWebhookLifecycleIndeterminate,
  resolveWebhookLifecycleGroup,
} from '../services/webhook-lifecycle-store.js';
import {
  listChatBotMembers,
  sendMessage,
  type ChatBotMember,
} from '../im/lark/client.js';

export interface PullRequestRef {
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
  key: string;
}

const VALUE_FLAGS = [
  '--pr',
  '--owner-agent',
  '--reviewer-agent',
  '--reviewer-bot',
  '--author-agent',
  '--author-bot',
  '--team',
  '--team-id',
  '--working-dir',
  '--workdir',
  '--cwd',
  '--name',
  '--chat-id',
];

export function parsePullRequestRef(raw: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PR 地址必须是完整的 http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PR 地址必须使用 http(s)');
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex(part => part === 'pull' || part === 'pulls');
  if (marker !== 2 || !/^\d+$/.test(parts[marker + 1] ?? '')) {
    throw new Error('当前仅支持形如 https://host/owner/repo/pull/123 的 PR 地址');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const number = Number(parts[marker + 1]);
  const host = url.host.toLowerCase();
  const canonical = `${url.protocol}//${url.host}/${owner}/${repo}/pull/${number}`;
  return {
    url: canonical,
    host,
    owner,
    repo,
    number,
    key: `${host}/${owner}/${repo}#${number}`.toLowerCase(),
  };
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function resolveRosterBotRef(
  bots: AggregatedRosterBot[],
  ref: string,
): AggregatedRosterBot {
  const needle = normalized(ref);
  const exactId = bots.find(bot => normalized(bot.larkAppId) === needle);
  if (exactId) return exactId;

  const matches = bots.filter(bot =>
    normalized(bot.name) === needle
    || normalized(bot.cliId) === needle,
  );
  if (matches.length === 0) throw new Error(`未在团队 roster 中找到 agent: ${ref}`);
  if (matches.length > 1) {
    throw new Error(
      `agent 引用不唯一: ${ref}；请改用 larkAppId（候选: ${matches.map(bot => `${bot.name}=${bot.larkAppId}`).join(', ')}）`,
    );
  }
  return matches[0];
}

function uniqueBots(bots: AggregatedRosterBot[]): AggregatedRosterBot[] {
  const seen = new Set<string>();
  return bots.filter(bot => {
    if (seen.has(bot.larkAppId)) return false;
    seen.add(bot.larkAppId);
    return true;
  });
}

export function resolveReviewerMentionOpenIds(
  members: Pick<ChatBotMember, 'larkAppId' | 'openId' | 'name' | 'displayName' | 'mentionable'>[],
  reviewers: Pick<AggregatedRosterBot, 'larkAppId' | 'name'>[],
): { openIds: string[]; missing: string[] } {
  const mentionable = members.filter(member => member.mentionable && member.openId);
  const used = new Set<string>();
  const openIds: string[] = [];
  const missing: string[] = [];

  for (const reviewer of reviewers) {
    const exact = mentionable.filter(member => member.larkAppId === reviewer.larkAppId);
    const name = normalized(reviewer.name);
    const byDisplayName = mentionable.filter(member =>
      normalized(member.displayName) === name || normalized(member.name) === name,
    );
    const candidates = exact.length > 0 ? exact : byDisplayName;
    if (candidates.length !== 1 || used.has(candidates[0].openId)) {
      missing.push(reviewer.name);
      continue;
    }
    used.add(candidates[0].openId);
    openIds.push(candidates[0].openId);
  }

  return { openIds, missing };
}

export function isAmbiguousGroupCreateFailure(status: number, reason: string): boolean {
  return status === 408
    || status === 504
    || reason.startsWith('group_create_indeterminate');
}

function isAmbiguousTransportError(error: any): boolean {
  const code = String(error?.code ?? '').toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_NETWORK'].includes(code)) return true;
  if (error?.name === 'AbortError') return true;
  return /timed?\s*out|timeout|socket hang up|connection reset/i.test(
    String(error?.message ?? error ?? ''),
  );
}

function roomScope(teamId: string): string {
  return `pr-room:${teamId}`;
}

function roomName(pr: PullRequestRef, explicit?: string): string {
  const preferred = explicit?.trim() || `[PR] ${pr.repo}#${pr.number} review`;
  return Array.from(preferred).slice(0, 58).join('');
}

export function buildPrRoomKickoff(
  pr: PullRequestRef,
  reviewerMentions: string[],
): string {
  const mentions = reviewerMentions.join(' ');
  return [
    mentions,
    `PR Review Room 已建立：${pr.url}`,
    'Reviewer agent：先独立检查 diff、测试、风险与可维护性，给出带 file:line 的结论；不要直接改作者分支。',
    'Author agent：接收评论后在项目 worktree 中做最小修改、验证并 push，逐条回复直到 APPROVE / 合并 / 明确废弃。',
    '本群以该 PR 为唯一上下文；合并、关闭或废弃后执行 botmux pr-room finish 结束生命周期，群记录保留。',
  ].filter(Boolean).join('\n');
}

async function createLocalTeamGroup(
  authorAppId: string,
  args: {
    name: string;
    larkAppIds: string[];
    ownerUnionIds?: string[];
    transferOwnerUnionId?: string;
  },
): Promise<TeamGroupCreateResult> {
  const configs = loadBotConfigs();
  const author = configs.find(config => config.larkAppId === authorAppId);
  if (!author || !args.larkAppIds.includes(authorAppId)) {
    return { ok: false, error: 'author_agent_not_local' };
  }
  for (const config of configs) {
    if (args.larkAppIds.includes(config.larkAppId)) registerBot(config);
  }
  try {
    const result = await createGroupWithBots({
      creatorLarkAppId: authorAppId,
      larkAppIds: args.larkAppIds,
      name: args.name,
      ownerUnionIds: args.ownerUnionIds,
      transferOwnerUnionId: args.transferOwnerUnionId,
    });
    return { ...result, shareLink: result.shareLink ?? undefined };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      ok: false,
      error: isAmbiguousTransportError(error)
        ? `group_create_indeterminate:${message}`
        : message,
    };
  }
}

async function sendKickoff(
  authorAppId: string,
  chatId: string,
  reviewers: AggregatedRosterBot[],
  pr: PullRequestRef,
): Promise<{ messageId: string; missing: string[] }> {
  const members = (await listChatBotMembers(authorAppId, chatId))
    .filter(member => member.larkAppId !== authorAppId);
  const resolved = resolveReviewerMentionOpenIds(members, reviewers);
  if (resolved.openIds.length === 0) {
    throw new Error(`reviewer_agent_not_mentionable: ${resolved.missing.join(', ')}`);
  }
  const mentions = resolved.openIds.map(openId => `<at user_id="${openId}"></at>`);
  const messageId = await sendMessage(authorAppId, chatId, buildPrRoomKickoff(pr, mentions), 'text');
  return { messageId, missing: resolved.missing };
}

async function assertSetupRepairCurrent(
  scope: string,
  pr: PullRequestRef,
  lifecycleId: string,
  repairId: string,
  dataDir: string,
): Promise<void> {
  if (!await isWebhookLifecycleSetupRepairCurrent(
    scope,
    pr.key,
    lifecycleId,
    repairId,
    dataDir,
  )) {
    throw new Error('setup repair claim 已失效；已停止外部副作用');
  }
}

async function openPrRoom(args: string[]): Promise<void> {
  const rawPr = firstPositional(args, VALUE_FLAGS) ?? argValue(args, '--pr');
  if (!rawPr) throw new Error('用法: botmux pr-room open <PR_URL> --owner-agent <name|larkAppId>');
  const pr = parsePullRequestRef(rawPr);
  const dataDir = resolveBotmuxDataDir();
  const teamId = argValue(args, '--team', '--team-id') ?? DEFAULT_TEAM_ID;
  const authorRef = argValue(args, '--author-agent', '--author-bot')
    ?? process.env.BOTMUX_LARK_APP_ID?.trim();
  if (!authorRef) {
    throw new Error('无法推断作者 agent；请在 Botmux 会话中运行，或传 --author-agent <name|larkAppId>');
  }
  const reviewerRefs = argValues(args, '--owner-agent', '--reviewer-agent', '--reviewer-bot');
  if (reviewerRefs.length === 0) throw new Error('至少传一个 --owner-agent <name|larkAppId>');

  const roster = buildFederatedRoster(dataDir, teamId);
  const author = resolveRosterBotRef(roster.bots, authorRef);
  if (!author.deployment.local) throw new Error('作者 agent 必须属于当前 Botmux 部署');
  const reviewers = uniqueBots(reviewerRefs.map(ref => resolveRosterBotRef(roster.bots, ref)));
  if (reviewers.some(bot => bot.larkAppId === author.larkAppId)) {
    throw new Error('Owner/reviewer agent 不能与作者 agent 相同');
  }
  const stale = reviewers.filter(bot => bot.deployment.stale);
  if (stale.length > 0) {
    throw new Error(`Owner agent 所在部署已离线: ${stale.map(bot => bot.name).join(', ')}`);
  }
  const selectedBotIds = Array.from(new Set([author.larkAppId, ...reviewers.map(bot => bot.larkAppId)]));

  const workdirRaw = argValue(args, '--working-dir', '--workdir', '--cwd');
  let bindWorkingDir: string | undefined;
  if (workdirRaw) {
    const checked = validateWorkingDir(workdirRaw);
    if (!checked.ok) throw new Error(`--working-dir ${checked.error}`);
    bindWorkingDir = resolve(checked.resolvedPath);
  }

  const scope = roomScope(teamId);
  const begun = await beginWebhookLifecycleFiring(
    scope,
    pr.key,
    dataDir,
    {
      blockResolvedReopen: !args.includes('--reopen'),
      blockIndeterminateRetry: true,
    },
  );
  if (begun.action === 'resolved') {
    throw new Error(`该 PR Room 已结束；如确需重开，请显式传 --reopen（原群 ${begun.record.chatId ?? '-'}）`);
  }
  if (begun.action === 'indeterminate' || begun.action === 'reconcile') {
    throw new Error(
      `上次建群结果不确定，已阻止自动重试以免重复建群；请找到实际群后执行 pr-room adopt（原因: ${begun.record.indeterminateReason ?? 'unknown'}）`,
    );
  }
  if (begun.action === 'reuse' && begun.record.chatId) {
    process.stdout.write(`${begun.record.chatId}\n`);
    if (
      begun.record.setupStatus === 'pending'
      || begun.record.setupStatus === 'repairing'
      || begun.record.setupStatus === 'degraded'
    ) {
      console.error(
        `⚠️  PR Room 已存在但 setup 未完成：${pr.url} → ${begun.record.chatId}`
        + `（${begun.record.setupError ?? begun.record.setupStatus}；执行 botmux pr-room repair）`,
      );
      process.exitCode = 3;
    } else {
      console.error(`✅ PR Room 已存在：${pr.url} → ${begun.record.chatId}`);
    }
    return;
  }
  if (begun.action === 'creating') {
    console.error(`PR Room 正在由另一进程创建：${pr.url}`);
    process.exitCode = 2;
    return;
  }

  const requestId = `pr-room-${begun.record.lifecycleId}`;
  const result = await orchestrateFederatedGroup(dataDir, {
    name: roomName(pr, argValue(args, '--name')),
    larkAppIds: selectedBotIds,
    operatorUnionId: author.owner?.unionId,
    requestId,
    teamId,
  }, {
    createTeamGroup: groupArgs => createLocalTeamGroup(author.larkAppId, groupArgs),
    fetcher: fetch,
  });
  if (result.status !== 200 || !result.body?.ok || typeof result.body.chatId !== 'string') {
    const reason = result.body?.error ?? `group_create_failed_${result.status}`;
    const ambiguous = isAmbiguousGroupCreateFailure(result.status, reason);
    if (ambiguous) {
      await markWebhookLifecycleIndeterminate(
        scope,
        pr.key,
        begun.record.lifecycleId,
        reason,
        dataDir,
      );
    } else {
      await failWebhookLifecycleGroup(scope, pr.key, begun.record.lifecycleId, dataDir);
    }
    throw new Error(
      ambiguous
        ? `${reason}；建群结果可能已提交，已阻止自动重试，请先查找实际群并用 pr-room adopt 接管`
        : reason,
    );
  }

  const chatId = String(result.body.chatId);
  const creator = typeof result.body.creator === 'string' ? result.body.creator : author.larkAppId;
  const ownerIssues = [
    ...(result.body.invalidOwnerUnionIds?.length ? ['owner_not_in_group'] : []),
    ...(result.body.missingOperatorIdentity ? ['author_owner_unbound'] : []),
  ];
  const activated = await activateWebhookLifecycleGroup(
    scope,
    pr.key,
    begun.record.lifecycleId,
    chatId,
    {
      creatorLarkAppId: creator,
      setup: {
        reviewerLarkAppIds: reviewers.map(bot => bot.larkAppId),
        workingDir: bindWorkingDir,
        ownerIssues,
      },
    },
    dataDir,
  );
  if (activated.status === 'stale') {
    console.error(`⚠️  群已创建但生命周期记录被替换，请勿重试建群：${chatId}`);
    process.stdout.write(`${chatId}\n`);
    return;
  }
  if (activated.status === 'pending_resolved') {
    console.error(`⚠️  群已创建，但 PR Room 在建群期间已被结束：${chatId}`);
    process.stdout.write(`${chatId}\n`);
    return;
  }
  const repairId = activated.record?.setupRepairId;
  if (!repairId) throw new Error('PR Room 已激活，但未取得 setup repair claim');

  let degraded = false;
  const degradedReasons: string[] = [];
  let workdirError: string | undefined;
  if (bindWorkingDir) {
    await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
    const bound = await bindOncall(author.larkAppId, chatId, bindWorkingDir);
    if (!bound.ok) {
      degraded = true;
      workdirError = bound.reason;
      degradedReasons.push(`workdir:${bound.reason}`);
    }
  }

  const rejectedReviewerIds = new Set<string>([
    ...(Array.isArray(result.body.invalidBotIds) ? result.body.invalidBotIds : []),
    ...(Array.isArray(result.body.skippedNoOwner) ? result.body.skippedNoOwner : []),
  ]);
  const joinedReviewers = reviewers.filter(bot => !rejectedReviewerIds.has(bot.larkAppId));
  if (joinedReviewers.length !== reviewers.length) {
    degraded = true;
    degradedReasons.push('reviewer_not_in_group');
  }

  await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
  const prepared = await prepareFederatedGroupReviewers(
    dataDir,
    teamId,
    chatId,
    joinedReviewers.map(bot => bot.larkAppId),
    `${requestId}:prepare:${chatId}`,
    fetch,
  );
  const preparedRemote = new Set(prepared.ready);
  const readyReviewers = joinedReviewers.filter(
    bot => bot.deployment.local || preparedRemote.has(bot.larkAppId),
  );
  if (prepared.failed.length > 0) {
    degraded = true;
    degradedReasons.push(`remote_prepare:${prepared.failed.map(failure => failure.error).join(',')}`);
  }

  let kickoffMessageId: string | undefined;
  let kickoffError: string | undefined;
  let unmentionedReviewers: string[] = [];
  if (readyReviewers.length === 0) {
    degraded = true;
    kickoffError = 'no_ready_reviewer_agents';
    degradedReasons.push(kickoffError);
  } else {
    try {
      await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
      const kickoff = await sendKickoff(author.larkAppId, chatId, readyReviewers, pr);
      kickoffMessageId = kickoff.messageId;
      unmentionedReviewers = kickoff.missing;
      if (unmentionedReviewers.length > 0) {
        degraded = true;
        degradedReasons.push(`unmentioned:${unmentionedReviewers.join(',')}`);
      }
    } catch (error: any) {
      degraded = true;
      kickoffError = error?.message ?? String(error);
      degradedReasons.push(`kickoff:${kickoffError}`);
    }
  }

  process.stdout.write(`${chatId}\n`);
  console.error(`✅ PR Room 已创建：${pr.url} → ${chatId}`);
  console.error(`   agents: ${[author, ...joinedReviewers].map(bot => bot.name).join(', ')}`);
  if (bindWorkingDir && !workdirError) console.error(`   workdir: ${bindWorkingDir}`);
  if (workdirError) console.error(`⚠️  作者工作目录绑定失败: ${workdirError}`);
  const rejectedReviewers = reviewers.filter(bot => rejectedReviewerIds.has(bot.larkAppId));
  if (rejectedReviewers.length > 0) {
    console.error(`⚠️  未加入群的 reviewer agent: ${rejectedReviewers.map(bot => bot.name).join(', ')}`);
  }
  for (const failure of prepared.failed) {
    console.error(`⚠️  reviewer 部署未就绪 ${failure.deploymentName}: ${failure.error}`);
  }
  if (kickoffMessageId) console.error(`✅ Owner agent review 已触发：${kickoffMessageId}`);
  if (unmentionedReviewers.length > 0) {
    console.error(`⚠️  以下 Owner agent 未取得可用 @ handle: ${unmentionedReviewers.join(', ')}`);
  }
  if (kickoffError) console.error(`⚠️  群已创建，但触发 Owner agent 失败：${kickoffError}`);
  if (result.body.invalidOwnerUnionIds?.length) {
    degraded = true;
    degradedReasons.push('owner_not_in_group');
    console.error(`⚠️  未能自动拉入的 Owner: ${result.body.invalidOwnerUnionIds.join(', ')}`);
  }
  if (result.body.missingOperatorIdentity) {
    degraded = true;
    degradedReasons.push('author_owner_unbound');
    console.error('⚠️  作者部署尚未绑定人类 Owner，无法自动把作者本人拉入群。');
  }
  const reviewersReady = joinedReviewers.length === reviewers.length
    && readyReviewers.length === reviewers.length
    && prepared.failed.length === 0
    && !!kickoffMessageId
    && unmentionedReviewers.length === 0
    && !kickoffError;
  const completion = await completeWebhookLifecycleSetupRepair(
    scope,
    pr.key,
    begun.record.lifecycleId,
    repairId,
    {
      error: degraded ? degradedReasons.join('; ') : undefined,
      reviewersReady,
      workingDirReady: !bindWorkingDir || !workdirError,
      ownerIssues,
    },
    dataDir,
  );
  if (completion.status === 'stale') {
    console.error('⚠️  setup 结果未写入：repair claim 已被替换或生命周期已结束');
    process.exitCode = 3;
    return;
  }
  if (completion.status === 'pending_resolved') {
    console.error('⚠️  setup 已完成，同时处理了期间收到的 finish 请求；PR Room 已结束。');
    return;
  }
  if (degraded) process.exitCode = 3;
}

async function adoptPrRoom(args: string[]): Promise<void> {
  const rawPr = firstPositional(args, VALUE_FLAGS) ?? argValue(args, '--pr');
  const chatId = argValue(args, '--chat-id');
  if (!rawPr || !chatId) {
    throw new Error('用法: botmux pr-room adopt <PR_URL> --chat-id <oc_xxx> [--owner-agent <name|larkAppId>]');
  }
  const pr = parsePullRequestRef(rawPr);
  const dataDir = resolveBotmuxDataDir();
  const teamId = argValue(args, '--team', '--team-id') ?? DEFAULT_TEAM_ID;
  const authorRef = argValue(args, '--author-agent', '--author-bot')
    ?? process.env.BOTMUX_LARK_APP_ID?.trim();
  if (!authorRef) {
    throw new Error('无法推断接管 agent；请在 Botmux 会话中运行，或传 --author-agent <name|larkAppId>');
  }
  const roster = buildFederatedRoster(dataDir, teamId);
  const author = resolveRosterBotRef(roster.bots, authorRef);
  if (!author.deployment.local) throw new Error('接管 agent 必须属于当前 Botmux 部署');
  const reviewerRefs = argValues(args, '--owner-agent', '--reviewer-agent', '--reviewer-bot');
  const reviewers = uniqueBots(reviewerRefs.map(ref => resolveRosterBotRef(roster.bots, ref)));
  if (reviewers.some(bot => bot.larkAppId === author.larkAppId)) {
    throw new Error('Owner/reviewer agent 不能与作者 agent 相同');
  }
  const stale = reviewers.filter(bot => bot.deployment.stale);
  if (stale.length > 0) {
    throw new Error(`Owner agent 所在部署已离线: ${stale.map(bot => bot.name).join(', ')}`);
  }
  const workdirRaw = argValue(args, '--working-dir', '--workdir', '--cwd');
  let bindWorkingDir: string | undefined;
  if (workdirRaw) {
    const checked = validateWorkingDir(workdirRaw);
    if (!checked.ok) throw new Error(`--working-dir ${checked.error}`);
    bindWorkingDir = resolve(checked.resolvedPath);
  }
  const configs = loadBotConfigs();
  const authorConfig = configs.find(config => config.larkAppId === author.larkAppId);
  if (!authorConfig) throw new Error('接管 agent 的本地 bot 配置不存在');
  const localParticipantIds = new Set([
    author.larkAppId,
    ...reviewers.filter(bot => bot.deployment.local).map(bot => bot.larkAppId),
  ]);
  for (const config of configs) {
    if (localParticipantIds.has(config.larkAppId)) registerBot(config);
  }
  if (!await isInChat(author.larkAppId, chatId)) {
    throw new Error(`接管 agent 不在群中，或 chatId 不可访问: ${chatId}`);
  }

  if (reviewers.length > 0) {
    const members = (await listChatBotMembers(author.larkAppId, chatId))
      .filter(member => member.larkAppId !== author.larkAppId);
    const resolved = resolveReviewerMentionOpenIds(members, reviewers);
    if (resolved.missing.length > 0) {
      throw new Error(`reviewer agent 不在群中、不可 @ 或名称不唯一: ${resolved.missing.join(', ')}`);
    }
  }

  const scope = roomScope(teamId);
  const begun = await beginWebhookLifecycleFiring(
    scope,
    pr.key,
    dataDir,
    {
      blockResolvedReopen: !args.includes('--reopen'),
      adoptIndeterminate: true,
    },
  );
  if (begun.action === 'resolved') {
    throw new Error(`该 PR Room 已结束；如确需重开，请显式传 --reopen（原群 ${begun.record.chatId ?? '-'}）`);
  }
  if (begun.action === 'reuse' && begun.record.chatId !== chatId) {
    throw new Error(`该 PR 已绑定其他群 ${begun.record.chatId}；拒绝覆盖为 ${chatId}`);
  }
  if (begun.action === 'reuse') {
    process.stdout.write(`${chatId}\n`);
    if (
      begun.record.setupStatus === 'pending'
      || begun.record.setupStatus === 'repairing'
      || begun.record.setupStatus === 'degraded'
    ) {
      console.error(
        `⚠️  PR Room 已接管但 setup 未完成：${pr.url} → ${chatId}`
        + `（${begun.record.setupError ?? begun.record.setupStatus}；执行 botmux pr-room repair）`,
      );
      process.exitCode = 3;
    } else {
      console.error(`✅ PR Room 已接管：${pr.url} → ${chatId}`);
    }
    return;
  }
  if (begun.action === 'creating') {
    console.error(`PR Room 正在由另一进程创建或接管：${pr.url}`);
    process.exitCode = 2;
    return;
  }
  if (begun.action === 'indeterminate') {
    throw new Error('PR Room 处于结果不确定状态，当前接管未能取得 reconcile 权限');
  }

  const activated = await activateWebhookLifecycleGroup(
    scope,
    pr.key,
    begun.record.lifecycleId,
    chatId,
    {
      creatorLarkAppId: author.larkAppId,
      setup: {
        reviewerLarkAppIds: reviewers.map(bot => bot.larkAppId),
        workingDir: bindWorkingDir,
        ownerIssues: [],
      },
    },
    dataDir,
  );
  if (activated.status === 'stale') throw new Error('PR Room 生命周期记录在接管期间被替换');
  if (activated.status === 'pending_resolved') {
    process.stdout.write(`${chatId}\n`);
    console.error(`⚠️  群已接管，但 PR Room 在接管期间已被结束：${chatId}`);
    return;
  }
  const repairId = activated.record?.setupRepairId;
  if (!repairId) throw new Error('PR Room 已接管，但未取得 setup repair claim');

  const setupErrors: string[] = [];
  let workingDirReady = !bindWorkingDir;
  if (bindWorkingDir) {
    try {
      await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
      const bound = await bindOncall(author.larkAppId, chatId, bindWorkingDir);
      if (!bound.ok) throw new Error(bound.reason);
      workingDirReady = true;
    } catch (error: any) {
      setupErrors.push(`workdir:${error?.message ?? String(error)}`);
      console.error(`⚠️  作者工作目录绑定失败：${error?.message ?? String(error)}`);
    }
  }

  let reviewersReady = reviewers.length === 0;
  if (reviewers.length > 0) {
    try {
      await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
      recordTeamGroup(dataDir, teamId, chatId);
      const prepared = await prepareFederatedGroupReviewers(
        dataDir,
        teamId,
        chatId,
        reviewers.map(bot => bot.larkAppId),
        `pr-room-adopt:${begun.record.lifecycleId}:${chatId}`,
        fetch,
      );
      if (prepared.failed.length > 0) {
        throw new Error(
          `远端 reviewer 部署未就绪: ${prepared.failed.map(failure => `${failure.deploymentName}(${failure.error})`).join(', ')}`,
        );
      }
      await assertSetupRepairCurrent(scope, pr, begun.record.lifecycleId, repairId, dataDir);
      const kickoff = await sendKickoff(
        author.larkAppId,
        chatId,
        reviewers,
        pr,
      );
      console.error(`✅ Owner agent review 已触发：${kickoff.messageId}`);
      if (kickoff.missing.length > 0) {
        throw new Error(`以下 Owner agent 未取得可用 @ handle: ${kickoff.missing.join(', ')}`);
      }
      reviewersReady = true;
    } catch (error: any) {
      setupErrors.push(`reviewer:${error?.message ?? String(error)}`);
      console.error(`⚠️  群已接管，但触发 Owner agent 失败：${error?.message ?? String(error)}`);
    }
  }

  const completion = await completeWebhookLifecycleSetupRepair(
    scope,
    pr.key,
    begun.record.lifecycleId,
    repairId,
    {
      error: setupErrors.length > 0 ? setupErrors.join('; ') : undefined,
      reviewersReady,
      workingDirReady,
      ownerIssues: [],
    },
    dataDir,
  );
  process.stdout.write(`${chatId}\n`);
  console.error(`✅ PR Room 已接管：${pr.url} → ${chatId}`);
  if (bindWorkingDir) console.error(`   workdir: ${bindWorkingDir}`);
  if (completion.status === 'stale') {
    console.error('⚠️  setup 结果未写入：repair claim 已被替换或生命周期已结束');
    process.exitCode = 3;
    return;
  }
  if (completion.status === 'pending_resolved') {
    console.error('⚠️  setup 已完成，同时处理了期间收到的 finish 请求；PR Room 已结束。');
    return;
  }
  if (setupErrors.length > 0) process.exitCode = 3;
}

async function repairPrRoom(args: string[]): Promise<void> {
  const rawPr = firstPositional(args, VALUE_FLAGS) ?? argValue(args, '--pr');
  if (!rawPr) {
    throw new Error('用法: botmux pr-room repair <PR_URL> [--owner-agent <name|larkAppId>] [--working-dir <path>]');
  }
  const pr = parsePullRequestRef(rawPr);
  const dataDir = resolveBotmuxDataDir();
  const teamId = argValue(args, '--team', '--team-id') ?? DEFAULT_TEAM_ID;
  const scope = roomScope(teamId);
  const snapshot = listWebhookLifecycleRecords({ connectorId: scope }, dataDir)
    .find(record => record.dedupKey === pr.key);
  if (!snapshot || snapshot.status !== 'active' || !snapshot.chatId) {
    throw new Error('未找到可修复的 active PR Room；结果不确定时先用 adopt，已结束时用 open --reopen');
  }

  const authorRef = argValue(args, '--author-agent', '--author-bot')
    ?? snapshot.creatorLarkAppId
    ?? process.env.BOTMUX_LARK_APP_ID?.trim();
  if (!authorRef) throw new Error('无法推断作者 agent；请传 --author-agent <name|larkAppId>');
  const roster = buildFederatedRoster(dataDir, teamId);
  const author = resolveRosterBotRef(roster.bots, authorRef);
  if (!author.deployment.local) throw new Error('作者 agent 必须属于当前 Botmux 部署');
  const reviewerRefs = argValues(args, '--owner-agent', '--reviewer-agent', '--reviewer-bot');
  const reviewerOverride = reviewerRefs.length > 0
    ? uniqueBots(reviewerRefs.map(ref => resolveRosterBotRef(roster.bots, ref)))
    : undefined;
  if (reviewerOverride?.some(bot => bot.larkAppId === author.larkAppId)) {
    throw new Error('Owner/reviewer agent 不能与作者 agent 相同');
  }
  const workdirRaw = argValue(args, '--working-dir', '--workdir', '--cwd');
  let workingDirOverride: string | undefined;
  if (workdirRaw) {
    const checked = validateWorkingDir(workdirRaw);
    if (!checked.ok) throw new Error(`--working-dir ${checked.error}`);
    workingDirOverride = resolve(checked.resolvedPath);
  }

  const claimed = await beginWebhookLifecycleSetupRepair(
    scope,
    pr.key,
    {
      reviewerLarkAppIds: reviewerOverride?.map(bot => bot.larkAppId),
      workingDir: workingDirOverride,
      acknowledgeOwnerIssues: args.includes('--ack-owner-present'),
    },
    dataDir,
  );
  if (claimed.action === 'inactive') {
    throw new Error('PR Room 在 repair 领取期间已结束');
  }
  if (claimed.action === 'busy') {
    console.error('PR Room setup 正在由另一进程执行；未重复发送 kickoff。');
    process.exitCode = 2;
    return;
  }
  if (claimed.action === 'ready') {
    process.stdout.write(`${claimed.record?.chatId ?? snapshot.chatId}\n`);
    console.error(`✅ PR Room setup 已就绪：${pr.url}`);
    return;
  }
  const room = claimed.record;
  const repairId = claimed.repairId;
  let reviewersReady = room.setupReviewersReady ?? false;
  let workingDirReady = room.setupWorkingDirReady ?? false;

  try {
    const chatId = room.chatId;
    if (!chatId) throw new Error('active PR Room 缺少 chatId');
    if (room.setupIntentVersion !== 1) {
      throw new Error(
        'legacy setup 缺少结构化意图；请显式传 --owner-agent、--working-dir 或 --ack-owner-present 后重试',
      );
    }
    if (!room.setupReviewersReady && !(room.setupReviewerLarkAppIds?.length)) {
      throw new Error('setup 仍需 reviewer，但未记录 reviewer；请显式传 --owner-agent');
    }
    if (!room.setupWorkingDirReady && !room.setupWorkingDir) {
      throw new Error('setup 仍需 workdir，但未记录路径；请显式传 --working-dir');
    }

    const reviewers = room.setupReviewersReady
      ? []
      : uniqueBots((room.setupReviewerLarkAppIds ?? [])
        .map(ref => resolveRosterBotRef(roster.bots, ref)));
    if (reviewers.some(bot => bot.larkAppId === author.larkAppId)) {
      throw new Error('Owner/reviewer agent 不能与作者 agent 相同');
    }
    const stale = reviewers.filter(bot => bot.deployment.stale);
    if (stale.length > 0) {
      throw new Error(`Owner agent 所在部署已离线: ${stale.map(bot => bot.name).join(', ')}`);
    }

    const configs = loadBotConfigs();
    const localParticipantIds = new Set([
      author.larkAppId,
      ...reviewers.filter(bot => bot.deployment.local).map(bot => bot.larkAppId),
    ]);
    for (const config of configs) {
      if (localParticipantIds.has(config.larkAppId)) registerBot(config);
    }
    if (!await isInChat(author.larkAppId, chatId)) {
      throw new Error(`作者 agent 不在群中，或 chatId 不可访问: ${chatId}`);
    }

    if (!room.setupWorkingDirReady && room.setupWorkingDir) {
      await assertSetupRepairCurrent(scope, pr, room.lifecycleId, repairId, dataDir);
      const bound = await bindOncall(author.larkAppId, chatId, room.setupWorkingDir);
      if (!bound.ok) throw new Error(`作者工作目录绑定失败: ${bound.reason}`);
      workingDirReady = true;
    }

    if (reviewers.length > 0) {
      const members = (await listChatBotMembers(author.larkAppId, chatId))
        .filter(member => member.larkAppId !== author.larkAppId);
      const mentionable = resolveReviewerMentionOpenIds(members, reviewers);
      if (mentionable.missing.length > 0) {
        throw new Error(`reviewer agent 不在群中、不可 @ 或名称不唯一: ${mentionable.missing.join(', ')}`);
      }
      await assertSetupRepairCurrent(scope, pr, room.lifecycleId, repairId, dataDir);
      recordTeamGroup(dataDir, teamId, chatId);
      const prepared = await prepareFederatedGroupReviewers(
        dataDir,
        teamId,
        chatId,
        reviewers.map(bot => bot.larkAppId),
        `pr-room-repair:${room.lifecycleId}:${chatId}`,
        fetch,
      );
      if (prepared.failed.length > 0) {
        throw new Error(
          `远端 reviewer 部署未就绪: ${prepared.failed.map(failure => `${failure.deploymentName}(${failure.error})`).join(', ')}`,
        );
      }
      await assertSetupRepairCurrent(scope, pr, room.lifecycleId, repairId, dataDir);
      const kickoff = await sendKickoff(author.larkAppId, chatId, reviewers, pr);
      if (kickoff.missing.length > 0) {
        throw new Error(`以下 reviewer 未取得可用 @ handle: ${kickoff.missing.join(', ')}`);
      }
      reviewersReady = true;
      console.error(`✅ Owner agent review 已重新触发：${kickoff.messageId}`);
    }

    const ownerIssues = room.setupOwnerIssues ?? [];
    const completion = await completeWebhookLifecycleSetupRepair(
      scope,
      pr.key,
      room.lifecycleId,
      repairId,
      {
        error: ownerIssues.length > 0 ? ownerIssues.join('; ') : undefined,
        reviewersReady,
        workingDirReady,
        ownerIssues,
      },
      dataDir,
    );
    if (completion.status === 'stale') {
      throw new Error('setup repair claim 已被替换或生命周期已结束');
    }
    process.stdout.write(`${chatId}\n`);
    if (completion.status === 'pending_resolved') {
      console.error('⚠️  setup 已完成，同时处理了期间收到的 finish 请求；PR Room 已结束。');
      return;
    }
    if (completion.record?.setupStatus === 'degraded') {
      console.error(
        `⚠️  agent setup 已修复，但人类 Owner 问题仍需处理：${ownerIssues.join('; ')}`
        + '（确认 Owner 已在群中后传 --ack-owner-present）',
      );
      process.exitCode = 3;
      return;
    }
    console.error(`✅ PR Room setup 已修复：${pr.url} → ${chatId}`);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const category = /工作目录|working-dir|workdir/.test(message)
      ? 'workdir'
      : (/reviewer|Owner agent|远端/.test(message) ? 'reviewer' : 'repair');
    await completeWebhookLifecycleSetupRepair(
      scope,
      pr.key,
      room.lifecycleId,
      repairId,
      {
        error: `${category}:${message}`,
        reviewersReady,
        workingDirReady,
      },
      dataDir,
    );
    throw error;
  }
}

async function finishPrRoom(args: string[]): Promise<void> {
  const rawPr = firstPositional(args, VALUE_FLAGS) ?? argValue(args, '--pr');
  if (!rawPr) throw new Error('用法: botmux pr-room finish <PR_URL> [--team <teamId>]');
  const pr = parsePullRequestRef(rawPr);
  const dataDir = resolveBotmuxDataDir();
  const teamId = argValue(args, '--team', '--team-id') ?? DEFAULT_TEAM_ID;
  const result = await resolveWebhookLifecycleGroup(roomScope(teamId), pr.key, dataDir);
  if (result.action === 'noop') {
    console.error(`未找到活跃 PR Room：${pr.url}`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${result.record?.chatId ?? ''}\n`);
  if (result.action === 'pending') {
    console.error(`⏳ PR Room 已请求结束；当前 setup 完成后会原子进入 ended：${pr.url}`);
  } else {
    console.error(`✅ PR Room 生命周期已结束（群记录保留）：${pr.url}`);
  }
}

function listPrRooms(args: string[]): void {
  const dataDir = resolveBotmuxDataDir();
  const teamId = argValue(args, '--team', '--team-id') ?? DEFAULT_TEAM_ID;
  const scope = roomScope(teamId);
  const rooms = listWebhookLifecycleRecords({ connectorId: scope }, dataDir);
  if (rooms.length === 0) {
    console.log('暂无 PR Room。');
    return;
  }
  for (const room of rooms) {
    console.log(
      `${room.status.padEnd(8)} ${(room.setupStatus ?? '-').padEnd(8)} ${room.dedupKey}  ${room.chatId ?? '-'}`,
    );
  }
}

function help(): void {
  console.log(`
botmux pr-room — 为一个 PR 建立作者/Owner agent 协作群

用法:
  botmux pr-room open <PR_URL> --owner-agent <name|larkAppId> [--owner-agent ...]
      [--author-agent <name|larkAppId>] [--team <teamId>]
      [--working-dir <path>] [--name <群名>] [--reopen]
  botmux pr-room adopt <PR_URL> --chat-id <oc_xxx> [--owner-agent <name|larkAppId>]
      [--working-dir <path>] [--reopen]
  botmux pr-room repair <PR_URL> [--owner-agent <name|larkAppId>]
      [--working-dir <path>] [--ack-owner-present]
  botmux pr-room finish <PR_URL> [--team <teamId>]
  botmux pr-room list [--team <teamId>]

行为:
  - PR URL 是幂等键：同一个 team 内重复 open 复用原群，不重复拉群。
  - 作者 agent 默认取 BOTMUX_LARK_APP_ID；Owner agent 必须显式选择，避免同一 Owner
    有多个 agent 时误拉错机器人。
  - 复用团队联邦拉群，把所选 agent 及各自已绑定 Owner 拉进群。
  - 远端部署确认 reviewer 已入群并写入团队信任后，才自动 @ 它发起 code review。
  - Owner 已先建群时，用 adopt 绑定现有群，避免创建重复群。
  - setup 降级时用 repair 重做未完成的 workdir、远端信任与 kickoff；不会重新建群。
  - reviewer/workdir 意图会持久化；人类 Owner 已手动入群后用 --ack-owner-present 确认。
  - repair 使用原子 claim；并发 repair 不会重复发送 kickoff，finish 会等待当前 setup 收口。
  - 已结束的 PR Room 默认不能覆盖；确需重开时显式传 --reopen。
  - finish 只标记生命周期结束，保留群与审查记录，不自动解散。
`);
}

export async function cmdPrRoom(subcommand: string, args: string[]): Promise<void> {
  try {
    process.env.SESSION_DATA_DIR ??= resolveBotmuxDataDir();
    if (subcommand === 'open') await openPrRoom(args);
    else if (subcommand === 'adopt') await adoptPrRoom(args);
    else if (subcommand === 'repair' || subcommand === 'retry') await repairPrRoom(args);
    else if (subcommand === 'finish' || subcommand === 'close' || subcommand === 'abandon') await finishPrRoom(args);
    else if (subcommand === 'list' || subcommand === 'status') listPrRooms(args);
    else help();
  } catch (error: any) {
    console.error(`botmux pr-room: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
