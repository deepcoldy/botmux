/**
 * Budget tracker — per-bot monthly cost budget state machine.
 *
 * Sits passively on the usage-ledger write path: the daemon wires a record
 * sink (see usage-ledger.ts `setUsageLedgerRecordSink`) that feeds every
 * positive-delta ledger record's `costCny` here. The tracker accumulates the
 * month's spend per bot in a small state file
 * (`budget-state-<appId>.json`, same per-bot partitioning + temp+rename
 * durability as the ledger's `state-<appId>.json`) and decides when a
 * budget threshold has been crossed.
 *
 * Alerting is edge-triggered and de-duplicated: each threshold fires at most
 * once per month (`alertedThresholds` persisted), and a single jump that
 * crosses several thresholds fires exactly one alert carrying the HIGHEST
 * crossed threshold while marking ALL crossed thresholds as alerted.
 *
 * Pure decision + file I/O: no bot-registry, no lark client. The daemon owns
 * notification delivery (DM to the bot owner) and the hard-stop admission
 * gate; this module only answers "how much have we spent" and "what crossed".
 *
 * 升级注意：升级前的 ledger 记录没有 costCny，状态丢失重建时一律计 0——
 * 预算统计从升级后开始累加，不回溯历史花费。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { defaultLedgerDir } from './usage-ledger.js';

export interface BudgetConfig {
  monthlyCny: number;
  alertThresholdPercent: number[];
  hardStop: boolean;
}

export interface BudgetAlert {
  larkAppId: string;
  month: string;
  spentCny: number;
  monthlyCny: number;
  percent: number;
  threshold: number;
  hardStop: boolean;
}

export interface BudgetStatus {
  month: string;
  spentCny: number;
  monthlyCny?: number;
  percent?: number;
  hardStop: boolean;
}

interface BudgetState {
  /** 'YYYY-MM' (UTC) — spend rolls over lazily when the month changes. */
  month: string;
  spentCny: number;
  /** Thresholds already alerted this month, so a lingering spend can't
   *  re-fire the same line every turn. */
  alertedThresholds: number[];
}

// ─── Config parsing (loose; garbage in → feature off, never throws) ──────────

/** Parse a `budget` block from bots.json. `monthlyCny` is the gate: a
 *  missing/non-positive/non-finite value disables the feature (null).
 *  Thresholds default to [80]; non-finite or out-of-(0,1000] entries are
 *  dropped, duplicates removed, ascending order. hardStop defaults false. */
export function parseBudgetConfig(raw: unknown): BudgetConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const monthlyCny = typeof r.monthlyCny === 'number' && Number.isFinite(r.monthlyCny) && r.monthlyCny > 0
    ? r.monthlyCny
    : null;
  if (monthlyCny === null) return null;

  const rawThresholds = Array.isArray(r.alertThresholdPercent) ? r.alertThresholdPercent : [];
  const thresholds = [...new Set(
    rawThresholds.filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 1000,
    ),
  )].sort((a, b) => a - b);

  return {
    monthlyCny,
    alertThresholdPercent: thresholds.length > 0 ? thresholds : [80],
    hardStop: r.hardStop === true,
  };
}

// ─── State persistence ───────────────────────────────────────────────────────

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function freshState(month: string): BudgetState {
  return { month, spentCny: 0, alertedThresholds: [] };
}

function sanitizeAppId(larkAppId: string): string {
  return larkAppId.replace(/[^A-Za-z0-9_-]/g, '') || 'default';
}

function statePath(dir: string, larkAppId: string): string {
  return join(dir, `budget-state-${sanitizeAppId(larkAppId)}.json`);
}

/** Hot-path cache: the admission gate and status reads must not re-parse the
 *  state file on every message. mtime guard picks up external changes
 *  (another daemon process, manual edits) on the next call. */
interface CachedState {
  mtimeMs: number;
  state: BudgetState;
}
const stateCache = new Map<string, CachedState>();

export function _resetBudgetTrackerForTest(): void {
  stateCache.clear();
}

function normalizeState(parsed: unknown, month: string): BudgetState | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.month !== 'string' || !/^\d{4}-\d{2}$/.test(p.month)) return null;
  if (p.month !== month) return freshState(month); // lazy rollover
  const spentCny = typeof p.spentCny === 'number' && Number.isFinite(p.spentCny) && p.spentCny >= 0
    ? p.spentCny
    : 0;
  const alerted = Array.isArray(p.alertedThresholds)
    ? [...new Set(
      p.alertedThresholds.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)),
    )]
    : [];
  return { month: p.month, spentCny, alertedThresholds: alerted };
}

