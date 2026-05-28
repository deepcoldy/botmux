/**
 * In-memory broker for `botmux ask` (v0.1.8).
 *
 * Holds the pending-ask registry, runs the deadline timers, and arbitrates
 * click resolution. IM-agnostic: the im/lark side wires a dispatcher via
 * `setCardDispatcher` so the broker doesn't import Lark types.
 *
 * §3 / §6 / §7 / §8 of /tmp/botmux-ask.md.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from './ask-types.js';

interface InternalPending extends Omit<PendingAsk, 'selections'> {
  resolve: (result: AskResult) => void;
  timeoutHandle: NodeJS.Timeout;
  /** epoch ms when settle ran; undefined while still pending. */
  settledAt?: number;
  /**
   * 按问题序号（questionIndex）累积的勾选 key 集合。
   * 单选问题（multiSelect:false）Set 内最多保留 1 个 key。
   * 多选问题（multiSelect:true）Set 内可保留任意个 key。
   */
  selections: Map<number, Set<string>>;
}

const pending = new Map<string, InternalPending>();
let dispatcher: AskCardDispatcher | null = null;

/** Window during which a settled ask is still queryable so race-losers get a
 *  precise `already_settled` outcome (and the card click handler can show
 *  "已被 X 答了" instead of a generic "已失效"). After this window expires,
 *  late clicks fall through to `stale` like any forgotten id. */
const SETTLED_RETENTION_MS = 60_000;

/** Wire the IM-side dispatcher. Called once during daemon bootstrap from
 *  daemon.ts after im/lark/ask-card.ts is constructed. */
export function setCardDispatcher(d: AskCardDispatcher): void {
  dispatcher = d;
}

/** Register a new pending ask. Returns a Promise that settles when:
 *   - a valid click arrives (`kind:'answered'`)
 *   - the deadline elapses (`kind:'timedOut'`)
 *   - the broker invalidates the ask (`kind:'invalidated'`)
 *
 *  Side effects:
 *   - generates askId + nonce
 *   - starts the deadline timer
 *   - dispatches the card; if the card send fails, the ask is immediately
 *     invalidated and the Promise settles with `kind:'invalidated'`.
 *
 *  Throws synchronously only if no dispatcher has been wired — that's a
 *  daemon-misconfiguration bug, not a runtime ask failure.
 */
export function registerAsk(input: CreateAskInput): Promise<AskResult> {
  if (!dispatcher) {
    throw new Error('ask-broker: cardDispatcher not wired — daemon bootstrap bug');
  }

  const askId = randomUUID();
  const nonce = randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;

  return new Promise<AskResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      settle(askId, {
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
    }, input.timeoutMs);
    // Don't keep the event loop alive just because an ask is pending.
    timeoutHandle.unref?.();

    // 为每个问题初始化空的勾选集合
    const selections = new Map<number, Set<string>>();
    for (let i = 0; i < input.questions.length; i++) {
      selections.set(i, new Set<string>());
    }

    const ask: InternalPending = {
      askId,
      nonce,
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sessionId: input.sessionId,
      approvers: input.approvers,
      questions: input.questions,
      createdAt,
      deadlineAt,
      settled: false,
      resolve,
      timeoutHandle,
      selections,
    };
    pending.set(askId, ask);

    // Card dispatch is async — store the messageId once it lands.
    void dispatcher!
      .send(snapshot(ask))
      .then(({ messageId }) => {
        const cur = pending.get(askId);
        if (cur && !cur.settled) cur.cardMessageId = messageId;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn?.(`ask-broker: ${askId} card dispatch failed: ${msg}`);
        settle(askId, {
          kind: 'invalidated',
          reason: `card dispatch failed: ${msg}`,
          selected: null,
          by: null,
          comment: null,
          timedOut: false,
        });
      });
  });
}

