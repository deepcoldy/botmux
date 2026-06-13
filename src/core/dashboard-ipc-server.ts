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
import * as grantPrefsStore from '../services/grant-prefs-store.js';
import { findConfigField, applyConfigField } from '../services/bot-config-store.js';
import { config } from '../config.js';
import { computeSandboxDiff, applySandboxDiff } from '../services/sandbox-land.js';
import { readRawConfig, findEntryIndex, requireConfigPath } from '../services/config-store.js';
import { setDefaultLocale, localeForBot, t } from '../i18n/index.js';
import { isLocale, type Locale } from '../i18n/types.js';
import { readGlobalConfig } from '../global-config.js';
import { normalizeChatReplyMode, type ChatReplyMode } from '../services/chat-reply-mode-store.js';
import * as chatFirstSeenStore from '../services/chat-first-seen-store.js';
import * as scheduler from './scheduler.js';
import { listActiveSessions, findActiveBySessionId, closeSession, getActiveSessionsRegistry, transferSession, deliverWriteLinkCardToOwners } from './worker-pool.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { getChatMode, replyMessage, sendMessage, resolveUnionIdFromOpenId, listThreadMessages, listChatMessages, getUserProfile } from '../im/lark/client.js';
import { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent } from '../im/lark/message-parser.js';
import { resumeSession } from './session-manager.js';
import { getCliDisplayName } from '../im/lark/card-builder.js';
import { locateLimiter } from './dashboard-locate.js';
import { buildTerminalUrl } from './terminal-url.js';
import { dashboardEventBus } from './dashboard-events.js';
import { validateWorkingDir } from './working-dir.js';
import { resolveRoleFile, writeRoleFile, deleteRoleFile } from './role-resolver.js';
import { triggerSessionTurn } from './trigger-session.js';
import { triggerWorkflowFromEnvelope } from '../workflows/trigger-from-envelope.js';
import type { TriggerInput, TriggerResult } from '../workflows/trigger-run.js';
import { validateTriggerRequest } from '../services/trigger-types.js';

// Workflow runner is wired by the daemon (it owns the heavy triggerWorkflowRun
// deps). Until set, workflow-targeted triggers report not-implemented.
let workflowRunner: ((input: TriggerInput) => Promise<TriggerResult>) | null = null;
export function setWorkflowRunner(fn: (input: TriggerInput) => Promise<TriggerResult>): void {
  workflowRunner = fn;
}
import {
  composeRowFromActive,
  composeRowFromClosed,
  feishuChatLink,
  setBotName as setRowsBotName,
  getBotName,
  type SessionRow,
} from './dashboard-rows.js';
import { getBotBrand, getBot } from '../bot-registry.js';
import { normalizeKanbanColumn, normalizeKanbanPosition, normalizeSessionTitle } from './session-board.js';
import type { ScheduledTask, ParsedSchedule, Session } from '../types.js';

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

/** 解析 session（活跃优先，已关闭兜底）。活跃会话取 ds.session —— registry 与
 *  store 持有同一对象，改字段后 updateSession 即落盘。 */
function findSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getSession(sessionId);
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
  if (column) session.kanbanColumn = column;
  if (position !== null) session.kanbanPosition = position;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: params.sessionId,
      patch: { kanbanColumn: session.kanbanColumn, kanbanPosition: session.kanbanPosition },
    },
  });
  jsonRes(res, 200, { ok: true });
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
ipcRoute('POST', '/api/sessions/:sessionId/resume', async (_req, res, params) => {
  const sessionId = params.sessionId;
  const reg = getActiveSessionsRegistry();
  if (!reg) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });
  const result = await resumeSession(sessionId, reg);
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 409;
    return jsonRes(res, status, { ok: false, error: result.error, activeSessionId: result.activeSessionId });
  }

  const ds = result.ds;
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

  jsonRes(res, 200, {
    ok: true,
    sessionId,
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
// GET    /api/roles/:chatId  → { chatId, content, byteLength }
// PUT    /api/roles/:chatId  body: {content} → write role file
// DELETE /api/roles/:chatId  → remove role file

ipcRoute('GET', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const content = resolveRoleFile(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, {
    chatId: p.chatId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasRole: content !== null,
  });
});

ipcRoute('PUT', '/api/roles/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { content?: unknown };
  try { body = await readJsonBody<{ content?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    writeRoleFile(cachedLarkAppId, p.chatId, content);
    jsonRes(res, 200, { ok: true });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const existed = deleteRoleFile(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, { ok: true, existed });
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
  jsonRes(res, 200, {
    larkAppId: cachedLarkAppId,
    botName: getBotName(),
    defaultOncall: defaultOncall ?? { enabled: false, workingDir: '', since: 0 },
    autoboundChatCount: autoboundChats.length,
    brandLabel: brandStore.getBotBrandLabel(cachedLarkAppId) ?? null,
    sandbox: sandboxStore.getBotSandbox(cachedLarkAppId),
    disableStreamingCard: cardPrefs.disableStreamingCard,
    writableTerminalLinkInCard: cardPrefs.writableTerminalLinkInCard,
    privateCard: cardPrefs.privateCard,
    autoStartOnGroupJoin: cardPrefs.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: cardPrefs.autoStartOnGroupJoinPrompt,
    autoStartOnNewTopic: cardPrefs.autoStartOnNewTopic,
    regularGroupReplyMode: cardPrefs.regularGroupReplyMode,
    regularGroupMentionMode: cardPrefs.regularGroupMentionMode,
    restrictGrantCommands: grantPrefs.restrictGrantCommands,
    messageQuotaDefaultLimit: grantPrefs.messageQuotaDefaultLimit,
    p2pMode,
  });
});

// Per-bot card-behaviour toggles. Body may carry any subset of booleans; only
// present keys are applied.
ipcRoute('PUT', '/api/bot-card-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    disableStreamingCard?: unknown; writableTerminalLinkInCard?: unknown; privateCard?: unknown;
    autoStartOnGroupJoin?: unknown; autoStartOnGroupJoinPrompt?: unknown; autoStartOnNewTopic?: unknown;
    regularGroupReplyMode?: unknown; regularGroupMentionMode?: unknown;
  };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const patch: {
    disableStreamingCard?: boolean; writableTerminalLinkInCard?: boolean; privateCard?: boolean;
    autoStartOnGroupJoin?: boolean; autoStartOnGroupJoinPrompt?: string; autoStartOnNewTopic?: boolean;
    regularGroupReplyMode?: ChatReplyMode; regularGroupMentionMode?: 'always' | 'topic' | 'never';
  } = {};
  if (typeof body.disableStreamingCard === 'boolean') patch.disableStreamingCard = body.disableStreamingCard;
  if (typeof body.writableTerminalLinkInCard === 'boolean') patch.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
  if (typeof body.privateCard === 'boolean') patch.privateCard = body.privateCard;
  if (typeof body.autoStartOnGroupJoin === 'boolean') patch.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
  if (typeof body.autoStartOnGroupJoinPrompt === 'string') patch.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
  if (typeof body.autoStartOnNewTopic === 'boolean') patch.autoStartOnNewTopic = body.autoStartOnNewTopic;
  if (typeof body.regularGroupReplyMode === 'string') {
    const m = normalizeChatReplyMode(body.regularGroupReplyMode);
    if (m) patch.regularGroupReplyMode = m;
  }
  if (body.regularGroupMentionMode === 'always' || body.regularGroupMentionMode === 'topic' || body.regularGroupMentionMode === 'never') {
    patch.regularGroupMentionMode = body.regularGroupMentionMode;
  }
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await cardPrefsStore.updateBotCardPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

// Per-bot 授权偏好。Body 任意子集：
//   • restrictGrantCommands: boolean       — 限制被授权人只能纯对话
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
  const body = raw as { restrictGrantCommands?: unknown; messageQuotaDefaultLimit?: unknown };

  const patch: { restrictGrantCommands?: boolean; messageQuotaDefaultLimit?: number | null } = {};
  if (typeof body.restrictGrantCommands === 'boolean') patch.restrictGrantCommands = body.restrictGrantCommands;
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

  const off = dashboardEventBus.subscribe(ev => {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.body)}\n\n`);
  });

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
