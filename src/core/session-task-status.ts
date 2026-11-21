// src/core/session-task-status.ts
//
// 会话任务状态：看板列、表格状态、概览计数、状态色条和决策看板共用的一套推导。
// 只读 daemon 已有的事实（运行态、举手、TUI 选择框、待选仓库、本轮结果、TODO），
// 不引入任何人工维护的字段。零依赖，dashboard 前端和 daemon 都直接引用。

/** 一轮结束时 daemon 记下的结果。 */
export type TurnOutcome = 'delivered' | 'interrupted' | 'no_output';

export interface SessionLastTurn {
  turnId: string;
  outcome: TurnOutcome;
  /** daemon 确认结果的时刻（epoch ms）。delivered 时晚于最终回复送达。 */
  at: number;
  /** 这一轮开始的时刻（daemon 把输入交给 CLI）。daemon 重启前开始的轮没有。 */
  startedAt?: number;
  /** 最终回复第一行（仅 delivered）。 */
  summary?: string;
  /** 中断时的错误码（仅 interrupted）。 */
  errorCode?: string;
  /** 这个时刻及之前的会话活动是维护性输入（自动压缩），不算新一轮，结果仍代表现状。 */
  heldThrough?: number;
}

/** 本轮结果的时效窗口：休眠会话超过它的中断不再算「需要你」，也不再留在看板上。 */
export const RECENT_TURN_WINDOW_MS = 24 * 60 * 60 * 1000;

export const BUSY_RUNTIME_STATUSES: ReadonlySet<string> = new Set(['starting', 'working', 'analyzing', 'active']);

export type NeedsYouReason = 'attention' | 'tui_prompt' | 'pending_repo' | 'limited' | 'stalled' | 'interrupted';

export type SessionTaskStatus =
  | { kind: 'closed'; at?: number }
  | { kind: 'needs_you'; reason: NeedsYouReason; detail?: string; at?: number }
  | { kind: 'working'; since?: number }
  | { kind: 'delivered'; at: number; summary?: string }
  | { kind: 'unfinished'; remaining: number }
  | { kind: 'idle' };

export type SessionTaskKind = SessionTaskStatus['kind'];

export const SESSION_TASK_KINDS: readonly SessionTaskKind[] = ['needs_you', 'working', 'delivered', 'unfinished', 'idle', 'closed'];

/** 推导所需的会话事实，字段与 dashboard SessionRow 同名。 */
export interface SessionTaskFacts {
  status?: unknown;
  closedAt?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
  busySinceAt?: unknown;
  lastMessageAt?: unknown;
  lastTurn?: unknown;
  openTodos?: unknown;
}

/** dashboard 前端的行是宽松的 Record，这里一并接受。 */
type FactsInput = SessionTaskFacts | Readonly<Record<string, unknown>>;

const OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'interrupted', 'no_output']);
export const TURN_SUMMARY_MAX_CHARS = 120;

function finiteMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 校验持久化/跨进程传来的本轮结果；形状不对一律当读不到。 */
export function normalizeLastTurn(raw: unknown): SessionLastTurn | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const turnId = text(r.turnId);
  const at = finiteMs(r.at);
  if (!turnId || at === undefined || typeof r.outcome !== 'string' || !OUTCOMES.has(r.outcome)) return undefined;
  const summary = text(r.summary);
  const errorCode = text(r.errorCode);
  const heldThrough = finiteMs(r.heldThrough);
  const startedAt = finiteMs(r.startedAt);
  return {
    turnId,
    outcome: r.outcome as TurnOutcome,
    at,
    ...(startedAt !== undefined && startedAt <= at ? { startedAt } : {}),
    ...(summary ? { summary: summary.slice(0, TURN_SUMMARY_MAX_CHARS) } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(heldThrough !== undefined && heldThrough > at ? { heldThrough } : {}),
  };
}

/** 晚于这个时刻的会话活动才算新一轮的输入。 */
export function lastTurnCurrentThrough(turn: SessionLastTurn): number {
  return Math.max(turn.at, turn.heldThrough ?? 0);
}

/** 本轮结果是否还代表会话现状：之后又来了消息（新一轮的输入）就不再算数。 */
export function currentLastTurn(input: FactsInput): SessionLastTurn | undefined {
  const facts = input as SessionTaskFacts;
  const turn = normalizeLastTurn(facts.lastTurn);
  if (!turn) return undefined;
  const lastMessageAt = finiteMs(facts.lastMessageAt);
  return lastMessageAt !== undefined && lastMessageAt > lastTurnCurrentThrough(turn) ? undefined : turn;
}

function attentionOf(input: FactsInput): { reason?: string; at?: number; agent: boolean } | undefined {
  const facts = input as SessionTaskFacts;
  const a = facts.agentAttention;
  if (!a || typeof a !== 'object') return undefined;
  const r = a as Record<string, unknown>;
  return { reason: text(r.reason), at: finiteMs(r.at), agent: r.source === 'agent' };
}

