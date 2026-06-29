import { openLedger, type LedgerHandle } from '../verified-delivery/ledger.js';
import {
  buildGoalAttentionBoard,
  type AttentionTask,
  type DispositionContext,
  type GoalAttentionBoard,
} from '../verified-delivery/attention.js';
import type { GoalBoardTask } from '../verified-delivery/goal-board.js';
import type { TaskView } from '../verified-delivery/types.js';
import { listGoalNotificationRetries } from '../services/goal-notification-retry-store.js';
import {
  countGoalWorkerReassignAttempts,
  DEFAULT_GOAL_WORKER_REASSIGN_MAX_ATTEMPTS,
} from './goal-reassign-budget.js';
import type { DaemonSession } from './types.js';

export type GoalAttentionLiveKind =
  | 'worker_zombie'
  | 'worker_dormant'
  | 'supervisor_zombie'
  | 'supervisor_dormant';

export interface GoalAttentionBuildOptions {
  baseDir?: string;
  chatId?: string;
  now?: number;
  ledger?: LedgerHandle;
}

export interface GoalAttentionLiveOptions {
  board: GoalAttentionBoard;
  activeSessions?: Map<string, DaemonSession>;
  larkAppId: string;
}

function isRiskEligible(task: TaskView): boolean {
  return task.status === 'dispatched' || task.status === 'rejected';
}

export function buildGoalAttentionContext(opts: GoalAttentionBuildOptions = {}): DispositionContext {
  const ledger = opts.ledger ?? openLedger({ baseDir: opts.baseDir });
  const now = opts.now ?? Date.now();
  const events = ledger.read();
  const tasks = ledger.tasks(opts.chatId);

  const reassignBudgetExhausted = new Set<string>();
  for (const task of tasks) {
    if (!task.taskId?.trim() || !isRiskEligible(task)) continue;
    const attempts = countGoalWorkerReassignAttempts(events, task.taskId, now);
    if (attempts >= DEFAULT_GOAL_WORKER_REASSIGN_MAX_ATTEMPTS) {
      reassignBudgetExhausted.add(task.taskId);
    }
  }

  const deadLetterTaskIds = new Set<string>();
  for (const record of listGoalNotificationRetries()) {
    if (record.status !== 'dead' || !record.taskId) continue;
    if (opts.chatId && record.goalChatId !== opts.chatId) continue;
    deadLetterTaskIds.add(record.taskId);
  }

  return { reassignBudgetExhausted, deadLetterTaskIds };
}

function stampLedgerRisk(task: AttentionTask): AttentionTask {
  return task.source ? task : { ...task, source: 'ledger' };
}

export function buildGoalAttentionBoardWithContext(opts: GoalAttentionBuildOptions = {}): GoalAttentionBoard {
  const context = buildGoalAttentionContext(opts);
  const board = buildGoalAttentionBoard({ baseDir: opts.baseDir, chatId: opts.chatId, context });
  return {
    ...board,
    systemRisk: board.systemRisk.map(stampLedgerRisk),
  };
}

function isGoalSupervisorTitle(title: string | undefined): boolean {
  return title?.startsWith('[Goal]') === true;
}

function liveStatus(ds: DaemonSession): 'live' | 'dormant' | 'zombie' {
  if (ds.worker && !ds.worker.killed) return 'live';
  if (ds.session.suspendedColdResume === true) return 'dormant';
  return 'zombie';
}

function liveKind(kind: 'worker' | 'supervisor', status: 'dormant' | 'zombie'): GoalAttentionLiveKind {
  return `${kind}_${status}` as GoalAttentionLiveKind;
}

function liveDetail(kind: 'worker' | 'supervisor', status: 'dormant' | 'zombie', ds: DaemonSession): string {
  const name = kind === 'supervisor' ? '监管者' : 'worker';
  if (status === 'dormant') return `${name} 会话处于冷恢复/休眠态，等待唤醒`;
  return `${name} 会话记录仍在，但 worker 进程不在线`;
}

function findSession(
  activeSessions: Map<string, DaemonSession>,
  input: { goalChatId: string; larkAppId: string; supervisor: boolean },
): DaemonSession | undefined {
  for (const ds of activeSessions.values()) {
    if (ds.chatId !== input.goalChatId || ds.larkAppId !== input.larkAppId || ds.scope !== 'chat') continue;
    const isSupervisor = isGoalSupervisorTitle(ds.session.title);
    if (input.supervisor === isSupervisor) return ds;
  }
  return undefined;
}

