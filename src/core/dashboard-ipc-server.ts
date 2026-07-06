// src/core/dashboard-ipc-server.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { verifyHmac } from '../dashboard/auth.js';
import { listenWithProbe } from '../utils/listen-with-probe.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as groupsStore from '../services/groups-store.js';
import { createGroupWithBots } from '../services/group-creator.js';
import * as oncallStore from '../services/oncall-store.js';
import * as brandStore from '../services/brand-store.js';
import * as sandboxStore from '../services/sandbox-store.js';
import * as cardPrefsStore from '../services/card-prefs-store.js';
import * as observedBotsStore from '../services/observed-bots-store.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import { getBotUnionId } from '../services/bot-union-ids-store.js';
import * as grantPrefsStore from '../services/grant-prefs-store.js';
import { findConfigField, applyConfigField, coerceConfigValue } from '../services/bot-config-store.js';
import { summaryRangeFromBotConfig, updateDashboardSummaryRange } from '../services/summary-range-store.js';
import { config } from '../config.js';
import { computeSandboxDiff, applySandboxDiff } from '../services/sandbox-land.js';
import { buildSafeInsightConversation, buildSafeInsightOverview, buildSafeInsightReport, buildSafeInsightTurnDetail } from '../services/insight/report.js';
import type { InsightConversationRole, InsightDetail, InsightSeverity, SafeSpanTag } from '../services/insight/types.js';
import { readRawConfig, findEntryIndex, requireConfigPath, rmwBotEntry } from '../services/config-store.js';
import { setDefaultLocale, localeForBot, t } from '../i18n/index.js';
import { isLocale, type Locale } from '../i18n/types.js';
import { readGlobalConfig } from '../global-config.js';
import { normalizeChatReplyMode, type ChatReplyMode } from '../services/chat-reply-mode-store.js';
import * as chatFirstSeenStore from '../services/chat-first-seen-store.js';
import * as scheduler from './scheduler.js';
import { listActiveSessions, findActiveBySessionId, closeSession, getActiveSessionsRegistry, transferSession, deliverWriteLinkCardToOwners, forkWorker, suspendWorker } from './worker-pool.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { getChatMode, replyMessage, sendMessage, resolveUnionIdFromOpenId, listThreadMessages, listChatMessages, getUserProfile } from '../im/lark/client.js';
import { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent } from '../im/lark/message-parser.js';
import { resumeSession, spawnDashboardSession, activateQueuedSession, closeCliMismatchedSessionsForBot } from './session-manager.js';
import { parseSpawnRequest } from './session-create.js';
import { getCliDisplayName } from '../im/lark/card-builder.js';
import { locateLimiter } from './dashboard-locate.js';
import { buildTerminalUrl } from './terminal-url.js';
import { dashboardEventBus } from './dashboard-events.js';
import { validateWorkingDir } from './working-dir.js';
import { isValidRoleChatId, resolveRole, resolveRoleFile, writeRoleFile, deleteRoleFile, readRoleInjectMode, writeRoleInjectMode, deleteRoleInjectMode, type RoleInjectMode } from './role-resolver.js';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../services/role-profile-store.js';
import { triggerSessionTurn } from './trigger-session.js';
import { triggerWorkflowFromEnvelope } from '../workflows/trigger-from-envelope.js';
import type { TriggerInput, TriggerResult } from '../workflows/trigger-run.js';
import { validateTriggerRequest, type TriggerResponse } from '../services/trigger-types.js';
import { resolveCliSelection, selectionKeyForBot } from '../setup/cli-selection.js';

// Workflow runner is wired by the daemon (it owns the heavy triggerWorkflowRun
// deps). Until set, workflow-targeted triggers report not-implemented.
let workflowRunner: ((input: TriggerInput) => Promise<TriggerResult>) | null = null;
export function setWorkflowRunner(fn: (input: TriggerInput) => Promise<TriggerResult>): void {
  workflowRunner = fn;
}

// 机器人真·改名 renamer，由 daemon 启动时注册（开放平台自动化 + daemon 侧
// botName/descriptor/bots-info 同步都在 daemon 的闭包里做）。未注册（测试环境）
// 时 PUT /api/bot-rename 降级为仅改 displayName。
export type BotRenameOutcome =
  | { ok: true; name: string }
  | { ok: false; reason: string; message: string };
let botRenamer: ((newName: string) => Promise<BotRenameOutcome>) | null = null;
export function setBotRenamer(fn: ((newName: string) => Promise<BotRenameOutcome>) | null): void {
  botRenamer = fn;
}
import {
  composeRowFromActive,
  composeRowFromClosed,
  feishuChatLink,
  setBotName as setRowsBotName,
  getBotName,
  type SessionRow,
} from './dashboard-rows.js';
import { getBotBrand, getBot, readBotSkillPolicy } from '../bot-registry.js';
import { normalizeKanbanColumn, normalizeKanbanPosition, normalizeSessionTitle } from './session-board.js';
import type { DaemonToWorker, ScheduledTask, ParsedSchedule, Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { attachSkillPolicy, detachSkillPolicy } from './skills/im-command.js';
import { readSkillRegistry } from '../services/skill-registry-store.js';

export interface IpcServerHandle {
  port: number;
  close: () => Promise<void>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Register a handler. Path supports `:name` segments captured into the params object. */
export function ipcRoute(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method: method.toUpperCase(), pattern, keys, handler });
}

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ─── Token-route auth (loopback HMAC) ───────────────────────────────────────
//
// Most IPC routes are loopback-trusted: the codebase's threat model treats a
// local botmux process as already root-equivalent on the box (see the
// migrate-to-chat route below), so close/resume/sandbox-diff carry no per-route
// auth. The two write-link routes are different — they HAND OUT a reusable
// terminal-control credential (the worker write token: GET /write-link returns
// the URL, POST /write-link-card delivers it as a private Lark card), so they
// additionally require the caller to prove it can read ~/.botmux/.dashboard-secret.
// That keeps a sandboxed worker, or a random local process that merely discovered
// the ipcPort, from minting write tokens for sessions it doesn't own. The legit
// callers — the dashboard proxy and `botmux term-link` — sign with the same secret
// + scheme as `botmux dashboard` → /__cli/rotate. (A same-user process that can
// read the secret is out of scope: it's already trusted.)
let injectedIpcSecret: string | null = null;
/** Test seam: override the secret used to verify token-route HMAC. */
export function setIpcAuthSecret(secret: string | null): void { injectedIpcSecret = secret; }
function ipcAuthSecret(): string | null {
  if (injectedIpcSecret) return injectedIpcSecret;
  try { return readFileSync(join(homedir(), '.botmux', '.dashboard-secret'), 'utf8').trim() || null; }
  catch { return null; }
}
function tokenRouteAuthorized(req: IncomingMessage): boolean {
  const secret = ipcAuthSecret();
  if (!secret) return false; // fail-closed: no secret on disk → nobody can sign
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return false;
  return verifyHmac(secret, { ts, nonce, sig }, req.socket.remoteAddress ?? '').ok;
}

ipcRoute('GET', '/__health', (_req, res) => {
  jsonRes(res, 200, { ok: true });
});

// ─── Session list / detail ─────────────────────────────────────────────────
// Row shape + composers live in dashboard-rows.ts so worker-pool can publish
// SessionRow events without importing this module (which would create a cycle:
// worker-pool → dashboard-ipc-server → worker-pool).

export type { SessionRow };
export { composeRowFromActive, composeRowFromClosed };

// Re-export setBotName for backwards-compatible imports (daemon.ts).  Both
// callers (this module's cachedBotName + dashboard-rows' cachedBotName) need
// to be primed; here we forward to the rows module which is the canonical
// holder.
export function setBotName(name: string): void { setRowsBotName(name); }

// The daemon's own larkAppId, primed at startup. Required for the groups
// endpoints below which proxy calls into groups-store on this bot's behalf.
let cachedLarkAppId = '';
export function setLarkAppId(id: string): void { cachedLarkAppId = id; }

ipcRoute('GET', '/api/sessions', (_req, res) => {
  // Active first (live state), closed appended (historical)
  const active = listActiveSessions().map(composeRowFromActive);
  const activeIds = new Set(active.map(r => r.sessionId));
  const closed = sessionStore.listSessions()
    .filter(s => s.status === 'closed' && !activeIds.has(s.sessionId))
    .map(composeRowFromClosed);
  jsonRes(res, 200, { sessions: [...active, ...closed] });
});

ipcRoute('GET', '/api/sessions/:sessionId', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (ds) return jsonRes(res, 200, { session: composeRowFromActive(ds) });
  const closed = sessionStore.listSessions().find(s => s.sessionId === params.sessionId);
  if (closed) return jsonRes(res, 200, { session: composeRowFromClosed(closed) });
  jsonRes(res, 404, { error: 'not_found' });
});

ipcRoute('POST', '/api/sessions/:sessionId/close', async (_req, res, params) => {
  const r = await closeSession(params.sessionId);
  jsonRes(res, 200, r);
});

/** Post a scope-aware "restarting" notice into the session's Lark thread/chat,
 *  mirroring the /resume route — so a Feishu-side observer sees why the CLI just
 *  restarted under them (the IM `/restart` command and the card button notify
 *  too; the dashboard was the lone silent path). `fresh` = the worker was gone
 *  and we re-forked it (revive) rather than doing an in-place CLI restart.
 *  Best-effort and fire-and-forget; never blocks the HTTP response. */
function postRestartNotice(ds: DaemonSession, fresh: boolean): void {
  if (!ds.larkAppId) return;
  const loc = localeForBot(ds.larkAppId);
  const cliName = getCliDisplayName(ds.session.cliId ?? 'claude-code');
  const text = fresh
    ? t('card.action.restarted_fresh', { cliName }, loc)
    : t('cmd.restart.in_progress', { cliName }, loc);
  const notice = JSON.stringify({ text });
  if (ds.scope === 'chat' && ds.chatId) {
    getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true })
      .then((mode) => mode === 'topic' && ds.session.rootMessageId
        ? replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
        : sendMessage(ds.larkAppId, ds.chatId, notice, 'text'))
      .catch(err => logger.debug(`[restart] failed to post chat-scope restart notice: ${err}`));
  } else if (ds.session.rootMessageId) {
    replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
      .catch(err => logger.debug(`[restart] failed to post thread-scope restart notice: ${err}`));
  }
}

