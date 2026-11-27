import { executeDashboardCliCommand, type DashboardCommandExecution } from './dashboard-command.js';
import type { DashboardEndpoint, DashboardResult } from './dashboard-endpoint.js';

/** Only these failures mean "no Dashboard is running here yet". Every other
 * reason (auth-failed, wrong-service, http-error, …) is something a fresh
 * supervisor would not fix and must never be bypassed by starting one. */
const DASHBOARD_ABSENT_REASONS = new Set(['no-secret', 'unreachable']);

/** True when a failed Dashboard call means nothing is serving here, as opposed
 * to a Dashboard that answered and refused. */
export function dashboardIsAbsent(result: DashboardResult): boolean {
  return !result.ok && DASHBOARD_ABSENT_REASONS.has(result.reason);
}

const FIRST_USE_READY_WAIT_MS = 30_000;
const FIRST_USE_POLL_MS = 250;

/** First-use recovery: an unconfigured install still needs the dashboard to set
 * up its first bot. Starting the normal supervisor preserves lifecycle/auth
 * ownership; no bot credentials or synthetic bots.json are required. A host
 * that already has bots configured never gets a supervisor from here: bringing
 * that fleet up is `botmux start`'s decision, so the original failure stands. */
export async function executeDashboardWithFirstUseBootstrap(
  args: string[],
  callEndpoint: (path: DashboardEndpoint, opts?: { rescanWhenUnreachable?: boolean }) => Promise<DashboardResult>,
  ensureExport: () => Promise<string | null>,
  deps: {
    hasConfig: () => boolean;
    /** True where host processes are invisible (a PID-namespace sandbox). The
     * same verdict gates `start` / `__watchdog`: a credential-only sandbox can
     * write the host home, so starting a supervisor from there would run a
     * second one beside the host fleet it cannot see. */
    hostProcessesHidden: () => boolean;
    start: () => Promise<void>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DashboardCommandExecution> {
  const execute = () => executeDashboardCliCommand(args, callEndpoint, ensureExport);
  const initial = await execute();
  if (initial.kind !== 'endpoint' || initial.result.ok) return initial;
  if (!dashboardIsAbsent(initial.result)) return initial;
  if (deps.hasConfig()) return initial;
  if (deps.hostProcessesHidden()) return initial;

  await deps.start();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + FIRST_USE_READY_WAIT_MS;
  while (now() < deadline) {
    // Do not rediscover the full port range on every readiness poll. The
    // dashboard atomically writes its actual bound port during startup.
    const status = await callEndpoint('/__cli/current');
    if (status.ok || status.reason === 'no-active-token') return execute();
    if (!DASHBOARD_ABSENT_REASONS.has(status.reason)) return execute();
    await sleep(FIRST_USE_POLL_MS);
  }
  return execute();
}
