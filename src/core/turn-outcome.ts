// src/core/turn-outcome.ts
//
// 在轮次终态处记下「本轮结果」（Session.lastTurn），供会话任务状态推导使用。
// 已交付只认两样确定事实同时成立：轮次正常结束 + 本轮有最终回复的送达回执；
// 其余一律不标已交付。
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { SUPPORTED_LOCALES, t } from '../i18n/index.js';
import * as sessionStore from '../services/session-store.js';
import { shouldNotifyTurnFailure } from '../services/turn-failure-notice.js';
import { logger } from '../utils/logger.js';
import { dashboardEventBus } from './dashboard-events.js';
import { waitForTurnFinalOutputDeliveryDrain } from './final-output-delivery-drain.js';
import { waitAllWithin } from './producer-quiescence.js';
import {
  lastTurnCurrentThrough,
  normalizeLastTurn,
  replySummaryLine,
  type SessionLastTurn,
  type TurnOutcome,
} from './session-task-status.js';
import { emitSessionTaskEvent } from './session-task-events.js';
import type { DaemonSession } from './types.js';

/** 等本轮 daemon 兜底最终回复投递完成的上限，覆盖现有 0/5/15 秒重试序列。 */
export const TURN_OUTCOME_DRAIN_TIMEOUT_MS = 30_000;
const FINAL_TEXT_MEMORY = 16;
const MARKER_TAIL_BYTES = 64 * 1024;

/** daemon 自己发起的维护轮（阈值 / 空闲自动压缩），不是任何人的任务。 */
export function isMaintenanceTurnId(turnId: string): boolean {
  return turnId.startsWith('auto-compact:');
}

export interface TurnOutcomeTerminal {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
}

export function classifyTurnOutcome(
  terminal: TurnOutcomeTerminal,
  facts: { recoveryHandled: boolean; finalDelivered: boolean },
): TurnOutcome {
  if (terminal.status === 'completed') return facts.finalDelivered ? 'delivered' : 'no_output';
  // 自动续跑接管的失败还没有结论；续跑失败时 daemon 会举手，那条信号会把会话归到「需要你」。
  if (facts.recoveryHandled) return 'no_output';
  return shouldNotifyTurnFailure({
    status: terminal.status,
    ...(terminal.errorCode !== undefined ? { errorCode: terminal.errorCode } : {}),
  }) ? 'interrupted' : 'no_output';
}

const finalTexts = new WeakMap<DaemonSession, Map<string, string>>();
const finalKinds = new WeakMap<DaemonSession, Map<string, 'answer' | 'diagnostic'>>();
const terminalStatuses = new WeakMap<DaemonSession, Map<string, TurnOutcomeTerminal['status']>>();
const turnStarts = new WeakMap<DaemonSession, Map<string, number>>();
const outcomeSeq = new WeakMap<DaemonSession, number>();
/** 没写盘的「无最终输出」：它的最终回复晚到时仍可补登成已交付。 */
const heldBackNoOutput = new WeakMap<DaemonSession, { turnId: string; at: number }>();

function remember<V>(store: WeakMap<DaemonSession, Map<string, V>>, ds: DaemonSession, turnId: string, value: V): void {
  const map = store.get(ds) ?? new Map<string, V>();
  store.set(ds, map);
  map.delete(turnId);
  map.set(turnId, value);
  while (map.size > FINAL_TEXT_MEMORY) map.delete(map.keys().next().value!);
}

function noteAnswered(ds: DaemonSession, turnId: string): void {
  if (turnId) remember(finalKinds, ds, turnId, 'answer');
}

/** daemon 开始一轮（把输入交给 CLI）时调用。 */
export function noteTurnStarted(ds: DaemonSession, turnId: string, at: number = Date.now()): void {
  if (turnId) remember(turnStarts, ds, turnId, at);
}

/** 这一轮开始的时刻；daemon 重启前开始的、或已被挤出记录窗口的轮没有。 */
export function turnStartedAt(ds: DaemonSession, turnId: string): number | undefined {
  return turnStarts.get(ds)?.get(turnId);
}

let restoredNotices: string[] | undefined;

/** 重启后从终端记录恢复的回复前面带一行提示，摘要要的是提示后面的正文。 */
function stripRestoredNotice(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  restoredNotices ??= SUPPORTED_LOCALES.map(locale => t('worker.bridge_restored_turn_notice', undefined, locale));
  const text = raw.trimStart();
  const notice = restoredNotices.find(n => text.startsWith(n));
  return notice ? text.slice(notice.length) : raw;
}

/** daemon 兜底投递最终回复时记下正文第一行，供卡片展示。 */
export function noteFinalReplyText(ds: DaemonSession, turnId: string, raw: unknown): void {
  if (!turnId) return;
  noteAnswered(ds, turnId);
  const line = replySummaryLine(stripRestoredNotice(raw));
  if (line) remember(finalTexts, ds, turnId, line);
}

