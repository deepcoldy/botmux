import * as sessionStore from '../services/session-store.js';
import * as groupsStore from '../services/groups-store.js';
import * as messageQueue from '../services/message-queue.js';
import { getBot } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import { validateWorkingDir } from './working-dir.js';
import { buildFollowUpContent, buildNewTopicPrompt, getAvailableBots, rememberLastCliInput } from './session-manager.js';
import { forkWorker, getCurrentCliVersion } from './worker-pool.js';
import { sessionKey, type DaemonSession } from './types.js';
import { markSessionActivity } from './session-activity.js';

export interface GoalSuperviseRequest {
  chatId: string;
  parentChatId: string;
  parentRoot?: string;
  title: string;
  brief?: string;
  workingDir?: string;
  parentSessionId?: string;
}

export interface GoalSuperviseResponse {
  ok: true;
  goalChatId: string;
  supervisorSessionId: string;
  parent: { chatId: string; rootMessageId?: string };
}

export interface GoalNotifyParentRequest {
  supervisorSessionId?: string;
  goalChatId?: string;
  taskId?: string;
  summary: string;
  attentionKind?: string;
  attentionReason?: string;
  done?: boolean;
}

export interface GoalNotifyParentResponse {
  ok: true;
  parentSessionId: string;
  goalChatId: string;
  goalTitle?: string;
  parentChatId: string;
  parentRoot?: string;
  supervisorSessionId: string;
  taskId?: string;
  done?: boolean;
  attentionKind?: string;
  attentionReason?: string;
}

export interface GoalNotifyParentError {
  ok: false;
  errorCode: string;
  error: string;
}

export interface GoalSuperviseError {
  ok: false;
  errorCode: string;
  error: string;
}

export interface GoalSupervisorDeps {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
}

export function buildGoalSupervisorPrompt(req: GoalSuperviseRequest): string {
  const brief = req.brief?.trim();
  const parentRootLine = req.parentRoot
    ? `- L1 主话题 rootMessageId: ${req.parentRoot}`
    : '- L1 主群没有指定 rootMessageId；完成通知发到主群顶层即可。';
  return [
    `你是 goal 群里的 L2 监管 agent。goal: ${req.title.trim() || req.chatId}`,
    '',
    '职责：',
    `1. 先按需创建/读取本 goal 群的 charter：\`botmux goal charter current --goal ${req.chatId} --create\`，再 \`botmux goal charter read --goal ${req.chatId} --json\`。必要时用 \`botmux goal charter update --goal ${req.chatId} --expected-updated-at ...\` 维护目标、组织方式、当前状态、下一步。`,
    `2. 派发和验收子任务前，先运行 \`botmux delivery list --goal ${req.chatId}\` 查可信交付账本，账本是真相源，聊天只是提醒和上下文。`,
    '3. 子任务默认在本 goal 群的群级会话里用 `botmux dispatch --chat-id <本 goal 群 chatId>` 派发；worker 必须用 `botmux report --task ...` 交证据。只有超大并行/重协作/防刷屏时，才显式加 `--new-topic` 开隔离话题。',
    '4. 验收时只认账本里的 evidence：能读文件就读，能跑命令就跑；accept/reject 必须写 evidenceChecked / ranCommands / reason。',
    '5. 全部子任务 accepted 后，主动通知 L1 主群，说明 goal 完成、关键证据和账本状态。',
    '',
    'L1 回报坐标：',
    `- L1 主群 chatId: ${req.parentChatId}`,
    parentRootLine,
    '',
    '常用完成通知命令：',
    `botmux goal notify-parent --summary "Goal「${req.title.trim() || req.chatId}」已完成：<摘要>"`,
    ...(brief ? ['', 'L1 给你的初始 brief：', brief] : []),
  ].join('\n');
}

function findActiveBySessionId(activeSessions: Map<string, DaemonSession>, sessionId?: string): DaemonSession | undefined {
  if (!sessionId) return undefined;
  for (const ds of activeSessions.values()) {
    if (ds.session.sessionId === sessionId) return ds;
  }
  return undefined;
}