ipcRoute('POST', '/api/sessions/:sessionId/restart', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  // Adopt/observed sessions: botmux never owned the CLI — restarting would kill
  // the user's real tmux/zellij pane. Hard-reject (the worker self-guards too).
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_restart_unsupported' });
  }
  const cliId = ds.session.cliId ?? 'unknown';
  if (ds.worker && !ds.worker.killed) {
    // Live worker → in-place CLI restart (kills the CLI, respawns with --resume).
    try {
      ds.worker.send({ type: 'restart' } as DaemonToWorker);
    } catch (err) {
      return jsonRes(res, 502, { ok: false, error: String(err) });
    }
    postRestartNotice(ds, false);
    return jsonRes(res, 200, { ok: true, sessionId: params.sessionId, cliId, revived: false });
  }
  // Worker is gone but the session is still active — idle-suspended (over the
  // per-bot cap), lazy-restored after a daemon restart, or crash-loop-stopped.
  // Revive it the same way the Feishu card restart does (forkWorker), so the
  // dashboard isn't a dead-end: a 409 here would leave NO working control to
  // bring the CLI back (the resume button only shows for closed sessions).
  forkWorker(ds, '', ds.hasHistory);
  postRestartNotice(ds, true);
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, cliId, revived: true });
});

/** Manually suspend one active session: kill the worker + CLI/pane, session
 *  stays active and cold-resumes from its transcript on the next message —
 *  the same semantics the idle-worker sweeper applies over the live cap.
 *  Primary use: `botmux suspend --isolated` after a credential rotation, so
 *  isolated bots' next cold spawn re-provisions the freshest creds. */
ipcRoute('POST', '/api/sessions/:sessionId/suspend', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  // Adopt/observed sessions: botmux never owned the CLI — suspending would kill
  // the user's real tmux/zellij pane. Same guard as /restart.
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_suspend_unsupported' });
  }
  if (!ds.worker || ds.worker.killed) {
    // Worker already gone (idle-suspended / crash-stopped) — the goal state is
    // already reached, so report idempotent success without a live kill.
    return jsonRes(res, 200, { ok: true, sessionId: params.sessionId, suspended: false, reason: 'no_live_worker' });
  }
  if (!suspendWorker(ds, 'manual_suspend')) {
    // Live worker but a non-suspendable (pty) backend: killing it would drop the
    // in-memory conversation with no persistent pane to resume from lazily.
    return jsonRes(res, 409, { ok: false, error: 'backend_not_suspendable' });
  }
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, suspended: true });
});

/** 解析 session（活跃优先，已关闭兜底）。活跃会话取 ds.session —— registry 与
 *  store 持有同一对象，改字段后 updateSession 即落盘。 */
function findSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getSession(sessionId);
}

function buildAsyncTriggerLookupResponse(sessionId: string, triggerId?: string): TriggerResponse {
  const ds = findActiveBySessionId(sessionId);
  if (!ds) {
    return { ok: false, errorCode: 'session_not_found', error: `active session not found: ${sessionId}` };
  }
  const resolvedTriggerId = triggerId || ds.latestAsyncTriggerId;
  if (!resolvedTriggerId) {
    return { ok: false, errorCode: 'bad_request', error: 'no async trigger recorded for this session' };
  }
  const state = ds.asyncTriggerResults?.get(resolvedTriggerId);
  if (!state) {
    return { ok: false, errorCode: 'bad_request', error: `async trigger not found for session: ${resolvedTriggerId}` };
  }
  if (state.status === 'completed') {
    return {
      ok: true,
      triggerId: resolvedTriggerId,
      action: 'completed',
      target: { kind: 'turn', sessionId, chatId: ds.chatId },
      output: state.content ? { content: state.content } : undefined,
      async: {
        status: 'completed',
        sessionId,
        completedAt: state.completedAt ? new Date(state.completedAt).toISOString() : undefined,
      },
      message: 'async trigger completed',
    };
  }
  return {
    ok: true,
    triggerId: resolvedTriggerId,
    action: 'queued',
    target: { kind: 'turn', sessionId, chatId: ds.chatId },
    async: {
      status: 'pending',
      sessionId,
    },
    message: 'async trigger pending',
  };
}

// 看板放置：dashboard 看板视图拖拽卡片后持久化列 + 列内排序位置。
// 改完广播 session.update，所有打开的 dashboard 实时同步。
ipcRoute('POST', '/api/sessions/:sessionId/board', async (req, res, params) => {
  let body: { column?: unknown; position?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const column = normalizeKanbanColumn(body.column);
  const position = normalizeKanbanPosition(body.position);
  if (!column && position === null) return jsonRes(res, 400, { ok: false, error: 'bad_request' });
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  // 待办池(queued)会话被拖到「进行中」= 激活：把暂存内容当首轮发给 CLI 开跑。
  // activateQueuedSession 内部会清 queued + 把列设成 in_progress + forkWorker。
  const activeDs = findActiveBySessionId(params.sessionId);
  if (column === 'in_progress' && activeDs?.session.queued) {
    await activateQueuedSession(activeDs);
  } else if (column) {
    session.kanbanColumn = column;
  }
  if (position !== null) session.kanbanPosition = position;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: params.sessionId,
      // queued 一并下发：激活后 session.queued 已为 false，前端浅合并若不带这个字段
      // 会残留 queued=true（卡片仍显示「开始」、再点 409）。!!session.queued 始终反映现态。
      patch: { kanbanColumn: session.kanbanColumn, kanbanPosition: session.kanbanPosition, queued: !!session.queued },
    },
  });
  jsonRes(res, 200, { ok: true });
});

// 待办池会话「开始」：把 parked 会话激活（发首轮、起 CLI），与拖到「进行中」同义。
ipcRoute('POST', '/api/sessions/:sessionId/start', async (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  if (!ds.session.queued) return jsonRes(res, 409, { ok: false, error: 'not_queued' });
  const r = await activateQueuedSession(ds);
  if (!r.ok) return jsonRes(res, 500, r);
  sessionStore.updateSession(ds.session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: params.sessionId, patch: { kanbanColumn: ds.session.kanbanColumn, queued: false } },
  });
  jsonRes(res, 200, { ok: true });
});

// Dashboard「创建会话」spawn：在新建的群里为本 daemon 的 bot 拉起/暂存一条 chat-scope
// 会话。aggregator 建完群后按模式(一起开工/lead 分配)对每个目标 bot 的 daemon 调一次。
ipcRoute('POST', '/api/sessions/spawn', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  const parsed = parseSpawnRequest(body);
  if (!parsed.ok) return jsonRes(res, 400, { ok: false, error: parsed.error });
  const postBanner = !!(body as any).postBanner;
  const r = await spawnDashboardSession(activeSessions, undefined, {
    larkAppId: cachedLarkAppId,
    chatId: parsed.value.chatId,
    content: parsed.value.content,
    column: parsed.value.column,
    role: parsed.value.role,
    coworkers: parsed.value.coworkers,
    title: parsed.value.title,
    postBanner,
    ownerOpenId: parsed.value.ownerOpenId,
    ownerUnionId: parsed.value.ownerUnionId,
  });
  if (!r.ok) return jsonRes(res, r.error === 'session_exists' ? 409 : 500, r);
  jsonRes(res, 200, r);
});

