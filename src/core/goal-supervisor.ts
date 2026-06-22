import * as sessionStore from '../services/session-store.js';
import * as groupsStore from '../services/groups-store.js';
import * as messageQueue from '../services/message-queue.js';
import { getBot } from '../bot-registry.js';
import { sendMessage } from '../im/lark/client.js';
import { localeForBot } from '../i18n/index.js';
import { validateWorkingDir } from './working-dir.js';
import { buildNewTopicPrompt, getAvailableBots, rememberLastCliInput } from './session-manager.js';
import { forkWorker, getCurrentCliVersion } from './worker-pool.js';
import { sessionKey, type DaemonSession } from './types.js';

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
  supervisorRootId: string;
  whiteboardId?: string;
  parent: { chatId: string; rootMessageId?: string };
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
    '1. 先按需创建/读取本 goal 群的 charter 白板：`botmux whiteboard current --create`，再 `botmux whiteboard read --json`。必要时用 `botmux whiteboard update --expected-updated-at ...` 维护目标、组织方式、当前状态、下一步。',
    `2. 派发和验收子任务前，先运行 \`botmux delivery list --goal ${req.chatId}\` 查可信交付账本，账本是真相源，聊天只是提醒和上下文。`,
    '3. 子任务在本 goal 群内用 `botmux dispatch --chat-id <本 goal 群 chatId>` 派发；worker 必须用 `botmux report --task ...` 交证据。',
    '4. 验收时只认账本里的 evidence：能读文件就读，能跑命令就跑；accept/reject 必须写 evidenceChecked / ranCommands / reason。',
    '5. 全部子任务 accepted 后，主动通知 L1 主群，说明 goal 完成、关键证据和账本状态。',
    '',
    'L1 回报坐标：',
    `- L1 主群 chatId: ${req.parentChatId}`,
    parentRootLine,
    '',
    '常用完成通知命令：',
    req.parentRoot
      ? `botmux send --chat-id ${req.parentChatId} --quote ${req.parentRoot} --mention-back "Goal「${req.title.trim() || req.chatId}」已完成：<摘要>"`
      : `botmux send --chat-id ${req.parentChatId} --no-mention "Goal「${req.title.trim() || req.chatId}」已完成：<摘要>"`,
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
  const seed = `Goal supervisor: ${title}`;
  const anchor = await sendMessage(larkAppId, chatId, seed, 'text');
  const scope: 'thread' | 'chat' = 'thread';

  const session = sessionStore.createSession(chatId, anchor, `[Goal] ${title}`.slice(0, 50), 'group');
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = scope;
  session.lastMessageAt = new Date(now).toISOString();
  session.workingDir = wd.workingDir;
  session.cliId = bot.config.cliId;
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
    supervisorRootId: anchor,
    parent: { chatId: parentChatId, rootMessageId: req.parentRoot },
  };
}
