/**
 * 群秘书运行时：把飞书消息事件、本机会话快照接到判定引擎上，按拍投递摘要。
 *
 * 一个 daemon 只服务一个 bot，所以这里是进程级单例：daemon 启动时 start，
 * event-dispatcher 每收到一条群消息调用 observeGroupSecretaryMessage（永不抛出）。
 * 没有任何群开启秘书时，定时器只做一次 Map 查询就返回，不拉会话快照。
 */
import { createHash } from 'node:crypto';
import { GroupSecretaryEngine, type SecretaryDigest, type SecretaryManualWatch, type SecretarySessionView } from './group-secretary-engine.js';
import { renderGroupSecretaryPrompt, renderMainSecretaryPrompt, renderPatrolPrompt } from './group-secretary-prompt.js';
import { getLedgerEntry, listLedger, markEscalationsDelivered, pendingEscalations, recordLedger, type LedgerStatus } from './group-secretary-ledger-store.js';
import { secretaryPatrolTurnId } from './send-policy.js';
import type { SecretaryEvent } from './group-secretary-engine.js';
import { getGroupSecretaryChat, getGroupSecretaryOwner, isGroupSecretaryChat, listGroupSecretaryChats, setGroupSecretaryChat, type GroupSecretaryChatEntry } from './group-secretary-store.js';
import { extractListenerMessageText, listenerSenderType } from './message-listener.js';
import type { ObserveSnapshot } from './session-observe.js';

export interface GroupSecretaryRuntimeDeps {
  larkAppId: string;
  /** bot 级总开关（默认关）：返回 false 时不旁听、不巡检，已登记的群保留。每拍重读，Dashboard 改完即生效。 */
  enabled: () => boolean;
  selfOpenId: () => string | undefined;
  fetchSnapshot: () => Promise<ObserveSnapshot>;
  deliver: (input: { chatId: string; turnId: string; prompt: string; ownerOpenId: string }) => Promise<unknown>;
  /**
   * 话题巡查：把一个静默回合投进秘书在该话题的 thread 会话（没有就新建）。提供了它就进入
   * 拆分模式（主群总管 + 话题巡查）；不提供 = 旧版单会话。created=true 表示会话是为这次巡查新建的。
   */
  deliverPatrol?: (input: { chatId: string; threadRoot: string; turnId: string; prompt: string; ownerOpenId: string }) => Promise<{ sessionId: string; created: boolean }>;
  /** 关掉一次性巡查会话（巡查回合结束后）。 */
  closePatrolSession?: (sessionId: string) => Promise<unknown>;
  /** 同时最多跑几个巡查会话（maxsvr 内存紧，默认 2）。 */
  maxConcurrentPatrols?: number;
  /** 巡查会话最长跟踪多久（超时视为结束，照常收尾）。 */
  patrolMaxMs?: number;
  /** 读 / 写群描述里的秘书标记（全群唯一登记）。不提供时只按本机登记判断。 */
  readMarker?: (chatId: string) => Promise<string | undefined>;
  /** appId 为 null 表示清除标记。 */
  /** `expect`：条件写，写前回读到的标记必须仍是这个值（null = 没有标记），否则不写，返回 marker_changed。 */
  writeMarker?: (chatId: string, appId: string | null, opts?: { expect?: string | null }) => Promise<{ ok: boolean; reason?: string; previous?: string }>;
  /** 读 / 写标记的单次超时（飞书接口挂住时不拖死整个秘书循环）。 */
  markerTimeoutMs?: number;
  markerRefreshMs?: number;
  /** 其它机器（federation 对端）上 bot 在这些群的会话；拿不到返回空数组。 */
  fetchRemoteViews?: (chatIds: string[]) => Promise<SecretarySessionView[]>;
  /** 该群是否开了 Context Sharing：开了就由它注入群消息增量，摘要里不再重复附带新消息。 */
  groupContextEnabled?: (chatId: string) => boolean;
  /** 秘书手动要求盯的话题（botmux secretary watch 写入的登记）。 */
  manualWatches?: () => SecretaryManualWatch[];
  /** 拉某群最近的消息（飞书 REST 形态，新→旧或旧→新均可），用于启动时补上下文。 */
  fetchRecentMessages?: (chatId: string) => Promise<any[]>;
  /** 读某会话最近几条对话（本机 daemon insight）；拿不到返回 undefined。 */
  fetchTranscript?: (larkAppId: string | undefined, sessionId: string, chatId: string) => Promise<Array<{ role: string; text: string }> | undefined>;
  log: (level: 'info' | 'warn', message: string) => void;
  /** 发送方在该群能否和本 bot 对话（canTalk）。 */
  canTalk: (chatId: string, senderOpenId: string | undefined) => boolean;
  now?: () => number;
  /** 单次投递超时；超时视为结果未知，不重投（避免重复回合）。 */
  deliverTimeoutMs?: number;
  tickMs?: number;
  sessionPollMs?: number;
}