function activeTask(task: GoalBoardTask): boolean {
  return task.status === 'dispatched' || task.status === 'reported' || task.status === 'rejected' || task.status === 'blocked';
}

function toLiveRisk(input: {
  goalChatId: string;
  goalTitle?: string;
  taskId: string;
  title?: string;
  kind: 'worker' | 'supervisor';
  status: 'dormant' | 'zombie';
  ds: DaemonSession;
  workerNames?: string[];
  lastActivityAt?: number;
}): AttentionTask {
  const task: AttentionTask = {
    goalChatId: input.goalChatId,
    taskId: input.taskId,
    disposition: {
      bucket: 'systemRisk',
      reason: liveKind(input.kind, input.status),
      next: input.kind === 'supervisor' ? '监管者会话需恢复' : 'worker 会话需恢复/重派',
    },
    source: 'live',
    liveKind: liveKind(input.kind, input.status),
    liveDetail: liveDetail(input.kind, input.status, input.ds),
    sessionId: input.ds.session.sessionId,
    larkAppId: input.ds.larkAppId,
  };
  if (input.goalTitle) task.goalTitle = input.goalTitle;
  if (input.title) task.title = input.title;
  if (input.workerNames?.length) task.workerNames = input.workerNames;
  if (input.lastActivityAt !== undefined) task.lastActivityAt = input.lastActivityAt;
  return task;
}

export function buildLocalGoalAttentionLiveRisks(opts: GoalAttentionLiveOptions): AttentionTask[] {
  const activeSessions = opts.activeSessions;
  if (!activeSessions || !opts.larkAppId) return [];

  const out: AttentionTask[] = [];
  const seen = new Set<string>();
  for (const goal of opts.board.perGoal) {
    const supervisor = findSession(activeSessions, { goalChatId: goal.goalChatId, larkAppId: opts.larkAppId, supervisor: true });
    if (supervisor) {
      const status = liveStatus(supervisor);
      if (status !== 'live') {
        const key = `supervisor:${goal.goalChatId}:${opts.larkAppId}:${supervisor.session.sessionId}:${status}`;
        seen.add(key);
        out.push(toLiveRisk({
          goalChatId: goal.goalChatId,
          goalTitle: goal.title,
          taskId: '__goal_supervisor__',
          title: '监管者会话',
          kind: 'supervisor',
          status,
          ds: supervisor,
        }));
      }
    }

    for (const task of goal.tasks) {
      if (!activeTask(task)) continue;
      const appIds = task.workerLarkAppIds ?? [];
      for (let i = 0; i < appIds.length; i++) {
        if (appIds[i] !== opts.larkAppId) continue;
        const worker = findSession(activeSessions, { goalChatId: goal.goalChatId, larkAppId: opts.larkAppId, supervisor: false });
        if (!worker) continue;
        const status = liveStatus(worker);
        if (status === 'live') continue;
        const key = `worker:${goal.goalChatId}:${task.taskId}:${opts.larkAppId}:${worker.session.sessionId}:${status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(toLiveRisk({
          goalChatId: goal.goalChatId,
          goalTitle: goal.title,
          taskId: task.taskId,
          title: task.title,
          kind: 'worker',
          status,
          ds: worker,
          workerNames: task.workerNames,
          lastActivityAt: task.dispatchedAt ?? task.latestReportedAt ?? task.latestVerdictAt,
        }));
      }
    }
  }
  return out;
}

export function withGoalAttentionLiveRisks(board: GoalAttentionBoard, liveRisks: AttentionTask[]): GoalAttentionBoard {
  if (liveRisks.length === 0) return board;
  const systemRisk = [...board.systemRisk.map(stampLedgerRisk), ...liveRisks]
    .sort((a, b) => (a.lastActivityAt ?? Number.POSITIVE_INFINITY) - (b.lastActivityAt ?? Number.POSITIVE_INFINITY));
  return {
    ...board,
    systemRisk,
    counts: {
      ...board.counts,
      systemRisk: systemRisk.length,
    },
  };
}
