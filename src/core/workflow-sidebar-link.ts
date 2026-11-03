/**
 * 工作流侧边栏入口的路径约定（设计 2026-11-03 §11）。
 *
 * 一条入口只有三种形态，三方各取所需、不各写一份正则：
 *   - 卡片按钮指向的路径入口 `/workflow/<主 Bot appId>/<runId>`（daemon / CLI 拼，Dashboard 收）；
 *   - Dashboard 跳进 SPA 的侧栏 hash `#/workflows/<runId>?app=<appId>&botmuxWorkbenchShell=immersive`；
 *   - 侧栏页面读数据的只读接口 `/api/workflow-sidebar/<appId>/<runId>`。
 *
 * 用路径不用 `#` 做入口，与决策看板的 `/board/<app>/<seq>` 同一个理由：平台冷访问 SSO 和
 * H5 免登的 returnTo 只带 pathname。链接里永远不带任何凭证。
 *
 * 本模块零依赖：daemon、CLI、Dashboard 服务端和 web bundle 都从这里取。
 */

import { WORKBENCH_SHELL_IMMERSIVE, WORKBENCH_SHELL_PARAM } from './workbench-shell.js';

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 与 v3 run-envelope 的 runId 白名单同形：首字符字母数字，排除 `.` / `..`。 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ENTRY_RE = /^\/workflow\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const API_RE = /^\/api\/workflow-sidebar\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export interface WorkflowSidebarTarget {
  /** 主 Bot（发起并驱动这个 run 的 Bot）的 appId。 */
  appId: string;
  runId: string;
}

export function isWorkflowSidebarTarget(appId: string, runId: string): boolean {
  return APP_ID_RE.test(appId) && RUN_ID_RE.test(runId);
}

/** 卡片按钮的路径入口；appId / runId 不合法时返回 undefined（不出按钮）。 */
export function workflowSidebarEntryPath(appId: string, runId: string): string | undefined {
  return isWorkflowSidebarTarget(appId, runId) ? `/workflow/${appId}/${runId}` : undefined;
}

export function parseWorkflowSidebarEntryPath(pathname: string): WorkflowSidebarTarget | null {
  const match = ENTRY_RE.exec(pathname);
  return match ? { appId: match[1]!, runId: match[2]! } : null;
}

export function workflowSidebarApiPath(target: WorkflowSidebarTarget): string {
  return `/api/workflow-sidebar/${target.appId}/${target.runId}`;
}

export function parseWorkflowSidebarApiPath(pathname: string): WorkflowSidebarTarget | null {
  const match = API_RE.exec(pathname);
  return match ? { appId: match[1]!, runId: match[2]! } : null;
}

/** Dashboard 302 进 SPA 的目标（以 `/` 开头）：侧栏版式由沉浸式标记 + `app` 参数共同识别。 */
export function workflowSidebarSpaEntry(target: WorkflowSidebarTarget): string {
  const query = new URLSearchParams({ app: target.appId, [WORKBENCH_SHELL_PARAM]: WORKBENCH_SHELL_IMMERSIVE });
  return `/#/workflows/${target.runId}?${query.toString()}`;
}

/**
 * 当前页面是不是侧栏版式：hash 是 `#/workflows/<runId>`、带 `app=<appId>`，且带沉浸式标记
 * （标记可能已在启动时被提升进 search，见 web/client-shell.ts）。普通 Dashboard 侧边栏点进来的
 * `#/workflows/<runId>` 没有这两样，仍走原来的详情页。
 */
export function parseWorkflowSidebarHash(search: string, hash: string): WorkflowSidebarTarget | null {
  const queryIndex = hash.indexOf('?');
  const path = queryIndex < 0 ? hash : hash.slice(0, queryIndex);
  const match = /^#\/workflows\/([^/?#]+)$/.exec(path);
  if (!match || queryIndex < 0) return null;
  const hashParams = new URLSearchParams(hash.slice(queryIndex + 1));
  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const immersive = searchParams.get(WORKBENCH_SHELL_PARAM) === WORKBENCH_SHELL_IMMERSIVE
    || hashParams.get(WORKBENCH_SHELL_PARAM) === WORKBENCH_SHELL_IMMERSIVE;
  if (!immersive) return null;
  let runId: string;
  try { runId = decodeURIComponent(match[1]!); } catch { return null; }
  const appId = hashParams.get('app') ?? '';
  return isWorkflowSidebarTarget(appId, runId) ? { appId, runId } : null;
}

/**
 * Does this link point at a workflow entry — the `/workflow/<app>/<run>`
 * sidebar entry, the Dashboard's `#/workflows/<run>` page, or a Feishu AppLink
 * wrapping either (its target travels in the `url` query parameter)?
 */
export function isWorkflowSidebarEntryUrl(href: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (parseWorkflowSidebarEntryPath(url.pathname)) return true;
  if (/^#\/workflows\/[^/?#]+/.test(url.hash)) return true;
  const wrapped = url.searchParams.get('url');
  return wrapped !== null && wrapped !== href && !wrapped.includes('url=') && isWorkflowSidebarEntryUrl(wrapped);
}
