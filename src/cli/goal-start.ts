export interface GoalStartBot {
  larkAppId: string;
  name: string;
  cliId?: string;
  openId?: string;
  unionId?: string;
  botmuxVersion?: string;
  a2aCapabilities?: string[];
  local: boolean;
}

export interface GoalStartTeam {
  teamId: string;
  teamName: string;
  bots: GoalStartBot[];
  memberUnionIds?: string[];
}

export interface GoalStartSelection {
  supervisor: GoalStartBot;
  workers: GoalStartBot[];
  team?: GoalStartTeam;
}

export type GoalStartSelectionResult =
  | { ok: true; value: GoalStartSelection; warnings: string[] }
  | { ok: false; error: string };

export function resolveGoalStartInvitee(input: {
  lastCallerOpenId?: string;
  ownerOpenId?: string;
  ownerUnionId?: string;
  deploymentOwnerUnionId?: string;
  callerIsBot?: boolean;
}): { openId?: string; unionId?: string } {
  const openId = input.callerIsBot
    ? undefined
    : (input.lastCallerOpenId?.trim() || input.ownerOpenId?.trim() || undefined);
  if (openId) return { openId };
  const unionId = input.ownerUnionId?.trim() || input.deploymentOwnerUnionId?.trim() || undefined;
  return unionId ? { unionId } : {};
}

