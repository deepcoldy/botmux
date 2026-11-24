/**
 * 实时 Bot 运行态采集与引用解析。
 *
 * 全部复用现有机制，不新造平行数据源：
 * - 离线/在线与飞书连接态：`listOnlineDaemons`（`dashboard-daemons/` 心跳）
 * - 忙闲/排队/受限会话：`fetchObserveSnapshot`（daemon `GET /api/sessions`）
 *   + daemon `GET /api/bot-default-oncall`（`maxLiveWorkers`, `pendingTurnCount`, `activeUsageLimit`）
 * - Antigravity 多账号轮换与冷却：`inspectAntigravityAccounts`
 * - 月度预算硬上限：`getBudgetStatus`
 * - 已有能力标签：`bot-profile-store`（`capability` / `specialties`）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../daemon-ipc-auth.js';
import { isStewardBot } from '../decision-board/model.js';
import { resolveBotmuxConfigDir } from '../config-dir.js';
import { resolveBotmuxDataDir } from '../data-dir.js';
import {
  inspectAntigravityAccounts,
  type AntigravityAccountsInspection,
} from '../../services/antigravity-accounts.js';
import { getBotProfile, type BotProfile } from '../../services/bot-profile-store.js';
import { normalizeBotsInfoRouteEntries, type NormalizedBotsInfoRouteEntry } from '../../services/bots-info-shape.js';
import { getBudgetStatus, type BudgetStatus } from '../../services/budget-tracker.js';
import {
  fetchObserveSnapshot,
  type DaemonIpcFetch,
} from '../../services/session-observe-command-fetch.js';
import type { ObserveDaemonEnvelope, ObserveSnapshot } from '../../services/session-observe.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../../utils/daemon-discovery.js';
import type {
  BotLiveRuntime,
  BotRuntimeSnapshot,
  TaskRoutingCostTier,
} from './model.js';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const PROBE_CONCURRENCY = 6;

export interface DaemonRuntimeExtra {
  maxLiveWorkers: number | null;
  residentSessionCount?: number;
  pendingTurnCount?: number;
  botName?: string | null;
  defaultWorkingDir?: string | null;
  defaultWorkingDirAutoWorktree?: boolean;
  activeUsageLimit?: {
    kind: 'usage' | 'rate';
    retryAtMs: number;
    retryLabel?: string;
  } | null;
  resolvedAllowedUsers?: string[];
}

export interface TaskRoutingProbeDeps {
  dataDir?: string;
  botmuxConfigDir?: string;
  now?: () => number;
  timeoutMs?: number;
  secret?: string;
  loadConfigs?: () => BotConfig[];
  readBotsInfo?: (dataDir: string) => NormalizedBotsInfoRouteEntry[];
  readBotProfile?: (dataDir: string, larkAppId: string) => BotProfile | null;
  discoverDaemons?: (dataDir?: string) => OnlineDaemonInfo[];
  fetchObserve?: (opts: { larkAppId?: string; dataDir?: string; timeoutMs?: number }) => Promise<ObserveSnapshot>;
  fetchDaemonExtra?: (daemon: OnlineDaemonInfo, timeoutMs: number) => Promise<DaemonRuntimeExtra | null>;
  inspectAgyAccounts?: () => AntigravityAccountsInspection;
  readBudgetStatus?: (bot: BotConfig, now: Date) => BudgetStatus | null;
}

function defaultReadBotsInfo(dataDir: string): NormalizedBotsInfoRouteEntry[] {
  const path = join(dataDir, 'bots-info.json');
  if (!existsSync(path)) return [];
  try {
    return normalizeBotsInfoRouteEntries(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function loadSecretSoft(override?: string): string | undefined {
  if (typeof override === 'string') return override;
  try { return loadDaemonIpcSecret(); } catch { return undefined; }
}

async function defaultFetchDaemonExtra(
  daemon: OnlineDaemonInfo,
  timeoutMs: number,
  secret: string | undefined,
  ipcFetch: DaemonIpcFetch = fetchDaemonIpc,
): Promise<DaemonRuntimeExtra | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await ipcFetch(daemon.ipcPort, '/api/bot-default-oncall', { method: 'GET', signal: controller.signal }, secret);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object') return null;
    const maxLiveWorkers = typeof j.maxLiveWorkers === 'number' && Number.isInteger(j.maxLiveWorkers) && j.maxLiveWorkers > 0
      ? j.maxLiveWorkers
      : null;
    const residentSessionCount = typeof j.residentSessionCount === 'number' && Number.isInteger(j.residentSessionCount) && j.residentSessionCount >= 0
      ? j.residentSessionCount
      : undefined;
    const pendingTurnCount = typeof j.pendingTurnCount === 'number' && Number.isInteger(j.pendingTurnCount) && j.pendingTurnCount >= 0
      ? j.pendingTurnCount
      : undefined;
    let activeUsageLimit: DaemonRuntimeExtra['activeUsageLimit'] = null;
    if (j.activeUsageLimit && typeof j.activeUsageLimit === 'object' && !Array.isArray(j.activeUsageLimit)) {
      const lim = j.activeUsageLimit as Record<string, unknown>;
      if ((lim.kind === 'usage' || lim.kind === 'rate')
        && typeof lim.retryAtMs === 'number' && Number.isFinite(lim.retryAtMs)) {
        activeUsageLimit = {
          kind: lim.kind,
          retryAtMs: lim.retryAtMs,
          ...(typeof lim.retryLabel === 'string' && lim.retryLabel ? { retryLabel: lim.retryLabel } : {}),
        };
      }
    }
    const resolvedAllowedUsers = Array.isArray(j.resolvedAllowedUsers)
      ? j.resolvedAllowedUsers.filter((x): x is string => typeof x === 'string')
      : undefined;
    return {
      maxLiveWorkers,
      ...(residentSessionCount !== undefined ? { residentSessionCount } : {}),
      ...(pendingTurnCount !== undefined ? { pendingTurnCount } : {}),
      botName: typeof j.botName === 'string' ? j.botName : null,
      defaultWorkingDir: typeof j.defaultWorkingDir === 'string' ? j.defaultWorkingDir : null,
      defaultWorkingDirAutoWorktree: j.defaultWorkingDirAutoWorktree === true,
      activeUsageLimit,
      ...(resolvedAllowedUsers ? { resolvedAllowedUsers } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function summarizeObserveEnvelope(
  envelope: ObserveDaemonEnvelope | undefined,
  extra: DaemonRuntimeExtra | null,
  daemon: OnlineDaemonInfo | undefined,
  bot: BotConfig,
  agyInspection: AntigravityAccountsInspection | undefined,
  budgetStatus: BudgetStatus | null,
): BotLiveRuntime {
  const maxLiveWorkers = extra?.maxLiveWorkers
    ?? (typeof bot.maxLiveWorkers === 'number' && Number.isInteger(bot.maxLiveWorkers) && bot.maxLiveWorkers > 0
      ? bot.maxLiveWorkers
      : null);

  const agyAccounts = bot.cliId === 'antigravity' && agyInspection?.managed
    ? {
        managed: true,
        availableCount: agyInspection.availableCount,
        enabledCount: agyInspection.enabledCount,
        ...(agyInspection.earliestRecoveryMs !== undefined
          ? { earliestRecoveryMs: agyInspection.earliestRecoveryMs }
          : {}),
      }
    : undefined;

  const budget = bot.budget && budgetStatus && typeof budgetStatus.monthlyCny === 'number'
    ? {
        monthlyCny: budgetStatus.monthlyCny,
        spentCny: budgetStatus.spentCny,
        percent: budgetStatus.percent ?? (budgetStatus.spentCny / budgetStatus.monthlyCny) * 100,
        hardStop: budgetStatus.hardStop,
        exceeded: budgetStatus.spentCny >= budgetStatus.monthlyCny,
      }
    : undefined;

  if (!daemon) {
    return {
      online: false,
      probeStatus: 'offline',
      larkConnected: 'unknown',
      workingCount: 'unknown',
      queuedCount: 'unknown',
      residentCount: 'unknown',
      maxLiveWorkers,
      limitedCount: 'unknown',
      ...(agyAccounts ? { agyAccounts } : {}),
      ...(budget ? { budget } : {}),
    };
  }

  const larkConnected: boolean | 'unknown' = daemon.larkConnection?.state === 'connected'
    ? true
    : daemon.larkConnection?.state === 'disconnected' || daemon.larkConnection?.state === 'failed'
      ? false
      : 'unknown';

  const probeStatus = !envelope
    ? 'unreachable'
    : envelope.probe.status === 'ok'
      ? 'ok'
      : envelope.probe.status === 'unauthorized'
        ? 'unauthorized'
        : envelope.probe.status === 'daemon_offline'
          ? 'offline'
          : 'unreachable';

  if (probeStatus !== 'ok' || !envelope) {
    return {
      online: false,
      probeStatus,
      larkConnected,
      workingCount: 'unknown',
      queuedCount: 'unknown',
      residentCount: extra?.residentSessionCount ?? 'unknown',
      maxLiveWorkers,
      limitedCount: 'unknown',
      ...(agyAccounts ? { agyAccounts } : {}),
      ...(budget ? { budget } : {}),
    };
  }

  let workingCount = 0;
  let parkedCount = 0;
  let residentCount = 0;
  let limitedCount = 0;

  for (const s of envelope.sessions) {
    if (s.closed === true) continue;
    if (s.queued === true) {
      parkedCount++;
      continue;
    }
    if (s.liveness === 'alive') {
      residentCount++;
      if (s.turn === 'working' || s.turn === 'starting' || s.turn === 'analyzing') {
        workingCount++;
      } else if (s.turn === 'limited') {
        limitedCount++;
      }
    }
  }

  const queuedCount = parkedCount + (extra?.pendingTurnCount ?? 0);
  const effectiveResident = extra?.residentSessionCount ?? residentCount;

  return {
    online: true,
    probeStatus: 'ok',
    larkConnected,
    workingCount,
    queuedCount,
    residentCount: effectiveResident,
    maxLiveWorkers,
    limitedCount,
    ...(extra?.activeUsageLimit ? {
      limitedUntilMs: extra.activeUsageLimit.retryAtMs,
      limitedKind: extra.activeUsageLimit.kind,
      ...(extra.activeUsageLimit.retryLabel ? { limitedLabel: extra.activeUsageLimit.retryLabel } : {}),
    } : {}),
    ...(agyAccounts ? { agyAccounts } : {}),
    ...(budget ? { budget } : {}),
  };
}

function resolveDisplayName(
  bot: BotConfig,
  daemon: OnlineDaemonInfo | undefined,
  extra: DaemonRuntimeExtra | null,
  info: NormalizedBotsInfoRouteEntry | undefined,
): string {
  return bot.displayName?.trim()
    || extra?.botName?.trim()
    || daemon?.botName?.trim()
    || info?.botName?.trim()
    || bot.name?.trim()
    || bot.larkAppId;
}

/**
 * Collect real-time runtime snapshots for all locally configured bots (or a single bot).
 */