/**
 * 勾选/取消勾选某问题的某个选项（累积模式，不 settle）。
 *
 * 校验同 `tryResolveAsk`：askId 存在 / nonce 匹配 / 未 settle / 已授权 /
 * questionIndex 合法 / key 在该问题的 options 中。
 *
 * 对于单选问题（multiSelect:false），翻转时 Set 内只保留该 key（相当于"换选"）。
 * 对于多选问题（multiSelect:true），翻转规则：已在 Set 中则移除，否则添加。
 *
 * 成功返回 `'toggled'`；非法返回对应 AskClickOutcome。
 */
export function toggleAsk(args: {
  askId: string;
  nonce: string;
  questionIndex: number;
  key: string;
  by: string;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.nonce !== args.nonce) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!ask.approvers.has(args.by)) return 'unauthorized';

  const question = ask.questions[args.questionIndex];
  if (!question) return 'stale';
  if (!question.options.some((o) => o.key === args.key)) return 'stale';

  const sel = ask.selections.get(args.questionIndex)!;

  if (question.multiSelect) {
    // 多选：有则删、无则加
    if (sel.has(args.key)) {
      sel.delete(args.key);
    } else {
      sel.add(args.key);
    }
  } else {
    // 单选：清空后只保留该 key（等价于"换选"，再次 toggle 同一 key 也保留）
    sel.clear();
    sel.add(args.key);
  }

  return 'toggled';
}

/**
 * 提交答案并 settle。
 *
 * `selections` 显式传入时直接使用（按钮单选 / 一次性表单提交场景）；
 * 否则使用 `toggleAsk` 累积的勾选状态。
 *
 * 对于 `multiSelect:false` 的问题，要求恰好 1 个选中，否则返回 `'stale'`。
 * 校验通过则 settle 并返回 `'accepted'`；非法返回对应 AskClickOutcome。
 */
export function submitAsk(args: {
  askId: string;
  nonce: string;
  by: string;
  selections?: ReadonlyArray<ReadonlyArray<string>>;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.nonce !== args.nonce) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!ask.approvers.has(args.by)) return 'unauthorized';

  // 构建最终答案数组（按问题顺序）
  let answers: ReadonlyArray<ReadonlyArray<string>>;

  if (args.selections !== undefined) {
    // 显式传入：逐问校验单选约束 + key 合法性
    answers = args.selections;
    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      const sel = answers[i] ?? [];
      if (!q.multiSelect && sel.length !== 1) return 'stale';
      // 校验每个选中的 key 必须在该问题的 options 中
      for (const key of sel) {
        if (!q.options.some((o) => o.key === key)) return 'stale';
      }
    }
  } else {
    // 使用累积的勾选状态
    const built: string[][] = [];
    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      const sel = ask.selections.get(i)!;
      if (!q.multiSelect && sel.size !== 1) return 'stale';
      built.push([...sel]);
    }
    answers = built;
  }

  settle(args.askId, {
    kind: 'answered',
    answers,
    by: args.by,
    comment: null,
    timedOut: false,
  });
  return 'accepted';
}

/** Resolve attempt from a card-button click. Returns one of the §10 outcomes;
 *  caller (card click handler) maps to user-facing toast.
 *
 *  v0.1.8 起退化为单问单选的便捷封装：等价于
 *  `submitAsk({..., selections:[[selected]]})`.
 *  使 `botmux ask buttons` 与其已有测试零回归。
 *
 *  All four "no-op" outcomes (`unauthorized`/`stale`/`already_settled`) leave
 *  the broker state unchanged so the original CLI Promise keeps waiting for
 *  the real winner or the deadline. */
export function tryResolveAsk(args: {
  askId: string;
  nonce: string;
  selected: string;
  by: string;
}): AskClickOutcome {
  return submitAsk({
    askId: args.askId,
    nonce: args.nonce,
    by: args.by,
    selections: [[args.selected]],
  });
}

/** Invalidate every pending ask. Intended for daemon shutdown / restart paths
 *  so CLI subprocesses unblock with `kind:'invalidated'` instead of waiting
 *  forever on a dead daemon. Returns the number of asks actually settled
 *  (settled-but-retained entries from the race window are skipped). */
