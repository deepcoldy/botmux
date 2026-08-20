/**
 * Host-overload alerting: watch the machine's 15-minute load average and memory
 * pressure, and fire a single Feishu DM to the bot owner when the host crosses
 * into an overloaded state (and one more when it recovers).
 *
 * Motivation: botmux already samples load/cpu/mem for the dashboard
 * (dashboard/resource-monitor-service.ts), but that path is purely passive — it
 * only feeds charts and never warns anyone. A cold-start that misses the 15s
 * readiness window (see the "bare-shell" false-death path) usually traces back
 * to the machine being overloaded, not to a config bug. This module turns the
 * already-collected signal into an actionable heads-up.
 *
 * Design:
 *  - Pure decision function {@link evaluateOverload} maps a reading + previous
 *    state to a next state and an optional alert action. No I/O, no timers, no
 *    Node globals — trivially unit-testable.
 *  - Hysteresis: enter at `load15 > cpuCount * enterLoadRatio` (or mem/swap over
 *    their enter thresholds); only clear once BELOW a lower exit threshold so a
 *    load hovering around the line can't flap and spam the owner.
 *  - Edge-triggered: exactly one "entered" alert per overload episode and one
 *    "recovered" alert when it ends. Steady-state (still overloaded / still
 *    healthy) produces no action.
 *  - A minimum re-alert interval guards against a long episode that dips just
 *    under the exit line and back repeatedly within a short window.
 */

export interface OverloadThresholds {
  /** Logical CPU count used to normalise load average (os.cpus().length). */
  cpuCount: number;
  /** Enter overload when load15 > cpuCount * this. Default 1.5. */
  enterLoadRatio: number;
  /** Leave overload only when load15 <= cpuCount * this. Default 1.0. Must be <= enterLoadRatio. */
  exitLoadRatio: number;
  /** Enter overload when used memory fraction (0..1) >= this. Default 0.92. */
  enterMemUsedFrac: number;
  /** Leave overload only when used memory fraction <= this. Default 0.85. */
  exitMemUsedFrac: number;
  /** Enter overload when swap-used fraction (0..1) >= this. Default 0.5. 0 disables. */
  enterSwapUsedFrac: number;
  /** Leave overload only when swap-used fraction <= this. Default 0.25. */
  exitSwapUsedFrac: number;
  /**
   * Minimum ms between two "entered" alerts. Even if the state machine leaves
   * and re-enters overload, suppress a fresh entered-alert within this window.
   * Default 15 min. The recovered-alert is never rate-limited (it ends noise).
   */
  minReAlertMs: number;
}

export const DEFAULT_OVERLOAD_THRESHOLDS: Omit<OverloadThresholds, 'cpuCount'> = {
  enterLoadRatio: 1.5,
  exitLoadRatio: 1.0,
  enterMemUsedFrac: 0.92,
  exitMemUsedFrac: 0.85,
  enterSwapUsedFrac: 0.5,
  exitSwapUsedFrac: 0.25,
  minReAlertMs: 15 * 60_000,
};

/** Parse a finite float from a raw env string; blank/garbage/failing-`isValid`
 *  → `fallback`. `isValid` defaults to non-negative (right for exit lines +
 *  minReAlertMs, where 0 is a legal "off"/"immediate" value); the enter
 *  thresholds pass stricter predicates (load must be > 0, mem must be in (0,1])
 *  so a degenerate `enter=0` can't sneak in — at enter=0 the 95% hysteresis
 *  clamp is still 0, breaking "exit strictly below enter" and (for mem) flapping
 *  entered/recovered every tick. Shared by {@link computeOverloadThresholds} so
 *  env-override precedence is testable without a live `process.env`. */
export function parseOverloadEnvFloat(
  raw: string | undefined,
  fallback: number,
  isValid: (n: number) => boolean = (n) => n >= 0,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && isValid(n) ? n : fallback;
}

/** Validity predicates for the two enter dimensions — exported so tests + the
 *  config/applier layers can share the exact same rule (single source of truth). */
export const isValidEnterLoadRatio = (n: number): boolean => Number.isFinite(n) && n > 0;
export const isValidEnterMemUsedFrac = (n: number): boolean => Number.isFinite(n) && n > 0 && n <= 1;

