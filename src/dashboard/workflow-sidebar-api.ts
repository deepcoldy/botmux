/**
 * 工作流侧边栏的 Dashboard 路由（设计 2026-11-03 §11.2–§11.4，D6）：
 *
 *   GET /workflow/<主 Bot appId>/<runId>              入口：只做跳转，不返回数据
 *   GET /api/workflow-sidebar/<主 Bot appId>/<runId>  侧栏页面的只读数据
 *
 * 两条都挂在 Dashboard 普通登录门禁之前、自己鉴权：飞书 H5 给白名单之外的人签发的是
 * 「只能看工作流侧栏」的会话（h5-auth.ts `workflowViewOnly`），它在其它所有路由上都等于
 * 没有身份，只有这里认它。
 *
 * 谁能看什么：
 *   - Dashboard 管理员（本机管理 cookie / 平台授予 dashboard:manage 的协管者）：完整视图；
 *   - 本群当前成员（H5 免登或平台透传的身份，经主 Bot 应用实时核对在群）：精简视图，
 *     只对「节点交给群里的 Bot 执行」的 run 开放（只有这类 run 的消息上有入口）；
 *   - 其他人 403；拿不到身份 401（带登录入口）。非管理员看不到 run 存不存在：
 *     不存在、不是 bot 执行、入口里的 appId 对不上，一律与「不在群」同样 403。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  parseWorkflowSidebarApiPath,
  parseWorkflowSidebarEntryPath,
  workflowSidebarSpaEntry,
  type WorkflowSidebarTarget,
} from '../core/workflow-sidebar-link.js';
import type {
  WorkflowSidebarMembershipCache,
  WorkflowSidebarMembershipRequest,
  WorkflowViewerMembership,
  WorkflowViewerPrincipal,
} from '../core/workflow-sidebar-membership.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import type { DashboardAuthIdentity } from './h5-auth.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { logger } from '../utils/logger.js';
import {
  projectWorkflowSidebarAdmin,
  projectWorkflowSidebarMember,
  readWorkflowSidebarRun,
} from './workflow-sidebar-view.js';

export interface WorkflowSidebarApiDeps {
  runsDir: string;
  /** `resolveDashboardIdentity` 的结论（legacy > 平台 > 白名单 H5）。只在命中本模块路由时才解析。 */
  identity(): DashboardRequestIdentity | null;
  /** 原始 H5 会话（含只能看工作流侧栏的窄会话）。 */
  h5(): DashboardAuthIdentity | null;
  /** H5 免登配置；`appId` 是签发 H5 open_id 的那个应用。 */
  h5Config: { enabled: boolean; entryPath: string; appId: string };
  /** 平台托管时的登录入口（未绑定平台返回 undefined）。 */
  platformLoginUrl?(returnTo: string): string | undefined;
  membership: WorkflowSidebarMembershipCache;
  /** 让主 Bot 的 daemon 用它自己的应用核对群成员；任何失败都应答 `unavailable`。 */
  askMembership(mainLarkAppId: string, request: WorkflowSidebarMembershipRequest): Promise<WorkflowViewerMembership>;
  brand(larkAppId: string): Brand;
  botName?(larkAppId: string): string | undefined;
  now?(): number;
  /** Monotonic clock + sleep for the denial floor (injectable for tests). */
  monotonicNow?(): number;
  sleep?(ms: number): Promise<void>;
}

/**
 * Every member-path refusal answers the same body no sooner than this after
 * the request arrived, so a non-member cannot tell "no such run" (answered
 * from disk) from "exists, you are not in its chat" (answered after asking the
 * main bot's daemon, which asks Feishu). One uncached lookup — a contact call
 * plus the chat's member pages — normally finishes well inside it; chats so
 * large that it does not still leak timing, which is all a guessed run id buys.
 */
export const WORKFLOW_SIDEBAR_DENY_FLOOR_MS = 1_000;

export function workflowSidebarIsAdmin(identity: DashboardRequestIdentity | null): boolean {
  return identity?.canManageHost === true;
}

/**
 * 用哪个身份去问「在不在群」。open_id 是 app-scoped 的：union_id 可以跨应用换算，优先用它；
 * 只有 H5 免登应用恰好就是主 Bot 应用时，H5 的 open_id 才能直接拿去比对。别的应用签发的
 * ou_ 一律不用（返回 null → 当作拿不到身份）。
 */
