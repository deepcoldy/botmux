import type { DaemonSession } from './types.js';

// Silent schedule turn ids are intentionally retained past turn_terminal: a
// worker can still emit a trailing idle/screenshot event after its terminal
// receipt. Unique ids make retention safe, while TTL + size bounds prevent a
// long-lived scheduler session from growing without limit.
const SILENT_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SILENT_TURNS_PER_SESSION = 256;

function pruneSilentScheduledTurns(ds: DaemonSession, now: number): void {
  const turns = ds.silentScheduledTurns;
  if (!turns) return;
  for (const [turnId, armedAt] of turns) {
    if (now - armedAt > SILENT_TURN_TTL_MS) {
      turns.delete(turnId);
      ds.silentScheduledTurnMeta?.delete(turnId);
      if (ds.latestSilentScheduledTurn?.turnId === turnId) ds.latestSilentScheduledTurn = undefined;
    }
  }
  while (turns.size >= MAX_SILENT_TURNS_PER_SESSION) {
    const oldest = turns.keys().next().value as string | undefined;
    if (!oldest) break;
    turns.delete(oldest);
    ds.silentScheduledTurnMeta?.delete(oldest);
    if (ds.latestSilentScheduledTurn?.turnId === oldest) ds.latestSilentScheduledTurn = undefined;
  }
  if (turns.size === 0) {
    ds.silentScheduledTurns = undefined;
    ds.silentScheduledTurnMeta = undefined;
  } else if (ds.silentScheduledTurnMeta?.size === 0) {
    ds.silentScheduledTurnMeta = undefined;
  }
}

export function armSilentScheduledTurn(
  ds: DaemonSession,
  turnId: string,
  now = Date.now(),
): void {
  pruneSilentScheduledTurns(ds, now);
  const turns = ds.silentScheduledTurns ??= new Map<string, number>();
  turns.set(turnId, now);
  const seq = (ds.turnOrderSeq ?? 0) + 1;
  ds.turnOrderSeq = seq;
  const meta = ds.silentScheduledTurnMeta ??= new Map<string, { seq: number; currentTurnIdAtArm?: string }>();
  meta.set(turnId, { seq, currentTurnIdAtArm: ds.currentTurnId });
  ds.latestSilentScheduledTurn = { turnId, seq };
}

export function resolveDeferredScheduledTurnId(ds: DaemonSession, turnId?: string): string | undefined {
  const run = ds.session?.deferredScheduleRun;
  if (!run) return undefined;
  if (turnId) return turnId === run.turnId ? run.turnId : undefined;
  // Before materialization the dedicated session can only belong to this run.
  // Afterwards, an unattributed event must not inherit silence from an older
  // schedule when a human follow-up already owns the session.
  return ds.session.rootMessageId === run.routingAnchor || ds.currentTurnId === run.turnId
    ? run.turnId : undefined;
}

export function isSilentScheduledTurn(
  ds: DaemonSession,
  turnId?: string,
  now = Date.now(),
): boolean {
  // A deferred run owns a dedicated session. Retirement can clear the worker's
  // capture identity before its trailing idle frame; neither that nor registry
  // expiry may make this still-hidden run loud. Explicit other turns stay exact.
  if (resolveDeferredScheduledTurnId(ds, turnId)) return true;
  if (!turnId) return false;
  const armedAt = ds.silentScheduledTurns?.get(turnId);
  if (armedAt === undefined) return false;
  if (now - armedAt <= SILENT_TURN_TTL_MS) return true;
  disarmSilentScheduledTurn(ds, turnId);
  return false;
}

export function disarmSilentScheduledTurn(ds: DaemonSession, turnId: string): void {
  ds.silentScheduledTurns?.delete(turnId);
  ds.silentScheduledTurnMeta?.delete(turnId);
  if (ds.latestSilentScheduledTurn?.turnId === turnId) ds.latestSilentScheduledTurn = undefined;
  if (ds.silentScheduledTurns?.size === 0) ds.silentScheduledTurns = undefined;
  if (ds.silentScheduledTurnMeta?.size === 0) ds.silentScheduledTurnMeta = undefined;
}

/** 记录一次非静默回合准入或人工终端直连提交，推进非静默序号并清掉上一轮的 screen 回合绑定。 */
export function noteNonSilentTurnActivity(ds: DaemonSession): void {
  const seq = (ds.turnOrderSeq ?? 0) + 1;
  ds.turnOrderSeq = seq;
  ds.lastNonSilentTurnSeq = seq;
  ds.lastScreenTurnId = undefined;
  ds.lastScreenTurnGeneration = undefined;
}

const ACTIVE_SILENT_SCHEDULE_STATUSES = new Set<string>(['working', 'analyzing', 'starting']);

/** 当前会话的活跃运行态是否纯属静默定时巡检。
 *  必须同时满足：worker 存活、状态处于忙碌态、当前 worker 代际下正在执行的回合为静默定时回合，
 *  且该巡检登记之后未发生任何非静默新回合或 Web 终端直连输入（保留巡检前已结束的旧真人 currentTurnId 兼容）。 */
export function isActiveTurnSilentSchedule(
  ds: DaemonSession,
  status: string | undefined,
  now = Date.now(),
): boolean {
  if (!ds.worker || ds.worker.killed || !status || !ACTIVE_SILENT_SCHEDULE_STATUSES.has(status)) {
    return false;
  }
  const currentGeneration = ds.workerGeneration ?? ds.session.workerGeneration;
  if (
    ds.lastScreenTurnGeneration !== undefined
    && ds.lastScreenTurnGeneration !== currentGeneration
  ) {
    return false;
  }
  const screenTurnId = ds.lastScreenTurnGeneration !== undefined
    ? ds.lastScreenTurnId
    : undefined;

  let executingTurnId: string | undefined = screenTurnId;
  if (!executingTurnId) {
    if (ds.currentTurnId && isSilentScheduledTurn(ds, ds.currentTurnId, now)) {
      executingTurnId = ds.currentTurnId;
    } else if (
      ds.latestSilentScheduledTurn
      && ds.latestSilentScheduledTurn.seq > (ds.lastNonSilentTurnSeq ?? 0)
      && (ds.lastTurnTerminalStatus === undefined
        || ds.lastTurnTerminalTurnId !== ds.latestSilentScheduledTurn.turnId)
      && isSilentScheduledTurn(ds, ds.latestSilentScheduledTurn.turnId, now)
    ) {
      executingTurnId = ds.latestSilentScheduledTurn.turnId;
    } else {
      const deferred = resolveDeferredScheduledTurnId(ds, undefined);
      if (deferred) executingTurnId = deferred;
    }
  }
  if (!executingTurnId || !isSilentScheduledTurn(ds, executingTurnId, now)) {
    return false;
  }
  if (
    (ds.lastTurnTerminalStatus !== undefined && ds.lastTurnTerminalTurnId === executingTurnId)
    || ds.terminalIdentityTurnIds?.has(executingTurnId) === true
  ) {
    return false;
  }

  const meta = ds.silentScheduledTurnMeta?.get(executingTurnId);
  if (meta) {
    if ((ds.lastNonSilentTurnSeq ?? 0) > meta.seq) return false;
    if (
      ds.currentTurnId
      && ds.currentTurnId !== meta.currentTurnIdAtArm
      && !isSilentScheduledTurn(ds, ds.currentTurnId, now)
    ) {
      return false;
    }
  } else if (ds.currentTurnId && !isSilentScheduledTurn(ds, ds.currentTurnId, now)) {
    return false;
  }
  return true;
}