/**
 * Should THIS daemon sample host pressure and own the overload alert?
 *
 * The alert is machine-level: the global `hostOverloadAlert` config names ONE
 * notifier bot, and only that bot's own daemon samples + advances the state
 * machine + DMs (it runs on this host, so no cross-daemon delivery is needed).
 * Every other daemon must no-op AND reset its local state, so that when the
 * target later switches TO this bot the state machine starts clean (no stale
 * "already overloaded" edge from a previous ownership). Pure predicate over the
 * config + this daemon's identity — the reset is the caller's responsibility.
 *
 * FAIL-CLOSED on apiOnly: a core-only (apiOnly) bot has no Feishu transport, so
 * it can never DM an admin. Even if a hand-edited config or a pre-`apiOnly`-aware
 * migration names an apiOnly bot as the target, this daemon must NOT sample —
 * it would advance the state machine and then silently drop every alert. The
 * migration also excludes apiOnly candidates; this is the runtime backstop for
 * configs that bypass it.
 *
 * @param alertCfg the global `hostOverloadAlert` block (or {} when unset).
 * @param self this daemon's identity: `larkAppId` + whether it's apiOnly.
 */
export function isOverloadAlertTarget(
  alertCfg: { enabled?: boolean; targetBotAppId?: string } | undefined,
  self: { larkAppId: string; apiOnly?: boolean } | string,
): boolean {
  if (!alertCfg) return false;
  const selfAppId = typeof self === 'string' ? self : self.larkAppId;
  const selfApiOnly = typeof self === 'string' ? false : self.apiOnly === true;
  if (selfApiOnly) return false; // apiOnly bots can't deliver a DM — never sample.
  return alertCfg.enabled === true
    && typeof alertCfg.targetBotAppId === 'string'
    && alertCfg.targetBotAppId === selfAppId;
}

/** Raw inputs for {@link computeOverloadThresholds}: the host CPU count, the
 *  operator's enter thresholds from global config (already-parsed numbers or
 *  undefined), and the relevant `BOTMUX_OVERLOAD_*` env strings. Kept as plain
 *  data so the priority + hysteresis logic is pure and unit-testable. */
export interface OverloadThresholdInputs {
  cpuCount: number;
  configEnterLoadRatio?: number;
  configEnterMemUsedFrac?: number;
  env?: {
    enterLoadRatio?: string;
    exitLoadRatio?: string;
    enterMemUsedFrac?: string;
    exitMemUsedFrac?: string;
    minReAlertMs?: string;
  };
  /** Optional sink for the hysteresis-clamp warning (daemon passes logger.warn). */
  warn?: (message: string) => void;
}

/**
 * Resolve the effective {@link OverloadThresholds} from env > global config >
 * built-in default for the ENTER lines, deriving the EXIT lines with hysteresis.
 *
 * Precedence (enter load/mem): a valid `BOTMUX_OVERLOAD_ENTER_*` env wins; else
 * a sane positive config value; else the built-in default. Config values are
 * re-validated defensively here (finite, positive, mem ≤ 1) so a bad persisted
 * value can't leak past the resolver.
 *
 * Hysteresis: the recover (exit) line MUST sit strictly below the enter line, or
 * a reading pinned at the threshold flaps entered/recovered every tick (enter
 * uses `>=`, recover uses `<=`). If a misconfigured exit ≥ enter, clamp it to
 * 95% of enter and warn. Swap thresholds + minReAlertMs pass through (env or
 * default). Pure: no `os`, no `process.env`, no clock.
 */
