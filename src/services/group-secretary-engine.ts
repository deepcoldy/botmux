/**
 * 群秘书判定引擎（纯逻辑，无 I/O，时钟可注入）。
 *
 * 输入两路：
 *   1. observeMessage —— 秘书 bot 收到的每条群消息（含没 @ 它的、其它 bot 发的）；
 *   2. observeSessions —— 定期从本机所有 daemon 拉到的会话投影（botmux observe 同源）。
 * 输出：takeDigests —— 按群聚合、防抖、限流后的待处理事件，交给 runtime 渲染成
 * 一个静默回合送进秘书会话，由模型决定是否催办 / 派活。
 *
 * 规则层只做「便宜、确定」的筛选，所有「这算不算没做完 / 这是不是任务」的判断留给模型：
 *   - turn_ended：会话从工作态回到空闲 —— 可能做完了，也可能做了一半就停（模型读回复判断）；
 *   - stuck：会话进入 stalled / interrupted / limited；
 *   - attention：会话新举手（blocked 等，带 daemon 给出的原因）；
 *   - stopped：上次还在工作，这次 worker 已不在（not_running / closed）；
 *   - unaddressed_task：真人在群顶层发了一条没 @ 任何人的消息，宽限期内也没有 bot 接话。
 *
 * 防失控：
 *   - 秘书自己的 chat 级会话（摘要投递的落点）不纳入观察，免得自己触发自己；
 *   - 第一次见到的会话只记基线，不发事件（daemon 重启 / 刚开启时不会把全群历史状态刷一遍）；
 *   - 每个会话每小时最多产出 perSessionEventsPerHour 个事件，催办—再停—再催的循环被硬性截断；
 *   - 每个群两次投递至少间隔 minFlushIntervalMs，事件静默 debounceMs 后才投递（攒成一批）。
 */

export type SecretarySenderType = 'user' | 'bot';

export interface SecretaryMessage {
  chatId: string;
  messageId: string;
  /** 话题内消息的根；顶层消息为空。 */
  rootId?: string;
  parentId?: string;
  senderType: SecretarySenderType;
  senderOpenId?: string;
  senderName?: string;
  text: string;
  /** 消息里 @ 了几个对象（含 @所有人）。 */
  mentionCount: number;
  /** 是否 @ 了秘书 bot 自己（这类消息走正常对话链路，不当作「无人认领」）。 */
  mentionsSelf: boolean;
  /** 是否秘书 bot 自己发的。 */
  fromSelf: boolean;
  /** epoch ms */
  createTime: number;
}

export type SecretaryLiveness = 'alive' | 'not_running' | 'closed' | 'unknown';

export interface SecretarySessionView {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  chatId?: string;
  scope?: 'thread' | 'chat';
  rootMessageId?: string;
  liveness: SecretaryLiveness;
  turn: string;
  attention?: { kind: string; reason: string; at: number };
  lastActivityAt?: number;
}

export type SecretaryEventKind =
  | 'new_messages'
  | 'check_in'
  | 'turn_ended'
  | 'stuck'
  | 'attention'
  | 'stopped'
  | 'unaddressed_task'
  /** 话题巡查写进台账、要让 leader 在主群知道的事（只进主群总管回合）。 */
  | 'escalation';

/** 秘书主动要求盯的话题（botmux secretary watch 写入），到点生成 check_in。 */
export interface SecretaryManualWatch {
  chatId: string;
  threadRoot: string;
  everyMs: number;
  note?: string;
  createdAt: number;
  /** 到期不再回访（缺省由登记方给 24 小时）。 */
  expiresAt?: number;
}

export interface SecretaryEvent {
  kind: SecretaryEventKind;
  at: number;
  session?: SecretarySessionView;
  /** stuck 时的 turn、attention 时的原因等。 */
  detail?: string;
  message?: SecretaryMessage;
  /**
   * 秘书自己在该会话话题里、最近一条真人消息之后已经发过几条（催办 / 传话）。由引擎按群消息
   * 数出来，不靠模型记忆，会话轮换、压缩都不丢；达到上限时模型只能改为请示真人。
   */
  ownMessagesSinceHuman?: number;
  /** 投递前由 runtime 补上的会话最近对话（本机 daemon insight，已脱敏）；拿不到就缺省。 */
  transcript?: Array<{ role: string; text: string }>;
  /** new_messages：本批新消息（按时间升序）。 */
  messages?: SecretaryMessage[];
  /** check_in：已经干了多久、第几次回访、是否秘书手动要求盯的。 */
  elapsedMs?: number;
  checkNo?: number;
  manualNote?: string;
  /** check_in：自上次回访以来会话对话有没有变化（runtime 比对 transcript 得出）。 */
  progressed?: boolean;
  /** 手动盯的话题根（check_in 找不到会话时也能定位到话题）。 */
  threadRoot?: string;
  /** escalation：哪个话题、上报了什么。 */
  escalation?: { threadRoot: string; text: string; at: number; status?: string; summary?: string; botName?: string };
}