/** Rebuild this month's spend from the daily ledger files when the state
 *  file is missing (deleted, or first run after upgrade). Records without
 *  costCny (pre-upgrade) count as 0 — historical spend is NOT backfilled. */
function rebuildBudgetStateFromLedger(dir: string, larkAppId: string, month: string): BudgetState {
  const state = freshState(month);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(`usage-${month}-`) && f.endsWith('.jsonl'));
  } catch {
    return state;
  }
  for (const name of files.sort()) {
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.includes(larkAppId)) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.larkAppId === larkAppId
          && typeof rec.costCny === 'number'
          && Number.isFinite(rec.costCny)
          && rec.costCny > 0) {
          state.spentCny += rec.costCny;
        }
      } catch { /* skip malformed lines */ }
    }
  }
  return state;
}

function loadState(dir: string, larkAppId: string, month: string): BudgetState {
  const path = statePath(dir, larkAppId);
  let fileMtime: number | null = null;
  try {
    fileMtime = statSync(path).mtimeMs;
  } catch {
    fileMtime = null;
  }

  if (fileMtime !== null) {
    const cached = stateCache.get(path);
    if (cached && cached.mtimeMs === fileMtime) {
      // Cache hit — still apply lazy rollover on the way out.
      return cached.state.month === month ? cached.state : freshState(month);
    }
    try {
      const state = normalizeState(JSON.parse(readFileSync(path, 'utf8')), month);
      if (state) {
        stateCache.set(path, { mtimeMs: fileMtime, state });
        return state;
      }
      // Unparseable shape: fall through to fresh. Do NOT cache — the next
      // successful save overwrites the file.
    } catch {
      // Corrupt JSON: same, fall through.
    }
  } else {
    // State file missing (or externally deleted): rebuild once from the
    // current month's ledger so a lost state file doesn't lose the month's
    // accumulated spend.
    const rebuilt = rebuildBudgetStateFromLedger(dir, larkAppId, month);
    if (rebuilt.spentCny > 0) persistState(dir, larkAppId, rebuilt);
    return rebuilt;
  }
  return freshState(month);
}