export function computeOverloadThresholds(inputs: OverloadThresholdInputs): OverloadThresholds {
  const cpuCount = Math.max(1, inputs.cpuCount || 1);
  const env = inputs.env ?? {};
  // Config enter values are re-validated with the SAME per-dimension predicates
  // as env (load > 0, mem in (0,1]) so a bad persisted value falls through to
  // the built-in default instead of poisoning the derived exit line.
  const cfgEnterLoad = typeof inputs.configEnterLoadRatio === 'number' && isValidEnterLoadRatio(inputs.configEnterLoadRatio)
    ? inputs.configEnterLoadRatio : DEFAULT_OVERLOAD_THRESHOLDS.enterLoadRatio;
  const cfgEnterMem = typeof inputs.configEnterMemUsedFrac === 'number' && isValidEnterMemUsedFrac(inputs.configEnterMemUsedFrac)
    ? inputs.configEnterMemUsedFrac : DEFAULT_OVERLOAD_THRESHOLDS.enterMemUsedFrac;
  // Enter thresholds: env wins, but only if it passes the strict predicate;
  // otherwise fall back to the (already-validated) config/default value.
  const enterLoadRatio = parseOverloadEnvFloat(env.enterLoadRatio, cfgEnterLoad, isValidEnterLoadRatio);
  let exitLoadRatio = parseOverloadEnvFloat(env.exitLoadRatio, DEFAULT_OVERLOAD_THRESHOLDS.exitLoadRatio);
  const enterMemUsedFrac = parseOverloadEnvFloat(env.enterMemUsedFrac, cfgEnterMem, isValidEnterMemUsedFrac);
  let exitMemUsedFrac = parseOverloadEnvFloat(env.exitMemUsedFrac, DEFAULT_OVERLOAD_THRESHOLDS.exitMemUsedFrac);
  const HYSTERESIS_MARGIN = 0.95; // exit = 95% of enter when misconfigured
  if (exitLoadRatio >= enterLoadRatio) {
    const clamped = enterLoadRatio * HYSTERESIS_MARGIN;
    inputs.warn?.(`[overload] BOTMUX_OVERLOAD_EXIT_LOAD_RATIO (${exitLoadRatio}) >= ENTER (${enterLoadRatio}); clamping exit to ${clamped}`);
    exitLoadRatio = clamped;
  }
  if (exitMemUsedFrac >= enterMemUsedFrac) {
    const clamped = enterMemUsedFrac * HYSTERESIS_MARGIN;
    inputs.warn?.(`[overload] BOTMUX_OVERLOAD_EXIT_MEM_FRAC (${exitMemUsedFrac}) >= ENTER (${enterMemUsedFrac}); clamping exit to ${clamped}`);
    exitMemUsedFrac = clamped;
  }
  return {
    cpuCount,
    enterLoadRatio,
    exitLoadRatio,
    enterMemUsedFrac,
    exitMemUsedFrac,
    enterSwapUsedFrac: DEFAULT_OVERLOAD_THRESHOLDS.enterSwapUsedFrac,
    exitSwapUsedFrac: DEFAULT_OVERLOAD_THRESHOLDS.exitSwapUsedFrac,
    minReAlertMs: parseOverloadEnvFloat(env.minReAlertMs, DEFAULT_OVERLOAD_THRESHOLDS.minReAlertMs),
  };
}

/** A single sampled reading of host pressure. */
export interface HostReading {
  /** 15-minute load average (os.loadavg()[2]). */
  load15: number;
  /** Total physical memory in bytes (os.totalmem()). */
  memTotalBytes: number;
  /** Free physical memory in bytes (os.freemem()). */
  memFreeBytes: number;
  /**
   * Swap total/used in bytes, if known. macOS/Node has no built-in swap read;
   * pass undefined to skip the swap dimension entirely.
   */
  swapTotalBytes?: number;
  swapUsedBytes?: number;
}

/** Which dimension(s) tripped the enter threshold — used for the alert copy. */
export type OverloadReason = 'load' | 'memory' | 'swap';

export interface OverloadState {
  overloaded: boolean;
  /** ms timestamp of the last "entered" alert we emitted (0 = never). */
  lastEnteredAlertAt: number;
}

export const INITIAL_OVERLOAD_STATE: OverloadState = { overloaded: false, lastEnteredAlertAt: 0 };

export interface OverloadAlertAction {
  kind: 'entered' | 'recovered';
  reasons: OverloadReason[];
  reading: HostReading;
  /** Derived, human-friendly numbers for the alert copy. */
  metrics: {
    load15: number;
    loadPerCpu: number;
    cpuCount: number;
    memUsedFrac: number;
    swapUsedFrac: number | undefined;
  };
}

export interface OverloadEvaluation {
  nextState: OverloadState;
  /** Present only on a state edge that should notify the owner. */
  action?: OverloadAlertAction;
}