/** 摘要的落点：主群总管回合，或某个话题的巡查回合。缺省 = 旧版单会话（不拆分）。 */
export type SecretaryDigestTarget = { kind: 'main' } | { kind: 'patrol'; threadRoot: string };

export interface SecretaryDigest {
  chatId: string;
  target?: SecretaryDigestTarget;
  /** 已投递失败的次数（requeue 时累加）。 */
  attempts?: number;
  events: SecretaryEvent[];
  /** 与事件相关的近期消息（按时间升序），供模型判断上下文；包含事件之后的新消息。 */
  context: SecretaryMessage[];
  /** 本机各 bot 在本群的在跑 / 近期会话（传话、催办要发进对方所在的话题）。 */
  activeSessions?: SecretarySessionView[];
  /** 秘书自己最近在本群发过的消息（避免重复请示 / 重复催）。 */
  ownRecent?: SecretaryMessage[];
}

export interface GroupSecretaryEngineOptions {
  selfAppId: string;
  isEnabledChat: (chatId: string) => boolean;
  now?: () => number;
  /** 最后一个事件之后静默多久才投递。 */
  debounceMs?: number;
  /** 同一个群两次投递的最小间隔。 */
  minFlushIntervalMs?: number;
  /** 无人认领的消息等多久（期间有 bot 接话就作废）。 */
  unaddressedGraceMs?: number;
  /** 每个会话每小时最多产出多少个事件。 */
  perSessionEventsPerHour?: number;
  /** 每个群保留多少条近期消息做上下文。 */
  contextMessagesPerChat?: number;
  /** 每个事件最多附带多少条相关消息。 */
  contextPerEvent?: number;
  /** 发送方是否有权让秘书替他办事（canTalk）。无权者的消息只当上下文，不成为任务候选。 */
  isTrustedHuman?: (chatId: string, senderOpenId: string | undefined) => boolean;
  /** 投递失败最多重试几次，超过就丢弃这批事件。 */
  maxDeliveryAttempts?: number;
  /** 每个群积压事件上限（超出丢最旧的），防止投递持续失败时 prompt 无限变长。 */
  maxPendingPerChat?: number;
  /** 会话事件超过这个年龄就视为过期丢弃（如网关故障期间攒下、恢复后才投递的事件）。 */
  staleEventMs?: number;
  /** 一批新消息最长等多久就必须投递（消息持续不断时也不会一直攒）。 */
  maxBatchWaitMs?: number;
  /**
   * 秘书会话是否正在处理上一批；忙时继续攒，最长攒 maxBusyHoldMs。
   * 拆分模式下 threadRoot 有值 = 问该话题的巡查是否在跑（或巡查名额已满）。
   */
  isSecretaryBusy?: (chatId: string, threadRoot?: string) => boolean;
  maxBusyHoldMs?: number;
  /** 在跑会话的回访间隔（逐次拉长，最后一档循环使用）。 */
  checkInIntervalsMs?: number[];
  /** 秘书手动要求盯的话题。 */
  manualWatches?: () => SecretaryManualWatch[];
  /**
   * 拆分模式（总管 + 话题巡查）：话题里的会话事件按 thread_root 各出一份巡查摘要，主群只收
   * 顶层消息、无人认领、上报；话题内的消息只当上下文，不再叫醒主群总管；秘书自己的所有会话
   * （包括巡查会话）都不观察，免得巡查自己触发自己。缺省 false = 旧版单会话行为。
   */
  splitPatrol?: boolean;
}

/**
 * 重启恢复补跑的一轮：会话进入工作态之前很久就没有任何新活动（没有新消息 / 输入），
 * 说明这轮是 daemon 恢复会话时自己补跑的，回到空闲不算「一轮任务结束」。
 * 拿不到活动时间时按真实一轮处理。
 */