/** 投递出去的是「没匹配到最终文本」诊断，不是模型的答复：不算本轮的最终回复。 */
export function noteDiagnosticFinal(ds: DaemonSession, turnId: string): void {
  if (!turnId || finalKinds.get(ds)?.get(turnId) === 'answer') return;
  remember(finalKinds, ds, turnId, 'diagnostic');
}

/**
 * 最终输出通道送达了一条消息。失败卡不是最终回复；「已完成但没匹配到最终文本」的诊断只记成诊断；
 * 其余记下正文第一行，回执晚于本轮结果落盘的补成已交付。
 */
export function noteFinalOutputReceipt(
  ds: DaemonSession,
  turnId: string,
  receipt: { turnFailed?: boolean; emptyCompletedNotice?: boolean; text: unknown },
  opts: { now?: () => number; dataDir?: string } = {},
): void {
  if (receipt.turnFailed) return;
  if (receipt.emptyCompletedNotice) {
    noteDiagnosticFinal(ds, turnId);
    return;
  }
  noteFinalReplyText(ds, turnId, receipt.text);
  noteLateFinalReply(ds, turnId, opts);
}

/** 自动压缩和 HTTP 调用方的轮不进群，不能顶掉会话上用户看得到的本轮结果。 */
export function isTurnOutcomeExcluded(ds: DaemonSession, turnId: string): boolean {
  return isMaintenanceTurnId(turnId)
    || ds.session.idleAutoCompact?.inFlight?.turnId === turnId
    || ds.idleAutoCompactDispatchedTurnId === turnId
    || !!ds.pendingWaitPromises?.has(turnId)
    || !!ds.asyncTriggerResults?.has(turnId)
    || !!ds.settledHttpTerminalTurns?.has(turnId);
}

function resultStillCurrent(ds: DaemonSession, turn: SessionLastTurn | undefined): turn is SessionLastTurn {
  return !!turn && !(ds.lastMessageAt > lastTurnCurrentThrough(turn));
}