function persistState(dir: string, larkAppId: string, state: BudgetState): void {
  mkdirSync(dir, { recursive: true });
  const target = statePath(dir, larkAppId);
  // temp+rename keeps a crash from truncating state; the pid suffix keeps
  // concurrent daemons from stomping each other's tmp file (same scheme as
  // the ledger's state-<appId>.json).
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
  try {
    stateCache.set(target, { mtimeMs: statSync(target).mtimeMs, state });
  } catch { /* mtime refresh is best-effort */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface BudgetTrackerOpts {
  now?: Date;
  ledgerDir?: string;
  budget?: BudgetConfig | null;
}

function resolveOpts(opts?: BudgetTrackerOpts): { now: Date; dir: string; month: string; budget: BudgetConfig | null } {
  const now = opts?.now ?? new Date();
  return {
    now,
    dir: opts?.ledgerDir ?? defaultLedgerDir(),
    month: monthOf(now),
    budget: opts?.budget ?? null,
  };
}

/**
 * Accumulate one positive-delta record's cost into the bot's monthly spend.
 * Returns an alert when this spend newly crosses one or more configured
 * thresholds (highest crossed threshold wins; all crossed thresholds are
 * marked alerted so they never re-fire this month). Returns null otherwise
 * and on ANY error — budget tracking must never break the ledger path.
 */
export function trackBudgetSpend(
  larkAppId: string,
  costCny: number,
  opts?: BudgetTrackerOpts,
): BudgetAlert | null {
  try {
    if (!larkAppId || typeof larkAppId !== 'string') return null;
    if (!Number.isFinite(costCny)) return null;
    const { dir, month, budget } = resolveOpts(opts);

    const state = loadState(dir, larkAppId, month);
    state.month = month;
    state.spentCny += costCny;

    let alert: BudgetAlert | null = null;
    if (budget && budget.monthlyCny > 0) {
      const percent = (state.spentCny / budget.monthlyCny) * 100;
      const effective = [...budget.alertThresholdPercent];
      // hardStop implies a 100% line even when not explicitly configured.
      if (budget.hardStop === true && !effective.includes(100)) effective.push(100);
      const newlyCrossed = effective.filter((t) => percent >= t && !state.alertedThresholds.includes(t));
      if (newlyCrossed.length > 0) {
        const threshold = Math.max(...newlyCrossed);
        for (const t of effective) {
          if (percent >= t && !state.alertedThresholds.includes(t)) state.alertedThresholds.push(t);
        }
        alert = {
          larkAppId,
          month,
          spentCny: state.spentCny,
          monthlyCny: budget.monthlyCny,
          percent,
          threshold,
          hardStop: budget.hardStop === true,
        };
      }
    }

    persistState(dir, larkAppId, state);
    return alert;
  } catch (err: any) {
    logger.warn(`budget-tracker: trackBudgetSpend failed for ${larkAppId}: ${err?.message ?? err}`);
    return null;
  }
}

/** Current month's status. Null only when there is neither a budget nor any
 *  recorded spend. With a budget but no spend → zero values (monthlyCny and
 *  percent present). With spend but no budget → monthlyCny/percent omitted. */
export function getBudgetStatus(larkAppId: string, opts?: BudgetTrackerOpts): BudgetStatus | null {
  try {
    if (!larkAppId || typeof larkAppId !== 'string') return null;
    const { dir, month, budget } = resolveOpts(opts);
    const state = loadState(dir, larkAppId, month);
    if (!budget && state.spentCny <= 0) return null;

    const status: BudgetStatus = {
      month: state.month,
      spentCny: state.spentCny,
      hardStop: budget?.hardStop === true,
    };
    if (budget && budget.monthlyCny > 0) {
      status.monthlyCny = budget.monthlyCny;
      status.percent = (state.spentCny / budget.monthlyCny) * 100;
    }
    return status;
  } catch (err: any) {
    logger.warn(`budget-tracker: getBudgetStatus failed for ${larkAppId}: ${err?.message ?? err}`);
    return null;
  }
}

/** Whether new turns should be refused for this bot this month. Fails OPEN:
 *  any error (unreadable state, bad config) returns false.
 *
 *  ⚠️ 判定原语已就绪但**尚未接入任何 turn 准入路径**——目前没有调用方，
 *  所以 `hardStop: true` 只影响告警口径（隐含 100% 阈值），不会真的拦下
 *  任务。要落地拦截需在 daemon 的入站入口（handleNewTopicAdmitted /
 *  handleThreadReplyAdmitted）调用本函数并回复用户；那是全 bot 共用的最热
 *  路径，属独立改动。改动时请同步 formatBudgetAlert 的文案口径。 */
export function isBudgetHardStopped(larkAppId: string, opts?: BudgetTrackerOpts): boolean {
  try {
    if (!larkAppId || typeof larkAppId !== 'string') return false;
    const budget = opts?.budget ?? null;
    if (!budget || budget.hardStop !== true || !(budget.monthlyCny > 0)) return false;
    const { dir, month } = resolveOpts(opts);
    const state = loadState(dir, larkAppId, month);
    if (state.month !== month) return false; // rolled over before we persisted
    return state.spentCny >= budget.monthlyCny;
  } catch {
    return false;
  }
}

function formatMoney(v: number): string {
  return v.toFixed(2);
}

function formatThreshold(v: number): string {
  // Thresholds are config numbers (e.g. 80, 80.5); trim float noise.
  return String(Math.round(v * 100) / 100);
}

/** Plain-text alert body for the owner DM.
 *
 *  ⚠️ 文案不得承诺「拒绝新任务」：hardStop 目前只有判定原语
 *  （isBudgetHardStopped），没有任何 turn 准入路径调用它，所以配了
 *  hardStop 也不会真的拦下任何任务。承诺拦截会让 owner 以为已被保护
 *  而不再人工关注（比不告警更糟）。真接入准入路径后再改回强口径。 */
export function formatBudgetAlert(alert: BudgetAlert): string {
  const spent = formatMoney(alert.spentCny);
  const budget = formatMoney(alert.monthlyCny);
  const percent = Math.round(alert.percent);
  if (alert.hardStop && alert.threshold >= 100) {
    return `🚫 月度预算已用尽：本月已用 ¥${spent} / ¥${budget}（${percent}%）。请人工关注并按需暂停会话——当前版本不会自动拒绝新任务。下月 1 日预算重置。`;
  }
  return `⚠️ 月度预算告警：本月已用 ¥${spent} / ¥${budget}（${percent}%），越过 ${formatThreshold(alert.threshold)}% 告警线。`;
}
