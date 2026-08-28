import { workbenchEntryUrl } from '../core/dashboard-url.js';

import type { DashboardEndpoint, DashboardResult } from './dashboard-endpoint.js';

export const DASHBOARD_COMMAND_USAGE = `用法:
  botmux dashboard           获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard current   获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard rotate    轮换 token，并打印新的 Dashboard 登录 URL`;

export type DashboardCommandExecution =
  | { kind: 'help' }
  | { kind: 'invalid'; argument: string }
  | { kind: 'endpoint'; action: 'current' | 'rotate'; result: DashboardResult };

const LEGACY_ENSURE_TOKEN_GATE_PREFIX =
  '401 <h1>Token expired</h1><p>Run <code>botmux dashboard</code>';

const MIN_DASHBOARD_EXPORT_BUDGET_MS = 500;
const MAX_DASHBOARD_EXPORT_TIMEOUT_MS = 5_000;

/** Bound the best-effort export to the caller's remaining startup budget.
 * Returning null below 500ms avoids a predictably doomed spawn and its
 * process-local failure cache. */
export function dashboardExportTimeoutForBudget(remainingMs: number): number | null {
  if (!Number.isFinite(remainingMs) || remainingMs < MIN_DASHBOARD_EXPORT_BUDGET_MS) return null;
  return Math.min(MAX_DASHBOARD_EXPORT_TIMEOUT_MS, Math.floor(remainingMs));
}

function legacyEnsureRouteMissing(result: DashboardResult): boolean {
  if (result.ok) return false;
  if (result.reason === 'wrong-service') return true;
  return result.reason === 'http-error'
    && result.detail?.startsWith(LEGACY_ENSURE_TOKEN_GATE_PREFIX) === true;
}

/**
 * `botmux dashboard` 成功时要打印的每一行，按顺序。
 *
 * ⚠️ 契约：**第 0 行永远是且只是那条 URL**，不带任何前缀、标签或修饰。脚本和用户
 * 都靠「取第一行」拿链接（`botmux dashboard | head -1`）。往后追加行可以，动第一行
 * 不行。
 *
 * 第二行是工作台直达入口（`<base>/workbench?t=<token>`）——`/workbench` 是
 * Dashboard 上一个无 fragment 的入口，会 302 到 `/?t=…#/agent-workbench`
 * （见 dashboard.ts）。它和第一行同源同 token，所以第一行能用它就能用；拼不出来
 * （URL 不可解析）时这一行整行省略，不打印半截链接。
 */
export function formatDashboardSuccessLines(result: Extract<DashboardResult, { ok: true }>): string[] {
  const lines = [result.url];
  const workbench = workbenchEntryUrl(result.url);
  if (workbench) lines.push(`工作台: ${workbench}`);
  if (result.localUrl) lines.push(`本地直连(平台异常时可用): ${result.localUrl}`);
  return lines;
}

export function formatDashboardFallbackFailure(
  action: 'current' | 'rotate',
  failure: Extract<DashboardResult, { ok: false }>,
): string {
  const operation = action === 'current' ? 'Dashboard lookup' : 'Rotation';
  return `${operation} failed: ${failure.detail ?? failure.reason}`;
}

/**
 * Refresh a successful dashboard response after the CLI has created/reused a
 * Devbox export. The first endpoint call is deliberately outside this helper:
 * it proves the dashboard is live and lets callDashboard() repair a stale
 * `.dashboard-port` before merlin-cli is allowed to export anything. A second
 * non-mutating current read is needed because the first response was rendered
 * before the export cache existed. If export/refresh fails, retain the already
 * usable local response rather than turning a best-effort enhancement fatal.
 */
export async function refreshDashboardResultAfterExport(
  result: Extract<DashboardResult, { ok: true }>,
  ensureExport: () => Promise<string | null>,
  callEndpoint: (path: DashboardEndpoint) => Promise<DashboardResult>,
): Promise<Extract<DashboardResult, { ok: true }>> {
  let exported: string | null;
  try {
    exported = await ensureExport();
  } catch {
    return result;
  }
  if (!exported) return result;
  try {
    const refreshed = await callEndpoint('/__cli/current');
    return refreshed.ok ? refreshed : result;
  } catch {
    return result;
  }
}

/** Execute the user-facing command first, then add the Devbox export as a
 * post-success enhancement. Keeping that order in one tested helper prevents a
 * future refactor from exporting the configured/stale port before endpoint
 * discovery has identified the live dashboard. */
export async function executeDashboardCommandWithExportRefresh(
  args: readonly string[],
  callEndpoint: (path: DashboardEndpoint) => Promise<DashboardResult>,
  ensureExport: () => Promise<string | null>,
): Promise<DashboardCommandExecution> {
  const execution = await executeDashboardCommand(args, callEndpoint);
  if (execution.kind !== 'endpoint' || !execution.result.ok) return execution;
  return {
    ...execution,
    result: await refreshDashboardResultAfterExport(execution.result, ensureExport, callEndpoint),
  };
}

/**
 * Parse and dispatch the dashboard subcommand without touching process-global
 * output or credentials. Keeping the endpoint call injected makes the safety
 * property executable in tests: help/invalid invocations cannot accidentally
 * reach the token-rotation endpoint.
 */
export async function executeDashboardCommand(
  args: readonly string[],
  callEndpoint: (path: DashboardEndpoint) => Promise<DashboardResult>,
): Promise<DashboardCommandExecution> {
  if (args.some(arg => ['--help', '-h', 'help'].includes(arg.toLowerCase()))) {
    return { kind: 'help' };
  }
  if (args.length > 1) return { kind: 'invalid', argument: args.join(' ') };

  const raw = args[0]?.toLowerCase();

  if (raw !== undefined && raw !== 'current' && raw !== 'rotate') {
    return { kind: 'invalid', argument: args[0] };
  }

  const action = raw === 'rotate' ? 'rotate' : 'current';
  if (action === 'rotate') {
    return { kind: 'endpoint', action, result: await callEndpoint('/__cli/rotate') };
  }

  const current = await callEndpoint('/__cli/current');
  if (current.ok || current.reason !== 'no-active-token') {
    return { kind: 'endpoint', action, result: current };
  }

  const ensured = await callEndpoint('/__cli/ensure');
  // The immediately preceding current probe proved this is a dashboard with no
  // active token. Older dashboards either 404 an unknown ensure route or pass
  // it through the browser token gate (the exact 401 HTML above). Only those
  // version signatures may fall back to legacy rotate; a new endpoint's 500,
  // auth failure, or transport failure must remain fail-closed.
  if (legacyEnsureRouteMissing(ensured)) {
    // A token may have appeared between the first read and the failed legacy
    // capability probe (or rediscovery may have healed the recorded port).
    // Re-read before using the mutating compatibility endpoint so a concurrent
    // valid link is returned instead of invalidated.
    const legacyCurrent = await callEndpoint('/__cli/current');
    if (legacyCurrent.ok || legacyCurrent.reason !== 'no-active-token') {
      return { kind: 'endpoint', action, result: legacyCurrent };
    }
    return { kind: 'endpoint', action, result: await callEndpoint('/__cli/rotate') };
  }
  return { kind: 'endpoint', action, result: ensured };
}