export interface GroupSecretaryRuntime {
  observeMessageEvent(data: any): void;
  noteMarker(chatId: string, appId: string | undefined): void;
  /** 立即跑一拍（测试与开关切换后用）。 */
  tick(): Promise<void>;
  stop(): void;
  readonly engine: GroupSecretaryEngine;
}

export function snapshotToSessionViews(snapshot: ObserveSnapshot): SecretarySessionView[] {
  const out: SecretarySessionView[] = [];
  for (const daemon of snapshot.daemons) {
    if (daemon.probe.status !== 'ok') continue;
    for (const s of daemon.sessions) {
      if (s.probe.status !== 'ok') continue;
      out.push({
        sessionId: s.identity.sessionId,
        larkAppId: s.identity.larkAppId ?? daemon.larkAppId,
        botName: s.identity.botName,
        chatId: s.identity.chatId,
        scope: s.identity.scope,
        rootMessageId: s.identity.rootMessageId,
        liveness: s.liveness,
        turn: s.turn,
        ...(s.attention ? { attention: s.attention } : {}),
        ...(s.lastActivityAt !== undefined ? { lastActivityAt: s.lastActivityAt } : {}),
      });
    }
  }
  return out;
}

/** 新版卡片经 REST 拉回来只剩「请升级客户端」占位：明确告诉模型去 quoted 读全文，别当成空消息。 */
function readableText(text: string, messageId: string): string {
  if (/请升级至最新版本客户端|upgrade to the latest version/i.test(text)) {
    return `[卡片消息，正文需用 botmux quoted ${messageId} 查看]`;
  }
  return text;
}

/** 飞书 REST 消息（im/v1/messages 列表项）→ 事件形态，复用同一套解析。 */
export function restMessageToEventData(item: any, chatId: string): any {
  const sender = item?.sender ?? {};
  const senderId = typeof sender.id === 'string' ? sender.id : undefined;
  const idType = sender.id_type;
  return {
    sender: {
      sender_type: sender.sender_type,
      sender_id: idType === 'app_id' ? { app_id: senderId } : { open_id: senderId },
    },
    message: {
      chat_id: item?.chat_id ?? chatId,
      chat_type: 'group',
      message_id: item?.message_id,
      ...(item?.root_id ? { root_id: item.root_id } : {}),
      ...(item?.parent_id ? { parent_id: item.parent_id } : {}),
      create_time: item?.create_time,
      message_type: item?.msg_type,
      content: item?.body?.content,
      mentions: Array.isArray(item?.mentions)
        ? item.mentions.map((m: any) => ({ id: { open_id: typeof m?.id === 'string' ? m.id : m?.id?.open_id }, name: m?.name }))
        : [],
    },
  };
}

export function larkEventToSecretaryMessage(data: any, selfOpenId: string | undefined, selfAppId?: string) {
  const message = data?.message;
  if (!message || typeof message !== 'object') return undefined;
  if (message.chat_type === 'p2p') return undefined;
  const chatId = typeof message.chat_id === 'string' ? message.chat_id : '';
  const messageId = typeof message.message_id === 'string' ? message.message_id : '';
  if (!chatId || !messageId) return undefined;
  const senderOpenId: string | undefined = data?.sender?.sender_id?.open_id ?? undefined;
  const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];
  const createTime = Number(message.create_time);
  return {
    chatId,
    messageId,
    ...(typeof message.root_id === 'string' && message.root_id ? { rootId: message.root_id } : {}),
    ...(typeof message.parent_id === 'string' && message.parent_id ? { parentId: message.parent_id } : {}),
    senderType: listenerSenderType(data?.sender?.sender_type),
    ...(senderOpenId ? { senderOpenId } : {}),
    text: readableText(extractListenerMessageText(message), messageId),
    mentionCount: mentions.length,
    mentionsSelf: !!selfOpenId && mentions.some(m => m?.id?.open_id === selfOpenId),
    fromSelf: (!!selfOpenId && senderOpenId === selfOpenId)
      || (!!selfAppId && data?.sender?.sender_id?.app_id === selfAppId),
    createTime: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
  };
}

