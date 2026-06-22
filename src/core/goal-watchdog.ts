import { buildFollowUpContent, rememberLastCliInput } from './session-manager.js';
import { markSessionActivity } from './session-activity.js';
import { forkWorker } from './worker-pool.js';
import { sessionKey, type DaemonSession } from './types.js';
import { localeForBot } from '../i18n/index.js';
import { openLedger, type LedgerHandle } from '../verified-delivery/ledger.js';
import type { TaskView } from '../verified-delivery/types.js';
import { logger } from '../utils/logger.js';

export const GOAL_WATCHDOG_PROMPT_PREFIX = '[goal-watchdog]';
export const DEFAULT_GOAL_WATCHDOG_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS = 30_000;

type GoalWatchdogStatus =
  | 'injected'
  | 'no-l2'
  | 'busy'
  | 'rate-limited'
  | 'empty';

export interface GoalWatchdogResult {
  goalChatId: string;
  status: GoalWatchdogStatus;
  pendingTaskIds: string[];
  sessionId?: string;
  reason?: string;
}

export interface GoalWatchdogDeps {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  ledger?: LedgerHandle;
  now?: number;
  intervalMs?: number;
  goalChatIds?: Iterable<string>;
  lastInjectedAt?: Map<string, number>;
  inject?: (ds: DaemonSession, prompt: string) => Promise<void> | void;
}

function isPendingForWatchdog(task: TaskView): boolean {
  return task.status === 'dispatched' || task.status === 'rejected';
}

export function pendingGoalTasks(tasks: TaskView[]): Map<string, TaskView[]> {
  const byGoal = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (!task.chatId || !isPendingForWatchdog(task)) continue;
    const arr = byGoal.get(task.chatId) ?? [];
    arr.push(task);
    byGoal.set(task.chatId, arr);
  }
  return byGoal;
}

export function buildGoalWatchdogPrompt(goalChatId: string, tasks: TaskView[]): string {
  const rows = tasks.map((task) => {
    const hint = task.acceptanceHint?.trim()
      ? ` acceptanceHint=${task.acceptanceHint.trim()}`
      : '';
    return `- ${task.taskId} status=${task.status}${hint}`;
  }).join('\n');
  return [
    `${GOAL_WATCHDOG_PROMPT_PREFIX} 本 goal 有未完成任务（dispatched/rejected 未 accepted），请按 orchestrate 巡检协议扫账本、主动核验产物、accept/reject/催。`,
    `goalChatId: ${goalChatId}`,
    '',
    'pending tasks:',
    rows || '- (none)',
  ].join('\n');
}

function isGoalSupervisorSession(ds: DaemonSession, larkAppId: string, goalChatId: string): boolean {
  return ds.larkAppId === larkAppId
    && ds.chatId === goalChatId
    && ds.scope === 'chat'
    && ds.session.status === 'active'
    && ds.session.title.startsWith('[Goal]');
}

function isBusy(ds: DaemonSession): boolean {
  if (!ds.worker || ds.worker.killed) return false;
  return ds.lastScreenStatus !== 'idle' && ds.lastScreenStatus !== 'limited';
}

export function findGoalSupervisorSession(
  activeSessions: Map<string, DaemonSession>,
  larkAppId: string,
  goalChatId: string,
): DaemonSession | undefined {
  const direct = activeSessions.get(sessionKey(goalChatId, larkAppId));
  if (direct && isGoalSupervisorSession(direct, larkAppId, goalChatId)) return direct;
  for (const ds of activeSessions.values()) {
    if (isGoalSupervisorSession(ds, larkAppId, goalChatId)) return ds;
  }
  return undefined;
}

export async function injectGoalSupervisorTurn(ds: DaemonSession, prompt: string): Promise<void> {
  const content = buildFollowUpContent(prompt, ds.session.sessionId, {
    isAdoptMode: false,
    cliId: ds.session.cliId,
    locale: localeForBot(ds.larkAppId),
    larkAppId: ds.larkAppId,
    chatId: ds.chatId,
  });
  markSessionActivity(ds);
  rememberLastCliInput(ds, prompt, content);
  if (ds.worker && !ds.worker.killed) {
    ds.worker.send({ type: 'message', content });
  } else {
    forkWorker(ds, content);
  }
}

