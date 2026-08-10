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

function legacyEnsureRouteMissing(result: DashboardResult): boolean {
  if (result.ok) return false;
  if (result.reason === 'wrong-service') return true;
  return result.reason === 'http-error'
    && result.detail?.startsWith(LEGACY_ENSURE_TOKEN_GATE_PREFIX) === true;
}

export function formatDashboardFallbackFailure(
  action: 'current' | 'rotate',
  failure: Extract<DashboardResult, { ok: false }>,
): string {
  const operation = action === 'current' ? 'Dashboard lookup' : 'Rotation';
  return `${operation} failed: ${failure.detail ?? failure.reason}`;
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