function memUsedFrac(reading: HostReading): number {
  if (reading.memTotalBytes <= 0) return 0;
  const used = reading.memTotalBytes - reading.memFreeBytes;
  return Math.max(0, Math.min(1, used / reading.memTotalBytes));
}

function swapUsedFrac(reading: HostReading): number | undefined {
  if (reading.swapTotalBytes === undefined || reading.swapUsedBytes === undefined) return undefined;
  if (reading.swapTotalBytes <= 0) return 0;
  return Math.max(0, Math.min(1, reading.swapUsedBytes / reading.swapTotalBytes));
}

/**
 * Which dimensions are over their ENTER thresholds right now. Non-empty ⇒ the
 * reading looks overloaded (used to trip a healthy→overloaded transition).
 */
function enterReasons(reading: HostReading, t: OverloadThresholds): OverloadReason[] {
  const reasons: OverloadReason[] = [];
  if (t.cpuCount > 0 && reading.load15 > t.cpuCount * t.enterLoadRatio) reasons.push('load');
  if (memUsedFrac(reading) >= t.enterMemUsedFrac) reasons.push('memory');
  const swap = swapUsedFrac(reading);
  if (t.enterSwapUsedFrac > 0 && swap !== undefined && swap >= t.enterSwapUsedFrac) reasons.push('swap');
  return reasons;
}

/**
 * True when EVERY dimension has fallen back under its EXIT threshold — i.e. the
 * host is comfortably healthy again. Requiring all dimensions to clear (with a
 * lower exit bar than the enter bar) is the hysteresis that prevents flapping.
 */
function fullyRecovered(reading: HostReading, t: OverloadThresholds): boolean {
  const loadOk = t.cpuCount <= 0 || reading.load15 <= t.cpuCount * t.exitLoadRatio;
  const memOk = memUsedFrac(reading) <= t.exitMemUsedFrac;
  const swap = swapUsedFrac(reading);
  const swapOk = t.enterSwapUsedFrac <= 0 || swap === undefined || swap <= t.exitSwapUsedFrac;
  return loadOk && memOk && swapOk;
}

function metricsFor(reading: HostReading, t: OverloadThresholds): OverloadAlertAction['metrics'] {
  return {
    load15: reading.load15,
    loadPerCpu: t.cpuCount > 0 ? reading.load15 / t.cpuCount : 0,
    cpuCount: t.cpuCount,
    memUsedFrac: memUsedFrac(reading),
    swapUsedFrac: swapUsedFrac(reading),
  };
}

/**
 * Core state-machine step. Given the previous state, the current reading and
 * thresholds (plus `now` for rate-limiting), return the next state and, on a
 * notable edge, the alert action to deliver.
 *
 * Transitions:
 *  - healthy → overloaded: any enter reason trips. Emit `entered` UNLESS a prior
 *    entered-alert fired within `minReAlertMs` (then flip state silently).
 *  - overloaded → healthy: only once `fullyRecovered` (all dims under exit bar).
 *    Always emit `recovered`.
 *  - no change: no action.
 */
export function evaluateOverload(
  prev: OverloadState,
  reading: HostReading,
  thresholds: OverloadThresholds,
  now: number,
): OverloadEvaluation {
  const reasons = enterReasons(reading, thresholds);

  if (!prev.overloaded) {
    if (reasons.length === 0) return { nextState: prev };
    // healthy → overloaded edge.
    const suppressed = now - prev.lastEnteredAlertAt < thresholds.minReAlertMs && prev.lastEnteredAlertAt > 0;
    const nextState: OverloadState = {
      overloaded: true,
      lastEnteredAlertAt: suppressed ? prev.lastEnteredAlertAt : now,
    };
    if (suppressed) return { nextState };
    return {
      nextState,
      action: { kind: 'entered', reasons, reading, metrics: metricsFor(reading, thresholds) },
    };
  }

  // Currently overloaded: stay until fully recovered.
  if (!fullyRecovered(reading, thresholds)) return { nextState: prev };
  // overloaded → healthy edge; always announce recovery.
  return {
    nextState: { overloaded: false, lastEnteredAlertAt: prev.lastEnteredAlertAt },
    action: {
      kind: 'recovered',
      // On recovery the reasons list is whatever was still elevated at the last
      // sample; report the (now-cleared) dimensions best-effort as empty.
      reasons: [],
      reading,
      metrics: metricsFor(reading, thresholds),
    },
  };
}