export function workflowViewerPrincipal(input: {
  identity: DashboardRequestIdentity | null;
  h5: DashboardAuthIdentity | null;
  h5AppId: string;
  mainLarkAppId: string;
}): WorkflowViewerPrincipal | null {
  const { identity, h5 } = input;
  if (identity?.kind === 'platform-dashboard') {
    return identity.principalUnionId?.startsWith('on_') ? { unionId: identity.principalUnionId } : null;
  }
  if (h5) {
    if (h5.unionId?.startsWith('on_')) return { unionId: h5.unionId };
    if (input.h5AppId && input.h5AppId === input.mainLarkAppId && h5.userId.startsWith('ou_')) {
      return { openId: h5.userId };
    }
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function entryPathOf(target: WorkflowSidebarTarget): string {
  return `/workflow/${target.appId}/${target.runId}`;
}

function loginUrlFor(target: WorkflowSidebarTarget, deps: WorkflowSidebarApiDeps): string | undefined {
  const returnTo = entryPathOf(target);
  const platform = deps.platformLoginUrl?.(returnTo);
  if (platform) return platform;
  return deps.h5Config.enabled ? `${deps.h5Config.entryPath}?returnTo=${encodeURIComponent(returnTo)}` : undefined;
}

/** 入口跳转目标；不是入口路径返回 null。 */
export function workflowSidebarEntryRedirect(
  pathname: string,
  opts: { signedIn: boolean; h5: { enabled: boolean; entryPath: string } },
): string | null {
  const target = parseWorkflowSidebarEntryPath(pathname);
  if (!target) return null;
  if (!opts.signedIn && opts.h5.enabled) {
    return `${opts.h5.entryPath}?returnTo=${encodeURIComponent(entryPathOf(target))}`;
  }
  return workflowSidebarSpaEntry(target);
}

export async function handleWorkflowSidebar(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowSidebarApiDeps,
): Promise<boolean> {
  const entry = parseWorkflowSidebarEntryPath(url.pathname);
  const api = entry ? null : parseWorkflowSidebarApiPath(url.pathname);
  if (!entry && !api) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  const target = (entry ?? api)!;
  const identity = deps.identity();
  const admin = workflowSidebarIsAdmin(identity);
  // A session scoped to owner-bound plugin results opens only those results:
  // here it counts as no session (the entry sends it through H5 login again).
  const rawH5 = deps.h5();
  const h5 = rawH5 && !rawH5.resultOnly ? rawH5 : null;
  const principal = admin ? null : workflowViewerPrincipal({
    identity,
    h5,
    h5AppId: deps.h5Config.appId,
    mainLarkAppId: target.appId,
  });

  if (entry) {
    // Any established identity goes on to the page (which then shows 403 if it
    // may not see the run): re-entering H5 login with a session that cannot
    // name a usable principal would only loop back here.
    const location = workflowSidebarEntryRedirect(url.pathname, {
      signedIn: admin || principal !== null || identity !== null || h5 !== null,
      h5: deps.h5Config,
    })!;
    res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  }

  const opts = { brand: deps.brand(target.appId), botName: deps.botName, now: deps.now };
  if (admin) {
    const found = readWorkflowSidebarRun(deps.runsDir, target.runId);
    if (found.kind === 'missing') { json(res, 404, { ok: false, error: 'unknown_run' }); return true; }
    if (found.kind === 'invalid') { json(res, 409, { ok: false, error: 'invalid_run_envelope' }); return true; }
    if (found.run.mainLarkAppId !== target.appId) { json(res, 404, { ok: false, error: 'unknown_run' }); return true; }
    json(res, 200, projectWorkflowSidebarAdmin(found.run, opts));
    return true;
  }

  if (!principal && (identity || h5)) {
    // Signed in, but not as anyone the main bot's app can check (an H5 open_id
    // issued by another app with no union_id, a platform visitor without an
    // actor): logging in again would not change that.
    json(res, 403, { ok: false, error: 'identity_unusable' });
    return true;
  }
  if (!principal) {
    const login = loginUrlFor(target, deps);
    json(res, 401, { ok: false, error: 'authentication_required', ...(login ? { loginUrl: login } : {}) },
      login ? { 'x-botmux-login-url': login } : {});
    return true;
  }

  const monotonic = deps.monotonicNow ?? (() => performance.now());
  const startedAt = monotonic();
  // One outward answer for every refusal below; the reason stays in the log.
  const forbidden = async (reason: string) => {
    logger.info(`[workflow-sidebar] member view refused (${reason}) app=${target.appId} run=${target.runId}`);
    const wait = WORKFLOW_SIDEBAR_DENY_FLOOR_MS - (monotonic() - startedAt);
    if (wait > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(wait);
    json(res, 403, { ok: false, error: 'forbidden' });
  };
  const found = readWorkflowSidebarRun(deps.runsDir, target.runId);
  if (found.kind !== 'ok') { await forbidden(`run ${found.kind}`); return true; }
  if (found.run.mainLarkAppId !== target.appId) { await forbidden('main bot mismatch'); return true; }
  if (found.run.nodeExecutor !== 'bot' || !found.run.chatId) { await forbidden('not a bot-executed run'); return true; }
  const run = found.run;
  const verdict = await deps.membership.check(
    { mainLarkAppId: run.mainLarkAppId, chatId: run.chatId!, principal },
    () => deps.askMembership(run.mainLarkAppId, { chatId: run.chatId!, principal }),
  );
  if (verdict === 'unavailable') { await forbidden('membership lookup failed'); return true; }
  if (verdict !== 'member') { await forbidden('not a current chat member'); return true; }
  json(res, 200, projectWorkflowSidebarMember(run, opts));
  return true;
}
