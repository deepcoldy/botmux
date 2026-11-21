// 决策看板上「关联群里的子任务」：把群里各个会话的任务状态（core/session-task-status）合成群状态，
// 再按事项算提示。纯函数，读会话在 chat-task-reader.ts。
import type { Locale } from '../../i18n/types.js';
import {
  deriveSessionTaskStatus,
  currentLastTurn,
  type NeedsYouReason,
  type SessionTaskFacts,
} from '../session-task-status.js';
import { isEndedState } from './hints.js';
import type { BoardItem, BoardLink } from './model.js';

export type ChatTaskKind = 'needs_you' | 'interrupted' | 'working' | 'unreadable' | 'delivered' | 'idle' | 'closed' | 'no_session';

/** 汇总里各状态的先后顺序。 */
export const CHAT_TASK_KINDS: readonly ChatTaskKind[] = ['needs_you', 'interrupted', 'working', 'unreadable', 'delivered', 'idle', 'closed', 'no_session'];

export interface ChatTaskState {
  chatId: string;
  kind: ChatTaskKind;
  /** needs_you 的原因。 */
  reason?: NeedsYouReason;
  /** 举手原因、错误码等一句话。 */
  detail?: string;
  /** 状态发生的时刻：结果时间、举手时间、本轮开始时间、关闭时间。 */
  at?: number;
  /** 最终回复第一行（delivered）。 */
  summary?: string;
  /** 决定这个状态的会话与结果标识（turnId 或举手时刻），用于提醒去重。 */
  sessionId?: string;
  ref?: string;
  /** 这个状态本身没有发生时刻、出不了提示时，同群里用来算提示的那个结果。 */
  alert?: ChatTaskState;
}

/** 群里一个会话的读取结果。 */
export type ChatSessionProbe =
  | { sessionId: string; closed: true; closedAt?: number }
  | { sessionId: string; closed?: false; facts: SessionTaskFacts }
  | { sessionId: string; closed?: false; unreadable: true };

function latest<T extends { at?: number }>(list: T[]): T | undefined {
  let best: T | undefined;
  for (const x of list) if (!best || (x.at ?? 0) > (best.at ?? 0)) best = x;
  return best;
}

function hintable(state: ChatTaskState): boolean {
  return state.at !== undefined && !!state.sessionId && !!state.ref;
}

/**
 * 群状态：没有会话 → 没有会话；都关了 → 已关闭；否则按 需要你 > 本轮中断 > 进行中 > 读不到 > 已交付 > 空闲。
 * 有会话读不到时不说「已交付」：那个会话可能还在跑或在等人。
 */
export function aggregateChatTaskState(chatId: string, probes: readonly ChatSessionProbe[]): ChatTaskState {
  if (probes.length === 0) return { chatId, kind: 'no_session' };
  const needs: ChatTaskState[] = [];
  const interrupted: ChatTaskState[] = [];
  const working: ChatTaskState[] = [];
  const delivered: ChatTaskState[] = [];
  let unreadable = false;
  let open = 0;
  let closedAt = 0;
  for (const p of probes) {
    if (p.closed) { closedAt = Math.max(closedAt, p.closedAt ?? 0); continue; }
    if ('unreadable' in p) { open++; unreadable = true; continue; }
    if (!('facts' in p)) continue;
    const status = deriveSessionTaskStatus(p.facts);
    // 会话清单还当它开着，所属 daemon 已经报了关闭。
    if (status.kind === 'closed') { closedAt = Math.max(closedAt, status.at ?? 0); continue; }
    open++;
    const sessionId = p.sessionId;
    if (status.kind === 'needs_you') {
      const turn = currentLastTurn(p.facts);
      const fromTurn = status.reason === 'interrupted' && turn?.outcome === 'interrupted' && turn.at === status.at;
      const entry: ChatTaskState = {
        chatId, kind: status.reason === 'interrupted' ? 'interrupted' : 'needs_you', sessionId,
        ...(status.reason !== 'interrupted' ? { reason: status.reason } : {}),
        ...(status.detail ? { detail: status.detail } : {}),
        ...(status.at !== undefined ? { at: status.at } : {}),
        ...(fromTurn ? { ref: turn!.turnId } : status.at !== undefined ? { ref: String(status.at) } : {}),
      };
      (entry.kind === 'needs_you' ? needs : interrupted).push(entry);
    } else if (status.kind === 'working') {
      working.push({ chatId, kind: 'working', sessionId, ...(status.since !== undefined ? { at: status.since } : {}) });
    } else if (status.kind === 'delivered') {
      const turn = currentLastTurn(p.facts);
      delivered.push({
        chatId, kind: 'delivered', sessionId, at: status.at,
        ...(status.summary ? { summary: status.summary } : {}),
        ...(turn ? { ref: turn.turnId } : {}),
      });
    }
  }
  if (open === 0) return { chatId, kind: 'closed', ...(closedAt > 0 ? { at: closedAt } : {}) };
  const pick = latest(needs) ?? latest(interrupted) ?? latest(working);
  if (pick) {
    if (pick.kind === 'working' || hintable(pick)) return pick;
    // 等你选、待选仓库、额度受限、长时间无进展没有发生时刻，自己出不了提示，不能因此挡掉同群别的会话的结果。
    const alert = latest(interrupted.filter(hintable)) ?? (working.length || unreadable ? undefined : latest(delivered));
    return alert ? { ...pick, alert } : pick;
  }
  if (unreadable) return { chatId, kind: 'unreadable' };
  return latest(delivered) ?? { chatId, kind: 'idle' };
}