const REASON_LABEL: Record<OverloadReason, string> = {
  load: 'CPU 负载',
  memory: '内存',
  swap: 'Swap',
};

/** Build the Feishu text body for an alert action. Kept here so it's testable. */
export function formatOverloadAlert(action: OverloadAlertAction, hostLabel?: string): string {
  const m = action.metrics;
  const host = hostLabel ? `（${hostLabel}）` : '';
  const load = `load15 ${m.load15.toFixed(1)} / ${m.cpuCount} 核 = 每核 ${m.loadPerCpu.toFixed(2)}`;
  const mem = `内存已用 ${(m.memUsedFrac * 100).toFixed(0)}%`;
  const swap = m.swapUsedFrac === undefined ? '' : ` · Swap ${(m.swapUsedFrac * 100).toFixed(0)}%`;
  if (action.kind === 'recovered') {
    return `✅ 机器负载已恢复${host}\n${load} · ${mem}${swap}\n（botmux 会话可以正常冷启动了）`;
  }
  const why = action.reasons.map(r => REASON_LABEL[r]).join(' + ') || '资源';
  return (
    `⚠️ 机器过载告警${host}\n` +
    `触发维度：${why}\n` +
    `${load} · ${mem}${swap}\n` +
    `此时 botmux 会话冷启动可能超时假死。建议：\`botmux delete stopped\` 清僵尸、挂起闲置会话、或调低各 bot 的 maxLiveWorkers。`
  );
}

/** action.value.action strings emitted by the alert card buttons; the daemon's
 *  card handler matches on these. Exported so the handler and tests share the
 *  exact literals (typo-proof). */
export const OVERLOAD_ACTION_CLEAN_STOPPED = 'overload_clean_stopped';
export const OVERLOAD_ACTION_SUSPEND_IDLE = 'overload_suspend_idle';
/** Restart a specific browser (bundleId carried on the button value). One action
 *  literal for all browsers; the per-browser one-shot claim keys on bundleId. */
export const OVERLOAD_ACTION_RESTART_BROWSER = 'overload_restart_browser';
/** Fail-safe action on a disabled (already-run) button — clients that don't
 *  suppress disabled callbacks just get a harmless toast, no side effect. */
export const OVERLOAD_ACTION_NOOP = 'overload_noop';

/** One-line metrics summary reused by both the text and card renderers. */
function metricsLine(m: OverloadAlertAction['metrics']): string {
  const load = `load15 ${m.load15.toFixed(1)} / ${m.cpuCount} 核 = 每核 ${m.loadPerCpu.toFixed(2)}`;
  const mem = `内存已用 ${(m.memUsedFrac * 100).toFixed(0)}%`;
  const swap = m.swapUsedFrac === undefined ? '' : ` · Swap ${(m.swapUsedFrac * 100).toFixed(0)}%`;
  return `${load} · ${mem}${swap}`;
}

/**
 * Per-button state carried on the card so any daemon can rebuild it after a
 * click without external storage. `done`/`n` record whether an action already
 * ran and how many sessions it affected (−1 = not yet run). Counts are the
 * machine-wide candidate totals shown in the button labels before clicking.
 */
export interface OverloadCardState {
  nonce: string;
  /** metrics for the summary line (kept compact). */
  load15: number;
  cpu: number;
  mem: number; // used fraction 0..1
  swap?: number; // used fraction 0..1, optional
  reasons: OverloadReason[];
  /** machine-wide candidate counts (refreshed on every rebuild). */
  stopped: number;
  idle: number;
  /** result of each action once run; -1 = not run yet. */
  cleanedN: number;
  suspendedN: number;
  /** Browsers currently running + holding memory on this host, in display order.
   *  Empty ⇒ no browser buttons (nothing to reclaim). */
  browsers?: OverloadCardBrowser[];
  /** bundleIds whose restart button has already been clicked (✓ done). */
  restartedBrowsers?: string[];
}