/** `botmux send --response-kind final` 的正文预览在 turn-sends 里，按 turnId 从尾部反查。 */
export function readFinalSendPreview(dataDir: string, sessionId: string, turnId: string): string | undefined {
  const path = join(dataDir, 'turn-sends', `${sessionId}.jsonl`);
  if (!existsSync(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, MARKER_TAIL_BYTES);
    if (length <= 0) return undefined;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.trim()) continue;
      try {
        const row = JSON.parse(lines[i]!);
        if (row?.turnId === turnId && row.responseKind === 'final' && typeof row.previewText === 'string') {
          return replySummaryLine(row.previewText);
        }
      } catch { /* 并发写入的半行 */ }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function finalSummary(ds: DaemonSession, turnId: string, dataDir: string): string | undefined {
  return finalTexts.get(ds)?.get(turnId) ?? readFinalSendPreview(dataDir, ds.session.sessionId, turnId);
}

function commitLastTurn(ds: DaemonSession, lastTurn: SessionLastTurn): boolean {
  const sessionId = ds.session.sessionId;
  // 等待期间会话可能已经关闭：用整行写回会把已关闭的行改回 active。
  let stored;
  try { stored = sessionStore.getSession(sessionId); } catch { return false; }
  if (ds.session.status !== 'active' || !stored || stored.status !== 'active') return false;
  const previous = ds.session.lastTurn;
  ds.session.lastTurn = lastTurn;
  try {
    sessionStore.updateSession(ds.session);
  } catch (err) {
    if (ds.session.lastTurn === lastTurn) ds.session.lastTurn = previous;
    logger.warn(`[${sessionId.slice(0, 8)}] turn outcome save failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  dashboardEventBus.publish({ type: 'session.update', body: { sessionId, patch: { lastTurn } } });
  const unchanged = previous?.turnId === lastTurn.turnId && previous.outcome === lastTurn.outcome;
  if (lastTurn.outcome !== 'no_output' && !unchanged && ds.session.chatId) emitSessionTaskEvent({ chatId: ds.session.chatId, sessionId });
  return true;
}

/**
 * 轮次终态时调用。completed 先等本轮 daemon 兜底最终回复投递落地（它的送达回执在
 * 飞书往返之后才记，可能晚于终态），再看有没有最终回复。只有最后一个终态能写，
 * 早到的旧轮等待结束后不会盖掉新轮的结果。
 */
export async function recordTurnOutcome(
  ds: DaemonSession,
  terminal: TurnOutcomeTerminal,
  opts: {
    recoveryHandled: boolean;
    isFinalDelivered: () => boolean;
    drainTimeoutMs?: number;
    now?: () => number;
    dataDir?: string;
  },
): Promise<SessionLastTurn | undefined> {
  if (ds.session.vcMeetingReceiver) return undefined;
  const now = opts.now ?? Date.now;
  const seq = (outcomeSeq.get(ds) ?? 0) + 1;
  outcomeSeq.set(ds, seq);
  remember(terminalStatuses, ds, terminal.turnId, terminal.status);
  if (terminal.status === 'completed') {
    await waitAllWithin(
      [waitForTurnFinalOutputDeliveryDrain(ds, terminal.turnId)],
      now() + (opts.drainTimeoutMs ?? TURN_OUTCOME_DRAIN_TIMEOUT_MS),
      now,
    );
  }
  if (outcomeSeq.get(ds) !== seq) return undefined;
  const outcome = classifyTurnOutcome(terminal, {
    recoveryHandled: opts.recoveryHandled,
    finalDelivered: terminal.status === 'completed' && opts.isFinalDelivered()
      && finalKinds.get(ds)?.get(terminal.turnId) !== 'diagnostic',
  });
  const at = now();
  const current = normalizeLastTurn(ds.session.lastTurn);
  const startedAt = turnStarts.get(ds)?.get(terminal.turnId);
  // 没有新消息就跑完、也没产出的轮（提示缓存保活、HTTP 等待、无输出的定时任务）不是新任务，
  // 不该盖掉还代表现状的上一个结果。上一个结果落定之前就开始的轮例外：那是收尾时追发的消息，
  // 它的结果才是现状（追发时间早于上一个结果的落定时间，光比最近消息时间看不出来）。
  const followUp = startedAt !== undefined && current !== undefined && startedAt < current.at;
  if (outcome === 'no_output' && current?.turnId !== terminal.turnId && resultStillCurrent(ds, current) && !followUp) {
    heldBackNoOutput.set(ds, { turnId: terminal.turnId, at });
    return undefined;
  }
  heldBackNoOutput.delete(ds);
  const summary = outcome === 'delivered'
    ? finalSummary(ds, terminal.turnId, opts.dataDir ?? config.session.dataDir)
    : undefined;
  const lastTurn: SessionLastTurn = {
    turnId: terminal.turnId,
    outcome,
    at,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(outcome === 'interrupted' ? { errorCode: terminal.errorCode ?? terminal.status } : {}),
  };
  return commitLastTurn(ds, lastTurn) ? lastTurn : undefined;
}

/**
 * 最终回复的送达回执晚于结果落盘（投递重试超过等待上限、transcript 滞后补发）时，
 * 把同一轮的「无最终输出」补成「已交付」。只认完全相同的 turnId，且那一轮是正常结束的：
 * 失败、取消的轮即使后来送达了什么，也不是交付。
 */
export function noteLateFinalReply(
  ds: DaemonSession,
  turnId: string,
  opts: { now?: () => number; dataDir?: string } = {},
): SessionLastTurn | undefined {
  noteAnswered(ds, turnId);
  if (terminalStatuses.get(ds)?.get(turnId) !== 'completed') return undefined;
  const current = ds.session.lastTurn;
  const heldBack = heldBackNoOutput.get(ds);
  // 之后又来了新消息：这一轮已经不是「本轮」，补登会把它重新顶成当前结果。
  const sameTurnNoOutput = current?.turnId === turnId && current.outcome === 'no_output' && resultStillCurrent(ds, current);
  const heldBackTurn = heldBack?.turnId === turnId && !(ds.lastMessageAt > heldBack.at);
  if (!sameTurnNoOutput && !heldBackTurn) return undefined;
  heldBackNoOutput.delete(ds);
  const summary = finalSummary(ds, turnId, opts.dataDir ?? config.session.dataDir);
  const startedAt = turnStarts.get(ds)?.get(turnId);
  const lastTurn: SessionLastTurn = {
    turnId,
    outcome: 'delivered',
    at: (opts.now ?? Date.now)(),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(summary ? { summary } : {}),
  };
  return commitLastTurn(ds, lastTurn) ? lastTurn : undefined;
}

/**
 * daemon 代发的维护输入（自动压缩）会刷新会话活动时间。在刷新之前调用：当前结果如果还代表
 * 现状，就把它的有效期延到这次活动，不让维护输入把「本轮已交付」顶掉。
 */
export function holdLastTurnThrough(ds: DaemonSession, at: number): SessionLastTurn | undefined {
  const current = normalizeLastTurn(ds.session.lastTurn);
  if (!resultStillCurrent(ds, current) || at <= lastTurnCurrentThrough(current)) return undefined;
  const lastTurn: SessionLastTurn = { ...current, heldThrough: at };
  return commitLastTurn(ds, lastTurn) ? lastTurn : undefined;
}