// 会话历史：实时拉取该会话所在话题/群的飞书消息（与 botmux history 同链路，
// 消息体不落盘），给 dashboard 的会话历史弹窗。复杂卡片的「请升级」兜底文本
// 用 message.get 的完整表示补齐；merge_forward 保持占位符（原型不展开）。
ipcRoute('GET', '/api/sessions/:sessionId/history', async (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const appId = session.larkAppId || cachedLarkAppId;
  if (!appId) return jsonRes(res, 422, { ok: false, error: 'no_lark_app' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '80', 10) || 80, 1), 200);
  try {
    const raw = session.scope === 'chat'
      ? await listChatMessages(appId, session.chatId, limit)
      : await listThreadMessages(appId, session.chatId, session.rootMessageId, limit);
    const messages = await Promise.all(raw.map(async (m: any) => {
      const parsed = parseApiMessage(m);
      if (parsed.msgType === 'interactive' && cardContentHasUpgradeFallback(parsed.content)) {
        const merged = await resolveMergedCardContent(appId, parsed.messageId).catch(() => null);
        if (merged) parsed.content = merged.text;
      }
      return {
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderType: parsed.senderType,
        msgType: parsed.msgType,
        content: parsed.content,
        // Lark create_time 是毫秒 epoch 字符串——规范成数字，前端 new Date 直接用
        createTime: Number(parsed.createTime) || undefined,
      };
    }));
    // 真人发送者补名字+头像（contact API，带缓存；不在可见范围的回退占位）
    const senders = new Map<string, { name: string; avatarUrl?: string } | null>();
    await Promise.all(
      [...new Set(messages.filter(m => m.senderType === 'user' && m.senderId).map(m => m.senderId))]
        .map(async id => { senders.set(id, await getUserProfile(appId, id)); }),
    );
    jsonRes(res, 200, {
      ok: true,
      scope: session.scope ?? 'thread',
      ownerOpenId: session.ownerOpenId,
      messages: messages.map(m => {
        const p = m.senderType === 'user' ? senders.get(m.senderId) : null;
        return p ? { ...m, senderName: p.name, senderAvatar: p.avatarUrl } : m;
      }),
    });
  } catch (err: any) {
    jsonRes(res, 502, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/trigger-result', (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const triggerId = url.searchParams.get('triggerId') ?? undefined;
  const result = buildAsyncTriggerLookupResponse(params.sessionId, triggerId);
  const status = result.ok
    ? 200
    : result.errorCode === 'session_not_found'
      ? 404
      : 400;
  jsonRes(res, status, result);
});

// 会话 insight：只读解析本会话的 transcript，产出动作 span / 失败聚合 / 规则建议
// （SafeInsightReport）。底层 services/insight 已做 fail-closed 脱敏投影——raw 命令
// 与输出永不进结构。detail=summary 只返聚合+建议（/insight 卡片、抽屉概览用）；
// detail=spans 才带脱敏 span（详情 tab 用）。owner-only 由 dashboard 外层 authed-only
// 路由 + /insight 命令层把关，IPC 自身 loopback-trusted。
ipcRoute('GET', '/api/sessions/:sessionId/insight', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('detail') === 'conversation') {
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    const role = url.searchParams.get('role') as InsightConversationRole | null;
    const severity = url.searchParams.get('severity') as InsightSeverity | null;
    const tag = url.searchParams.get('tag') as SafeSpanTag | null;
    const turnIndexes = url.searchParams.getAll('turnIndexes')
      .flatMap(v => v.split(','))
      .map(v => parseInt(v, 10))
      .filter(Number.isFinite);
    const conversation = buildSafeInsightConversation({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
    }, {
      offset,
      limit,
      q: url.searchParams.get('q') ?? undefined,
      role: role && ['user', 'a2a_agent', 'system', 'agent'].includes(role) ? role : undefined,
      severity: severity && ['bad', 'warn', 'info'].includes(severity) ? severity : undefined,
      tag: tag && ['failure', 'slow', 'retry', 'read_write_imbalance', 'diagnostic', 'normal'].includes(tag) ? tag : undefined,
      turnIndexes: turnIndexes.length ? turnIndexes : undefined,
    });
    return jsonRes(res, 200, { ok: true, conversation });
  }
  const detail: InsightDetail = url.searchParams.get('detail') === 'spans' ? 'spans' : 'summary';
  try {
    const report = buildSafeInsightReport({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
    }, { detail });
    jsonRes(res, 200, { ok: true, report });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/insight/turn/:turnIndex', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
  const limit = parseInt(url.searchParams.get('limit') ?? '4000', 10) || 4000;
  try {
    const turn = buildSafeInsightTurnDetail({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
    }, parseInt(params.turnIndex, 10) || 0, { offset, limit });
    jsonRes(res, 200, { ok: true, turn });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

// 跨会话 insight 总览：仍然只读、按需、owner-only（外层 dashboard route
// 不在 public-read 白名单）。只聚合本 daemon registry 里的 botmux 会话；
// 不扫整机 transcript，不返回 raw span/input/output。
ipcRoute('GET', '/api/insights/summary', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
  const active = listActiveSessions().map(composeRowFromActive);
  const activeIds = new Set(active.map(r => r.sessionId));
  const closed = sessionStore.listSessions()
    .filter(s => s.status === 'closed' && !activeIds.has(s.sessionId))
    .map(composeRowFromClosed);
  const rows = [...active, ...closed];
  const overview = await buildSafeInsightOverview(rows.map(row => {
    const session = findSessionRecord(row.sessionId);
    return {
      cliId: row.cliId,
      sessionId: row.sessionId,
      cliSessionId: session?.cliSessionId,
      cwd: row.workingDir,
      workingDir: row.workingDir,
      title: row.title,
      botName: row.botName,
      larkAppId: row.larkAppId,
      status: row.status,
      lastMessageAt: row.lastMessageAt,
    };
  }), { limit });
  jsonRes(res, 200, { ok: true, overview });
});

// 部署 owner 的资料（名字 + 头像）——dashboard 左上角和历史弹窗展示「我」。
// owner 身份来自 deployment identity（ownerUnionId），头像经 contact API 查询
// （带缓存）；未绑定 owner 或查不到时回退名字/null。
ipcRoute('GET', '/api/owner-profile', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  const me = getDeploymentIdentity(config.session.dataDir);
  if (!me.ownerUnionId) return jsonRes(res, 200, { ok: false, error: 'owner_unbound', name: me.ownerName ?? null });
  const p = await getUserProfile(cachedLarkAppId, me.ownerUnionId, 'union_id');
  jsonRes(res, 200, { ok: true, name: p?.name ?? me.ownerName ?? null, avatarUrl: p?.avatarUrl ?? null });
});

// 会话重命名：dashboard 看板卡片就地编辑标题。title 只是展示元数据（飞书话题
// 标题不受影响），但全视图（看板/状态板/表格/抽屉）读同一字段，改一处全变。
ipcRoute('POST', '/api/sessions/:sessionId/rename', async (req, res, params) => {
  let body: { title?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const title = normalizeSessionTitle(body.title);
  if (!title) return jsonRes(res, 400, { ok: false, error: 'bad_title' });
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  session.title = title;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: params.sessionId, patch: { title } },
  });
  jsonRes(res, 200, { ok: true, title });
});

// 会话锁定：保护被锁定会话不被 dashboard「清理空闲」批量关闭。锁定是会话元数据，
// 不影响用户显式点击关闭/批量关闭，避免把会话变成不可管理状态。
ipcRoute('POST', '/api/sessions/:sessionId/lock', async (req, res, params) => {
  let body: { locked?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof body.locked !== 'boolean') return jsonRes(res, 400, { ok: false, error: 'bad_locked' });
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  if (body.locked) session.locked = true;
  else delete session.locked;
  sessionStore.updateSession(session);
  const locked = !!session.locked;
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: params.sessionId, patch: { locked } },
  });
  jsonRes(res, 200, { ok: true, locked });
});

/**
 * Mint the WRITABLE web-terminal link for a live session — the dashboard
 * counterpart to the Lark card's "🔑 获取操作链接" button. Returns the URL with
 * the worker's write `?token=` appended, built daemon-side via buildTerminalUrl
 * so it picks up this process's live terminal-proxy state (the dashboard
 * aggregator can't see it). The token is returned ONLY here, on demand —
 * deliberately never embedded in /api/sessions rows or the SSE stream.
 *
 * Two gates protect it: at the dashboard's HTTP boundary this path is absent
 * from the public allow-list, so an anonymous browser 401s; and here on the
 * daemon IPC, tokenRouteAuthorized requires a loopback-HMAC signed with
 * .dashboard-secret, so a local process that merely knows the ipcPort still
 * can't pull a write token.
 */
ipcRoute('GET', '/api/sessions/:sessionId/write-link', (req, res, params) => {
  if (!tokenRouteAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerToken) return jsonRes(res, 409, { ok: false, error: 'terminal_unavailable' });
  jsonRes(res, 200, { ok: true, url: buildTerminalUrl(ds, { write: true }) });
});

/**
 * Deliver the writable-terminal card privately to the bot's owner(s) — the
 * `botmux term-link <id>` CLI command's backend. Unlike the GET route above
 * (which returns the URL to its single authenticated caller), this POSTs the
 * card into the owners' private Lark channels (ephemeral → DM fallback) and
 * returns ONLY delivery counts: the write token never crosses back to the CLI /
 * stdout. Same loopback-HMAC gate as write-link — it still hands out a control
 * credential, just into Lark rather than into the HTTP response.
 */
ipcRoute('POST', '/api/sessions/:sessionId/write-link-card', async (req, res, params) => {
  if (!tokenRouteAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const r = await deliverWriteLinkCardToOwners(ds);
  const status = r.ok ? 200
    : r.error === 'terminal_unavailable' ? 409
    : r.error === 'no_owner' ? 422
    : 502;
  jsonRes(res, status, r);
});

// ─── Sandbox landing (owner reviews the clone's diff then applies it back) ───
function workingDirForSession(sessionId: string): string | undefined {
  const ds = findActiveBySessionId(sessionId);
  if (ds) return ds.session.workingDir;
  return sessionStore.listSessions().find(s => s.sessionId === sessionId)?.workingDir;
}

ipcRoute('GET', '/api/sessions/:sessionId/sandbox-diff', (_req, res, params) => {
  const d = computeSandboxDiff(config.session.dataDir, params.sessionId, localeForBot(cachedLarkAppId));
  if (!d.ok) return jsonRes(res, 200, { ok: false, error: d.error });
  jsonRes(res, 200, {
    ok: true, empty: d.empty, files: d.files, insertions: d.insertions, deletions: d.deletions,
    statText: d.statText, patch: d.patch, workingDir: workingDirForSession(params.sessionId) ?? null,
  });
});

ipcRoute('POST', '/api/sessions/:sessionId/sandbox-land/:action', (_req, res, params) => {
  if (params.action === 'discard') return jsonRes(res, 200, { ok: true, discarded: true });
  if (params.action !== 'apply') return jsonRes(res, 400, { ok: false, error: 'unknown action' });
  const locLand = localeForBot(cachedLarkAppId);
  const wd = workingDirForSession(params.sessionId);
  if (!wd) return jsonRes(res, 404, { ok: false, error: t('sandbox.workingdir_not_found', undefined, locLand) });
  const d = computeSandboxDiff(config.session.dataDir, params.sessionId, locLand);
  if (!d.ok) return jsonRes(res, 200, { ok: false, error: d.error });
  if (d.empty) return jsonRes(res, 200, { ok: false, error: t('sandbox.no_changes_left', undefined, locLand) });
  const a = applySandboxDiff(wd, config.session.dataDir, params.sessionId, locLand);
  jsonRes(res, 200, a.ok ? { ok: true, files: d.files, insertions: d.insertions, deletions: d.deletions, workingDir: wd } : { ok: false, error: a.error });
});

/**
 * Reactivate a closed session — counterpart to `/close`. Used by both the
 * "▶️ 恢复会话" card button (via card-handler) and the `botmux resume <id>`
 * CLI command (via this HTTP route). The CLI route also drops a notice into
 * the original Lark thread so users see why the session is alive again.
 */
ipcRoute('POST', '/api/sessions/:sessionId/resume', async (req, res, params) => {
  const sessionId = params.sessionId;
  const reg = getActiveSessionsRegistry();
  if (!reg) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });
  const result = await resumeSession(sessionId, reg);
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 409;
    return jsonRes(res, status, { ok: false, error: result.error, activeSessionId: result.activeSessionId });
  }

  const ds = result.ds;
  // `?wake=1` is an opt-in operational hook (no UI/CLI caller wires it today —
  // it's meant for direct `curl` recovery): instead of the default lazy
  // cold-resume on the next inbound message, fork the worker immediately so the
  // session is usable right away. Off by default keeps every existing caller's
  // behaviour unchanged.
  const wake = new URL(req.url ?? '/', 'http://localhost').searchParams.get('wake') === '1';
  // Tell the dashboard the row flipped back to active (mirror of session.update
  // emitted by closeSession). Use `null` for closedAt — `undefined` would be
  // dropped by JSON.stringify on the SSE wire and the aggregator's spread
  // (`{...cur, ...patch}`) would leave the stale closedAt in place.
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId,
      patch: { status: 'active', closedAt: null },
    },
  });

  // Notify the original chat so humans see why the session is alive again.
  // Routing follows session.scope — thread-scope replies into the thread root
  // (reply_in_thread=true), chat-scope posts a plain message to the chat (any
  // reply_in_thread call would silently get rejected or land on a stale root).
  const cliId = ds.session.cliId;
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const notice = JSON.stringify({ text: `🔄 会话已通过命令行恢复，发条消息继续与 ${cliName} 对话。` });
  if (ds.larkAppId) {
    if (ds.scope === 'chat' && ds.chatId) {
      getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true })
        .then((mode) => mode === 'topic' && ds.session.rootMessageId
          ? replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
          : sendMessage(ds.larkAppId, ds.chatId, notice, 'text'))
        .catch(err => logger.debug(`[resume] failed to post chat-scope resume notice: ${err}`));
    } else if (ds.session.rootMessageId) {
      replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
        .catch(err => logger.debug(`[resume] failed to post thread-scope resume notice: ${err}`));
    }
  }

  // Report the EFFECTIVE action, not the raw request flag: only fork when wake
  // was asked AND there's no live worker to clobber. (resumeSession always hands
  // back a worker:null ds today, so this matches `wake` in practice — but
  // reporting the action keeps the response honest if the guard ever broadens.)
  const woke = wake && (!ds.worker || ds.worker.killed);
  if (woke) {
    forkWorker(ds, '', true);
  }

  jsonRes(res, 200, {
    ok: true,
    sessionId,
    wake: woke,
    title: ds.session.title,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    workingDir: ds.session.workingDir,
    cliId,
  });
});