export async function runGoalWatchdogOnce(deps: GoalWatchdogDeps): Promise<GoalWatchdogResult[]> {
  const ledger = deps.ledger ?? openLedger();
  const now = deps.now ?? Date.now();
  const intervalMs = deps.intervalMs ?? DEFAULT_GOAL_WATCHDOG_INTERVAL_MS;
  const lastInjectedAt = deps.lastInjectedAt ?? defaultLastInjectedAt;
  const inject = deps.inject ?? injectGoalSupervisorTurn;
  const byGoal = pendingGoalTasks(ledger.tasks());
  const goalFilter = deps.goalChatIds ? new Set(deps.goalChatIds) : undefined;
  const results: GoalWatchdogResult[] = [];

  for (const [goalChatId, tasks] of byGoal) {
    if (goalFilter && !goalFilter.has(goalChatId)) continue;
    if (tasks.length === 0) {
      results.push({ goalChatId, status: 'empty', pendingTaskIds: [] });
      continue;
    }
    const ds = findGoalSupervisorSession(deps.activeSessions, deps.larkAppId, goalChatId);
    const pendingTaskIds = tasks.map((task) => task.taskId);
    if (!ds) {
      results.push({ goalChatId, status: 'no-l2', pendingTaskIds, reason: 'no active chat-scope goal supervisor session' });
      continue;
    }
    if (isBusy(ds)) {
      results.push({ goalChatId, status: 'busy', pendingTaskIds, sessionId: ds.session.sessionId });
      continue;
    }
    const last = lastInjectedAt.get(goalChatId) ?? 0;
    if (last > 0 && now - last < intervalMs) {
      results.push({ goalChatId, status: 'rate-limited', pendingTaskIds, sessionId: ds.session.sessionId });
      continue;
    }
    const prompt = buildGoalWatchdogPrompt(goalChatId, tasks);
    await inject(ds, prompt);
    lastInjectedAt.set(goalChatId, now);
    results.push({ goalChatId, status: 'injected', pendingTaskIds, sessionId: ds.session.sessionId });
  }

  return results;
}

const defaultLastInjectedAt = new Map<string, number>();

export async function runGoalWatchdogForGoal(input: {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  goalChatId: string;
  now?: number;
  cooldownMs?: number;
}): Promise<GoalWatchdogResult[]> {
  return runGoalWatchdogOnce({
    larkAppId: input.larkAppId,
    activeSessions: input.activeSessions,
    now: input.now,
    intervalMs: input.cooldownMs ?? DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS,
    goalChatIds: [input.goalChatId],
    lastInjectedAt: defaultLastInjectedAt,
  });
}

export function startGoalWatchdog(input: {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  intervalMs?: number;
}): NodeJS.Timeout | null {
  const disabled = process.env.BOTMUX_GOAL_WATCHDOG === '0' || process.env.BOTMUX_GOAL_WATCHDOG === 'false';
  if (disabled) {
    logger.info('[goal-watchdog] disabled by BOTMUX_GOAL_WATCHDOG');
    return null;
  }
  const envIntervalMs = Number(process.env.BOTMUX_GOAL_WATCHDOG_INTERVAL_MS || '');
  const intervalMs = input.intervalMs ?? (envIntervalMs || DEFAULT_GOAL_WATCHDOG_INTERVAL_MS);
  const tick = async () => {
    try {
      const results = await runGoalWatchdogOnce({
        larkAppId: input.larkAppId,
        activeSessions: input.activeSessions,
        intervalMs,
      });
      const injected = results.filter((r) => r.status === 'injected');
      if (injected.length > 0) {
        logger.info(`[goal-watchdog] injected ${injected.length} goal supervisor turn(s): ${injected.map((r) => `${r.goalChatId}:${r.pendingTaskIds.length}`).join(', ')}`);
      }
    } catch (err) {
      logger.warn(`[goal-watchdog] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 10_000).unref?.();
  logger.info(`[goal-watchdog] started interval=${intervalMs}ms`);
  return timer;
}