export async function collectBotRuntimeSnapshots(
  deps: TaskRoutingProbeDeps = {},
  options: { onlyAppIds?: readonly string[] } = {},
): Promise<BotRuntimeSnapshot[]> {
  const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
  const botmuxConfigDir = deps.botmuxConfigDir ?? resolveBotmuxConfigDir();
  const nowFn = deps.now ?? Date.now;
  const nowMs = nowFn();
  const nowDate = new Date(nowMs);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const allConfigs = (deps.loadConfigs ?? loadBotConfigs)();
  const filterSet = options.onlyAppIds?.length ? new Set(options.onlyAppIds) : null;
  const targetEntries = allConfigs
    .map((cfg, configOrder) => ({ cfg, configOrder }))
    .filter(({ cfg }) => !filterSet || filterSet.has(cfg.larkAppId));

  if (targetEntries.length === 0) return [];

  const botsInfo = (deps.readBotsInfo ?? defaultReadBotsInfo)(dataDir);
  const infoByApp = new Map(botsInfo.map(entry => [entry.larkAppId, entry]));
  const onlineDaemons = (deps.discoverDaemons ?? listOnlineDaemons)(dataDir);
  const daemonByApp = new Map(onlineDaemons.map(d => [d.larkAppId, d]));

  // Observe snapshot across target online daemons.
  const secret = loadSecretSoft(deps.secret);
  const observeByApp = new Map<string, ObserveDaemonEnvelope>();
  const targetOnlineDaemons = targetEntries
    .map(({ cfg }) => daemonByApp.get(cfg.larkAppId))
    .filter((d): d is OnlineDaemonInfo => Boolean(d));

  if (targetOnlineDaemons.length > 0) {
    if (deps.fetchObserve) {
      if (filterSet && filterSet.size === 1) {
        const appId = [...filterSet][0]!;
        const snap = await deps.fetchObserve({ larkAppId: appId, dataDir, timeoutMs });
        for (const env of snap.daemons) {
          if (env.larkAppId) observeByApp.set(env.larkAppId, env);
        }
      } else {
        const snap = await deps.fetchObserve({ dataDir, timeoutMs });
        for (const env of snap.daemons) {
          if (env.larkAppId) observeByApp.set(env.larkAppId, env);
        }
      }
    } else {
      const snaps = await mapLimited(targetOnlineDaemons, PROBE_CONCURRENCY, async d => {
        const snap = await fetchObserveSnapshot({
          larkAppId: d.larkAppId,
          dataDir,
          timeoutMs,
          ...(secret !== undefined ? { secret } : {}),
        });
        return snap.daemons[0];
      });
      for (const env of snaps) {
        if (env?.larkAppId) observeByApp.set(env.larkAppId, env);
      }
    }
  }

  // Fetch per-daemon runtime extras (maxLiveWorkers, pendingTurnCount, activeUsageLimit).
  const fetchExtra = deps.fetchDaemonExtra
    ?? ((daemon: OnlineDaemonInfo, ms: number) => defaultFetchDaemonExtra(daemon, ms, secret));
  const extraPairs = await mapLimited(targetOnlineDaemons, PROBE_CONCURRENCY, async d => {
    const extra = await fetchExtra(d, timeoutMs);
    return [d.larkAppId, extra] as const;
  });
  const extraByApp = new Map(extraPairs);

  // Inspect shared Antigravity account pool once if any candidate runs antigravity.
  let agyInspection: AntigravityAccountsInspection | undefined;
  if (targetEntries.some(({ cfg }) => cfg.cliId === 'antigravity')) {
    try {
      agyInspection = deps.inspectAgyAccounts
        ? deps.inspectAgyAccounts()
        : inspectAntigravityAccounts({ botmuxConfigDir, now: nowFn });
    } catch {
      agyInspection = undefined;
    }
  }

  const readProfile = deps.readBotProfile ?? getBotProfile;
  const readBudget = deps.readBudgetStatus
    ?? ((bot: BotConfig, d: Date) => (bot.budget ? getBudgetStatus(bot.larkAppId, { budget: bot.budget, now: d }) : null));

  return targetEntries.map(({ cfg, configOrder }): BotRuntimeSnapshot => {
    const daemon = daemonByApp.get(cfg.larkAppId);
    const extra = extraByApp.get(cfg.larkAppId) ?? null;
    const info = infoByApp.get(cfg.larkAppId);
    const envelope = observeByApp.get(cfg.larkAppId);
    const profile = readProfile(dataDir, cfg.larkAppId);
    const budgetStatus = cfg.budget ? readBudget(cfg, nowDate) : null;
    const costTier: TaskRoutingCostTier = cfg.taskRouting?.costTier ?? 'medium';

    return {
      larkAppId: cfg.larkAppId,
      name: resolveDisplayName(cfg, daemon, extra, info),
      cliId: cfg.cliId,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.defaultWorkingDir || extra?.defaultWorkingDir
        ? { defaultWorkingDir: extra?.defaultWorkingDir ?? cfg.defaultWorkingDir }
        : {}),
      ...(cfg.defaultWorkingDirAutoWorktree || extra?.defaultWorkingDirAutoWorktree
        ? { autoWorktree: true }
        : {}),
      isSteward: isStewardBot(cfg.steward),
      apiOnly: cfg.apiOnly === true,
      configOrder,
      profile: {
        enabled: cfg.taskRouting?.enabled === true,
        costTier,
        ...(cfg.taskRouting?.strengths ? { strengths: cfg.taskRouting.strengths } : {}),
        ...(cfg.taskRouting?.limitations ? { limitations: cfg.taskRouting.limitations } : {}),
        ...(profile?.capability ? { legacyCapability: profile.capability } : {}),
        ...(profile?.specialties?.length ? { legacySpecialties: profile.specialties } : {}),
      },
      runtime: summarizeObserveEnvelope(envelope, extra, daemon, cfg, agyInspection, budgetStatus),
    };
  });
}