/**
 * Cross-daemon session transfer endpoint.
 *
 * Called by a *leader* daemon during `/relay --create` to instruct *peer*
 * daemons to migrate their own session (located by `sourceAnchor`) into a
 * newly-created chat. The peer daemon authenticates the request and runs its
 * own `transferSession()` internally — the leader never touches another
 * daemon's process / tmux / jsonl directly.
 *
 * Security:
 *   - Only accepts requests from 127.0.0.1 (no remote daemon coordination).
 *   - `requesterLarkAppId` must be a known bot in this machine's bots
 *     registry. The threat model assumes a malicious bot daemon process is
 *     already root-equivalent on the box; this check just prevents random
 *     other 127.0.0.1 processes from forging migrations.
 *   - `sourceAnchor` must match a session currently owned by *this* daemon
 *     (peer can only move its own sessions — never anybody else's).
 *   - Owner-only: only the original session owner may relocate the session.
 *
 * The leader passes `targetRootMessageId` — typically the leader's M1
 * notification message — so the peer's session lands anchored on a real
 * message in the new chat. Since the new chat is always chat-scope, the
 * rootMessageId is only used for audit / display, not routing.
 */
ipcRoute('POST', '/api/sessions/migrate-to-chat', async (req, res) => {
  const remote = req.socket.remoteAddress;
  // node may report '127.0.0.1' or '::ffff:127.0.0.1' (IPv4 mapped) or '::1'.
  const localish = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!localish) return jsonRes(res, 403, { ok: false, error: 'not_local' });

  let body: {
    sourceAnchor?: string;
    targetChatId?: string;
    targetRootMessageId?: string;
    requesterLarkAppId?: string;
    requestingUserOpenId?: string;
    requestingUserUnionId?: string;
  };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'invalid_json' });
  }
  const { sourceAnchor, targetChatId, targetRootMessageId, requesterLarkAppId, requestingUserOpenId, requestingUserUnionId } = body;
  if (!sourceAnchor || !targetChatId || !targetRootMessageId || !requesterLarkAppId || !requestingUserOpenId) {
    return jsonRes(res, 400, { ok: false, error: 'missing_field' });
  }

  // Requester must be a live botmux daemon — not a random localhost process
  // pretending to be one. We check the cross-process daemon registry
  // (~/.botmux/data/dashboard-daemons/<larkAppId>.json + heartbeat) rather
  // than this process's local bot list: in production each bot has its own
  // daemon process, and a per-process `getAllBots()` only sees its OWN bot
  // (botmux is one-daemon-per-bot at boot, daemon.ts:2367). Using the
  // registry lets the peer recognise the leader bot.
  const requesterKnown = listOnlineDaemons().some(d => d.larkAppId === requesterLarkAppId);
  if (!requesterKnown) return jsonRes(res, 403, { ok: false, error: 'unknown_requester' });

  // Locate this daemon's own session at the given source anchor. We match
  // by anchor (rootMessageId for thread-scope, chatId for chat-scope) AND
  // larkAppId — multi-bot threads share a rootMessageId but each bot's
  // session is uniquely keyed by (anchor, larkAppId).
  const reg = getActiveSessionsRegistry();
  if (!reg) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });

  let ds: ReturnType<typeof findActiveBySessionId> = undefined;
  for (const candidate of reg.values()) {
    const candAnchor = candidate.scope === 'chat' ? candidate.chatId : candidate.session.rootMessageId;
    if (candAnchor === sourceAnchor && candidate.larkAppId === cachedLarkAppId) {
      ds = candidate;
      break;
    }
  }
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'no_session_at_anchor' });

  // Owner-only: the user who triggered /relay --create must own this peer's
  // session too. If a peer's session is owned by someone else, we refuse —
  // the leader summarises this as "skipped: not your session" rather than
  // forcing a transfer of someone else's work.
  //
  // Cross-app identity: Lark `open_id` is app-scoped — the same user has a
  // different open_id in each bot's namespace, so leader's senderOpenId
  // and peer's stored ownerOpenId cannot be compared directly. Prefer
  // `union_id` (stable across apps within a tenant) when both sides have
  // it. Sessions persisted before ownerUnionId existed fall through to a
  // lazy backfill: resolve peer's stored open_id → union_id via Lark API
  // (using PEER's bot client, so the open_id is in the right namespace),
  // persist for next time, and compare.
  if (ds.session.ownerOpenId) {
    let peerOwnerUnionId = ds.session.ownerUnionId;
    if (!peerOwnerUnionId && requestingUserUnionId) {
      // Backfill: legacy session, look up the union_id via Lark API once
      // and persist it so subsequent comparisons (and any other code path
      // that grows to read it) are fast.
      const looked = await resolveUnionIdFromOpenId(ds.larkAppId, ds.session.ownerOpenId);
      if (looked) {
        peerOwnerUnionId = looked;
        ds.session.ownerUnionId = looked;
        sessionStore.updateSession(ds.session);
      }
    }
    const ownerMatch = (peerOwnerUnionId && requestingUserUnionId)
      ? peerOwnerUnionId === requestingUserUnionId
      // Same-bot fallback (no union_id on either side): open_id namespaces
      // match, so direct compare works.
      : ds.session.ownerOpenId === requestingUserOpenId;
    if (!ownerMatch) {
      return jsonRes(res, 403, { ok: false, error: 'not_session_owner' });
    }
  }

  // Target chat was built by the leader's /relay --create — by
  // construction a regular group, chat-scope (M1 is the audit anchor).
  const result = await transferSession(ds.session.sessionId, targetChatId, targetRootMessageId, 'group', 'chat');
  if (!result.ok) {
    return jsonRes(res, 500, { ok: false, error: result.error });
  }
  jsonRes(res, 200, { ok: true, sessionId: ds.session.sessionId });
});

ipcRoute('POST', '/api/sessions/:sessionId/locate', async (_req, res, params) => {
  const sid = params.sessionId;
  const acq = locateLimiter.tryAcquire(sid);
  if (!acq.ok) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(acq.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterMs: acq.retryAfterMs }));
    return;
  }
  // Resolve owning session (active first, then closed-store fallback). The
  // locate marker is a bare @-mention of the session's owner — no other text,
  // no AppLink redirect on the frontend. The notification on the user's
  // device is enough to navigate them back to the topic.
  const ds = findActiveBySessionId(sid);
  const closed = ds ? null : sessionStore.getSession(sid);
  const ctx = ds
    ? {
        larkAppId: ds.larkAppId,
        rootMessageId: ds.session.rootMessageId,
        ownerOpenId: ds.session.ownerOpenId,
      }
    : closed
      ? {
          larkAppId: closed.larkAppId ?? '',
          rootMessageId: closed.rootMessageId,
          ownerOpenId: closed.ownerOpenId,
        }
      : null;
  if (!ctx || !ctx.larkAppId) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  if (!ctx.ownerOpenId) {
    return jsonRes(res, 422, { ok: false, error: 'no_owner' });
  }
  try {
    const messageId = await replyMessage(
      ctx.larkAppId,
      ctx.rootMessageId,
      `<at user_id="${ctx.ownerOpenId}"></at>`,
      'text',
      true,
    );
    jsonRes(res, 200, { ok: true, messageId });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: String(err) });
  }
});

// ─── Schedules ─────────────────────────────────────────────────────────────

export interface ScheduleRow {
  id: string;
  name: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  larkAppId?: string;
  botName?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local' | 'new-topic';
  feishuChatLink: string;
}

function composeScheduleRow(t: ScheduledTask): ScheduleRow {
  return {
    id: t.id,
    name: t.name,
    parsed: t.parsed,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: t.chatId,
    rootMessageId: t.rootMessageId,
    larkAppId: t.larkAppId,
    botName: getBotName(),
    enabled: t.enabled,
    createdAt: t.createdAt,
    lastRunAt: t.lastRunAt,
    nextRunAt: t.nextRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
    repeat: t.repeat,
    deliver: t.deliver ?? 'origin',
    feishuChatLink: feishuChatLink(t.chatId, getBotBrand(t.larkAppId)),
  };
}

ipcRoute('GET', '/api/schedules', (_req, res) => {
  // Filter to tasks owned by this daemon's bot (multi-bot setups run one
  // daemon per bot — each only manages its own schedules).  belongsToOwner
  // falls through to "all tasks" when no owner filter is configured (tests).
  const all = scheduleStore.listTasks().filter(t => scheduler.belongsToOwner(t));
  jsonRes(res, 200, { schedules: all.map(composeScheduleRow) });
});

ipcRoute('POST', '/api/schedules/:id/run',    (_req, res, p) => jsonRes(res, 200, scheduler.runNow(p.id)));
ipcRoute('POST', '/api/schedules/:id/pause',  (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, false)));
ipcRoute('POST', '/api/schedules/:id/resume', (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, true)));
// Toggle delivery mode between 'origin' (reply in original thread) and
// 'new-topic' (open a brand-new topic + fresh session on every fire).
ipcRoute('POST', '/api/schedules/:id/delivery', (_req, res, p) => jsonRes(res, 200, scheduler.toggleDelivery(p.id)));

ipcRoute('POST', '/api/trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, errorCode: 'bot_not_found', error: 'larkAppId_not_set' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, errorCode: 'trigger_failed', error: 'active session registry unavailable' });
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, errorCode: 'bad_json', error: 'invalid JSON body' });
  }
  const valid = validateTriggerRequest(body);
  if (!valid.ok) return jsonRes(res, valid.status, valid.body);
  try {
    let result;
    if (valid.request.target.kind === 'workflow') {
      if (!workflowRunner) {
        return jsonRes(res, 501, { ok: false, errorCode: 'workflow_trigger_not_implemented', error: 'workflow runner not wired on this daemon' });
      }
      result = await triggerWorkflowFromEnvelope(valid.request, { larkAppId: cachedLarkAppId, runWorkflow: workflowRunner });
    } else {
      result = await triggerSessionTurn(valid.request, { larkAppId: cachedLarkAppId, activeSessions });
    }
    const status = result.ok
      ? 200
      : result.errorCode === 'bot_not_in_chat'
        ? 403
        : result.errorCode === 'session_not_found'
          ? 404
        : result.errorCode === 'wait_timeout'
          ? 504
        : result.errorCode === 'target_required' || result.errorCode === 'bad_request'
          ? 400
          : 500;
    return jsonRes(res, status, result);
  } catch (e: any) {
    return jsonRes(res, 500, { ok: false, errorCode: 'trigger_failed', error: e?.message ?? String(e) });
  }
});