/**
 * 还挡着任务状态的举手。举手只在真人回复时清除，bot 协作群里可能一直挂着；之后又开了新一轮
 * （正在跑，或已经有了新一轮的结果）就说明有人接着推进了，按新一轮算。举手那一轮本身的结果不算：
 * agent 常常在一轮中间举手、然后结束这一轮。读不到时刻就当还挡着。
 */
function blockingAttention(input: FactsInput, busy: boolean): ReturnType<typeof attentionOf> {
  const facts = input as SessionTaskFacts;
  const attention = attentionOf(facts);
  if (!attention || attention.at === undefined) return attention;
  const busySince = busy ? finiteMs(facts.busySinceAt) ?? 0 : 0;
  const turnStart = normalizeLastTurn(facts.lastTurn)?.startedAt ?? 0;
  return Math.max(busySince, turnStart) > attention.at ? undefined : attention;
}

function remainingTodos(input: FactsInput): number {
  const facts = input as SessionTaskFacts;
  const todos = facts.openTodos;
  if (!todos || typeof todos !== 'object') return 0;
  const remaining = (todos as Record<string, unknown>).remaining;
  return typeof remaining === 'number' && remaining > 0 ? remaining : 0;
}

function needsYou(reason: NeedsYouReason, detail?: string, at?: number): SessionTaskStatus {
  return { kind: 'needs_you', reason, ...(detail ? { detail } : {}), ...(at !== undefined ? { at } : {}) };
}

/**
 * 优先级自上而下：已关闭 → 需要你 → 进行中 → 本轮结果（中断 / 已交付）→ 没做完 → 空闲。
 * 读不到本轮结果（旧会话、从没跑过、结果被后来的消息盖过）只会落到「没做完 / 空闲」，
 * 绝不推成已交付。
 */
export function deriveSessionTaskStatus(input: FactsInput, now: number = Date.now()): SessionTaskStatus {
  const facts = input as SessionTaskFacts;
  const status = String(facts.status ?? '');
  if (status === 'closed') {
    const at = finiteMs(facts.closedAt);
    return at !== undefined ? { kind: 'closed', at } : { kind: 'closed' };
  }
  const busy = BUSY_RUNTIME_STATUSES.has(status);
  const attention = blockingAttention(facts, busy);
  if (attention?.agent) return needsYou('attention', attention.reason, attention.at);
  if (facts.tuiPromptActive) return needsYou('tui_prompt');
  if (facts.pendingRepo) return needsYou('pending_repo');
  if (status === 'limited') return needsYou('limited');
  if (status === 'stalled') return needsYou('stalled');
  // daemon 自己举的手（失败卡、最终回复投递失败、续跑失败、审核拦截等）都是这一轮没走完。
  if (attention) return needsYou('interrupted', attention.reason, attention.at);
  if (busy) {
    const since = finiteMs(facts.busySinceAt);
    return since !== undefined ? { kind: 'working', since } : { kind: 'working' };
  }
  const turn = currentLastTurn(facts);
  // 休眠多日的旧中断没人接手也不会再动，留在「需要你」里只会越积越多。
  const staleDormant = status === 'dormant' && turn !== undefined && now - turn.at >= RECENT_TURN_WINDOW_MS;
  if (turn?.outcome === 'interrupted' && !staleDormant) return needsYou('interrupted', turn.errorCode, turn.at);
  if (turn?.outcome === 'delivered') {
    return turn.summary ? { kind: 'delivered', at: turn.at, summary: turn.summary } : { kind: 'delivered', at: turn.at };
  }
  const remaining = remainingTodos(facts);
  if (remaining > 0) return { kind: 'unfinished', remaining };
  return { kind: 'idle' };
}

/**
 * 最近一次任务状态变化的时刻：新消息、开始新一轮、一轮结束、举手。自动压缩这类维护输入也会刷新
 * 最近消息时间，但它被本轮结果的 heldThrough 盖住，不算新消息。
 */
export function taskStatusChangedAt(input: FactsInput): number {
  const facts = input as SessionTaskFacts;
  const attention = attentionOf(facts);
  const turn = normalizeLastTurn(facts.lastTurn);
  const lastMessageAt = finiteMs(facts.lastMessageAt) ?? 0;
  return Math.max(
    0,
    lastMessageAt > (turn?.heldThrough ?? 0) ? lastMessageAt : 0,
    finiteMs(facts.busySinceAt) ?? 0,
    turn?.at ?? 0,
    attention?.at ?? 0,
  );
}

/** 最终回复的第一行，去掉 Markdown 标题/引用/列表前缀和强调符号。 */
export function replySummaryLine(raw: unknown, max = TURN_SUMMARY_MAX_CHARS): string | undefined {
  if (typeof raw !== 'string') return undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) continue;
    const cleaned = line
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /^[-*_=|:\s]{3,}$/.test(cleaned)) continue;
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  }
  return undefined;
}
