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

export type SecretaryEventKind = 'turn_ended' | 'stuck' | 'attention' | 'stopped' | 'unaddressed_task';

export interface SecretaryEvent {
  kind: SecretaryEventKind;
  at: number;
  session?: SecretarySessionView;
  /** stuck 时的 turn、attention 时的原因等。 */
  detail?: string;
  message?: SecretaryMessage;
}

export interface SecretaryDigest {
  chatId: string;
  events: SecretaryEvent[];
  /** 与事件相关的近期消息（按时间升序），供模型判断上下文。 */
  context: SecretaryMessage[];
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
}

const WORKING_TURNS = new Set(['working', 'starting', 'analyzing']);
const STUCK_TURNS = new Set(['stalled', 'interrupted', 'limited']);
const HOUR_MS = 60 * 60_000;

interface SessionMemo {
  liveness: SecretaryLiveness;
  turn: string;
  attentionAt?: number;
}

interface ChatState {
  messages: SecretaryMessage[];
  pending: SecretaryEvent[];
  unaddressed: Array<{ message: SecretaryMessage; dueAt: number }>;
  lastEventAt: number;
  lastFlushAt: number;
}

export class GroupSecretaryEngine {
  private readonly opts: Required<Omit<GroupSecretaryEngineOptions, 'now'>> & { now: () => number };
  private readonly chats = new Map<string, ChatState>();
  private readonly sessions = new Map<string, SessionMemo>();
  private readonly sessionEventTimes = new Map<string, number[]>();

  constructor(options: GroupSecretaryEngineOptions) {
    this.opts = {
      now: options.now ?? Date.now,
      selfAppId: options.selfAppId,
      isEnabledChat: options.isEnabledChat,
      debounceMs: options.debounceMs ?? 5_000,
      minFlushIntervalMs: options.minFlushIntervalMs ?? 20_000,
      unaddressedGraceMs: options.unaddressedGraceMs ?? 20_000,
      perSessionEventsPerHour: options.perSessionEventsPerHour ?? 3,
      contextMessagesPerChat: options.contextMessagesPerChat ?? 60,
      contextPerEvent: options.contextPerEvent ?? 6,
    };
  }

  private chat(chatId: string): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { messages: [], pending: [], unaddressed: [], lastEventAt: 0, lastFlushAt: 0 };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private pushEvent(chatId: string, event: SecretaryEvent): void {
    const state = this.chat(chatId);
    state.pending.push(event);
    state.lastEventAt = this.opts.now();
  }

  observeMessage(message: SecretaryMessage): void {
    if (!this.opts.isEnabledChat(message.chatId)) return;
    const state = this.chat(message.chatId);
    if (state.messages.some(m => m.messageId === message.messageId)) return;
    state.messages.push(message);
    if (state.messages.length > this.opts.contextMessagesPerChat) {
      state.messages.splice(0, state.messages.length - this.opts.contextMessagesPerChat);
    }
    // 有 bot（含秘书自己）在某条消息下接了话：那条就不算无人认领。
    if (message.senderType === 'bot' || message.fromSelf) {
      const repliedTo = new Set([message.rootId, message.parentId].filter(Boolean));
      if (repliedTo.size > 0) {
        state.unaddressed = state.unaddressed.filter(u => !repliedTo.has(u.message.messageId));
      }
      return;
    }
    if (message.fromSelf || message.mentionsSelf) return;
    if (message.rootId) return;
    if (message.mentionCount > 0) return;
    if (message.text.trim().length < 2) return;
    state.unaddressed.push({ message, dueAt: this.opts.now() + this.opts.unaddressedGraceMs });
  }

  /** 传入本次拉到的全部会话（可含其它群、已关闭的）；未出现在快照里的会话会被遗忘。 */
  observeSessions(rows: SecretarySessionView[]): void {
    const now = this.opts.now();
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.chatId || !this.opts.isEnabledChat(row.chatId)) continue;
      // 摘要落点（秘书自己的群级会话）不观察，避免自激。
      if (row.larkAppId === this.opts.selfAppId && row.scope === 'chat') continue;
      seen.add(row.sessionId);
      const prev = this.sessions.get(row.sessionId);
      this.sessions.set(row.sessionId, {
        liveness: row.liveness,
        turn: row.turn,
        attentionAt: row.attention?.at,
      });
      if (!prev) continue;
      const events: SecretaryEvent[] = [];
      const wasWorking = prev.liveness === 'alive' && WORKING_TURNS.has(prev.turn);
      if (row.attention && row.attention.at !== prev.attentionAt) {
        events.push({ kind: 'attention', at: now, session: row, detail: `${row.attention.kind}: ${row.attention.reason}` });
      } else if (STUCK_TURNS.has(row.turn) && row.turn !== prev.turn) {
        events.push({ kind: 'stuck', at: now, session: row, detail: row.turn });
      } else if (wasWorking && (row.liveness === 'not_running' || row.liveness === 'closed')) {
        events.push({ kind: 'stopped', at: now, session: row, detail: row.liveness });
      } else if (wasWorking && row.liveness === 'alive' && row.turn === 'idle') {
        events.push({ kind: 'turn_ended', at: now, session: row });
      }
      for (const event of events) {
        if (!this.admitSessionEvent(row.sessionId, now)) continue;
        this.pushEvent(row.chatId, event);
      }
    }
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) {
        this.sessions.delete(id);
        this.sessionEventTimes.delete(id);
      }
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
      if (state.pending.length === 0) continue;
      if (now - state.lastEventAt < this.opts.debounceMs) continue;
      if (now - state.lastFlushAt < this.opts.minFlushIntervalMs) continue;
      const events = state.pending;
      state.pending = [];
      state.lastFlushAt = now;
      out.push({ chatId, events, context: this.contextFor(state, events) });
    }
    return out;
  }

  /** 投递失败时把事件放回去，下一拍重试（不重置限流计数）。 */
  requeue(digest: SecretaryDigest): void {
    const state = this.chat(digest.chatId);
    state.pending = [...digest.events, ...state.pending];
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