// ─── Groups (Phase B) ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/groups', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const chats = await groupsStore.listChats(cachedLarkAppId);
    // Stamp a firstSeenAt timestamp for every chat (preserve existing values,
    // backfill new ones with Date.now()). Lark doesn't expose chat create_time
    // anywhere, so the dashboard sorts by this client-side proxy instead.
    const seenMap = chatFirstSeenStore.markSeenBulk(chats.map(c => c.chatId));
    // Annotate each chat with its oncall binding (if any) so the dashboard
    // matrix can show toggle state without a second round-trip.
    const enriched = chats.map(c => {
      const oncall = oncallStore.getOncallStatus(cachedLarkAppId, c.chatId);
      const hasRole = resolveRoleFile(cachedLarkAppId, c.chatId) !== null;
      // /introduce 记录的外部 botmux 机器人（按名字）——dashboard 团队看板用
      // 它识别「介绍过同团队机器人的协作群」。
      const observedBotNames = observedBotsStore
        .listObservedBots(config.session.dataDir, cachedLarkAppId, c.chatId)
        .map(b => b.name);
      return { ...c, oncallChat: oncall ?? null, firstSeenAt: seenMap.get(c.chatId) ?? null, hasRole, observedBotNames };
    });
    jsonRes(res, 200, { chats: enriched });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('GET', '/api/groups/:chatId/membership', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const inChat = await groupsStore.isInChat(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { inChat });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('POST', '/api/groups/:chatId/add-bots', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { larkAppIds?: unknown };
  try {
    body = await readJsonBody<{ larkAppIds?: string[] }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  try {
    const result = await groupsStore.addBotToChat(cachedLarkAppId, p.chatId, body.larkAppIds as string[]);
    jsonRes(res, 200, { result });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

// Disband (delete) a chat from this bot's identity. Public route picks an
// in-chat bot as the executor; this just performs the call.
ipcRoute('POST', '/api/groups/:chatId/disband', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.disbandChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// Make this bot leave the chat. Always works on a member bot per Lark docs.
ipcRoute('POST', '/api/groups/:chatId/leave', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.leaveChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// 平台团队大厅打卡：dashboard 在 team-sync 后编排本机 bot 往大厅（bot-only 群）
// 发登记消息。实测大厅只有「直接点名 @」会投递（普通消息/自 @/@all 全部静默），
// 所以打卡消息点名 @ 本机其他未入册 bot（mentionNames，open_id 由本 app 的
// cross-ref 解析——open_id 是 per-app 的，只有发送方自己能解析），被点到的 bot
// 从 mentions 学到自己的 union_id。回声路径保留（有 receive-all scope 的应用仍可
// 从自家消息学）。已入册且无人可教时幂等跳过。
ipcRoute('POST', '/api/platform/hall-announce', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: { chatId?: unknown; mentionNames?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  if (!/^oc_[0-9a-f]+$/i.test(chatId)) return jsonRes(res, 400, { ok: false, error: 'bad_chat_id' });
  const mentionNames = Array.isArray(body.mentionNames)
    ? body.mentionNames.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  // 解析点名目标：name → 本 app 视角的 open_id（cross-ref，来自历史 @ 事件）。解析不到的跳过。
  const resolved: Array<{ name: string; openId: string }> = [];
  if (mentionNames.length) {
    try {
      const map: Record<string, string> = JSON.parse(
        readFileSync(join(config.session.dataDir, `bot-openids-${cachedLarkAppId}.json`), 'utf-8'),
      );
      for (const name of mentionNames) {
        const openId = map[name];
        if (typeof openId === 'string' && openId.startsWith('ou_')) resolved.push({ name, openId });
      }
    } catch { /* 无 cross-ref → 全部解析失败，退化为普通打卡 */ }
  }
  if (getBotUnionId(config.session.dataDir, cachedLarkAppId) && resolved.length === 0) {
    return jsonRes(res, 200, { ok: true, skipped: 'already_learned' });
  }
  try {
    const atPrefix = resolved.map((r) => `<at user_id="${r.openId}">${r.name}</at> `).join('');
    // 自己还没入册 → 带 #hall-echo 请求回执：被点到的 bot 会 @ 回我们一次，
    // 我们从回执的 mentions[] 学到自己的 union_id（见 event-dispatcher hall 分支）。
    const echoTag = getBotUnionId(config.session.dataDir, cachedLarkAppId) ? '' : ' #hall-echo';
    await sendMessage(cachedLarkAppId, chatId, atPrefix + t('platform.hall_announce', undefined, localeForBot(cachedLarkAppId)) + echoTag, 'text');
    jsonRes(res, 200, { ok: true, mentioned: resolved.map((r) => r.name), unresolved: mentionNames.filter((n) => !resolved.some((r) => r.name === n)) });
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: `send_failed: ${(e as Error).message}` });
  }
});

// ─── Oncall bindings (dashboard) ───────────────────────────────────────────
// PUT  /api/oncall/:chatId  body: {workingDir} — bind or update workingDir
// DELETE /api/oncall/:chatId — unbind
//
// Auth: dashboard's loopback token is the gate. No per-chat owner concept —
// allowedUsers governs who can operate via Lark too (see canOperate).

ipcRoute('PUT', '/api/oncall/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { workingDir?: unknown };
  try { body = await readJsonBody<{ workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
  if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });

  // Same validation as /oncall bind in Lark — exists + is a directory.
  const v = validateWorkingDir(workingDir);
  if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
  const resolvedPath = v.resolvedPath;

  const r = await oncallStore.bindOncall(cachedLarkAppId, p.chatId, workingDir);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, entry: r.entry, created: r.created, resolvedPath });
});

ipcRoute('DELETE', '/api/oncall/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  // Idempotent: always succeeds. unbindOncall writes a tombstone into
  // defaultOncallAutoboundChats so the auto-bind judge won't reinstate this
  // chat on the next observation, even if it had no prior binding.
  const r = await oncallStore.unbindOncall(cachedLarkAppId, p.chatId);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, wasBound: r.wasBound });
});

// ─── Role management (dashboard) ───────────────────────────────────────────
// GET    /api/roles/:chatId  → { chatId, content, byteLength, injectMode, effectiveContent, effectiveSource }
// PUT    /api/roles/:chatId  body: {content?, injectMode?} → write role file and/or injection mode
// DELETE /api/roles/:chatId  → remove role file (and injection-mode sidecar)

ipcRoute('GET', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const content = resolveRoleFile(cachedLarkAppId, p.chatId);
  const effective = resolveRole(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, {
    chatId: p.chatId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasRole: content !== null,
    injectMode: readRoleInjectMode(cachedLarkAppId, p.chatId),
    effectiveContent: effective.content,
    effectiveSource: effective.source,
    effectiveByteLength: effective.content ? Buffer.byteLength(effective.content, 'utf-8') : 0,
    hasEffectiveRole: effective.content !== null,
  });
});

ipcRoute('PUT', '/api/roles/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  let body: { content?: unknown; injectMode?: unknown };
  try { body = await readJsonBody<{ content?: string; injectMode?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // injectMode is a per-chat setting that can be updated on its own (no content)
  // — e.g. toggling "inject once" for a chat whose effective role is the team
  // default. Only 'every'/'once' are accepted; anything else is ignored.
  const injectMode: RoleInjectMode | undefined =
    body.injectMode === 'once' ? 'once' : body.injectMode === 'every' ? 'every' : undefined;
  const hasContentField = typeof body.content === 'string';
  const content = hasContentField ? (body.content as string).trim() : '';
  if (!hasContentField && injectMode === undefined) {
    return jsonRes(res, 400, { ok: false, error: 'content_or_inject_mode_required' });
  }
  if (hasContentField && !content) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    if (hasContentField) writeRoleFile(cachedLarkAppId, p.chatId, content);
    if (injectMode !== undefined) writeRoleInjectMode(cachedLarkAppId, p.chatId, injectMode);
    jsonRes(res, 200, { ok: true });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const existed = deleteRoleFile(cachedLarkAppId, p.chatId);
  deleteRoleInjectMode(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, { ok: true, existed });
});

// ─── Role profile management (dashboard) ──────────────────────────────────
// Profiles are authoring/storage helpers only; applying one writes this bot's
// entry into the selected chat role and does not alter runtime role layering.

ipcRoute('GET', '/api/role-profiles', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const profiles = listRoleProfiles(config.session.dataDir).map(p => ({
    ...p,
    hasCurrentBotEntry: readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId) !== null,
  }));
  jsonRes(res, 200, { profiles, larkAppId: cachedLarkAppId });
});

ipcRoute('GET', '/api/role-profiles/:profileId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const entries = listRoleProfileEntries(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { profileId: p.profileId, entries });
});

ipcRoute('GET', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  jsonRes(res, 200, {
    profileId: p.profileId,
    larkAppId: cachedLarkAppId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasEntry: content !== null,
  });
});

ipcRoute('PUT', '/api/role-profiles/:profileId/:larkAppId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { content?: unknown; allowEmpty?: unknown };
  try { body = await readJsonBody<{ content?: string; allowEmpty?: boolean }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const allowEmpty = body.allowEmpty === true;
  if (!content && !allowEmpty) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    writeRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId, content, { allowEmpty });
    jsonRes(res, 200, { ok: true, byteLength: Math.min(Buffer.byteLength(content, 'utf-8'), MAX_ROLE_PROFILE_ENTRY_BYTES) });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const existed = deleteRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  deleteRoleProfileIfEmpty(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { ok: true, existed });
});