const RECOVERY_SLACK_MS = 2 * 60_000;
function isRecoveryEpisode(prev: { workingSince?: number }, row: { lastActivityAt?: number }): boolean {
  if (prev.workingSince === undefined || row.lastActivityAt === undefined) return false;
  return row.lastActivityAt < prev.workingSince - RECOVERY_SLACK_MS;
}

/** 卡片状态、定时任务提示这类机器噪音：只进上下文，不叫醒秘书。 */
export function isSecretaryNoiseMessage(m: SecretaryMessage): boolean {
  if (m.senderType !== 'bot') return false;
  const t = m.text.trim();
  return t === '' || t === 'Working' || t === 'Completed' || t === 'Task failed'
    || t.startsWith('[卡片: 🖥️') || t.startsWith('🕐 定时任务') || t.startsWith('[卡片: ⚠️');
}

const WORKING_TURNS = new Set(['working', 'starting', 'analyzing']);
const STUCK_TURNS = new Set(['stalled', 'interrupted', 'limited']);
const HOUR_MS = 60 * 60_000;
/** 会话连续多少次不在快照里才遗忘（10s 一拍 ≈ 30s）。 */
const MISSING_GRACE = 3;

interface SessionMemo {
  liveness: SecretaryLiveness;
  turn: string;
  attentionAt?: number;
  /** 本次进入工作态的时间（用于判断这一轮有没有新的输入）。 */
  workingSince?: number;
}

interface WatchState {
  chatId: string;
  startedAt: number;
  nextCheckAt: number;
  checks: number;
}

interface ChatState {
  messages: SecretaryMessage[];
  /** 自上次投递以来的新消息（触发「感知」）。 */
  newMessages: SecretaryMessage[];
  /** 本批第一条待投递内容进来的时间（0 = 没有积压）。 */
  firstPendingAt: number;
  pending: SecretaryEvent[];
  unaddressed: Array<{ message: SecretaryMessage; dueAt: number }>;
  lastEventAt: number;
  lastFlushAt: number;
  /** 当前积压里最多已失败过几次。 */
  pendingAttempts: number;
}

export class GroupSecretaryEngine {
  private readonly opts: Required<Omit<GroupSecretaryEngineOptions, 'now'>> & { now: () => number };
  private readonly chats = new Map<string, ChatState>();
  private readonly sessions = new Map<string, SessionMemo>();
  private readonly sessionEventTimes = new Map<string, number[]>();
  /** 每个会话最近一次快照（投递前复核事件是否仍然成立、列出在跑会话）。 */
  private readonly latest = new Map<string, SecretarySessionView>();
  /** 会话连续缺席快照的次数。 */
  private readonly missing = new Map<string, number>();
  /** 引擎启动时间：手动盯的话题重启后从这里起算，不在启动瞬间集中回访。 */
  private readonly startedAt: number;
  /** 跟进清单：在跑会话 → 下次回访时间。 */
  private readonly watches = new Map<string, WatchState>();
  /** 手动盯的话题上次回访时间（key = chatId + threadRoot）。 */
  private readonly manualLastCheck = new Map<string, number>();

  constructor(options: GroupSecretaryEngineOptions) {
    this.opts = {
      now: options.now ?? Date.now,
      selfAppId: options.selfAppId,
      isEnabledChat: options.isEnabledChat,
      debounceMs: options.debounceMs ?? 5_000,
      minFlushIntervalMs: options.minFlushIntervalMs ?? 0,
      unaddressedGraceMs: options.unaddressedGraceMs ?? 20_000,
      perSessionEventsPerHour: options.perSessionEventsPerHour ?? 3,
      contextMessagesPerChat: options.contextMessagesPerChat ?? 200,
      contextPerEvent: options.contextPerEvent ?? 8,
      isTrustedHuman: options.isTrustedHuman ?? (() => true),
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? 3,
      maxPendingPerChat: options.maxPendingPerChat ?? 20,
      staleEventMs: options.staleEventMs ?? 10 * 60_000,
      maxBatchWaitMs: options.maxBatchWaitMs ?? 10_000,
      isSecretaryBusy: options.isSecretaryBusy ?? (() => false),
      maxBusyHoldMs: options.maxBusyHoldMs ?? 3 * 60_000,
      checkInIntervalsMs: options.checkInIntervalsMs ?? [5 * 60_000, 10 * 60_000, 20 * 60_000],
      manualWatches: options.manualWatches ?? (() => []),
      splitPatrol: options.splitPatrol ?? false,
    };
    this.startedAt = this.opts.now();
  }