export type BotRefResolution =
  | { ok: true; larkAppId: string }
  | { ok: false; error: string };

/**
 * Resolve a user-supplied bot ref (exact larkAppId, or unique case-insensitive
 * match on display name / botName / process name). Ambiguous names fail closed
 * rather than silently targeting the wrong bot.
 */
export function resolveTaskRoutingBotRef(
  ref: string,
  snapshots: readonly Pick<BotRuntimeSnapshot, 'larkAppId' | 'name' | 'cliId'>[],
): BotRefResolution {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, error: 'Bot 引用不能为空' };

  const exact = snapshots.find(s => s.larkAppId === trimmed);
  if (exact) return { ok: true, larkAppId: exact.larkAppId };

  const lower = trimmed.replace(/^@+/, '').trim().toLowerCase();
  const byName = snapshots.filter(s => s.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, larkAppId: byName[0]!.larkAppId };
  if (byName.length > 1) {
    return {
      ok: false,
      error: `Bot 名称「${trimmed}」匹配到多个 Bot（${byName.map(b => b.larkAppId).join(', ')}），请改用完整 larkAppId`,
    };
  }

  const byCli = snapshots.filter(s => s.cliId.toLowerCase() === lower);
  if (byCli.length === 1) return { ok: true, larkAppId: byCli[0]!.larkAppId };
  if (byCli.length > 1) {
    return {
      ok: false,
      error: `CLI「${trimmed}」匹配到多个 Bot（${byCli.map(b => `${b.name}(${b.larkAppId})`).join(', ')}），请用显示名或 larkAppId`,
    };
  }

  return { ok: false, error: `未找到本机配置的 Bot：${trimmed}` };
}
