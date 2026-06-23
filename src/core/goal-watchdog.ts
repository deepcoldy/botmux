import { buildFollowUpContent, rememberLastCliInput } from './session-manager.js';
import { markSessionActivity } from './session-activity.js';
import { forkWorker } from './worker-pool.js';
import { sessionKey, type DaemonSession } from './types.js';
import { localeForBot } from '../i18n/index.js';
import { openLedger, type LedgerHandle } from '../verified-delivery/ledger.js';
import { summarizeAcceptanceCriteria } from '../verified-delivery/acceptance.js';
import type { TaskView } from '../verified-delivery/types.js';
import { reconcileTaskByCriteria, type ReconcileResult } from '../verified-delivery/reconcile.js';
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { emitGoalNarration } from '../verified-delivery/narration.js';

export const GOAL_WATCHDOG_PROMPT_PREFIX = '[goal-watchdog]';
export const DEFAULT_GOAL_WATCHDOG_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS = 30_000;

type GoalWatchdogStatus =
  | 'injected'
  | 'reconciled'
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
  notify?: (event: GoalWatchdogNotifyEvent) => Promise<void> | void;
  checkedBy?: string;
  defaultCwd?: string;
  defaultTimeoutMs?: number;
}

export type GoalWatchdogNotifyKind = 'accepted' | 'rejected';

export interface GoalWatchdogNotifyEvent {
  kind: GoalWatchdogNotifyKind;
  larkAppId: string;
  goalChatId: string;
  task: TaskView;
  result: ReconcileResult;
}