/**
 * 「没人 @ 的任务」的等待时间按 bot 错开（20–35 秒）。不同机器上的秘书互相锁不住，
 * 靠群消息协调：先到期的秘书引用原消息发建议，其它秘书收到这条 bot 回复（parent/root
 * 指向原消息）就放弃该候选。错开让「先到者」确定，避免同一秒一起出声。
 */
export function staggeredGraceMs(larkAppId: string): number {
  let h = 0;
  for (const ch of larkAppId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 20_000 + (h % 15_000);
}

/** 巡查没有写台账时，按触发事件兜底一行（让总管和下一次巡查至少知道发生过什么）。 */
function fallbackLedgerStatus(events: SecretaryEvent[]): LedgerStatus {
  const kinds = new Set(events.map(e => e.kind));
  if (kinds.has('attention')) return 'waiting_human';
  if (kinds.has('stuck') || kinds.has('stopped')) return 'stalled';
  if (kinds.has('turn_ended')) return 'idle';
  return 'working';
}

const PATROL_KIND_LABEL: Partial<Record<SecretaryEvent['kind'], string>> = {
  check_in: '回访', turn_ended: '一轮结束', stuck: '卡住', attention: '举手', stopped: '进程消失',
};

interface PatrolRun {
  chatId: string;
  threadRoot: string;
  startedAt: number;
  created: boolean;
  sawBusy: boolean;
  events: SecretaryEvent[];
  botName?: string;
}

export function createGroupSecretaryRuntime(deps: GroupSecretaryRuntimeDeps): GroupSecretaryRuntime {
  const now = deps.now ?? Date.now;
  const splitPatrol = !!deps.deliverPatrol;
  const maxConcurrentPatrols = Math.max(1, deps.maxConcurrentPatrols ?? 2);
  const patrolMaxMs = deps.patrolMaxMs ?? 20 * 60_000;
  /** 在跑的巡查：sessionId → 巡查信息（投递成功后登记，回合结束收尾时移除）。 */
  const patrols = new Map<string, PatrolRun>();
  /** 正在投递中的巡查（chatId\0threadRoot）。 */
  const patrolInflight = new Set<string>();
  /** 已交给引擎的上报（threadRoot\0at），避免每拍重复推。 */
  const notedEscalations = new Set<string>();
  const patrolKey = (chatId: string, root: string) => `${chatId}\u0000${root}`;
  const runningPatrolCount = () => patrols.size + patrolInflight.size;
  /** 巡查投递中 / 在跑期间，该话题最近一次出现真人消息的时间（chatId\0threadRoot → 本机观察时刻）。
   *  只要巡查期间话题里来过真人，这个会话就当作正常对话会话保留，不自动关。 */
  const humanSeenInPatrol = new Map<string, number>();
  const isPatrolling = (chatId: string, root: string): boolean => {
    if (patrolInflight.has(patrolKey(chatId, root))) return true;
    for (const p of patrols.values()) if (p.chatId === chatId && p.threadRoot === root) return true;
    return false;
  };
  /** 本拍 takeDigests 里已经放行的巡查数（投递是并行的，放行时就要占名额）。 */
  let reservedPatrols = 0;
  const patrolBusy = (chatId: string, root: string): boolean => {
    if (patrolInflight.has(patrolKey(chatId, root))) return true;
    for (const p of patrols.values()) if (p.chatId === chatId && p.threadRoot === root) return true;
    if (runningPatrolCount() + reservedPatrols >= maxConcurrentPatrols) return true;
    reservedPatrols++;
    return false;
  };
  /** 秘书自己的群级会话正在跑的群（忙时新消息继续攒）。 */
  const ownBusy = new Set<string>();
  /** check_in 进展判断：每个会话上次回访时的对话指纹。 */
  const transcriptSig = new Map<string, string>();
  /** 群描述标记的最近读数：chatId → 标记里的 appId（undefined = 无标记）。缺项 = 还没读到。 */
  const markers = new Map<string, string | undefined>();
  const markerReadAt = new Map<string, number>();
  const markerRefreshMs = deps.markerRefreshMs ?? 60_000;
  const markerTimeoutMs = deps.markerTimeoutMs ?? 8_000;
  const withTimeout = async <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error('marker_timeout')), markerTimeoutMs);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  /** 本机登记是自己，且群描述标记没有指向别的 bot（读不到时按本机登记继续，不因网络抖动停手）。 */
  /** 同一次开启：await 前后读到的是不是同一份登记（关闭、接管、关了又开都算换了）。 */
  const sameRegistration = (a: GroupSecretaryChatEntry | undefined, b: GroupSecretaryChatEntry): boolean =>
    !!a && a.larkAppId === b.larkAppId && a.enabledAt === b.enabledAt && a.enabledBy === b.enabledBy;
  const isActiveChat = (chatId: string | undefined): boolean => {
    if (!isGroupSecretaryChat(deps.larkAppId, chatId)) return false;
    if (!deps.readMarker || !markers.has(chatId!)) return true;
    return markers.get(chatId!) === deps.larkAppId;
  };
  const refreshMarkers = async (): Promise<void> => {
    if (!deps.readMarker) return;
    for (const { chatId } of listGroupSecretaryChats(deps.larkAppId)) {
      if (now() - (markerReadAt.get(chatId) ?? 0) < markerRefreshMs) continue;
      markerReadAt.set(chatId, now());
      try {
        const marker = await withTimeout(deps.readMarker(chatId));
        const entry = getGroupSecretaryChat(deps.larkAppId, chatId);
        if (!entry) continue;
        if (marker === deps.larkAppId) {
          markers.set(chatId, marker);
          if (!entry.markerConfirmedAt) setGroupSecretaryChat(chatId, { ...entry, markerConfirmedAt: now() });
          continue;
        }
        if (marker === undefined && !entry.markerConfirmedAt) {
          // 旧版本只在本机登记：补写标记（迁移）。失败下次刷新再试，期间按本机登记继续工作。
          if (!deps.writeMarker) continue;
          // 条件写：只在标记仍然缺失时补写。await 期间另一台机器接管写入的标记不会被覆盖。
          const wrote = await withTimeout(deps.writeMarker(chatId, deps.larkAppId, { expect: null }));
          if (wrote.ok) {
            const current = getGroupSecretaryChat(deps.larkAppId, chatId);
            if (!sameRegistration(current, entry)) {
              // 写标记期间登记变了（/secretary off、本机别的 bot 接管、关了又开）：不拿旧登记写回。
              // 登记已不归自己时，迟到的这次写把标记盖成了自己，按本机现任秘书还回去（没有就清空）。
              if (!current) {
                const owner = getGroupSecretaryOwner(chatId)?.larkAppId ?? null;
                try {
                  // 只撤回自己刚写的那一份：标记若已被别人改写，保留对方的。
                  const undo = await withTimeout(deps.writeMarker(chatId, owner, { expect: deps.larkAppId }));
                  if (!undo.ok) deps.log('warn', `[group-secretary] marker rollback failed chat=${chatId.slice(0, 12)}: ${undo.reason ?? 'unknown'}`);
                } catch (err) {
                  deps.log('warn', `[group-secretary] marker rollback failed chat=${chatId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
                }
                markers.set(chatId, owner ?? undefined);
              }
              deps.log('info', `[group-secretary] registration changed during marker migration chat=${chatId.slice(0, 12)}; skipped`);
              continue;
            }
            markers.set(chatId, deps.larkAppId);
            setGroupSecretaryChat(chatId, { ...current!, markerConfirmedAt: now() });
            deps.log('info', `[group-secretary] wrote marker for legacy registration chat=${chatId.slice(0, 12)}`);
          } else if (wrote.reason === 'marker_changed') {
            // 补写前别的 bot 已写入标记：不覆盖。本拍就按新标记处理（指向别人立即停止投递），
            // 下一拍重读后清掉本机登记。
            markers.set(chatId, wrote.previous);
            markerReadAt.delete(chatId);
            deps.log('info', `[group-secretary] marker appeared during migration chat=${chatId.slice(0, 12)}; not overwritten`);
          } else {
            deps.log('warn', `[group-secretary] marker migration failed chat=${chatId.slice(0, 12)}: ${wrote.reason ?? 'unknown'}; will retry`);
          }
          continue;
        }
        // 确认过的登记，标记却不见了或指向别人：已被关闭 / 接管。清掉本机登记，彻底停手（不会重启后复活）。
        markers.set(chatId, marker);
        setGroupSecretaryChat(chatId, null);
        engine.forgetChat(chatId);
        deps.log('info', `[group-secretary] marker for chat=${chatId.slice(0, 12)} is ${marker ?? 'absent'}; cleared local registration and stood down`);
      } catch (err) {
        deps.log('warn', `[group-secretary] marker refresh failed chat=${chatId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const engine = new GroupSecretaryEngine({
    selfAppId: deps.larkAppId,
    isEnabledChat: chatId => isActiveChat(chatId),
    isTrustedHuman: (chatId, openId) => !!openId && deps.canTalk(chatId, openId),
    unaddressedGraceMs: staggeredGraceMs(deps.larkAppId),
    isSecretaryBusy: (chatId, threadRoot) => threadRoot === undefined
      ? ownBusy.has(chatId)
      : patrolBusy(chatId, threadRoot),
    splitPatrol,
    manualWatches: () => deps.manualWatches?.() ?? [],
    now,
  });
  const deliverTimeoutMs = deps.deliverTimeoutMs ?? 90_000;
  const sessionPollMs = deps.sessionPollMs ?? 10_000;
  let lastPollAt = 0;
  const backfilled = new Set<string>();
  /** 每个开启的群首次检查时补拉最近消息（daemon 重启 / 刚开启时内存里没有上下文）。 */
  const backfill = async (): Promise<void> => {
    if (!deps.fetchRecentMessages) return;
    for (const { chatId, enabledAt } of listGroupSecretaryChats(deps.larkAppId)) {
      if (backfilled.has(chatId)) continue;
      backfilled.add(chatId);
      try {
        const items = await deps.fetchRecentMessages(chatId);
        let n = 0;
        for (const item of items) {
          const m = larkEventToSecretaryMessage(restMessageToEventData(item, chatId), deps.selfOpenId(), deps.larkAppId);
          if (!m || m.createTime < enabledAt) continue;
          engine.observeMessage(m, { backfill: true });
          n++;
        }
        deps.log('info', `[group-secretary] backfilled ${n} message(s) chat=${chatId.slice(0, 12)}`);
      } catch (err) {
        backfilled.delete(chatId);
        deps.log('warn', `[group-secretary] backfill failed chat=${chatId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  let inFlight = false;
  let seq = 0;

  const deliver = async (digest: SecretaryDigest): Promise<void> => {
    const entry = getGroupSecretaryChat(deps.larkAppId, digest.chatId);
    if (!entry) return;
    const turnId = `secretary:${deps.larkAppId}:${digest.chatId}:${now()}:${++seq}`;
    // 补证据：每个会话事件附上该会话最近几条对话（bot 最后说了什么），让模型判断「做完了」
    // 还是「做一半停了」。只补一次（重投沿用），失败就不带。
    if (deps.fetchTranscript) {
      await Promise.all(digest.events.map(async event => {
        if (!event.session || event.transcript) return;
        try {
          const lines = await deps.fetchTranscript!(event.session.larkAppId, event.session.sessionId, digest.chatId);
          if (lines?.length) event.transcript = lines;
          if (event.kind === 'check_in' && lines?.length) {
            const sig = createHash('sha1').update(JSON.stringify(lines)).digest('hex');
            const prev = transcriptSig.get(event.session.sessionId);
            if (prev !== undefined) event.progressed = prev !== sig;
            transcriptSig.set(event.session.sessionId, sig);
          }
        } catch { /* 无证据照常投递 */ }
      }));
    }
    // 投递前最后一次复核：取证据（或将来在这之前加的任何 await）期间可能已被关闭 / 接管 /
    // 关了又开，这批事件属于旧的那次开启，丢弃。不挂在取证据分支里，免得以后改投递流程时漏掉。
    if (!sameRegistration(getGroupSecretaryChat(deps.larkAppId, digest.chatId), entry) || !isActiveChat(digest.chatId)) {
      deps.log('info', `[group-secretary] registration changed before delivery chat=${digest.chatId.slice(0, 12)}; dropped ${digest.events.length} event(s)`);
      return;
    }
    if (digest.target?.kind === 'patrol') {
      await deliverPatrolDigest(digest, entry, digest.target.threadRoot);
      return;
    }
    const isMain = digest.target?.kind === 'main';
    const prompt = isMain
      ? renderMainSecretaryPrompt(digest, {
        enabledByOpenId: entry.enabledBy,
        groupContextInjected: deps.groupContextEnabled?.(digest.chatId) ?? false,
        ledger: listLedger(deps.larkAppId, digest.chatId, undefined, now()),
      })
      : renderGroupSecretaryPrompt(digest, {
        enabledByOpenId: entry.enabledBy,
        groupContextInjected: deps.groupContextEnabled?.(digest.chatId) ?? false,
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), deliverTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        deps.deliver({ chatId: digest.chatId, turnId, prompt, ownerOpenId: entry.enabledBy }),
        timeout,
      ]);
      if (result === 'timeout') {
        // 投递可能仍在进行、也可能已经送达：结果未知时不重投，宁可漏一批也不重复唤起。
        deps.log('warn', `[group-secretary] deliver timed out chat=${digest.chatId.slice(0, 12)}; dropped ${digest.events.length} event(s)`);
        return;
      }
      if (isMain) {
        const escalated = digest.events
          .filter(e => e.kind === 'escalation' && e.escalation)
          .map(e => ({ threadRoot: e.escalation!.threadRoot, at: e.escalation!.at }));
        try { markEscalationsDelivered(deps.larkAppId, digest.chatId, escalated, now()); } catch { /* 下次照样在台账里 */ }
      }
      deps.log('info', `[group-secretary] delivered ${digest.events.length} event(s) chat=${digest.chatId.slice(0, 12)} `
        + `${isMain ? 'target=main ' : ''}kinds=${digest.events.map(e => e.kind).join(',')}`);
    } catch (err) {
      const requeued = engine.requeue(digest);
      deps.log('warn', `[group-secretary] deliver failed chat=${digest.chatId.slice(0, 12)}`
        + `${requeued ? ' (will retry)' : `; dropped ${digest.events.length} event(s) after retries`}: `
        + `${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * 话题巡查投递。便宜的预筛先过一遍：自动回访（非手动盯）只有「两次回访之间对话没变化」才值得
   * 叫醒巡查；第一次回访只记指纹做基线。预筛后没事件了就不起会话。
   */
  const deliverPatrolDigest = async (digest: SecretaryDigest, entry: GroupSecretaryChatEntry, threadRoot: string): Promise<void> => {
    const events = digest.events.filter(e => e.kind !== 'check_in' || !!e.manualNote || e.progressed === false);
    if (events.length === 0) return;
    const patrolDigest: SecretaryDigest = { ...digest, events };
    const key = patrolKey(digest.chatId, threadRoot);
    const turnId = secretaryPatrolTurnId(deps.larkAppId, digest.chatId, threadRoot, now(), ++seq);
    const watched = (deps.manualWatches?.() ?? []).some(w => w.chatId === digest.chatId && w.threadRoot === threadRoot);
    const prompt = renderPatrolPrompt(patrolDigest, {
      enabledByOpenId: entry.enabledBy,
      threadRoot,
      ledgerEntry: getLedgerEntry(deps.larkAppId, digest.chatId, threadRoot, undefined, now()),
      watched,
    });
    const startedAt = now();
    patrolInflight.add(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), deliverTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        deps.deliverPatrol!({ chatId: digest.chatId, threadRoot, turnId, prompt, ownerOpenId: entry.enabledBy }),
        timeout,
      ]);
      if (result === 'timeout') {
        humanSeenInPatrol.delete(key);
        deps.log('warn', `[group-secretary] patrol deliver timed out chat=${digest.chatId.slice(0, 12)} root=${threadRoot.slice(0, 16)}; dropped ${events.length} event(s)`);
        return;
      }
      const botName = events.find(e => e.session?.botName)?.session?.botName;
      patrols.set(result.sessionId, {
        chatId: digest.chatId, threadRoot, startedAt, created: result.created, sawBusy: false, events,
        ...(botName ? { botName } : {}),
      });
      deps.log('info', `[group-secretary] patrol started chat=${digest.chatId.slice(0, 12)} root=${threadRoot.slice(0, 16)} `
        + `session=${result.sessionId.slice(0, 8)}${result.created ? ' (new)' : ''} kinds=${events.map(e => e.kind).join(',')}`);
    } catch (err) {
      humanSeenInPatrol.delete(key);
      const requeued = engine.requeue(patrolDigest);
      deps.log('warn', `[group-secretary] patrol deliver failed chat=${digest.chatId.slice(0, 12)} root=${threadRoot.slice(0, 16)}`
        + `${requeued ? ' (will retry)' : `; dropped ${events.length} event(s) after retries`}: `
        + `${err instanceof Error ? err.message : String(err)}`);
    } finally {
      patrolInflight.delete(key);
      if (timer) clearTimeout(timer);
    }
  };

  /** 巡查回合结束：没写台账就兜底一行；会话是为巡查新建、期间也没有真人来过，就关掉（一次性）。 */
  const finishPatrol = async (sessionId: string, run: PatrolRun, lastActivityAt: number | undefined): Promise<void> => {
    patrols.delete(sessionId);
    const humanSeenAt = humanSeenInPatrol.get(patrolKey(run.chatId, run.threadRoot));
    humanSeenInPatrol.delete(patrolKey(run.chatId, run.threadRoot));
    try {
      const cur = getLedgerEntry(deps.larkAppId, run.chatId, run.threadRoot, undefined, now());
      if (!cur || cur.updatedAt < run.startedAt) {
        const kinds = [...new Set(run.events.map(e => PATROL_KIND_LABEL[e.kind] ?? e.kind))].join('、');
        recordLedger(deps.larkAppId, {
          chatId: run.chatId, threadRoot: run.threadRoot, status: fallbackLedgerStatus(run.events),
          summary: `巡查没有写台账（触发：${kinds}）${cur?.summary ? `；上次：${cur.summary}` : ''}`,
          ...(run.botName ? { botName: run.botName } : {}),
          auto: true, at: now(),
        });
      } else if (run.botName && !cur.botName) {
        recordLedger(deps.larkAppId, { ...cur, botName: run.botName, at: cur.updatedAt });
      }
    } catch (err) {
      deps.log('warn', `[group-secretary] patrol ledger fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 巡查期间有人在话题里 @ 了秘书（会话有新的真人活动）：这已经是一个正常对话会话，不关。
    // 两路信号任一成立就不关：旁听到巡查期间话题里有真人发言（不论是否 @ 秘书）；
    // 或会话本身在投递之后又收到了消息（30 秒内的那次是巡查投递自己）。
    const humanCameIn = (humanSeenAt !== undefined && humanSeenAt >= run.startedAt)
      || (lastActivityAt !== undefined && lastActivityAt > run.startedAt + 30_000);
    if (!run.created || humanCameIn || !deps.closePatrolSession) return;
    try {
      await deps.closePatrolSession(sessionId);
      deps.log('info', `[group-secretary] patrol session ${sessionId.slice(0, 8)} closed root=${run.threadRoot.slice(0, 16)}`);
    } catch (err) {
      deps.log('warn', `[group-secretary] closing patrol session ${sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 每次拉到会话快照后：推进在跑巡查的状态，结束的收尾。 */
  const trackPatrols = async (views: SecretarySessionView[]): Promise<void> => {
    if (patrols.size === 0) return;
    const byId = new Map(views.map(v => [v.sessionId, v]));
    for (const [sessionId, run] of [...patrols]) {
      const v = byId.get(sessionId);
      const age = now() - run.startedAt;
      const busy = !!v && v.liveness === 'alive' && (v.turn === 'working' || v.turn === 'starting' || v.turn === 'analyzing');
      if (busy) run.sawBusy = true;
      // 结束：跑过一轮又回到空闲；或者一直没看到它忙（回合太短，两次快照之间就做完了）但已过 90 秒；
      // 或者会话已经停了 / 超过最长跟踪时间。快照里暂时看不到（探测失败）不算结束，免得关掉还在跑的巡查。
      const idle = !!v && v.liveness === 'alive' && !busy;
      const done = (idle && (run.sawBusy || age > 90_000))
        || (!!v && v.liveness !== 'alive')
        || age > patrolMaxMs;
      if (done) await finishPatrol(sessionId, run, v?.lastActivityAt);
    }
  };

  /** 台账里新的待上报 → 主群总管事件（每次开启的进程里每条只推一次；重启后未交付的会再推）。 */
  const pullEscalations = (): void => {
    for (const { chatId } of listGroupSecretaryChats(deps.larkAppId)) {
      if (!isActiveChat(chatId)) continue;
      let pending: ReturnType<typeof pendingEscalations> = [];
      try { pending = pendingEscalations(deps.larkAppId, chatId, undefined, now()); } catch { continue; }
      for (const e of pending) {
        const k = `${chatId}\u0000${e.threadRoot}\u0000${e.escalation!.at}`;
        if (notedEscalations.has(k)) continue;
        notedEscalations.add(k);
        engine.noteEscalation(chatId, {
          threadRoot: e.threadRoot, text: e.escalation!.text, at: e.escalation!.at,
          status: e.status, summary: e.summary, ...(e.botName ? { botName: e.botName } : {}),
        });
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    if (!deps.enabled()) return;
    if (listGroupSecretaryChats(deps.larkAppId).length === 0) return;
    inFlight = true;
    try {
      await refreshMarkers();
      await backfill();
      if (now() - lastPollAt >= sessionPollMs) {
        lastPollAt = now();
        try {
          const localViews = snapshotToSessionViews(await deps.fetchSnapshot());
          let remoteViews: SecretarySessionView[] = [];
          if (deps.fetchRemoteViews) {
            try {
              remoteViews = await deps.fetchRemoteViews(listGroupSecretaryChats(deps.larkAppId).map(c => c.chatId));
            } catch { remoteViews = []; }
          }
          const localIds = new Set(localViews.map(v => v.sessionId));
          const views = [...localViews, ...remoteViews.filter(v => !localIds.has(v.sessionId))];
          ownBusy.clear();
          for (const v of views) {
            if (v.larkAppId === deps.larkAppId && v.scope === 'chat' && v.chatId
              && v.liveness === 'alive' && (v.turn === 'working' || v.turn === 'starting' || v.turn === 'analyzing')) {
              ownBusy.add(v.chatId);
            }
          }
          engine.observeSessions(views);
          if (splitPatrol) await trackPatrols(views);
        } catch (err) {
          deps.log('warn', `[group-secretary] session snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (splitPatrol) pullEscalations();
      // 各群并行投递：一个群卡住不拖累其它群（单次投递另有超时兜底）。
      reservedPatrols = 0;
      const digests = engine.takeDigests();
      reservedPatrols = 0;
      await Promise.allSettled(digests.map(deliver));
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, deps.tickMs ?? 5_000);
  timer.unref?.();

  return {
    engine,
    noteMarker(chatId: string, appId: string | undefined): void {
      markers.set(chatId, appId);
      markerReadAt.set(chatId, now());
    },
    observeMessageEvent(data: any): void {
      try {
        const chatId = data?.message?.chat_id;
        if (!deps.enabled() || !isActiveChat(chatId)) return;
        const message = larkEventToSecretaryMessage(data, deps.selfOpenId(), deps.larkAppId);
        if (!message) return;
        // 开启之前的消息（重放 / 补拉）不进秘书视野。
        const entry = getGroupSecretaryChat(deps.larkAppId, chatId);
        if (entry && message.createTime < entry.enabledAt) return;
        // 「真人」是近似：listenerSenderType 把非 app/bot 的发送方都当 user，带 root_id 的系统通知
        // 也会被算进来。误判只会让会话多保留一轮（交给空闲挂起），不会误关有人的会话。
        if (message.senderType === 'user' && message.rootId && isPatrolling(chatId, message.rootId)) {
          humanSeenInPatrol.set(patrolKey(chatId, message.rootId), now());
        }
        engine.observeMessage(message);
      } catch (err) {
        deps.log('warn', `[group-secretary] observe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    tick,
    stop(): void {
      clearInterval(timer);
    },
  };
}

let current: GroupSecretaryRuntime | undefined;

export function setGroupSecretaryRuntime(runtime: GroupSecretaryRuntime | undefined): void {
  current?.stop();
  current = runtime;
}

/** /secretary on|takeover 成功后立刻更新标记缓存，不用等下一次刷新（否则接管后最多 60s 静默）。 */
export function noteSecretaryMarker(chatId: string, appId: string | undefined): void {
  current?.noteMarker(chatId, appId);
}

/** /secretary off 时清掉该群的积压，免得关了又开时投递关之前的旧事件。 */
export function forgetGroupSecretaryChat(chatId: string): void {
  current?.engine.forgetChat(chatId);
}

/** event-dispatcher 的旁路入口：未启动 / 未开启时零成本返回，永不抛出。 */
export function observeGroupSecretaryMessage(data: any): void {
  current?.observeMessageEvent(data);
}