/** A per-browser restart button descriptor carried on the card. */
export interface OverloadCardBrowser {
  bundleId: string;
  label: string;
  memMB: number;
}

/** Build the machine-wide summary/metrics line from card state. */
function stateMetricsLine(st: OverloadCardState): string {
  const load = `load15 ${st.load15.toFixed(1)} / ${st.cpu} 核 = 每核 ${(st.cpu > 0 ? st.load15 / st.cpu : 0).toFixed(2)}`;
  const mem = `内存已用 ${(st.mem * 100).toFixed(0)}%`;
  const swap = st.swap === undefined ? '' : ` · Swap ${(st.swap * 100).toFixed(0)}%`;
  return `${load} · ${mem}${swap}`;
}

/** Seed initial card state from an `entered` action + counts + nonce. */
export function initialOverloadCardState(
  action: OverloadAlertAction,
  counts: { stopped: number; idle: number },
  nonce: string,
  browsers: OverloadCardBrowser[] = [],
): OverloadCardState {
  return {
    nonce,
    load15: action.metrics.load15,
    cpu: action.metrics.cpuCount,
    mem: action.metrics.memUsedFrac,
    ...(action.metrics.swapUsedFrac === undefined ? {} : { swap: action.metrics.swapUsedFrac }),
    reasons: action.reasons,
    stopped: counts.stopped,
    idle: counts.idle,
    cleanedN: -1,
    suspendedN: -1,
    ...(browsers.length ? { browsers, restartedBrowsers: [] } : {}),
  };
}

/** Card button label for a browser restart, e.g. `♻️ 重启 Arc · 6.2 GB`. Inlined
 *  here (rather than imported from core/browser-restart) so this card module
 *  stays free of node:child_process and trivially unit-testable. Pure. */
function browserButtonLabel(label: string, memMB: number): string {
  if (!Number.isFinite(memMB) || memMB <= 0) return `♻️ 重启 ${label}`;
  const mem = memMB >= 1024 ? `${(memMB / 1024).toFixed(1)} GB` : `${Math.round(memMB)} MB`;
  return `♻️ 重启 ${label} · ${mem}`;
}

/**
 * Build the interactive Feishu overload card from card state (returns a JSON
 * string). This one builder renders BOTH the initial alert and every post-click
 * rebuild: it always shows two buttons so clicking one never removes the other.
 *
 *  - Not-yet-run button → live callback, label shows the candidate count
 *    (「🧹 清僵尸会话 (N)」). Carries the full `st` so the handler can rebuild.
 *  - Already-run button → disabled + a `✓ 已清理 X 个` label (with a `noop`
 *    fail-safe action for clients that don't suppress disabled callbacks).
 *
 * Each button also carries its own nonce claim (one-shot per action), so the
 * owner can click both buttons on one card, but neither twice.
 */