export function buildGoalStartRetryCommand(input: {
  chatId: string;
  title: string;
  teamId?: string;
  workers: Array<{ name: string; larkAppId?: string }>;
  project?: string;
  brief?: string;
  sessionId: string;
  skipReadinessCheck?: boolean;
}): string {
  const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const args = [
    'botmux goal start',
    '--chat-id', shellQuote(input.chatId),
    '--title', shellQuote(input.title),
    ...(input.teamId ? ['--team', shellQuote(input.teamId)] : []),
    ...input.workers.flatMap((worker) => ['--worker', shellQuote(worker.larkAppId ?? worker.name)]),
    ...(input.project ? ['--project', shellQuote(input.project)] : []),
    ...(input.brief ? ['--brief', shellQuote(input.brief)] : []),
    ...(input.skipReadinessCheck ? ['--skip-readiness-check'] : []),
    '--session-id', shellQuote(input.sessionId),
  ];
  return args.join(' ');
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function resolveUniqueBot(ref: string, bots: GoalStartBot[]): { bot?: GoalStartBot; error?: string } {
  const value = ref.trim();
  if (!value) return { error: '执行者名称不能为空' };

  const exact = bots.filter((bot) => bot.larkAppId === value);
  if (exact.length === 1) return { bot: exact[0] };

  const key = normalized(value);
  const byName = bots.filter((bot) => normalized(bot.name) === key);
  if (byName.length === 1) return { bot: byName[0] };
  if (byName.length > 1) return { error: `机器人名称“${value}”不唯一，请改用 app_id` };

  const byCli = bots.filter((bot) => normalized(bot.cliId) === key);
  if (byCli.length === 1) return { bot: byCli[0] };
  if (byCli.length > 1) return { error: `CLI 名称“${value}”不唯一，请改用 app_id` };
  return { error: `找不到机器人“${value}”` };
}

function resolveWorkers(refs: string[], bots: GoalStartBot[]): { workers?: GoalStartBot[]; error?: string } {
  const workers: GoalStartBot[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const resolved = resolveUniqueBot(ref, bots);
    if (!resolved.bot) return { error: resolved.error };
    if (seen.has(resolved.bot.larkAppId)) continue;
    seen.add(resolved.bot.larkAppId);
    workers.push(resolved.bot);
  }
  return { workers };
}

function resolveTeam(ref: string, teams: GoalStartTeam[]): { team?: GoalStartTeam; error?: string } {
  const value = ref.trim();
  const byId = teams.filter((team) => team.teamId === value);
  if (byId.length === 1) return { team: byId[0] };
  const byName = teams.filter((team) => normalized(team.teamName) === normalized(value));
  if (byName.length === 1) return { team: byName[0] };
  if (byName.length > 1) return { error: `团队名称“${value}”不唯一，请改用团队 ID` };
  return { error: `找不到平台团队“${value}”` };
}

/**
 * Resolve the product-level goal-start selection without touching disk or Lark.
 * Local-only workers deliberately win when no team was named: a single-machine
 * goal should not depend on platform state merely because those bots also
 * happen to appear in a synced team.
 */
export function resolveGoalStartSelection(input: {
  parentLarkAppId: string;
  supervisorRef?: string;
  workerRefs: string[];
  teamRef?: string;
  localBots: GoalStartBot[];
  teams: GoalStartTeam[];
}): GoalStartSelectionResult {
  if (input.workerRefs.filter((ref) => ref.trim()).length === 0) {
    return { ok: false, error: '至少需要一个执行者' };
  }

  const parent = input.localBots.find((bot) => bot.larkAppId === input.parentLarkAppId);
  if (!parent) return { ok: false, error: '当前主控会话所属机器人没有本机配置' };

  const supervisorRef = input.supervisorRef?.trim();
  const supervisorResolved = supervisorRef
    ? resolveUniqueBot(supervisorRef, input.localBots)
    : { bot: parent };
  if (!supervisorResolved.bot) return { ok: false, error: supervisorResolved.error ?? '找不到监管者' };
  if (supervisorResolved.bot.larkAppId !== parent.larkAppId) {
    return {
      ok: false,
      error: '监管者必须是当前主控会话所属的本机机器人，才能可靠回报进展',
    };
  }
  const supervisor = supervisorResolved.bot;

  let team: GoalStartTeam | undefined;
  let workers: GoalStartBot[] | undefined;
  const warnings: string[] = [];

  if (input.teamRef?.trim()) {
    const resolved = resolveTeam(input.teamRef, input.teams);
    if (!resolved.team) return { ok: false, error: resolved.error ?? '找不到平台团队' };
    team = resolved.team;
    if (!team.bots.some((bot) => bot.larkAppId === supervisor.larkAppId)) {
      return { ok: false, error: `监管者 ${supervisor.name} 不在团队 ${team.teamName} 中` };
    }
    const workerResult = resolveWorkers(input.workerRefs, team.bots);
    if (!workerResult.workers) return { ok: false, error: workerResult.error ?? '找不到执行者' };
    workers = workerResult.workers;
  } else {
    const localResult = resolveWorkers(input.workerRefs, input.localBots);
    if (localResult.workers) {
      workers = localResult.workers;
    } else {
      const workerTeams = input.teams.flatMap((candidate) => {
        const resolved = resolveWorkers(input.workerRefs, candidate.bots);
        return resolved.workers ? [{ team: candidate, workers: resolved.workers }] : [];
      });
      const candidates = workerTeams.filter(({ team: candidate }) => (
        candidate.bots.some((bot) => bot.larkAppId === supervisor.larkAppId)
      ));
      if (candidates.length === 0) {
        if (workerTeams.length > 0) {
          const names = workerTeams.map(({ team: candidate }) => `${candidate.teamName} (${candidate.teamId})`).join('；');
          return { ok: false, error: `执行者在这些团队中，但当前监管者不在：${names}` };
        }
        return { ok: false, error: `${localResult.error}；已同步的平台团队中也没有包含全部执行者的团队` };
      }
      if (candidates.length > 1) {
        const names = candidates.map(({ team: candidate }) => `${candidate.teamName} (${candidate.teamId})`).join('；');
        return { ok: false, error: `多个平台团队都包含这些执行者，请用 --team 指定：${names}` };
      }
      team = candidates[0]!.team;
      workers = candidates[0]!.workers;
      warnings.push(`已自动选择唯一匹配的团队：${team.teamName}`);
    }
  }

  const withoutSupervisor = workers.filter((worker) => worker.larkAppId !== supervisor.larkAppId);
  if (withoutSupervisor.length === 0) {
    return { ok: false, error: '监管者不能同时是唯一执行者' };
  }
  if (withoutSupervisor.length !== workers.length) {
    warnings.push(`已从执行者列表移除监管者 ${supervisor.name}`);
  }

  return {
    ok: true,
    value: { supervisor, workers: withoutSupervisor, ...(team ? { team } : {}) },
    warnings,
  };
}

export function buildGoalStartBrief(input: {
  brief?: string;
  teamName?: string;
  supervisorName: string;
  workers: Array<{ name: string; larkAppId: string; mentionOpenId?: string; local: boolean }>;
  localWorkingDir?: string;
  requiredRepo?: string;
}): string {
  const hasRemoteWorker = input.workers.some((worker) => !worker.local);
  const lines = [
    input.brief?.trim(),
    '',
    '启动信息：',
    ...(input.teamName ? [`- 团队：${input.teamName}`] : []),
    `- 监管者：${input.supervisorName}`,
    `- 执行者：${input.workers.map((worker) => `${worker.name}${worker.local ? '（本机）' : '（远端）'}`).join('、')}`,
    '- 派活坐标（可直接复制）：',
    ...input.workers.map((worker) => `  --bot ${worker.mentionOpenId ?? worker.larkAppId}:${worker.name}:执行者`),
    ...(input.localWorkingDir ? [`- 本机项目目录：${input.localWorkingDir}`] : []),
    ...(input.requiredRepo ? [`- 项目仓库：${input.requiredRepo}`] : []),
    ...(hasRemoteWorker && !input.requiredRepo ? ['- 项目仓库：未指定；远端代码任务派发前必须先向主控确认项目。'] : []),
    '',
    '派任务时只使用上面的执行者。',
    ...(input.requiredRepo
      ? [`跨设备代码任务必须使用 --needs-repo "${input.requiredRepo}"；不要把本机绝对路径发给远端执行者。`]
      : hasRemoteWorker
        ? ['存在远端执行者但没有项目仓库要求；不要直接派发远端代码任务，先向主控确认项目。']
      : []),
  ].filter((line, index, all) => line !== undefined && !(line === '' && all[index - 1] === '')) as string[];
  return lines.join('\n').trim();
}
