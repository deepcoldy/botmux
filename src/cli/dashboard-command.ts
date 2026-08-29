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

/**
 * How long `start`/`restart` should keep waiting for the dashboard to answer, and
 * what to tell an operator who asks for the link while it is still coming up.
 *
 * SIZED FROM A REAL FLEET, not from how long a boot "should" take. The budget was
 * 6s; MEASURED on a 13-member fleet the dashboard needed ~45s from supervisor
 * start to answering (supervisor up at 14:23:04, `.dashboard-port` written at
 * 14:23:49). So every `restart` there ended in the "still booting" fallback, and
 * the operator's natural next step — `botmux dashboard` — printed
 * "not reachable ... `botmux restart` will start it": advice that would restart a
 * daemon which was in fact coming up fine, throwing away the boot about to
 * succeed.
 */
export const DASHBOARD_READY_WAIT_MS = 90_000;

/**
 * How long to keep polling before the liveness gate may end the wait.
 *
 * A just-started supervisor has not written its dashboard row yet, so the very
 * first observation can legitimately be "cannot tell" — which must not be read as
 * "nothing is coming up". This is the old whole-budget value, so the previous
 * behaviour is preserved for that initial stretch and the gate only starts cutting
 * waits short once the state file has had time to appear.
 */
export const DASHBOARD_LIVENESS_GRACE_MS = 6_000;

/**
 * Failure reasons that prove we REACHED the dashboard, so waiting cannot change
 * them. This is the "did we get an answer from the dashboard itself" question —
 * NOT "is this backed by a file", which is the distinction an earlier version got
 * wrong in both directions:
 *
 *  • `no-secret` looks file-backed and permanent, but `.dashboard-secret` is
 *    created BY the dashboard during its own boot (`loadOrCreateSecret()`, called
 *    at module scope in dashboard.ts). On a fresh install the supervisor has a live
 *    dashboard pid well before that line runs, so the first poll legitimately sees
 *    `no-secret` and it resolves on its own moments later.
 *  • `wrong-service` is not permanent either: another service can hold the recorded
 *    port while the dashboard has not bound its own yet, which makes discovery fail
 *    now and succeed once it binds.
 *
 * Treating either as terminal ended the poll early and then told the operator to
 * restart a dashboard that was coming up fine — the same misdiagnosis this module
 * fixes for `unreachable`.
 *
 * Terminal is therefore "we got an answer FROM the dashboard": `no-active-token`
 * (it is up, it just has no token yet) and `http-error`. The latter is exactly how
 * `dashboard-endpoint.ts:reachedDashboard()` classifies it — a 500 or a malformed
 * body means the dashboard replied, so waiting changes nothing, and leaving it out
 * would spend the full 90s budget on a live dashboard that answers 500 forever.
 */
export function dashboardFailureIsTerminal(failure: Extract<DashboardResult, { ok: false }>): boolean {
  return failure.reason === 'no-active-token' || failure.reason === 'http-error';
}

/**
 * Map an observed fleet state to "is a dashboard coming up?" — the OBSERVATION
 * half of the readiness decision, kept pure so it is testable.
 *
 * This used to live inline in `cli.ts` where nothing could reach it, and the
 * `launching` branch in particular is the whole point of the fix: the supervisor
 * records `status='launching', pid=0` while a crashed member is in restart
 * backoff, so a pid-based check called that "not live", ended the poll, and then
 * advised restarting a dashboard the supervisor was already bringing back.
 *
 * Tri-state on purpose — `null` is "cannot tell yet", NOT "no":
 *  • no state file, or the dashboard row not written yet → null
 *  • no live supervisor → false (nobody left to start anything)
 *  • stopped / errored → false (the supervisor has given up)
 *  • launching → true (pid is 0 BY DESIGN here; never pid-check this state)
 *  • online → only true if the pid is actually alive
 *
 * @param state  parsed fleet state, or null when absent/unreadable
 * @param pidAlive  liveness probe, injected so tests need no real processes
 */
export function dashboardComingUpFromState(
  state: {
    supervisorPid?: number;
    procs?: ReadonlyArray<{ name: string; pid?: number; status?: string }>;
  } | null,
  dashboardProcessName: string,
  pidAlive: (pid: number) => boolean,
): boolean | null {
  if (!state) return null;
  const sup = state.supervisorPid;
  const supervisorAlive = Number.isSafeInteger(sup) && (sup as number) > 1 && pidAlive(sup as number);
  if (!supervisorAlive) return false;
  const proc = state.procs?.find((p) => p.name === dashboardProcessName);
  if (!proc) return null;
  if (proc.status === 'stopped' || proc.status === 'errored') return false;
  if (proc.status === 'launching') return true;
  if (!Number.isSafeInteger(proc.pid) || (proc.pid as number) <= 1) return false;
  return pidAlive(proc.pid as number);
}