  private chat(chatId: string): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { messages: [], newMessages: [], firstPendingAt: 0, pending: [], unaddressed: [], lastEventAt: 0, lastFlushAt: 0, pendingAttempts: 0 };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private pushEvent(chatId: string, event: SecretaryEvent): void {
    const state = this.chat(chatId);
    state.pending.push(event);
    this.trimPending(state);
    state.lastEventAt = this.opts.now();
    if (!state.firstPendingAt) state.firstPendingAt = state.lastEventAt;
  }

  private trimPending(state: ChatState): void {
    if (state.pending.length > this.opts.maxPendingPerChat) {
      state.pending.splice(0, state.pending.length - this.opts.maxPendingPerChat);
    }
  }

  /**
   * @param options.backfill 启动补拉的历史消息：只进上下文，不成为「无人认领」候选，也不撤销候选。
   */
  observeMessage(message: SecretaryMessage, options: { backfill?: boolean } = {}): void {
    if (!this.opts.isEnabledChat(message.chatId)) return;
    const state = this.chat(message.chatId);
    if (state.messages.some(m => m.messageId === message.messageId)) return;
    state.messages.push(message);
    if (options.backfill) {
      state.messages.sort((a, b) => a.createTime - b.createTime);
      if (state.messages.length > this.opts.contextMessagesPerChat) {
        state.messages.splice(0, state.messages.length - this.opts.contextMessagesPerChat);
      }
      return;
    }
    if (state.messages.length > this.opts.contextMessagesPerChat) {
      state.messages.splice(0, state.messages.length - this.opts.contextMessagesPerChat);
    }
    const now = this.opts.now();
    // 有 bot（含秘书自己）在某条消息下接了话：那条就不算无人认领，转回普通批次（排在回复之前）。
    if (message.senderType === 'bot' || message.fromSelf) {
      const repliedTo = new Set([message.rootId, message.parentId].filter(Boolean));
      if (repliedTo.size > 0) {
        const claimed = state.unaddressed.filter(u => repliedTo.has(u.message.messageId));
        if (claimed.length > 0) {
          state.unaddressed = state.unaddressed.filter(u => !repliedTo.has(u.message.messageId));
          for (const u of claimed) this.perceive(state, u.message, now);
        }
      }
      this.perceive(state, message, now);
      return;
    }
    // 候选分流：无人认领的候选不进普通批次，只在宽限到期仍没人接时以 unaddressed_task 叫醒。
    // 否则 5 秒 debounce 会先把它随 new_messages 投出去——秘书在宽限期内就看到它（可能抢先出声），
    // 而投递后候选被划掉，到期不再唤醒（选择静默观望的那一轮就成了漏响应）。
    if (this.isUnaddressedCandidate(message, now)) {
      state.unaddressed.push({ message, dueAt: Math.max(now, message.createTime + this.opts.unaddressedGraceMs) });
      return;
    }
    this.perceive(state, message, now);
  }

  /** 感知：除了秘书自己发的、@ 秘书的（走普通对话回合，否则同一条会被处理两次）和机器噪音，都进本批。 */
  private perceive(state: ChatState, message: SecretaryMessage, now: number): void {
    if (message.fromSelf || message.mentionsSelf || isSecretaryNoiseMessage(message)) return;
    // 拆分模式：话题里的消息归该话题的巡查（作为上下文），不叫醒主群总管。
    if (this.opts.splitPatrol && message.rootId) return;
    state.newMessages.push(message);
    if (state.newMessages.length > this.opts.contextMessagesPerChat) state.newMessages.shift();
    state.lastEventAt = now;
    if (!state.firstPendingAt) state.firstPendingAt = now;
  }

  private isUnaddressedCandidate(message: SecretaryMessage, now: number): boolean {
    if (message.mentionsSelf || message.rootId || message.mentionCount > 0) return false;
    if (message.text.trim().length < 2) return false;
    // 重放 / 补拉到的旧消息不当新任务：宽限期按消息自身时间算，早已过期的直接忽略。
    if (now - message.createTime > this.opts.unaddressedGraceMs + 60_000) return false;
    // 没有对话权限的人发的消息只当上下文：秘书回合以开启人身份运行，不能替任意群成员派活。
    return this.opts.isTrustedHuman(message.chatId, message.senderOpenId);
  }