ipcRoute('POST', '/api/role-profiles/:profileId/apply', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { chatId?: unknown; larkAppId?: unknown; force?: unknown; preview?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : '';
  const larkAppId = typeof body.larkAppId === 'string' && body.larkAppId.trim() ? body.larkAppId.trim() : '';
  if (!chatId || !larkAppId) return jsonRes(res, 400, { ok: false, error: 'chatId_and_larkAppId_required' });
  if (!isValidRoleChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  if (larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  if (content === null) return jsonRes(res, 200, { ok: false, error: 'missing_entry', changed: false });
  const existing = resolveRoleFile(cachedLarkAppId, chatId);
  const preview = body.preview === true;
  const force = body.force === true;
  if (preview) {
    return jsonRes(res, 200, {
      ok: true,
      preview: true,
      changed: false,
      wouldOverwrite: existing !== null,
      wouldRefuse: existing !== null && !force,
      content,
      byteLength: Buffer.byteLength(content, 'utf-8'),
    });
  }
  if (existing && !force) return jsonRes(res, 409, { ok: false, error: 'chat_role_exists', changed: false });
  if (!content) {
    const existed = deleteRoleFile(cachedLarkAppId, chatId);
    return jsonRes(res, 200, { ok: true, changed: existed, byteLength: 0, deleted: existed });
  }
  writeRoleFile(cachedLarkAppId, chatId, content);
  jsonRes(res, 200, { ok: true, changed: true, byteLength: Buffer.byteLength(content, 'utf-8') });
});

// ─── Per-bot defaultOncall (dashboard) ─────────────────────────────────────
// GET  /api/bot-default-oncall → returns this daemon's current config
// PUT  /api/bot-default-oncall  body: { enabled, workingDir }
//
// Forward-only policy: enabling does not backfill or distinguish "old vs new"
// chats. Any group the bot is in — present or future — auto-binds on its
// next observed topic if it has no existing oncall binding and is not in
// the tombstone list. `since` is stamped purely as informational metadata
// (UI shows "上次启用时间").

ipcRoute('GET', '/api/bot-default-oncall', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const { defaultOncall, autoboundChats } = oncallStore.getBotDefaultOncall(cachedLarkAppId);
  const cardPrefs = cardPrefsStore.getBotCardPrefs(cachedLarkAppId);
  const grantPrefs = grantPrefsStore.getBotGrantPrefs(cachedLarkAppId);
  let p2pMode: 'thread' | 'chat' = 'thread';
  try { if (getBot(cachedLarkAppId).config.p2pMode === 'chat') p2pMode = 'chat'; } catch { /* default thread */ }
  let cliId = '';
  let wrapperCli: string | null = null;
  let model: string | null = null;
  let agentSelectionKey = '';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    cliId = cfg.cliId;
    wrapperCli = typeof cfg.wrapperCli === 'string' && cfg.wrapperCli.trim() ? cfg.wrapperCli : null;
    model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : null;
    agentSelectionKey = selectionKeyForBot(cliId, wrapperCli ?? undefined);
  } catch { /* no registered bot */ }
  let maxLiveWorkers: number | null = null;
  try {
    const m = getBot(cachedLarkAppId).config.maxLiveWorkers;
    if (typeof m === 'number' && Number.isInteger(m) && m > 0) maxLiveWorkers = m;
  } catch { /* default unlimited */ }
  // startupCommands → newline-joined for the dashboard textarea (one per line).
  let startupCommands = '';
  try {
    const sc = getBot(cachedLarkAppId).config.startupCommands;
    if (Array.isArray(sc) && sc.length) startupCommands = sc.join('\n');
  } catch { /* none */ }
  // Per-bot env → pretty JSON for the dashboard textarea. The dashboard is
  // owner-authenticated, so showing the real values here is acceptable (same
  // as editing bots.json directly); the chat-facing /config get masks them.
  let env = '';
  try {
    const e = getBot(cachedLarkAppId).config.env;
    if (e && typeof e === 'object' && Object.keys(e).length) env = JSON.stringify(e, null, 2);
  } catch { /* none */ }
  // defaultWorkingDir — the "仅默认目录" mode source. Mutually exclusive with
  // defaultOncall in the dashboard 3-way selector; the frontend derives the
  // current mode from (defaultOncall.enabled ? oncall : defaultWorkingDir ? default : off).
  let defaultWorkingDir: string | null = null;
  try {
    const d = getBot(cachedLarkAppId).config.defaultWorkingDir;
    if (typeof d === 'string' && d.trim()) defaultWorkingDir = d;
  } catch { /* none */ }
  // 展示名编辑框数据：displayName = 自定义备注名（null = 未设，跟随飞书名称）；
  // larkBotName = 飞书探测到的应用名（供 placeholder /「恢复默认」提示用）。
  let displayName: string | null = null;
  let larkBotName: string | null = null;
  try {
    const bot = getBot(cachedLarkAppId);
    displayName = bot.config.displayName ?? null;
    larkBotName = bot.botName ?? null;
  } catch { /* none */ }
  jsonRes(res, 200, {
    larkAppId: cachedLarkAppId,
    botName: getBotName(),
    displayName,
    larkBotName,
    cliId,
    wrapperCli,
    model,
    agentSelectionKey,
    defaultOncall: defaultOncall ?? { enabled: false, workingDir: '', since: 0 },
    defaultWorkingDir,
    autoboundChatCount: autoboundChats.length,
    brandLabel: brandStore.getBotBrandLabel(cachedLarkAppId) ?? null,
    sandbox: sandboxStore.getBotSandbox(cachedLarkAppId),
    disableStreamingCard: cardPrefs.disableStreamingCard,
    silentTurnReactions: cardPrefs.silentTurnReactions,
    writableTerminalLinkInCard: cardPrefs.writableTerminalLinkInCard,
    privateCard: cardPrefs.privateCard,
    botToBotSameDir: cardPrefs.botToBotSameDir,
    autoStartOnGroupJoin: cardPrefs.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: cardPrefs.autoStartOnGroupJoinPrompt,
    autoStartOnNewTopic: cardPrefs.autoStartOnNewTopic,
    regularGroupReplyMode: cardPrefs.regularGroupReplyMode,
    regularGroupMentionMode: cardPrefs.regularGroupMentionMode,
    docSubscribeDefaultMode: cardPrefs.docSubscribeDefaultMode,
    restrictGrantCommands: grantPrefs.restrictGrantCommands,
    autoGrantRequestCards: grantPrefs.autoGrantRequestCards,
    messageQuotaDefaultLimit: grantPrefs.messageQuotaDefaultLimit,
    p2pMode,
    maxLiveWorkers,
    startupCommands,
    launchShell: getBot(cachedLarkAppId).config.launchShell ?? '',
    env,
    summaryRange: summaryRangeFromBotConfig(getBot(cachedLarkAppId).config),
    skills: getBot(cachedLarkAppId).config.skills ?? null,
  });
});

// Per-bot card-behaviour toggles. Body may carry any subset of booleans; only
// present keys are applied.
ipcRoute('PUT', '/api/bot-card-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    disableStreamingCard?: unknown; silentTurnReactions?: unknown; writableTerminalLinkInCard?: unknown; privateCard?: unknown;
    botToBotSameDir?: unknown;
    autoStartOnGroupJoin?: unknown; autoStartOnGroupJoinPrompt?: unknown; autoStartOnNewTopic?: unknown;
    regularGroupReplyMode?: unknown; regularGroupMentionMode?: unknown; docSubscribeDefaultMode?: unknown;
  };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const patch: {
    disableStreamingCard?: boolean; silentTurnReactions?: boolean; writableTerminalLinkInCard?: boolean; privateCard?: boolean;
    botToBotSameDir?: boolean;
    autoStartOnGroupJoin?: boolean; autoStartOnGroupJoinPrompt?: string; autoStartOnNewTopic?: boolean;
    regularGroupReplyMode?: ChatReplyMode; regularGroupMentionMode?: 'always' | 'topic' | 'never' | 'ambient';
    docSubscribeDefaultMode?: 'mention-only' | 'all';
  } = {};
  if (typeof body.disableStreamingCard === 'boolean') patch.disableStreamingCard = body.disableStreamingCard;
  if (typeof body.botToBotSameDir === 'boolean') patch.botToBotSameDir = body.botToBotSameDir;
  if (typeof body.silentTurnReactions === 'boolean') patch.silentTurnReactions = body.silentTurnReactions;
  if (typeof body.writableTerminalLinkInCard === 'boolean') patch.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
  if (typeof body.privateCard === 'boolean') patch.privateCard = body.privateCard;
  if (typeof body.autoStartOnGroupJoin === 'boolean') patch.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
  if (typeof body.autoStartOnGroupJoinPrompt === 'string') patch.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
  if (typeof body.autoStartOnNewTopic === 'boolean') patch.autoStartOnNewTopic = body.autoStartOnNewTopic;
  if (typeof body.regularGroupReplyMode === 'string') {
    const m = normalizeChatReplyMode(body.regularGroupReplyMode);
    if (m) patch.regularGroupReplyMode = m;
  }
  if (body.regularGroupMentionMode === 'always' || body.regularGroupMentionMode === 'topic' || body.regularGroupMentionMode === 'never' || body.regularGroupMentionMode === 'ambient') {
    patch.regularGroupMentionMode = body.regularGroupMentionMode;
  }
  if (body.docSubscribeDefaultMode === 'mention-only' || body.docSubscribeDefaultMode === 'all') {
    patch.docSubscribeDefaultMode = body.docSubscribeDefaultMode;
  }
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await cardPrefsStore.updateBotCardPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

