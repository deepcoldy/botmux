// 会话任务状态的展示文案：看板卡片、表格状态、状态筛选共用。推导本身在 core/session-task-status。
import {
  deriveSessionTaskStatus,
  type SessionTaskKind,
  type SessionTaskStatus,
} from '../../core/session-task-status.js';
import { needsYouReasonLabel, t } from './ui.js';

export type TaskTone = 'need' | 'work' | 'done' | 'todo' | 'idle' | 'closed';

export function taskTone(status: SessionTaskStatus): TaskTone {
  switch (status.kind) {
    case 'needs_you': return 'need';
    case 'working': return 'work';
    case 'delivered': return 'done';
    case 'unfinished': return 'todo';
    case 'closed': return 'closed';
    default: return 'idle';
  }
}

/** 「12 分钟」「3 小时」这样的时长；不到一分钟返回空串。 */
export function taskDurationText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '';
  if (min < 60) return t('sessions.task.minutes', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('sessions.task.hours', { n: hours });
  return t('sessions.task.days', { n: Math.floor(hours / 24) });
}

function agoText(at: number, now: number): string {
  const span = taskDurationText(now - at);
  return span ? t('sessions.task.ago', { time: span }) : t('sessions.task.justNow');
}

const KIND_LABEL_KEYS: Record<Exclude<SessionTaskKind, 'needs_you'>, string> = {
  working: 'sessions.task.working',
  delivered: 'sessions.task.delivered',
  unfinished: 'sessions.task.unfinished',
  idle: 'sessions.task.idle',
  closed: 'sessions.task.closed',
};

/** 状态短语：需要你时直接给原因（等你拍板或回答 / 本轮中断 / …）。 */
export function taskStatusLabel(status: SessionTaskStatus): string {
  return status.kind === 'needs_you' ? needsYouReasonLabel(status.reason) : t(KIND_LABEL_KEYS[status.kind]);
}

export function taskKindLabel(kind: SessionTaskKind): string {
  return kind === 'needs_you' ? t('sessions.task.needsYou') : t(KIND_LABEL_KEYS[kind]);
}

/** 表格状态列：任务状态短语，休眠会话补一个「休眠」。 */
export function sessionTaskStatusText(row: Record<string, any>): string {
  const label = taskStatusLabel(deriveSessionTaskStatus(row));
  return row.status === 'dormant' ? `${label} · ${t('sessions.status.dormant')}` : label;
}

export interface TaskCardLine {
  tone: TaskTone;
  label: string;
  detail?: string;
}

/** 看板卡片上的状态行；空闲与已关闭不占行。 */
export function sessionTaskCardLine(status: SessionTaskStatus, now: number = Date.now()): TaskCardLine | null {
  switch (status.kind) {
    case 'needs_you':
      return { tone: 'need', label: needsYouReasonLabel(status.reason), ...(status.detail ? { detail: status.detail } : {}) };
    case 'working': {
      const span = status.since !== undefined ? taskDurationText(now - status.since) : '';
      return { tone: 'work', label: t('sessions.task.working'), ...(span ? { detail: t('sessions.task.runningFor', { time: span }) } : {}) };
    }
    case 'delivered':
      return {
        tone: 'done',
        label: t('sessions.task.deliveredAgo', { ago: agoText(status.at, now) }),
        ...(status.summary ? { detail: status.summary } : {}),
      };
    case 'unfinished':
      return { tone: 'todo', label: t('sessions.task.unfinished'), detail: t('sessions.task.todoRemaining', { n: status.remaining }) };
    default:
      return null;
  }
}

/** 状态筛选可选值：任务状态 + 休眠（运行态，用来找进程已退出的会话）。 */
export const SESSION_STATUS_FILTERS = ['needs_you', 'working', 'delivered', 'unfinished', 'idle', 'dormant', 'closed'] as const;

/** 旧版本存下的运行态筛选值映射到任务状态。 */
const LEGACY_STATUS_FILTERS: Record<string, SessionTaskKind> = {
  starting: 'working',
  analyzing: 'working',
  active: 'working',
  limited: 'needs_you',
  stalled: 'needs_you',
};

export function statusFilterLabel(value: string): string {
  if (value === 'dormant') return t('sessions.status.dormant');
  const kind = LEGACY_STATUS_FILTERS[value] ?? value;
  return kind === 'needs_you' || kind in KIND_LABEL_KEYS ? taskKindLabel(kind as SessionTaskKind) : value;
}

export function matchesStatusFilter(row: Record<string, any>, value: string): boolean {
  if (value === 'dormant') return row.status === 'dormant';
  return deriveSessionTaskStatus(row).kind === (LEGACY_STATUS_FILTERS[value] ?? value);
}
