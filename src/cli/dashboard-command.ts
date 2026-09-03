import { stripDashboardToken, workbenchEntryUrl, workbenchSpaUrl } from '../core/dashboard-url.js';

import type { DashboardEndpoint, DashboardResult } from './dashboard-endpoint.js';

/**
 * 取本机 `ip:port` + token 直连链接的显式开关。
 *
 * 名字刻意写成一句「读一眼就知道别随便调」的话，而不是 `--local` / `--token`
 * 之类中性词：这条命令的输出会被大模型读进上下文、再顺手转发到飞书群里，而
 * token 一旦进了聊天记录/思考过程就等于泄漏。名字本身就是给模型的警告。
 *
 * **故意不进 {@link DASHBOARD_COMMAND_USAGE}**：help 里列出来，等于邀请模型
 * 「既然有这个参数那就加上」。它只在 `botmux dashboard` 实际跑完、且确实存在
 * 一条被隐藏的本地链接时，在输出末尾提示给**人**看（见
 * {@link formatDashboardSuccessLines}）。
 */
export const DASHBOARD_LOCAL_TOKEN_FLAG = '--i-am-the-owner-show-token-link';

export const DASHBOARD_COMMAND_USAGE = `用法:
  botmux dashboard           获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard current   获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard rotate    轮换 token，并打印新的 Dashboard 登录 URL`;

/**
 * 给**大模型**看的安全提示，跟在链接后面一起打印。
 *
 * 为什么钉在 CLI 输出里、而不是写进 skill 文档：真正会把链接转发出去的那一刻，
 * 模型手里只有这段 stdout。提示与链接同处一段文本，才和它做「要不要发」这个决定
 * 时读到的上下文重合。
 *
 * 两条规则分别对应两种泄漏形态：
 *  1. **多人群**——判断交给模型自己（它才知道当前会话是私聊还是几十人大群），
 *     所以写成判据而不是硬规则；这同时也是给用户的安全警示。
 *  2. **非 owner**——Dashboard 是整机管理面，token 等于管理员凭证，不是「谁问都能给」
 *     的普通链接。
 */
export const DASHBOARD_LINK_SAFETY_HINT = [
  '⚠️ 安全提示（给 AI 读）：以上链接是本机 Dashboard 的**管理员凭证**，不是普通网页链接。',
  '  · 只发给 owner 本人。任何其他人（包括同事、同群成员）都不要发，也不要在回答里复述。',
  '  · 当前会话若是多人群（你自己判断人数与成员构成），一律**不要把带 `?t=` token 的链接发出去**——',
  '    聊天记录会长期留存并可被转发/截图，等同于把管理员权限交出去。',
  '  · 需要给别人指路时，只说「在服务器上运行 `botmux dashboard`」，让对方自己取。',
].join('\n');

export type DashboardCommandExecution =
  | { kind: 'help' }
  | { kind: 'invalid'; argument: string }
  | { kind: 'endpoint'; action: 'current' | 'rotate'; result: DashboardResult; showLocalTokenLink: boolean };

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
 * ─── 绑定中心化平台后，链接里不再带 token ──────────────────────────────────
 * `localUrl` 有值 **就等于**「远程基址已生效」这一位（平台绑定 + 远程访问，或
 * 自建反代 `BOTMUX_PUBLIC_URL`，见 dashboard-url.ts:buildDashboardUrls —— 只有
 * 那种情况才会额外给出本地直连形态）。所以不必另读一遍配置就能判断。
 *
 * 这种情况下 token **对访问毫无贡献、只剩泄漏价值**：走平台子域进来的请求由平台
 * 注入身份，`request-identity.ts` 对 `platform-dashboard` 身份恒把
 * `presentedToken` 压成 undefined，实测带 `?t=` 依旧 401（`x-botmux-auth-scope:
 * workbench`）；平台边缘更是先把浏览器 302 去 SSO 登录。真人 owner 是被平台认出来
 * 的，不是靠这段 token。既然如此，就别把它印在一条会被复制、转发、截图的链接上。
 *
 * 反过来，**未绑定平台时 token 不能去**：那时 `http://ip:port/` 只是静态壳，SPA
 * 探 `/api/settings` 拿 401，而 401 上的 `x-botmux-login-url` 由
 * `buildPlatformDashboardLoginUrl()` 生成、未绑定时返回 undefined —— 登录浮层没有
 * 出口，去掉 token 等于把唯一入口堵死。所以 `localUrl === undefined` 分支原样保留。
 *
 * ⚠️ 无凭证形态必须用 hash 路由 `/#/agent-workbench`，不能用 `/workbench`：后者
 * 不在 `decideDashboardAuth` 的静态壳白名单里，token-free 访问实测 401（平台身份
 * 下也一样），会给出一条打不开的链接。有 token 时才用无 fragment 的 `/workbench`。
 *
 * @param showLocalTokenLink 用户是否显式递了 {@link DASHBOARD_LOCAL_TOKEN_FLAG}
 */