/**
 * Should the readiness poll take another turn?
 *
 * Three independent bounds, and all of them matter:
 *  • the clock — liveness alone would spin forever on a member that is up but
 *    never binds its port;
 *  • whether the failure is terminal — no point polling an answer that will not
 *    change;
 *  • whether a dashboard is coming up — the clock alone would spend the (now much
 *    larger) budget in full on a fleet that has no dashboard member, or whose
 *    dashboard the supervisor has given up on.
 *
 * `comingUp` is deliberately TRI-STATE. `null` means "cannot tell yet" (no state
 * file, or the supervisor has not written the dashboard row), which is normal in
 * the first moments and must not end the wait; before
 * DASHBOARD_LIVENESS_GRACE_MS it keeps waiting, after it stops rather than hold
 * the full budget on a fleet whose state never appears.
 */
export function shouldKeepWaitingForDashboard(input: {
  elapsedMs: number;
  budgetMs?: number;
  graceMs?: number;
  failure: Extract<DashboardResult, { ok: false }>;
  /** true = running or scheduled; false = definitely not; null = cannot tell yet. */
  comingUp: boolean | null;
}): boolean {
  if (input.elapsedMs >= (input.budgetMs ?? DASHBOARD_READY_WAIT_MS)) return false;
  if (dashboardFailureIsTerminal(input.failure)) return false;
  if (input.comingUp === null) {
    return input.elapsedMs < (input.graceMs ?? DASHBOARD_LIVENESS_GRACE_MS);
  }
  return input.comingUp;
}

/**
 * The message for a failure that may just mean "not up yet" — the one an operator
 * sees from `botmux dashboard`.
 *
 * "Run restart" is right ONLY when nothing is coming up. With a live dashboard
 * member, nothing is broken and a restart would throw away a boot that is about to
 * succeed, so say "wait" instead. Covers every non-terminal shape, because they
 * are all reachable while the dashboard is still booting: the port not listening
 * yet (`unreachable`), the secret not written yet (`no-secret` — the dashboard
 * creates it itself), and the port not bound yet so discovery finds someone else
 * on the recorded one (`wrong-service`). See DASHBOARD_READY_WAIT_MS.
 */
export function formatDashboardUnreachable(port: string | number, comingUp: boolean | null): string {
  // `null` ("cannot tell yet") is treated as coming up: the honest advice when we
  // do not know is "wait and retry", never "restart".
  if (comingUp !== false) {
    return `dashboard 正在启动中，还没开始在 127.0.0.1:${port} 上应答（大 fleet 可能要几十秒）。`
      + '稍等几秒后重新运行 `botmux dashboard` 即可，不需要 restart。';
  }
  return `dashboard process not reachable on 127.0.0.1:${port} — \`botmux restart\` will start it`;
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

/**
 * `botmux dashboard`'s execution path, as ONE importable unit.
 *
 * Why this exists rather than inline wiring in `cli.ts`: the opt-in below is the
 * whole fix for a dead `.dashboard-port`, and `cli.ts` exports nothing testable,
 * so the only way to check it was a source-text assertion. Two such assertions
 * were written and both were wrong — the first false-RED on a legitimate
 * extract-to-local refactor, the second stayed GREEN when the flag-carrying call
 * was fully disconnected from the caller actually passed down (flag present,
 * command executed, wiring severed). A regex over nested callbacks cannot express
 * "this options object reaches that caller"; a function can.
 *
 * `rescanWhenUnreachable: true` is correct HERE and only here: this is a one-shot
 * human command, so at worst it scans the probe range once per invocation. The
 * 500ms readiness poll must keep the default (false) or it would scan every tick.
 *
 * @param callEndpoint the raw endpoint caller; this wrapper is what adds the opt-in
 */
export async function executeDashboardCliCommand(
  args: readonly string[],
  callEndpoint: (path: DashboardEndpoint, opts: { rescanWhenUnreachable: boolean }) => Promise<DashboardResult>,
): Promise<DashboardCommandExecution> {
  return executeDashboardCommand(args, (path) => callEndpoint(path, { rescanWhenUnreachable: true }));
}