function isPendingForWatchdog(task: TaskView): boolean {
  return task.status === 'dispatched' || task.status === 'reported' || task.status === 'rejected' || task.status === 'blocked';
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

export function buildGoalWatchdogPrompt(goalChatId: string, tasks: TaskView[], inspectionFacts: Map<string, string> = new Map()): string {
  const rows = tasks.map((task) => {
    const hint = task.acceptanceHint?.trim() && !task.acceptanceCriteria
      ? ` acceptanceHint=${task.acceptanceHint.trim()}`
      : '';
    const checks = task.acceptanceCriteria
      ? summarizeAcceptanceCriteria(task.acceptanceCriteria).map((line) => `\n    - ${line}`).join('')
      : '';
    const help = task.help
      ? ` helpKind=${task.help.kind ?? 'other'} blocker=${task.help.blocker}`
      : '';
    const fact = inspectionFacts.get(task.taskId);
    const factLine = fact ? `\n    inspectionFact: ${fact}` : '';
    return `- ${task.taskId} status=${task.status}${hint}${help}${checks}${factLine}`;
  }).join('\n');
  return [
    `${GOAL_WATCHDOG_PROMPT_PREFIX} 你是本 goal 的统揽监管者。请先查 charter、账本和最近群消息，再为每个非终态任务给出并执行下一步：验收/accept/reject/催/重派/升级。聊天只是触发器，证据和账本才是真相；blocked 任务先处理 worker 求助，定不了再升级给人。`,
    '注意：机械对账只提供线索和零歧义核验；worker 未 report 但产物看似达标时，不要把它当作已完成事实，必须由你判断是代办、催交还是重派，并诚实留痕。',
    `goalChatId: ${goalChatId}`,
    '',
    'pending tasks:',
    rows || '- (none)',
  ].join('\n');
}

function formatFailedChecks(result: ReconcileResult): string[] {
  return (result.verify?.checks ?? [])
    .filter((check) => !check.ok)
    .map((check) => `- ${check.kind} ${check.target}${check.detail ? `: ${check.detail}` : ''}`);
}

function formatPassedChecks(result: ReconcileResult): string[] {
  return (result.verify?.checks ?? [])
    .filter((check) => check.ok)
    .map((check) => `- ${check.kind} ${check.target}`);
}

function buildGoalWatchdogNotification(event: GoalWatchdogNotifyEvent): string {
  const { kind, task, result } = event;
  if (kind === 'accepted') {
    const checks = formatPassedChecks(result).slice(0, 8).join('\n');
    return [
      `[goal-watchdog] 已自动验收任务 ${task.taskId}`,
      `reportId: ${result.reportId ?? task.latestReportId ?? '(unknown)'}`,
      checks ? `通过检查:\n${checks}` : undefined,
    ].filter(Boolean).join('\n');
  }
  if (kind === 'rejected') {
    const failed = formatFailedChecks(result).slice(0, 8).join('\n');
    return [
      `[goal-watchdog] 已自动打回任务 ${task.taskId}`,
      `reportId: ${result.reportId ?? task.latestReportId ?? '(unknown)'}`,
      failed ? `未通过检查:\n${failed}` : undefined,
    ].filter(Boolean).join('\n');
  }
  return '';
}

async function sendGoalWatchdogNotification(event: GoalWatchdogNotifyEvent): Promise<void> {
  const eventId = event.result.eventId ?? event.result.reportId ?? event.task.latestReportId ?? 'unknown';
  if (event.kind === 'accepted') {
    await emitGoalNarration({
      larkAppId: event.larkAppId,
      goalChatId: event.goalChatId,
      event: {
        type: 'accepted',
        key: `narr:accepted:${event.task.taskId}:${eventId}`,
        taskId: event.task.taskId,
        title: event.task.title,
        mode: '自动对账',
      },
    }, { sendMessage });
    return;
  }
  if (event.kind === 'rejected') {
    await emitGoalNarration({
      larkAppId: event.larkAppId,
      goalChatId: event.goalChatId,
      event: {
        type: 'rejected',
        key: `narr:rejected:${event.task.taskId}:${eventId}`,
        taskId: event.task.taskId,
        reason: event.result.verify ? `对账核验未通过：${formatFailedChecks(event.result).join('；') || '检查未通过'}` : 'check_failed',
      },
    }, { sendMessage });
  }
}

export function isGoalSupervisorTitle(title: string | undefined): boolean {
  return title?.startsWith('[Goal]') === true;
}

export function shouldTriggerGoalWatchdogOnSessionBoundary(ds: DaemonSession): boolean {
  return ds.scope === 'chat'
    && Boolean(ds.chatId)
    && !isGoalSupervisorTitle(ds.session.title);
}

function isGoalSupervisorSession(ds: DaemonSession, larkAppId: string, goalChatId: string): boolean {
  return ds.larkAppId === larkAppId
    && ds.chatId === goalChatId
    && ds.scope === 'chat'
    && ds.session.status === 'active'
    && isGoalSupervisorTitle(ds.session.title);
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
  const notify = deps.notify ?? sendGoalWatchdogNotification;
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
    if (!ds) {
      results.push({
        goalChatId,
        status: 'no-l2',
        pendingTaskIds: tasks.map((task) => task.taskId),
        reason: 'no active chat-scope goal supervisor session',
      });
      continue;
    }
    const legacyTasks: TaskView[] = [];
    const inspectionFacts = new Map<string, string>();
    let reconciled = false;
    const last = lastInjectedAt.get(goalChatId) ?? 0;
    for (const task of tasks) {
      const reconcile = reconcileTaskByCriteria(ledger, task.taskId, {
        checkedBy: deps.checkedBy ?? 'goal-watchdog',
        now,
        defaultCwd: deps.defaultCwd,
        defaultTimeoutMs: deps.defaultTimeoutMs,
      });
      if (reconcile.action === 'no-criteria') {
        if (task.status === 'reported') continue;
        legacyTasks.push(task);
      } else if (reconcile.action === 'unreported-pass') {
        inspectionFacts.set(
          task.taskId,
          reconcile.inspectionFact ?? '产物已满足结构化验收标准，但 worker 未交付 report；请监管者判断是否代办、催交或重派。',
        );
        legacyTasks.push(task);
      } else if (reconcile.action === 'blocked') {
        legacyTasks.push(task);
      } else if (reconcile.action === 'escalated') {
        continue;
      } else if ((reconcile.action === 'accepted' || reconcile.action === 'rejected') && !reconcile.deduped) {
        reconciled = true;
        try {
          await notify({ kind: reconcile.action, larkAppId: deps.larkAppId, goalChatId, task, result: reconcile });
        } catch (err) {
          logger.warn(`[goal-watchdog] notify ${reconcile.action} failed goal=${goalChatId} task=${task.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (reconcile.action === 'nudge') {
        inspectionFacts.set(
          task.taskId,
          reconcile.inspectionFact ?? '结构化验收未通过；请监管者统揽判断：引导 worker、重派、要求重新 report，或升级给人。',
        );
        legacyTasks.push(task);
      }
    }
    if (legacyTasks.length === 0) {
      if (reconciled) {
        lastInjectedAt.set(goalChatId, now);
        results.push({ goalChatId, status: 'reconciled', pendingTaskIds: tasks.map((task) => task.taskId) });
      } else {
        results.push({ goalChatId, status: 'empty', pendingTaskIds: [] });
      }
      continue;
    }
    const pendingTaskIds = legacyTasks.map((task) => task.taskId);
    if (isBusy(ds)) {
      results.push({ goalChatId, status: 'busy', pendingTaskIds, sessionId: ds.session.sessionId });
      continue;
    }
    if (last > 0 && now - last < intervalMs) {
      results.push({ goalChatId, status: 'rate-limited', pendingTaskIds, sessionId: ds.session.sessionId });
      continue;
    }
    const prompt = buildGoalWatchdogPrompt(goalChatId, legacyTasks, inspectionFacts);
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
    intervalMs: input.cooldownMs ?? DEFAULT_GOAL_WATCHDOG_INTERVAL_MS,
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
      const reconciled = results.filter((r) => r.status === 'reconciled');
      if (injected.length > 0 || reconciled.length > 0) {
        const parts = [];
        if (injected.length > 0) parts.push(`injected ${injected.length}: ${injected.map((r) => `${r.goalChatId}:${r.pendingTaskIds.length}`).join(', ')}`);
        if (reconciled.length > 0) parts.push(`reconciled ${reconciled.length}: ${reconciled.map((r) => `${r.goalChatId}:${r.pendingTaskIds.length}`).join(', ')}`);
        logger.info(`[goal-watchdog] ${parts.join('; ')}`);
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