export function invalidateAll(reason: string): number {
  const ids = [...pending.entries()]
    .filter(([, ask]) => !ask.settled)
    .map(([id]) => id);
  for (const id of ids) {
    settle(id, {
      kind: 'invalidated',
      reason,
      selected: null,
      by: null,
      comment: null,
      timedOut: false,
    });
  }
  if (ids.length > 0) {
    logger.info?.(`ask-broker: invalidated ${ids.length} pending ask(s): ${reason}`);
  }
  return ids.length;
}

/** Internal — settle an ask exactly once and notify the dispatcher's onSettle
 *  hook (best-effort, never blocks broker state transitions). The settled
 *  entry stays in the map for `SETTLED_RETENTION_MS` so late race-losers get
 *  a precise `already_settled` outcome; `gcSettled` reaps it afterward. */
function settle(askId: string, result: AskResult): void {
  const ask = pending.get(askId);
  if (!ask || ask.settled) return;
  ask.settled = true;
  ask.settledAt = Date.now();
  clearTimeout(ask.timeoutHandle);
  // Reap older settled entries opportunistically — keeps the map bounded
  // without paying for a dedicated GC timer.
  gcSettled();

  try {
    ask.resolve(result);
  } catch (err) {
    logger.warn?.(
      `ask-broker: ${askId} resolve threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (dispatcher?.onSettle) {
    try {
      void Promise.resolve(dispatcher.onSettle(snapshot(ask), result)).catch((err) => {
        logger.warn?.(
          `ask-broker: ${askId} onSettle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      logger.warn?.(
        `ask-broker: ${askId} onSettle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Strip broker-internal fields before handing a snapshot to the IM-side
 *  dispatcher. Keeps the dispatcher contract narrow. */
function snapshot(ask: InternalPending): PendingAsk {
  const { resolve: _r, timeoutHandle: _t, settledAt: _sat, selections: _sel, ...rest } = ask;
  return {
    ...rest,
    selections: ask.questions.map((_, i) => [...(ask.selections.get(i) ?? new Set<string>())]),
  };
}

/** Drop settled entries that have aged past the retention window. Cheap O(n)
 *  walk — n is tiny in practice (≤ a few dozen pending+recent asks). */
function gcSettled(): void {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  for (const [id, ask] of pending) {
    if (ask.settled && ask.settledAt !== undefined && ask.settledAt < cutoff) {
      pending.delete(id);
    }
  }
}

// ---- diagnostics for tests ---------------------------------------------------

/** Count of asks still awaiting a click / timeout — excludes settled entries
 *  retained within the race-loser feedback window. For tests and metrics only. */
export function _pendingCount(): number {
  let n = 0;
  for (const ask of pending.values()) if (!ask.settled) n++;
  return n;
}

/** Read a pending ask by id. Returns a snapshot; mutating it has no effect on
 *  broker state. Used by the card handler to PATCH toggle state. */
export function getAskSnapshot(askId: string): PendingAsk | undefined {
  const a = pending.get(askId);
  return a ? snapshot(a) : undefined;
}

/** Read a pending ask by id — for tests only. Returns a snapshot; mutating it
 *  has no effect on broker state. */
export function _getPending(askId: string): PendingAsk | undefined {
  return getAskSnapshot(askId);
}

/** 返回当前 pending map 中所有 askId 列表（含 settled 但仍在 retention 内的条目）。
 *  仅供测试使用。 */
export function _allAskIds(): string[] {
  return [...pending.keys()];
}

/** Reset broker state — for tests only. Does NOT resolve outstanding promises,
 *  so tests must not call this while real CLI processes might be waiting. */
export function _resetForTest(): void {
  for (const ask of pending.values()) clearTimeout(ask.timeoutHandle);
  pending.clear();
  dispatcher = null;
}