  /** 传入本次拉到的全部会话（可含其它群、已关闭的）；未出现在快照里的会话会被遗忘。 */
  observeSessions(rows: SecretarySessionView[]): void {
    const now = this.opts.now();
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.chatId || !this.opts.isEnabledChat(row.chatId)) continue;
      // 摘要落点（秘书自己的群级会话）不观察，避免自激；拆分模式下巡查会话也是秘书自己的，一并跳过。
      if (row.larkAppId === this.opts.selfAppId && (row.scope === 'chat' || this.opts.splitPatrol)) continue;
      seen.add(row.sessionId);
      this.latest.set(row.sessionId, row);
      const prev = this.sessions.get(row.sessionId);
      this.trackWatch(row, prev, now);
      const workingNow = row.liveness === 'alive' && (row.turn === 'working' || row.turn === 'analyzing');
      const prevWorking = !!prev && prev.liveness === 'alive' && (prev.turn === 'working' || prev.turn === 'analyzing');
      const workingSince = workingNow ? (prevWorking && prev!.workingSince !== undefined ? prev!.workingSince : now) : undefined;
      this.sessions.set(row.sessionId, {
        liveness: row.liveness,
        turn: row.turn,
        attentionAt: row.attention?.at,
        ...(workingSince !== undefined ? { workingSince } : {}),
      });
      if (!prev) continue;
      const events: SecretaryEvent[] = [];
      // 只认真正在干活（working / analyzing）。'starting' 是 CLI 启动 / 重启恢复，
      // 重启后一批恢复的会话 starting→idle 不是「一轮做完」，不能当 turn_ended。
      const wasWorking = prev.liveness === 'alive' && (prev.turn === 'working' || prev.turn === 'analyzing');
      if (row.attention && row.attention.at !== prev.attentionAt) {
        events.push({ kind: 'attention', at: now, session: row, detail: `${row.attention.kind}: ${row.attention.reason}` });
      } else if (STUCK_TURNS.has(row.turn) && row.turn !== prev.turn) {
        events.push({ kind: 'stuck', at: now, session: row, detail: row.turn });
      } else if (wasWorking && (row.liveness === 'not_running' || row.liveness === 'closed')) {
        events.push({ kind: 'stopped', at: now, session: row, detail: row.liveness });
      } else if (wasWorking && row.liveness === 'alive' && row.turn === 'idle' && !isRecoveryEpisode(prev, row)) {
        events.push({ kind: 'turn_ended', at: now, session: row });
      }
      for (const event of events) {
        if (!this.admitSessionEvent(row.sessionId, now)) continue;
        this.pushEvent(row.chatId, event);
      }
    }
    this.dueManualWatches(now);
    // 快照里暂时缺席的会话（对端超时、探测失败）先保留记忆，连续缺席 MISSING_GRACE 次才遗忘：
    // 一次抖动不能丢掉「工作中」的基线（否则 turn_ended 丢失、回访计时被重置）。
    for (const id of [...this.sessions.keys()]) {
      if (seen.has(id)) { this.missing.delete(id); continue; }
      const n = (this.missing.get(id) ?? 0) + 1;
      if (n < MISSING_GRACE) { this.missing.set(id, n); continue; }
      this.missing.delete(id);
      this.sessions.delete(id);
      this.latest.delete(id);
      this.watches.delete(id);
    }
    // 限流计数与会话记忆分开过期：会话因探测失败暂时从快照里消失时，计数不能被清零，
    // 否则「催 → 停 → 再催」的循环会绕过每小时上限。
    for (const [id, times] of [...this.sessionEventTimes]) {
      const live = times.filter(t => now - t < HOUR_MS);
      if (live.length === 0) this.sessionEventTimes.delete(id);
      else this.sessionEventTimes.set(id, live);
    }
  }

  /**
   * 跟进清单：会话开工（或第一次看到时已在工作）就加入；在跑期间按间隔生成 check_in，
   * 间隔逐次拉长；停下 / 消失就移出（停下由 turn_ended 做收尾检查）。
   * check_in 是我们自己排的回访，不受每小时事件上限约束。
   */
  private trackWatch(row: SecretarySessionView, prev: SessionMemo | undefined, now: number): void {
    const working = row.liveness === 'alive' && (row.turn === 'working' || row.turn === 'analyzing');
    const existing = this.watches.get(row.sessionId);
    if (!working) {
      if (existing) this.watches.delete(row.sessionId);
      return;
    }
    const intervals = this.opts.checkInIntervalsMs;
    if (!existing) {
      this.watches.set(row.sessionId, { chatId: row.chatId!, startedAt: now, nextCheckAt: now + intervals[0]!, checks: 0 });
      return;
    }
    if (!prev || now < existing.nextCheckAt) return;
    existing.checks++;
    existing.nextCheckAt = now + intervals[Math.min(existing.checks, intervals.length - 1)]!;
    this.pushEvent(row.chatId!, {
      kind: 'check_in', at: now, session: row, elapsedMs: now - existing.startedAt, checkNo: existing.checks,
    });
  }

  private dueManualWatches(now: number): void {
    for (const w of this.opts.manualWatches()) {
      if (!this.opts.isEnabledChat(w.chatId)) continue;
      const key = `${w.chatId}\u0000${w.threadRoot}`;
      if (w.expiresAt !== undefined && now >= w.expiresAt) continue;
      const last = this.manualLastCheck.get(key) ?? Math.max(w.createdAt, this.startedAt);
      if (now - last < w.everyMs) continue;
      this.manualLastCheck.set(key, now);
      const session = [...this.latest.values()]
        .filter(v => v.chatId === w.chatId && v.rootMessageId === w.threadRoot)
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
      this.pushEvent(w.chatId, {
        kind: 'check_in', at: now, elapsedMs: now - w.createdAt, manualNote: w.note ?? `秘书在盯的话题 ${w.threadRoot}`,
        threadRoot: w.threadRoot,
        ...(session ? { session } : {}),
        ...(!session ? { detail: `thread_root=${w.threadRoot}（本机没有找到对应会话）` } : {}),
      });
    }
  }

  private admitSessionEvent(sessionId: string, now: number): boolean {
    const times = (this.sessionEventTimes.get(sessionId) ?? []).filter(t => now - t < HOUR_MS);
    if (times.length >= this.opts.perSessionEventsPerHour) {
      this.sessionEventTimes.set(sessionId, times);
      return false;
    }
    times.push(now);
    this.sessionEventTimes.set(sessionId, times);
    return true;
  }

  /** 关闭某个群时清掉它的全部状态。 */
  forgetChat(chatId: string): void {
    this.chats.delete(chatId);
  }

  takeDigests(): SecretaryDigest[] {
    const now = this.opts.now();
    const out: SecretaryDigest[] = [];
    for (const [chatId, state] of this.chats) {
      if (!this.opts.isEnabledChat(chatId)) {
        this.chats.delete(chatId);
        continue;
      }
      const due = state.unaddressed.filter(u => u.dueAt <= now);
      if (due.length > 0) {
        state.unaddressed = state.unaddressed.filter(u => u.dueAt > now);
        for (const u of due) {
          state.pending.push({ kind: 'unaddressed_task', at: u.dueAt, message: u.message });
        }
        state.lastEventAt = Math.max(state.lastEventAt, ...due.map(u => u.dueAt));
      }
      // 投递前复核：过期的、会话状态已经变了的事件直接丢弃（网关故障期间攒下的事件恢复后
      // 不会原样重放，避免去催一个早就做完、或者已经重新开工的任务）。
      if (state.pending.length > 0) state.pending = state.pending.filter(e => this.stillValid(e, now));
      if (state.pending.length === 0 && state.newMessages.length === 0) {
        state.firstPendingAt = 0;
        continue;
      }
      const waited = now - (state.firstPendingAt || now);
      // 攒批：安静 debounceMs 后投递；消息一直不断时，最长等 maxBatchWaitMs 也要投。
      if (now - state.lastEventAt < this.opts.debounceMs && waited < this.opts.maxBatchWaitMs) continue;
      if (now - state.lastFlushAt < this.opts.minFlushIntervalMs) continue;
      if (this.opts.splitPatrol) {
        this.takeSplit(chatId, state, now, waited, out);
        continue;
      }
      // 秘书还在处理上一批：继续攒（最长 maxBusyHoldMs，之后照投，交给 CLI 排队）。
      if (this.opts.isSecretaryBusy(chatId) && waited < this.opts.maxBusyHoldMs) continue;
      const events = state.pending;
      if (state.newMessages.length > 0) {
        events.unshift({ kind: 'new_messages', at: now, messages: state.newMessages });
      }
      const attempts = state.pendingAttempts;
      state.pending = [];
      state.newMessages = [];
      state.firstPendingAt = 0;
      state.pendingAttempts = 0;
      state.lastFlushAt = now;
      for (const event of events) {
        const root = event.session?.scope === 'thread' ? event.session.rootMessageId : undefined;
        if (root) event.ownMessagesSinceHuman = this.ownMessagesSinceHuman(state, root);
      }
      const activeSessions = this.activeSessionsFor(chatId, now);
      const ownRecent = state.messages.filter(m => m.fromSelf).slice(-6);
      out.push({
        chatId,
        events,
        context: this.contextFor(state, events),
        ...(activeSessions.length ? { activeSessions } : {}),
        ...(ownRecent.length ? { ownRecent } : {}),
        ...(attempts ? { attempts } : {}),
      });
    }
    return out;
  }

  private activeSessionsFor(chatId: string, now: number, threadRoot?: string): SecretarySessionView[] {
    return [...this.latest.values()]
      .filter(v => v.chatId === chatId
        && (threadRoot === undefined || v.rootMessageId === threadRoot)
        && (v.liveness === 'alive' || (v.lastActivityAt !== undefined && now - v.lastActivityAt < 24 * HOUR_MS)))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, 15);
  }

  /** 事件归哪个话题巡查；undefined = 主群总管。 */
  static patrolRootOf(event: SecretaryEvent): string | undefined {
    if (event.kind === 'new_messages' || event.kind === 'unaddressed_task' || event.kind === 'escalation') return undefined;
    if (event.session?.scope === 'thread' && event.session.rootMessageId) return event.session.rootMessageId;
    return event.threadRoot;
  }

  /**
   * 拆分模式出摘要：主群一份（顶层新消息、无人认领、上报、chat 级会话事件），每个有事的话题一份。
   * 各落点独立判忙：某个话题的巡查还在跑，只压住那个话题的事件，不挡主群和别的话题。
   */
  private takeSplit(chatId: string, state: ChatState, now: number, waited: number, out: SecretaryDigest[]): void {
    const groups = new Map<string | undefined, SecretaryEvent[]>();
    for (const e of state.pending) {
      const root = GroupSecretaryEngine.patrolRootOf(e);
      const list = groups.get(root) ?? [];
      list.push(e);
      groups.set(root, list);
    }
    if (state.newMessages.length > 0 && !groups.has(undefined)) groups.set(undefined, []);
    const attempts = state.pendingAttempts;
    const keep: SecretaryEvent[] = [];
    let flushed = false;
    for (const [root, events] of groups) {
      // 主群总管忙：最长攒 maxBusyHoldMs 后照投（交给 CLI 排队）。巡查忙或名额满：一直压着，
      // 过期的会话事件由投递前复核丢弃——巡查宁可晚，不能超并发把机器内存打满。
      const busy = this.opts.isSecretaryBusy(chatId, root);
      if (busy && (root !== undefined || waited < this.opts.maxBusyHoldMs)) {
        keep.push(...events);
        continue;
      }
      flushed = true;
      if (root === undefined) {
        if (state.newMessages.length > 0) {
          events.unshift({ kind: 'new_messages', at: now, messages: state.newMessages });
          state.newMessages = [];
        }
        const activeSessions = this.activeSessionsFor(chatId, now);
        const ownRecent = state.messages.filter(m => m.fromSelf && !m.rootId).slice(-6);
        out.push({
          chatId,
          target: { kind: 'main' },
          events,
          context: this.contextFor(state, events),
          ...(activeSessions.length ? { activeSessions } : {}),
          ...(ownRecent.length ? { ownRecent } : {}),
          ...(attempts ? { attempts } : {}),
        });
        continue;
      }
      const own = this.ownMessagesSinceHuman(state, root);
      for (const e of events) e.ownMessagesSinceHuman = own;
      const activeSessions = this.activeSessionsFor(chatId, now, root);
      const ownRecent = state.messages.filter(m => m.fromSelf && (m.rootId === root || m.messageId === root)).slice(-6);
      const threadMessages = state.messages.filter(m => m.messageId === root || m.rootId === root);
      out.push({
        chatId,
        target: { kind: 'patrol', threadRoot: root },
        events,
        // 巡查只看这一个话题：话题里的消息多带一些（不按每事件上限截），主群顶层一条都不带。
        context: threadMessages.slice(-Math.max(this.opts.contextPerEvent * 2, 16)),
        ...(activeSessions.length ? { activeSessions } : {}),
        ...(ownRecent.length ? { ownRecent } : {}),
        ...(attempts ? { attempts } : {}),
      });
    }
    state.pending = keep;
    if (flushed) state.lastFlushAt = now;
    if (keep.length === 0 && state.newMessages.length === 0) {
      state.firstPendingAt = 0;
      state.pendingAttempts = 0;
    }
  }

  /** 话题巡查写了待上报（runtime 从台账读到）：作为主群总管的一个事件。同一次上报由 runtime 去重。 */
  noteEscalation(chatId: string, escalation: NonNullable<SecretaryEvent['escalation']>): void {
    if (!this.opts.isEnabledChat(chatId)) return;
    this.pushEvent(chatId, { kind: 'escalation', at: this.opts.now(), escalation });
  }

  /**
   * 投递失败时把事件放回去，下一拍重试（不重置限流计数）。超过重试上限返回 false 并丢弃，
   * 避免永久性失败（如秘书会话卡在选仓库）无限重试。
   */
  requeue(digest: SecretaryDigest): boolean {
    const attempts = (digest.attempts ?? 0) + 1;
    if (attempts >= this.opts.maxDeliveryAttempts) return false;
    if (!this.opts.isEnabledChat(digest.chatId)) return false;
    const state = this.chat(digest.chatId);
    for (const e of digest.events) {
      if (e.kind === 'new_messages') state.newMessages = [...(e.messages ?? []), ...state.newMessages];
      else state.pending.push(e);
    }
    this.trimPending(state);
    state.pendingAttempts = Math.max(state.pendingAttempts, attempts);
    if (!state.firstPendingAt) state.firstPendingAt = this.opts.now();
    return true;
  }

  /** 会话事件在投递时是否仍然成立。拿不到当前快照（探测失败）时只按年龄判断。 */
  private stillValid(event: SecretaryEvent, now: number): boolean {
    if (!event.session) return true;
    if (now - event.at > this.opts.staleEventMs) return false;
    const cur = this.latest.get(event.session.sessionId);
    if (!cur) return true;
    switch (event.kind) {
      case 'check_in':
        return !!event.manualNote || (cur.liveness === 'alive' && WORKING_TURNS.has(cur.turn));
      case 'turn_ended':
        return cur.liveness === 'alive' && cur.turn === 'idle';
      case 'stuck':
        return cur.turn === event.session.turn;
      case 'attention':
        return !!cur.attention && cur.attention.at === event.session.attention?.at;
      case 'stopped':
        return cur.liveness !== 'alive';
      default:
        return true;
    }
  }

  /** 话题里最近一条真人消息之后，秘书自己发了几条。 */
  private ownMessagesSinceHuman(state: ChatState, root: string): number {
    let count = 0;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.messageId !== root && m.rootId !== root) continue;
      if (m.fromSelf) count++;
      else if (m.senderType === 'user') break;
    }
    return count;
  }

  private contextFor(state: ChatState, events: SecretaryEvent[]): SecretaryMessage[] {
    const picked = new Map<string, SecretaryMessage>();
    const take = (list: SecretaryMessage[]) => {
      for (const m of list.slice(-this.opts.contextPerEvent)) picked.set(m.messageId, m);
    };
    for (const event of events) {
      if (event.message) {
        const idx = state.messages.findIndex(m => m.messageId === event.message!.messageId);
        const before = idx >= 0 ? state.messages.slice(0, idx + 1) : [event.message];
        take(before.filter(m => !m.rootId));
        continue;
      }
      const s = event.session;
      if (!s) continue;
      if (s.scope === 'thread' && s.rootMessageId) {
        const root = s.rootMessageId;
        take(state.messages.filter(m => m.messageId === root || m.rootId === root));
      } else {
        take(state.messages.filter(m => !m.rootId));
      }
    }
    return [...picked.values()].sort((a, b) => a.createTime - b.createTime);
  }
}