function findGoalSupervisorByGoal(activeSessions: Map<string, DaemonSession>, larkAppId: string, goalChatId?: string): DaemonSession | undefined {
  if (!goalChatId) return undefined;
  const direct = activeSessions.get(sessionKey(goalChatId, larkAppId));
  if (direct?.session.goalSupervisor?.goalChatId === goalChatId) return direct;
  for (const ds of activeSessions.values()) {
    if (ds.larkAppId === larkAppId && ds.session.goalSupervisor?.goalChatId === goalChatId) return ds;
  }
  return undefined;
}

export function findGoalParentSession(activeSessions: Map<string, DaemonSession>, larkAppId: string, supervisor: DaemonSession): DaemonSession | undefined {
  const meta = supervisor.session.goalSupervisor;
  if (!meta) return undefined;
  const bySession = findActiveBySessionId(activeSessions, meta.parentSessionId);
  if (bySession && bySession.larkAppId === larkAppId) return bySession;

  const byChat = activeSessions.get(sessionKey(meta.parentChatId, larkAppId));
  if (byChat) return byChat;
  if (meta.parentRoot) {
    const byRoot = activeSessions.get(sessionKey(meta.parentRoot, larkAppId));
    if (byRoot) return byRoot;
  }
  for (const ds of activeSessions.values()) {
    if (ds.larkAppId !== larkAppId) continue;
    if (ds.chatId === meta.parentChatId && ds.scope === 'chat') return ds;
    if (meta.parentRoot && ds.session.rootMessageId === meta.parentRoot) return ds;
  }
  return undefined;
}

export function buildGoalParentNotificationPrompt(supervisor: DaemonSession, summary: string): string {
  const meta = supervisor.session.goalSupervisor;
  const goalTitle = meta?.title || supervisor.session.title.replace(/^\[Goal\]\s*/, '') || supervisor.chatId;
  return [
    '[goal-parent-notify] L2 goal supervisor reports progress/completion.',
    `goal: ${goalTitle}`,
    `goalChatId: ${meta?.goalChatId ?? supervisor.chatId}`,
    '',
    'summary:',
    summary.trim(),
    '',
    '请按 L1 流程查 goal charter / delivery ledger 做最终汇总；账本仍是真相源，不要只信这条通知。',
  ].join('\n');
}

export async function injectGoalParentTurn(parent: DaemonSession, prompt: string): Promise<void> {
  const content = buildFollowUpContent(prompt, parent.session.sessionId, {
    isAdoptMode: false,
    cliId: parent.session.cliId,
    locale: localeForBot(parent.larkAppId),
    larkAppId: parent.larkAppId,
    chatId: parent.chatId,
  });
  markSessionActivity(parent);
  rememberLastCliInput(parent, prompt, content);
  if (parent.worker && !parent.worker.killed) {
    parent.worker.send({ type: 'message', content });
  } else {
    forkWorker(parent, content);
  }
}

export async function notifyGoalParent(
  req: GoalNotifyParentRequest,
  deps: GoalSupervisorDeps,
): Promise<GoalNotifyParentResponse | GoalNotifyParentError> {
  const summary = req.summary.trim();
  if (!summary) return { ok: false, errorCode: 'missing_summary', error: 'summary is required' };

  const supervisor = findActiveBySessionId(deps.activeSessions, req.supervisorSessionId) ??
    findGoalSupervisorByGoal(deps.activeSessions, deps.larkAppId, req.goalChatId);
  if (!supervisor || supervisor.larkAppId !== deps.larkAppId || !supervisor.session.goalSupervisor) {
    return { ok: false, errorCode: 'supervisor_not_found', error: 'active goal supervisor session not found' };
  }

  const parent = findGoalParentSession(deps.activeSessions, deps.larkAppId, supervisor);
  if (!parent) {
    return { ok: false, errorCode: 'parent_not_active', error: 'active L1 parent session not found' };
  }

  await injectGoalParentTurn(parent, buildGoalParentNotificationPrompt(supervisor, summary));
  return {
    ok: true,
    parentSessionId: parent.session.sessionId,
    goalChatId: supervisor.session.goalSupervisor.goalChatId,
    goalTitle: supervisor.session.goalSupervisor.title,
    parentChatId: supervisor.session.goalSupervisor.parentChatId,
    parentRoot: supervisor.session.goalSupervisor.parentRoot,
    supervisorSessionId: supervisor.session.sessionId,
    taskId: req.taskId,
    done: req.done,
    attentionKind: req.attentionKind,
    attentionReason: req.attentionReason,
  };
}