// Per-bot explicit `/summary` history range. Body `{ limit, sinceHours }`.
ipcRoute('PUT', '/api/bot-summary-range', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const r = await updateDashboardSummaryRange(cachedLarkAppId, raw);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Backward-compatible dashboard endpoint from the short-lived keyword-trigger UI.
ipcRoute('PUT', '/api/bot-summary-trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { limit: (raw as Record<string, unknown>).limit, sinceHours: (raw as Record<string, unknown>).sinceHours }
    : raw;
  const r = await updateDashboardSummaryRange(cachedLarkAppId, body);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Per-bot 授权偏好。Body 任意子集：
//   • restrictGrantCommands: boolean       — 限制被授权人只能纯对话
//   • autoGrantRequestCards: boolean       — 未授权 @ 被挡住时是否发 grant 申请卡
//   • messageQuotaDefaultLimit: number|null — 默认消息额度（null = 关闭，正整数 = 启用）
ipcRoute('PUT', '/api/bot-grant-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // 顶层必须是对象：JSON `null` / 数字 / 字符串等都拒（null 解引用会抛 → 500）。
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as { restrictGrantCommands?: unknown; autoGrantRequestCards?: unknown; messageQuotaDefaultLimit?: unknown };

  const patch: { restrictGrantCommands?: boolean; autoGrantRequestCards?: boolean; messageQuotaDefaultLimit?: number | null } = {};
  if (typeof body.restrictGrantCommands === 'boolean') patch.restrictGrantCommands = body.restrictGrantCommands;
  if (typeof body.autoGrantRequestCards === 'boolean') patch.autoGrantRequestCards = body.autoGrantRequestCards;
  // null（含 JSON null）= 关闭默认额度；number = 设定（store 内再校验正整数）。
  if (body.messageQuotaDefaultLimit === null) patch.messageQuotaDefaultLimit = null;
  else if (typeof body.messageQuotaDefaultLimit === 'number') patch.messageQuotaDefaultLimit = body.messageQuotaDefaultLimit;
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await grantPrefsStore.updateBotGrantPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

// Per-bot card footer brand label. Body `{ brandLabel: string | null }`:
//   • string (incl. '')  → store verbatim ('' = brand off)
//   • null / absent      → clear the key (revert to default botmux brand)
ipcRoute('PUT', '/api/bot-brand-label', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { brandLabel?: unknown };
  try { body = await readJsonBody<{ brandLabel?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const next: string | null = typeof body.brandLabel === 'string' ? body.brandLabel : null;
  const r = await brandStore.updateBotBrandLabel(cachedLarkAppId, next);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, brandLabel: r.brandLabel });
});

// 机器人改名（dashboard 档案头 ✎ 入口）。Body `{ name: string }`。
// 主路径：daemon 注册的 renamer 走开放平台自动化真改飞书应用名（改基础信息 +
// 建版发布，群内显示名生效）；失败（Web 登录态过期 / 非协作者 / lark 租户等）
// 自动降级为仅改 botmux 展示名 displayName，并把原因作为 warning 返回给前端。
// 响应：{ ok, mode: 'feishu'|'local', botName, warning?, message? }。
ipcRoute('PUT', '/api/bot-rename', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { name?: unknown };
  try { body = await readJsonBody<{ name?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('displayName');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.name === 'string' ? body.name.trim() : '';
  if (!raw) return jsonRes(res, 400, { ok: false, error: 'name_required' });
  // 长度等校验与 IM /config 入口共用（字段 spec 的 maxLen，coerceConfigValue 执行）。
  const c = coerceConfigValue(spec, raw);
  if (!c.ok) return jsonRes(res, 400, { ok: false, error: c.reason });
  const name = c.value as string;

  // 主路径：开放平台真改名（daemon 注册；成功时 daemon 侧已同步 botName /
  // descriptor / bots-info 并清掉冗余的 displayName）。
  if (botRenamer) {
    let renamed: BotRenameOutcome;
    try {
      renamed = await botRenamer(name);
    } catch (err) {
      renamed = { ok: false, reason: 'api_error', message: err instanceof Error ? err.message : String(err) };
    }
    if (renamed.ok) {
      return jsonRes(res, 200, { ok: true, mode: 'feishu', botName: getBotName() });
    }
    // 降级：仅改 botmux 展示名，带上飞书侧失败原因让前端明示。
    const fallback = await applyConfigField(cachedLarkAppId, spec, name);
    if (!fallback.ok) return jsonRes(res, 400, { ok: false, error: fallback.reason, warning: renamed.reason, message: renamed.message });
    return jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: renamed.reason, message: renamed.message });
  }

  // 无 renamer（daemon 未注册，理论上只在测试环境出现）→ 直接走本地展示名。
  const r = await applyConfigField(cachedLarkAppId, spec, name);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: 'renamer_not_wired' });
});

// Per-bot agent launch settings. Body `{ cliId, model }` where `cliId` is the
// dashboard selection key (plain adapter id or a wrapper option such as
// `ttadk-x-codex`). Changes affect the next spawned CLI session; existing
// sessions frozen on a different cliId/wrapperCli are closed immediately, so
// a later lazy resume can't resurrect the old CLI (#346 covered the restart
// path; this covers the hot-switch path).
ipcRoute('PUT', '/api/bot-agent', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { cliId?: unknown; model?: unknown };
  try { body = await readJsonBody<{ cliId?: unknown; model?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const key = typeof body.cliId === 'string' && body.cliId.trim() ? body.cliId.trim() : '';
  if (!key) return jsonRes(res, 400, { ok: false, error: 'cli_required' });
  let selected: ReturnType<typeof resolveCliSelection>;
  try {
    selected = resolveCliSelection(key);
  } catch (err: any) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_cli', message: err?.message ?? String(err) });
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';

  const r = await rmwBotEntry(cachedLarkAppId, (entry) => {
    entry.cliId = selected.cliId;
    if (selected.wrapperCli) entry.wrapperCli = selected.wrapperCli;
    else delete entry.wrapperCli;
    if (model) entry.model = model;
    else delete entry.model;
    return { write: true, result: null };
  });
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });

  const bot = getBot(cachedLarkAppId);
  bot.config.cliId = selected.cliId;
  if (selected.wrapperCli) bot.config.wrapperCli = selected.wrapperCli;
  else bot.config.wrapperCli = undefined;
  bot.config.model = model || undefined;

  // 热切后立刻清掉本 bot 名下失配的存量会话——否则它们冻结的旧 CLI 会被下一条
  // 消息 lazy resume 复活，要等下次 daemon 重启才被 restore 守卫清理。
  const closedMismatchedSessions = await closeCliMismatchedSessionsForBot(cachedLarkAppId);

  const selectionKey = selectionKeyForBot(selected.cliId, selected.wrapperCli);
  jsonRes(res, 200, {
    ok: true,
    cliId: selected.cliId,
    wrapperCli: selected.wrapperCli ?? null,
    model: model || null,
    selectionKey,
    closedMismatchedSessions,
  });
});

// Per-bot 私聊单聊模式 p2pMode。Body `{ p2pMode: 'chat' | 'thread' }`:
//   • 'chat'           → 私聊走扁平连续 chat-scope 会话
//   • 'thread'（默认）  → 清回每条 DM 独立 thread-scope 会话
// 走 applyConfigField（与 /botconfig 同一写盘 + 热更新路径），保证一致。
ipcRoute('PUT', '/api/bot-p2p-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { p2pMode?: unknown };
  try { body = await readJsonBody<{ p2pMode?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('p2pMode');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  // 只有 'chat' 有意义；其它（含 'thread'）一律清回默认，bots.json 保持干净。
  const value = body.p2pMode === 'chat' ? 'chat' : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, p2pMode: value ?? 'thread' });
});

// Per-bot 启动命令 startupCommands。Body `{ startupCommands: string }`（原始文本，
// 逗号/换行分隔，每条可带参数如 `/effort ultracode`）：空白 → 清除（不发任何命令）。
// 走 applyConfigField（与 /botconfig 文本子卡同一写盘 + 内存热更新路径），next-session
// 生效（下个会话起按序自动发）。
ipcRoute('PUT', '/api/bot-startup-commands', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { startupCommands?: unknown };
  try { body = await readJsonBody<{ startupCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('startupCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.startupCommands === 'string' ? body.startupCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, startupCommands: (value ?? []).join('\n') });
});

// Per-bot launch-shell override launchShell。Body `{ launchShell: string }`：
// 空字符串＝清除（回 $SHELL）。走 applyConfigField（与 /config launchShell 同一写盘
// + 内存热更新路径），next-session 生效（下个会话起用新 shell 启动 CLI）。
ipcRoute('PUT', '/api/bot-launch-shell', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { launchShell?: unknown };
  try { body = await readJsonBody<{ launchShell?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('launchShell');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.launchShell === 'string' ? body.launchShell : '';
  let value: string | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回 $SHELL
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, launchShell: value ?? '' });
});

// Per-bot 环境变量 env。Body `{ env: string }`（原始 JSON 文本，如
// `{"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"}` 让本 bot 走 GLM/第三方
// 服务商）：空白 → 清除；否则按 json kind 解析 + sanitizePerBotEnv 过滤后落盘。
// 走 applyConfigField（与 /botconfig 同一写盘 + 内存热更新路径），next-session 生效
// （下个会话起注入到 CLI 进程）。回包返回脱敏后的 pretty JSON 供 textarea 回填。
ipcRoute('PUT', '/api/bot-env', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { env?: unknown };
  try { body = await readJsonBody<{ env?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('env');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.env === 'string' ? body.env : '';
  let value: Record<string, string> | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as Record<string, string>;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, env: value ? JSON.stringify(value, null, 2) : '' });
});

// Per-bot 最大同时活跃会话数 maxLiveWorkers。Body `{ maxLiveWorkers: number | null }`:
//   • 正整数  → 设上限；超过后 idle-worker sweeper 把最久未用的会话休眠到上限内
//   • null    → 清除（回落到内置默认 30）
// 走 applyConfigField（与 /config 同一写盘 + 内存热更新路径）：sweeper 每分钟读
// 实时 bot.config.maxLiveWorkers，免重启即生效。
ipcRoute('PUT', '/api/bot-max-live-workers', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as { maxLiveWorkers?: unknown };
  const spec = findConfigField('maxLiveWorkers');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  // null（含 JSON null）= 清除上限；number 走 coerce 校验正整数。
  let value: number | null;
  if (body.maxLiveWorkers === null || body.maxLiveWorkers === undefined) {
    value = null;
  } else {
    const c = coerceConfigValue(spec, body.maxLiveWorkers);
    if (!c.ok || typeof c.value !== 'number') return jsonRes(res, 400, { ok: false, error: 'invalid_number' });
    value = c.value;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, maxLiveWorkers: value });
});

// Per-bot skill policy. Dashboard uses this for attach/detach; JSON policy
// still shares the same applyConfigField path as /botconfig.
ipcRoute('PUT', '/api/bot-skills', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const body = raw as { action?: unknown; name?: unknown; policy?: unknown };
  const spec = findConfigField('skills');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  const current = getBot(cachedLarkAppId).config.skills;
  let next = current;
  if (body.action === 'attach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
    next = attachSkillPolicy(current, name);
  } else if (body.action === 'detach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    next = detachSkillPolicy(current, name);
  } else if (body.action === 'set') {
    if (body.policy === null) {
      next = undefined;
    } else {
      const parsed = readBotSkillPolicy(body.policy);
      if (!parsed) return jsonRes(res, 400, { ok: false, error: 'invalid_policy' });
      next = parsed;
    }
  } else {
    return jsonRes(res, 400, { ok: false, error: 'invalid_action' });
  }

  const r = await applyConfigField(cachedLarkAppId, spec, next ?? null);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, skills: getBot(cachedLarkAppId).config.skills ?? null });
});