export function buildOverloadAlertCard(st: OverloadCardState, hostLabel?: string): string {
  const host = hostLabel ? `（${hostLabel}）` : '';
  const why = st.reasons.map(r => REASON_LABEL[r]).join(' + ') || '资源';

  const cleanBtn = st.cleanedN >= 0
    ? { tag: 'button', type: 'default', disabled: true,
        text: { tag: 'plain_text', content: `✓ 已清理 ${st.cleanedN} 个僵尸` },
        value: { action: OVERLOAD_ACTION_NOOP } }
    : { tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: `🧹 清僵尸会话 (${st.stopped})` },
        value: { action: OVERLOAD_ACTION_CLEAN_STOPPED, st: JSON.stringify(st) } };

  const suspendBtn = st.suspendedN >= 0
    ? { tag: 'button', type: 'default', disabled: true,
        text: { tag: 'plain_text', content: `✓ 已挂起 ${st.suspendedN} 个闲置` },
        value: { action: OVERLOAD_ACTION_NOOP } }
    : { tag: 'button', type: 'default',
        text: { tag: 'plain_text', content: `💤 挂起闲置会话 (${st.idle})` },
        value: { action: OVERLOAD_ACTION_SUSPEND_IDLE, st: JSON.stringify(st) } };

  // Per-browser restart buttons: one per browser that's running + holding memory
  // on this host. Each carries its own bundleId so the one-shot claim keys on it
  // (the owner can bounce Arc AND Chrome on one card, but neither twice). A
  // clicked browser → disabled ✓; the memory tag reflects what was reclaimed.
  const browsers = st.browsers ?? [];
  const restarted = new Set(st.restartedBrowsers ?? []);
  const browserBtns = browsers.map((b) => restarted.has(b.bundleId)
    ? { tag: 'button', type: 'default', disabled: true,
        text: { tag: 'plain_text', content: `✓ 已重启 ${b.label}` },
        value: { action: OVERLOAD_ACTION_NOOP } }
    : { tag: 'button', type: 'danger',
        text: { tag: 'plain_text', content: browserButtonLabel(b.label, b.memMB) },
        value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: b.bundleId, st: JSON.stringify(st) } });

  const memList = browsers.length
    ? '内存占用：' + browsers.map(b => `**${b.label} ${b.memMB >= 1024 ? (b.memMB / 1024).toFixed(1) + 'G' : b.memMB + 'M'}**`).join(' · ')
    : '';

  const actionRows: unknown[] = [{ tag: 'action', actions: [cleanBtn, suspendBtn] }];
  // Repo convention: <= 4 buttons per `action` row. With 5+ custom browser
  // targets we'd otherwise cram them all into one row; chunk into rows of 4.
  for (let i = 0; i < browserBtns.length; i += 4) {
    actionRows.push({ tag: 'action', actions: browserBtns.slice(i, i + 4) });
  }

  const noteLines = [
    '清僵尸=关闭进程已退出的僵尸会话；挂起闲置=挂起空闲可恢复会话（下条消息冷恢复）。',
  ];
  if (browsers.length) noteLines.push('重启浏览器=优雅退出并重开该浏览器（会恢复标签页），用于释放浏览器占用的大块内存。');
  noteLines.push('仅管理员可操作，每个按钮可点一次。');

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**触发维度：**${why}\n${stateMetricsLine(st)}` } },
    { tag: 'div', text: { tag: 'lark_md', content: `当前可降压：**僵尸会话 ${st.stopped} 个** · **闲置会话 ${st.idle} 个**` } },
  ];
  if (memList) elements.push({ tag: 'div', text: { tag: 'lark_md', content: memList } });
  elements.push({ tag: 'hr' });
  elements.push(...actionRows);
  elements.push({ tag: 'note', elements: [{ tag: 'lark_md', content: noteLines.join('') }] });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: `⚠️ 机器过载告警${host}` } },
    elements,
  });
}

/** Display-only card for the `recovered` edge (no buttons). */
export function buildOverloadRecoveredCard(action: OverloadAlertAction, hostLabel?: string): string {
  const host = hostLabel ? `（${hostLabel}）` : '';
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: `✅ 机器负载已恢复${host}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: metricsLine(action.metrics) } },
      { tag: 'note', elements: [{ tag: 'lark_md', content: 'botmux 会话可以正常冷启动了。' }] },
    ],
  });
}

/** Grey "this alert card has expired" card (daemon restart lost the nonce, etc.). */
export function buildOverloadExpiredCard(detail = ''): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: '⏳ 操作已失效' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: detail || '这张告警卡已过期（daemon 重启或超时）。等待下一次告警即可。' } }],
  });
}

/**
 * Failure card for a browser-restart click that could not complete (quit failed,
 * refused to quit within the window, or quit-but-relaunch-failed). Rendered as a
 * FULL patchable alert card (not a toast): the browser-restart handler can run up
 * to ~12s, past the 2.5s card-ACK window, after which a toast-only result is
 * dropped by the dispatcher — so the failure must ride a card the dispatcher can
 * patch in. Carries the rebuilt alert `st` so every still-live button (including
 * this browser's, whose claim was released for retry) stays clickable.
 */
export function buildOverloadBrowserFailureCard(st: OverloadCardState, label: string, detail: string, hostLabel?: string): string {
  const base = JSON.parse(buildOverloadAlertCard(st, hostLabel)) as { elements: unknown[] };
  base.elements.push({
    tag: 'note',
    elements: [{ tag: 'lark_md', content: `⚠️ **${label}**：${detail}` }],
  });
  return JSON.stringify(base);
}