function resolveWorkingDir(req: GoalSuperviseRequest, larkAppId: string, parent?: DaemonSession): { ok: true; workingDir: string } | { ok: false; error: string } {
  const parentSession = req.parentSessionId ? sessionStore.getSession(req.parentSessionId) : undefined;
  const bot = getBot(larkAppId);
  const candidate =
    req.workingDir ||
    parent?.session.workingDir ||
    parent?.workingDir ||
    parentSession?.workingDir ||
    bot.config.defaultWorkingDir ||
    bot.config.workingDir ||
    '~';
  const v = validateWorkingDir(candidate, localeForBot(larkAppId));
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, workingDir: v.resolvedPath };
}

export async function startGoalSupervisor(
  req: GoalSuperviseRequest,
  deps: GoalSupervisorDeps,
): Promise<GoalSuperviseResponse | GoalSuperviseError> {
  const larkAppId = deps.larkAppId;
  const chatId = req.chatId.trim();
  const parentChatId = req.parentChatId.trim();
  if (!chatId) return { ok: false, errorCode: 'missing_chatId', error: 'chatId is required' };
  if (!parentChatId) return { ok: false, errorCode: 'missing_parentChatId', error: 'parentChatId is required' };

  const inChat = await groupsStore.isInChat(larkAppId, chatId);
  if (!inChat) {
    return { ok: false, errorCode: 'bot_not_in_chat', error: `bot ${larkAppId} is not in goal chat ${chatId}` };
  }

  const parent = findActiveBySessionId(deps.activeSessions, req.parentSessionId);
  const wd = resolveWorkingDir(req, larkAppId, parent);
  if (!wd.ok) return { ok: false, errorCode: 'invalid_working_dir', error: wd.error };

  const bot = getBot(larkAppId);
  const title = req.title.trim() || 'Goal supervisor';
  const anchor = chatId;
  const scope: 'thread' | 'chat' = 'chat';

  const session = sessionStore.createSession(chatId, anchor, `[Goal] ${title}`.slice(0, 50), 'group');
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = scope;
  session.lastMessageAt = new Date(now).toISOString();
  session.workingDir = wd.workingDir;
  session.cliId = bot.config.cliId;
  session.goalSupervisor = {
    goalChatId: chatId,
    title,
    parentChatId,
    parentRoot: req.parentRoot,
    parentSessionId: req.parentSessionId,
    createdAt: new Date(now).toISOString(),
  };
  sessionStore.updateSession(session);

  messageQueue.ensureQueue(anchor);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType: 'group',
    scope,
    spawnedAt: Date.parse(session.createdAt) || now,
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: false,
    workingDir: wd.workingDir,
  };

  const userPrompt = buildGoalSupervisorPrompt(req);
  const cliInput = buildNewTopicPrompt(
    userPrompt,
    session.sessionId,
    bot.config.cliId,
    bot.config.cliPathOverride,
    undefined,
    undefined,
    await getAvailableBots(larkAppId, chatId),
    undefined,
    { name: bot.botName, openId: bot.botOpenId },
    localeForBot(larkAppId),
    undefined,
    { larkAppId, chatId },
  );

  deps.activeSessions.set(sessionKey(anchor, larkAppId), ds);
  rememberLastCliInput(ds, userPrompt, cliInput);
  forkWorker(ds, cliInput);

  return {
    ok: true,
    goalChatId: chatId,
    supervisorSessionId: session.sessionId,
    parent: { chatId: parentChatId, rootMessageId: req.parentRoot },
  };
}