// Per-bot file-sandbox toggle. Body `{ enabled: boolean }`. When on, this bot's
// CLI sessions run inside a per-session bwrap file sandbox (Linux). For oncall
// bots shared with semi-trusted users.
ipcRoute('PUT', '/api/bot-sandbox', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown };
  try { body = await readJsonBody<{ enabled?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const r = await sandboxStore.updateBotSandbox(cachedLarkAppId, body.enabled === true);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, sandbox: r.sandbox });
});

// 实时切换 UI 语言（locale），无需重启 daemon。`botmux lang` / Dashboard 语言开关
// 写盘后 POST 这个端点，让本 daemon 从磁盘重新读 locale 并热更新：
//   • 全局默认（~/.botmux/config.json 的 `lang`）→ setDefaultLocale（缺省回落 'zh'）；
//   • 本 bot 的 per-bot 覆盖（bots.json 的 `lang`）→ 同步进内存 bot.config.lang
//     （与 applyConfigField 同口径），让 `botmux lang --bot N` 跨进程写入也免重启。
// 卡片都在 daemon 端按消息实时渲染（localeForBot），所以下一条消息/卡片立即生效。
// 文件是单一事实源，本端点只是“立即重读”信号——不在此落盘（写入方已落盘）。
ipcRoute('POST', '/api/locale/reload', async (_req, res) => {
  const globalLang = readGlobalConfig().lang;
  const resolvedDefault: Locale = isLocale(globalLang) ? globalLang : 'zh';
  setDefaultLocale(resolvedDefault);

  let botLang: Locale | null = null;
  if (cachedLarkAppId) {
    try {
      const raw = await readRawConfig(requireConfigPath());
      const idx = findEntryIndex(raw, cachedLarkAppId);
      const entryLang = idx >= 0 ? raw[idx]?.lang : undefined;
      botLang = isLocale(entryLang) ? entryLang : null;
      getBot(cachedLarkAppId).config.lang = botLang ?? undefined;
    } catch { /* bot 未注册 / 读盘失败：全局已应用，per-bot 维持原值 */ }
  }

  // Push the resolved locale to this bot's live workers too. Cards render on the
  // daemon (already switched above), but a few user-facing strings originate in
  // the worker process (submit notices, CoCo adopt notes) — without this they'd
  // stay in the spawn-time language until the session restarts.
  const workerLocale: Locale = botLang ?? resolvedDefault;
  const reg = getActiveSessionsRegistry();
  if (cachedLarkAppId && reg) {
    for (const ds of reg.values()) {
      if (ds.larkAppId !== cachedLarkAppId || !ds.worker || ds.worker.killed) continue;
      try { ds.worker.send({ type: 'set_locale', locale: workerLocale }); } catch { /* worker gone */ }
    }
  }

  jsonRes(res, 200, { ok: true, defaultLocale: resolvedDefault, botLang });
});

ipcRoute('PUT', '/api/bot-default-oncall', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown; workingDir?: unknown };
  try { body = await readJsonBody<{ enabled?: boolean; workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const enabled = body.enabled === true;
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';

  // Validate workingDir when enabling. Allow blank workingDir only when
  // disabling — the on-disk record keeps the last value so the UI can
  // round-trip after a disable.
  let resolvedPath = '';
  if (enabled) {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.updateBotDefaultOncall(cachedLarkAppId, { enabled, workingDir });
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, defaultOncall: r.defaultOncall, resolvedPath: resolvedPath || undefined });
});

// Per-bot「默认工作目录模式」三选一（dashboard 单选；两个底层字段互斥）：
//   • off     → 清 defaultWorkingDir + 关 defaultOncall（新会话弹「选仓库」卡）
//   • default → 写 defaultWorkingDir + 关 defaultOncall（钉目录、跳过选仓库、不改权限）
//   • oncall  → 开 defaultOncall(+dir) + 清 defaultWorkingDir（新群自动绑+开放对话；
//               该目录经 resolveBotDefaultWorkingDir 的 layer-4 兜底覆盖该 bot 所有会话）
// 两字段在 oncallStore.setWorkingDirMode 的**同一个 rmwBotEntry 锁内**一次性原子写盘 +
// 同步内存：否则两个并发请求分别加锁写各自字段会交错，最终留下 defaultOncall.enabled 与
// defaultWorkingDir 同时存在的不一致态（GET/前端按 enabled 显示 oncall，但 runtime 的
// effectiveDefaultWorkingDir 优先用 defaultWorkingDir → UI 与实际目录背离；PR #311 Codex 评审）。
// next-session 生效（运行中会话需 /restart）。
ipcRoute('PUT', '/api/bot-working-dir-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { mode?: unknown; workingDir?: unknown };
  try { body = await readJsonBody<{ mode?: unknown; workingDir?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const mode = body.mode;
  if (mode !== 'off' && mode !== 'default' && mode !== 'oncall') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_mode' });
  }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';

  // 非「关闭」模式必须给一个真实存在的目录。
  let resolvedPath = '';
  if (mode !== 'off') {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.setWorkingDirMode(cachedLarkAppId, mode, workingDir);
  if (!r.ok) return jsonRes(res, 400, r);
  return jsonRes(res, 200, {
    ok: true, mode,
    defaultWorkingDir: r.defaultWorkingDir,
    defaultOncall: r.defaultOncall,
    resolvedPath: resolvedPath || undefined,
  });
});

// Create a brand-new chat with this bot as creator/owner and `larkAppIds` as
// initial bot members. The dashboard's public route picks any online daemon
// to act as creator, then forwards here.
ipcRoute('POST', '/api/groups/create', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    name?: unknown;
    larkAppIds?: unknown;
    userOpenIds?: unknown;
    ownerUnionIds?: unknown;
    transferOwnerTo?: unknown;
    notifyOwnerOpenId?: unknown;
    bindWorkingDir?: unknown;
    roleProfileId?: unknown;
  };
  try {
    body = await readJsonBody<{
      name?: string;
      larkAppIds?: string[];
      userOpenIds?: string[];
      ownerUnionIds?: string[];
      transferOwnerTo?: string;
      notifyOwnerOpenId?: string;
      bindWorkingDir?: string;
      roleProfileId?: string;
    }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  // userOpenIds, transferOwnerTo, notifyOwnerOpenId are optional; pre-validated
  // upstream by the dashboard route. All open_ids MUST be in the calling bot's
  // app scope (caller is responsible — Lark open_ids are app-scoped, see
  // dashboard/operator-selector.ts).
  const userIds = Array.isArray(body.userOpenIds) && body.userOpenIds.every(x => typeof x === 'string')
    ? (body.userOpenIds as string[])
    : [];
  // Owner union_ids (tenant-stable) to pull bot owners into a federated group.
  const ownerUnionIds = Array.isArray(body.ownerUnionIds) && body.ownerUnionIds.every(x => typeof x === 'string')
    ? (body.ownerUnionIds as string[])
    : [];
  const transferTo = typeof body.transferOwnerTo === 'string' && body.transferOwnerTo.trim()
    ? body.transferOwnerTo.trim()
    : null;
  const notifyTo = typeof body.notifyOwnerOpenId === 'string' && body.notifyOwnerOpenId.trim()
    ? body.notifyOwnerOpenId.trim()
    : null;
  const roleProfileId = typeof body.roleProfileId === 'string' && body.roleProfileId.trim()
    ? body.roleProfileId.trim()
    : null;
  if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  }
  const bindWorkingDir = typeof body.bindWorkingDir === 'string' ? body.bindWorkingDir.trim() : '';
  let bindResolvedPath: string | undefined;
  if (bindWorkingDir) {
    const v = validateWorkingDir(bindWorkingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    bindResolvedPath = v.resolvedPath;
  }
  try {
    const r = await createGroupWithBots({
      creatorLarkAppId: cachedLarkAppId,
      larkAppIds: body.larkAppIds as string[],
      name,
      userOpenIds: userIds,
      ownerUnionIds,
      transferOwnerTo: transferTo ?? undefined,
      notifyOwnerOpenId: notifyTo ?? undefined,
      bindWorkingDir: bindWorkingDir || undefined,
      roleProfileId: roleProfileId ?? undefined,
    });
    jsonRes(res, 200, bindResolvedPath ? { ...r, bindResolvedPath } : r);
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: String((e as Error).message ?? e) });
  }
});

// ─── SSE event stream ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/events', (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  // Initial flush so the client sees the connection alive immediately.
  res.write('retry: 5000\n\n');

  // Subscribe BEFORE snapshotting so no event published in the gap is missed.
  const off = dashboardEventBus.subscribe(ev => {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.body)}\n\n`);
  });

  // Replay the current active sessions as `session.spawned` right after
  // subscribing. `DashboardEventBus` has no buffer/replay, and the daemon
  // publishes its discovery descriptor BEFORE restoreActiveSessions() runs
  // (daemon.ts) — so a dashboard that hydrates (GET /api/sessions) during the
  // descriptor→restore window gets an EMPTY snapshot, and any restore-time
  // `announceSessionRow()` that fires before THIS subscription is established is
  // dropped. Without this replay the aggregator would then have neither a
  // snapshot row nor a spawned row, and later session.update/close patches would
  // be discarded as unknown-row. Replaying here makes SSE attach deterministic:
  // a row registered before subscribe arrives via this snapshot; one registered
  // after arrives via the live subscription above. Idempotent — both the
  // aggregator and the browser store upsert by sessionId, so any row also
  // delivered live just refreshes the same entry.
  try {
    for (const ds of listActiveSessions()) {
      res.write(`event: session.spawned\ndata: ${JSON.stringify({ session: composeRowFromActive(ds) })}\n\n`);
    }
  } catch (err) {
    logger.warn(`[dashboard-ipc] /api/events snapshot replay failed: ${err}`);
  }

  const hb = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15_000);

  res.on('close', () => { off(); clearInterval(hb); });
});

export function startIpcServer(opts: { port: number; host: string }): Promise<IpcServerHandle> {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        await r.handler(req, res, params);
        return;
      }
      jsonRes(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      logger.error('[dashboard-ipc] handler error', err);
      if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
    }
  });
  // Probe upward on EADDRINUSE instead of a single fixed bind: a second botmux
  // instance resolving the same IPC port (BOTMUX_DAEMON_IPC_BASE_PORT + idx)
  // would otherwise reject and take the whole daemon down at startup (the caller
  // in daemon.ts awaits this unguarded). The daemon republishes the returned
  // (bound) port into its descriptor so the dashboard still discovers it.
  return listenWithProbe({
    server,
    port: opts.port,
    host: opts.host,
    log: (m) => logger.warn(`[dashboard-ipc] ${m}`),
  }).then((port) => ({
    port,
    close: () => new Promise<void>(r => server.close(() => r())),
  }));
}
