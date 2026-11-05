/**
 * 群秘书运行时：把飞书消息事件、本机会话快照接到判定引擎上，按拍投递摘要。
 *
 * 一个 daemon 只服务一个 bot，所以这里是进程级单例：daemon 启动时 start，
 * event-dispatcher 每收到一条群消息调用 observeGroupSecretaryMessage（永不抛出）。
 * 没有任何群开启秘书时，定时器只做一次 Map 查询就返回，不拉会话快照。
 */
import { createHash } from 'node:crypto';
import { GroupSecretaryEngine, type SecretaryDigest, type SecretaryManualWatch, type SecretarySessionView } from './group-secretary-engine.js';
import { renderGroupSecretaryPrompt } from './group-secretary-prompt.js';
import { getGroupSecretaryChat, getGroupSecretaryOwner, isGroupSecretaryChat, listGroupSecretaryChats, setGroupSecretaryChat, type GroupSecretaryChatEntry } from './group-secretary-store.js';
import { extractListenerMessageText, listenerSenderType } from './message-listener.js';
import type { ObserveSnapshot } from './session-observe.js';

export interface GroupSecretaryRuntimeDeps {
  larkAppId: string;
  selfOpenId: () => string | undefined;
  fetchSnapshot: () => Promise<ObserveSnapshot>;
  deliver: (input: { chatId: string; turnId: string; prompt: string; ownerOpenId: string }) => Promise<unknown>;
  /** 读 / 写群描述里的秘书标记（全群唯一登记）。不提供时只按本机登记判断。 */
  readMarker?: (chatId: string) => Promise<string | undefined>;
  /** appId 为 null 表示清除标记。 */
  writeMarker?: (chatId: string, appId: string | null) => Promise<{ ok: boolean; reason?: string }>;
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

export function createGroupSecretaryRuntime(deps: GroupSecretaryRuntimeDeps): GroupSecretaryRuntime {
  const now = deps.now ?? Date.now;
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
          const wrote = await withTimeout(deps.writeMarker(chatId, deps.larkAppId));
          if (wrote.ok) {
            const current = getGroupSecretaryChat(deps.larkAppId, chatId);
            if (!sameRegistration(current, entry)) {
              // 写标记期间登记变了（/secretary off、本机别的 bot 接管、关了又开）：不拿旧登记写回。
              // 登记已不归自己时，迟到的这次写把标记盖成了自己，按本机现任秘书还回去（没有就清空）。
              if (!current) {
                const owner = getGroupSecretaryOwner(chatId)?.larkAppId ?? null;
                try {
                  const undo = await withTimeout(deps.writeMarker(chatId, owner));
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
    isSecretaryBusy: chatId => ownBusy.has(chatId),
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
      // 取证据期间可能已被关闭 / 接管 / 关了又开：这批事件属于旧的那次开启，丢弃。
      if (!sameRegistration(getGroupSecretaryChat(deps.larkAppId, digest.chatId), entry) || !isActiveChat(digest.chatId)) {
        deps.log('info', `[group-secretary] registration changed while gathering evidence chat=${digest.chatId.slice(0, 12)}; dropped ${digest.events.length} event(s)`);
        return;
      }
    }
    const prompt = renderGroupSecretaryPrompt(digest, {
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
      deps.log('info', `[group-secretary] delivered ${digest.events.length} event(s) chat=${digest.chatId.slice(0, 12)} `
        + `kinds=${digest.events.map(e => e.kind).join(',')}`);
    } catch (err) {
      const requeued = engine.requeue(digest);
      deps.log('warn', `[group-secretary] deliver failed chat=${digest.chatId.slice(0, 12)}`
        + `${requeued ? ' (will retry)' : `; dropped ${digest.events.length} event(s) after retries`}: `
        + `${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
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
        } catch (err) {
          deps.log('warn', `[group-secretary] session snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 各群并行投递：一个群卡住不拖累其它群（单次投递另有超时兜底）。
      await Promise.allSettled(engine.takeDigests().map(deliver));
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
        if (!isActiveChat(chatId)) return;
        const message = larkEventToSecretaryMessage(data, deps.selfOpenId(), deps.larkAppId);
        if (!message) return;
        // 开启之前的消息（重放 / 补拉）不进秘书视野。
        const entry = getGroupSecretaryChat(deps.larkAppId, chatId);
        if (entry && message.createTime < entry.enabledAt) return;
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
