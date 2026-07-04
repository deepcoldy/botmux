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

/** IM-side canTalk predicate, wired by the daemon at bootstrap. Lets the broker
 *  honour the bot's canTalk gate without importing Lark types: whoever may
 *  address the bot in this chat may answer its `botmux ask`. Returns false until
 *  wired, so an unwired broker authorizes no one (daemon always wires it). */
let canTalkChecker: ((larkAppId: string, chatId: string, openId: string) => boolean) | null = null;

/** Wire the canTalk predicate. Called once during daemon bootstrap. */
export function setCanTalkChecker(
  fn: (larkAppId: string, chatId: string, openId: string) => boolean,
): void {
  canTalkChecker = fn;
}

/** A click is authorized iff the clicker may `canTalk` to the bot in this chat.
 *  `botmux ask` is a talk-level interaction (answering the agent's question),
 *  so it follows the canTalk gate — not the stricter canOperate / allowedUsers. */
function isAuthorizedToAnswer(ask: InternalPending, by: string): boolean {
  return canTalkChecker?.(ask.larkAppId, ask.chatId, by) ?? false;
}

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
  if (!isAuthorizedToAnswer(ask, args.by)) return 'unauthorized';

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
  if (!isAuthorizedToAnswer(ask, args.by)) return 'unauthorized';

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

/**
 * 提交一段自定义回复（用户在话题里直接打字作答，替代点按钮）并 settle。
 *
 * 校验：askId 存在 / 未 settle / `by` 可 canTalk / text trim 后非空。
 * settle 为 `kind:'answered'`，各问 `answers` 为空数组、`comment` 携带 trim 后原文
 * （替代语义：没有任何选项被选中，CLI 侧 formatAnswer 用 comment 回落作答）。
 *
 * 不需要 nonce：调用方（daemon 消息路由）用 `findPendingAskByAnchor` 从在线
 * pending 表按话题 anchor 查到 askId，本身就排除了「重启后的陈旧卡片」场景。
 *
 * 成功返回 `'accepted'`；非法返回对应 AskClickOutcome。
 */
export function submitCustomReply(args: {
  askId: string;
  by: string;
  text: string;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!isAuthorizedToAnswer(ask, args.by)) return 'unauthorized';
  const text = args.text.trim();
  if (!text) return 'stale';

  settle(args.askId, {
    kind: 'answered',
    answers: ask.questions.map(() => []),
    by: args.by,
    comment: text,
    timedOut: false,
  });
  return 'accepted';
}

/**
 * 按话题 anchor 查找一个**未 settle**的 pending ask，供 daemon 判断「这条文字回复
 * 是不是在回答某个 ask」。匹配条件：
 *   - larkAppId 相同（不跨 bot 命中）
 *   - chatId 相同
 *   - thread-scope：ask.rootMessageId === anchor（话题根 message_id）
 *   - chat-scope：ask.rootMessageId === null（anchor 实为 chatId，已由 chatId 命中）
 *
 * 命中多个时返回最先注册的（实践中同一 anchor 同时最多一个 pending ask，因为发起
 * ask 的 CLI 此刻正阻塞等待结果）。返回 snapshot，改它不影响 broker 状态。
 */
export function findPendingAskByAnchor(args: {
  larkAppId: string;
  chatId: string;
  anchor: string;
}): PendingAsk | undefined {
  for (const ask of pending.values()) {
    if (ask.settled) continue;
    if (ask.larkAppId !== args.larkAppId) continue;
    if (ask.chatId !== args.chatId) continue;
    const matches =
      ask.rootMessageId === null ? true : ask.rootMessageId === args.anchor;
    if (matches) return snapshot(ask);
  }
  return undefined;
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
  canTalkChecker = null;
}