export function formatDashboardSuccessLines(
  result: Extract<DashboardResult, { ok: true }>,
  showLocalTokenLink = false,
): string[] {
  const remoteBacked = result.localUrl !== undefined;
  // 平台/反代已生效 ⇒ 主链接去掉 token；否则原样（token 是唯一入口）。
  const primary = remoteBacked ? stripDashboardToken(result.url) ?? result.url : result.url;
  const lines = [primary];

  // 工作台入口跟着主链接的凭证形态走：带 token 用无 fragment 的 `/workbench`，
  // 不带 token 必须用 hash 形态（`/workbench` token-free 是 401 死链）。
  const workbench = remoteBacked ? workbenchSpaUrl(primary) : workbenchEntryUrl(primary);
  if (workbench) lines.push(`工作台: ${workbench}`);

  if (result.localUrl) {
    if (showLocalTokenLink) {
      lines.push(`本地直连(平台异常时可用): ${result.localUrl}`);
      lines.push('  ⚠️ 上面这条带 token，等同管理员密码：只在你自己的终端里用，别发给任何人、别贴进聊天。');
    } else {
      // 给**人**看的提示。参数刻意不进 help（见 DASHBOARD_LOCAL_TOKEN_FLAG）：
      // 只有真正跑过这条命令的人才会看到它。
      lines.push(
        `本地直连(平台异常时可用): 已隐藏——它带 token，等同管理员密码。需要时加 ${DASHBOARD_LOCAL_TOKEN_FLAG}`,
      );
    }
  }

  lines.push(DASHBOARD_LINK_SAFETY_HINT);
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
 *
 * {@link DASHBOARD_LOCAL_TOKEN_FLAG} is consumed HERE rather than in `cli.ts` so
 * the whole parse stays one testable unit — and, importantly, so it is stripped
 * before the "at most one positional" check below. Leaving it in `args` would
 * make `botmux dashboard rotate --i-am-the-owner-show-token-link` parse as
 * `invalid`, i.e. the safety flag would break the very command it guards.
 */
export async function executeDashboardCommand(
  args: readonly string[],
  callEndpoint: (path: DashboardEndpoint) => Promise<DashboardResult>,
): Promise<DashboardCommandExecution> {
  if (args.some(arg => ['--help', '-h', 'help'].includes(arg.toLowerCase()))) {
    return { kind: 'help' };
  }
  // Case-sensitive on purpose: this must be typed deliberately, and an exact
  // match keeps a near-miss (`--I-Am-The-Owner…`) an `invalid` argument the user
  // sees, rather than silently printing the token link.
  const showLocalTokenLink = args.includes(DASHBOARD_LOCAL_TOKEN_FLAG);
  const positional = args.filter(arg => arg !== DASHBOARD_LOCAL_TOKEN_FLAG);

  if (positional.length > 1) return { kind: 'invalid', argument: positional.join(' ') };

  const raw = positional[0]?.toLowerCase();

  if (raw !== undefined && raw !== 'current' && raw !== 'rotate') {
    return { kind: 'invalid', argument: positional[0] };
  }

  const action = raw === 'rotate' ? 'rotate' : 'current';
  const settle = (result: DashboardResult): DashboardCommandExecution =>
    ({ kind: 'endpoint', action, result, showLocalTokenLink });

  if (action === 'rotate') {
    return settle(await callEndpoint('/__cli/rotate'));
  }

  const current = await callEndpoint('/__cli/current');
  if (current.ok || current.reason !== 'no-active-token') {
    return settle(current);
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
      return settle(legacyCurrent);
    }
    return settle(await callEndpoint('/__cli/rotate'));
  }
  return settle(ensured);
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