/** 事项要看的群：全部 chat 关联（主群不在关联里时一并算上），去重，排除管家群。 */
export function itemChatIds(item: Pick<BoardItem, 'primaryChat'>, links: readonly BoardLink[], stewardChatId?: string): string[] {
  const ids: string[] = [];
  for (const l of links) if (l.kind === 'chat' && !ids.includes(l.ref)) ids.push(l.ref);
  if (item.primaryChat && !ids.includes(item.primaryChat)) ids.unshift(item.primaryChat);
  return ids.filter(id => id !== stewardChatId);
}

export type TaskHintKind = 'task_needs_you' | 'task_interrupted' | 'task_delivered';

export interface TaskHint {
  kind: TaskHintKind;
  chatId: string;
  at: number;
  /** 去重 key：`task:<类型>:<会话>:<turnId 或举手时刻>`。 */
  key: string;
  detail?: string;
  summary?: string;
}

const HINT_OF: Partial<Record<ChatTaskKind, TaskHintKind>> = {
  needs_you: 'task_needs_you',
  interrupted: 'task_interrupted',
  delivered: 'task_delivered',
};

/** 一个群状态对应的提示：只有「已交付 / 等人处理 / 中断」且晚于管家最后一次更新这一项。 */
export function taskHintForChat(chat: ChatTaskState, stewardUpdatedAt: number): TaskHint | undefined {
  const state = chat.alert ?? chat;
  const kind = HINT_OF[state.kind];
  if (!kind || state.at === undefined || !state.sessionId || !state.ref) return undefined;
  if (state.at <= stewardUpdatedAt) return undefined;
  return {
    kind, chatId: state.chatId, at: state.at,
    key: `task:${state.kind}:${state.sessionId}:${state.ref}`,
    ...(state.detail ? { detail: state.detail } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
  };
}

/** 管家最后一次动这一项的时刻（建项、改任何字段、记历史都算；只有管家的写入会动 updatedAt）。 */
export function stewardUpdatedAt(item: Pick<BoardItem, 'updatedAt' | 'stewardEventAt' | 'createdAt'>): number {
  return Math.max(item.createdAt, item.updatedAt, item.stewardEventAt ?? 0);
}

const HINT_RANK: Record<TaskHintKind, number> = { task_needs_you: 0, task_interrupted: 1, task_delivered: 2 };

/** 一项在看板上显示的那条提示：已结束的项没有；多个群时等人 > 中断 > 已交付，同类取最近。 */
export function itemTaskHint(
  item: Pick<BoardItem, 'state' | 'updatedAt' | 'stewardEventAt' | 'createdAt'>,
  states: readonly ChatTaskState[],
): TaskHint | undefined {
  if (isEndedState(item.state)) return undefined;
  const since = stewardUpdatedAt(item);
  let best: TaskHint | undefined;
  for (const s of states) {
    const h = taskHintForChat(s, since);
    if (!h) continue;
    if (!best || HINT_RANK[h.kind] < HINT_RANK[best.kind] || (HINT_RANK[h.kind] === HINT_RANK[best.kind] && h.at > best.at)) best = h;
  }
  return best;
}

export const TASK_HINT_LABELS: Record<Locale, Record<TaskHintKind, string>> = {
  zh: { task_delivered: '子任务已交付', task_needs_you: '子任务等人处理', task_interrupted: '子任务中断' },
  en: { task_delivered: 'Subtask delivered', task_needs_you: 'Subtask needs someone', task_interrupted: 'Subtask interrupted' },
};

export interface TaskNoticeEntry {
  seq: number;
  title: string;
  hint: TaskHint;
  /** 群的展示名（关联里的标签 / 群名）。 */
  chatText?: string;
  link?: string;
}

/** 一轮提醒里最多逐项列这么多条，其余写「另有 N 项」。 */
export const TASK_NOTICE_MAX_ENTRIES = 20;

function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 管家群里的那一条：横幅 + 逐项一行。 */
export function formatTaskNotice(entries: readonly TaskNoticeEntry[], locale: Locale): string {
  const zh = locale !== 'en';
  const shown = entries.slice(0, TASK_NOTICE_MAX_ENTRIES);
  const head = zh
    ? `【决策看板 · 子任务】${entries.length} 条关联群的新结果（只是提示，状态没改）：`
    : `[Decision board · subtask] ${entries.length} new result(s) in linked chats (hints only; no state was changed):`;
  const lines = shown.map(e => {
    const label = TASK_HINT_LABELS[locale][e.hint.kind];
    const where = e.chatText ? (zh ? `（${oneLine(e.chatText, 40)}）` : ` (${oneLine(e.chatText, 40)})`) : '';
    const what = e.hint.summary ?? e.hint.detail;
    return `#${e.seq} ${oneLine(e.title)} — ${label}${where}${what ? `${zh ? '：' : ': '}${oneLine(what)}` : ''}${e.link ? ` ${e.link}` : ''}`;
  });
  const more = entries.length - shown.length;
  if (more > 0) lines.push(zh ? `另有 ${more} 条，见看板。` : `${more} more on the board.`);
  return [head, ...lines].join('\n');
}

/** 送进管家会话的正文：通知 + 处理指引。 */
export function formatTaskPrompt(entries: readonly TaskNoticeEntry[], locale: Locale): string {
  const tail = locale === 'en'
    ? 'Follow "Subtask results" in `botmux board guide`: read each chat\'s result with `botmux board show <n>`, then write back progress or change the state with `botmux board set`.'
    : '按 `botmux board guide` 里「子任务结果」一节处理：逐项 `botmux board show <编号>` 看群里的结果，用 `botmux board set` 回写进展或改状态。';
  return `${formatTaskNotice(entries, locale)}\n\n${tail}`;
}
