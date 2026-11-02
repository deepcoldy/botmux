/**
 * 群秘书运行时：把飞书消息事件、本机会话快照接到判定引擎上，按拍投递摘要。
 *
 * 一个 daemon 只服务一个 bot，所以这里是进程级单例：daemon 启动时 start，
 * event-dispatcher 每收到一条群消息调用 observeGroupSecretaryMessage（永不抛出）。
 * 没有任何群开启秘书时，定时器只做一次 Map 查询就返回，不拉会话快照。
 */
import { GroupSecretaryEngine, type SecretaryDigest, type SecretarySessionView } from './group-secretary-engine.js';
import { renderGroupSecretaryPrompt } from './group-secretary-prompt.js';
import { getGroupSecretaryChat, isGroupSecretaryChat, listGroupSecretaryChats } from './group-secretary-store.js';
import { extractListenerMessageText, listenerSenderType } from './message-listener.js';
import type { ObserveSnapshot } from './session-observe.js';

export interface GroupSecretaryRuntimeDeps {
  larkAppId: string;
  selfOpenId: () => string | undefined;
  fetchSnapshot: () => Promise<ObserveSnapshot>;
  deliver: (input: { chatId: string; turnId: string; prompt: string; ownerOpenId: string }) => Promise<unknown>;
  log: (level: 'info' | 'warn', message: string) => void;
  now?: () => number;
  tickMs?: number;
  sessionPollMs?: number;
}

export interface GroupSecretaryRuntime {
  observeMessageEvent(data: any): void;
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

export function larkEventToSecretaryMessage(data: any, selfOpenId: string | undefined) {
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
    text: extractListenerMessageText(message),
    mentionCount: mentions.length,
    mentionsSelf: !!selfOpenId && mentions.some(m => m?.id?.open_id === selfOpenId),
    fromSelf: !!selfOpenId && senderOpenId === selfOpenId,
    createTime: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
  };
}

export function createGroupSecretaryRuntime(deps: GroupSecretaryRuntimeDeps): GroupSecretaryRuntime {
  const now = deps.now ?? Date.now;
  const engine = new GroupSecretaryEngine({
    selfAppId: deps.larkAppId,
    isEnabledChat: chatId => isGroupSecretaryChat(deps.larkAppId, chatId),
    now,
  });
  const sessionPollMs = deps.sessionPollMs ?? 10_000;
  let lastPollAt = 0;
  let inFlight = false;
  let seq = 0;

  const deliver = async (digest: SecretaryDigest): Promise<void> => {
    const entry = getGroupSecretaryChat(deps.larkAppId, digest.chatId);
    if (!entry) return;
    const turnId = `secretary:${deps.larkAppId}:${digest.chatId}:${now()}:${++seq}`;
    const prompt = renderGroupSecretaryPrompt(digest, { enabledByOpenId: entry.enabledBy });
    try {
      await deps.deliver({ chatId: digest.chatId, turnId, prompt, ownerOpenId: entry.enabledBy });
      deps.log('info', `[group-secretary] delivered ${digest.events.length} event(s) chat=${digest.chatId.slice(0, 12)} `
        + `kinds=${digest.events.map(e => e.kind).join(',')}`);
    } catch (err) {
      engine.requeue(digest);
      deps.log('warn', `[group-secretary] deliver failed chat=${digest.chatId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    if (listGroupSecretaryChats(deps.larkAppId).length === 0) return;
    inFlight = true;
    try {
      if (now() - lastPollAt >= sessionPollMs) {
        lastPollAt = now();
        try {
          engine.observeSessions(snapshotToSessionViews(await deps.fetchSnapshot()));
        } catch (err) {
          deps.log('warn', `[group-secretary] session snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const digest of engine.takeDigests()) await deliver(digest);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, deps.tickMs ?? 5_000);
  timer.unref?.();

  return {
    engine,
    observeMessageEvent(data: any): void {
      try {
        const chatId = data?.message?.chat_id;
        if (!isGroupSecretaryChat(deps.larkAppId, chatId)) return;
        const message = larkEventToSecretaryMessage(data, deps.selfOpenId());
        if (message) engine.observeMessage(message);
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

/** event-dispatcher 的旁路入口：未启动 / 未开启时零成本返回，永不抛出。 */
export function observeGroupSecretaryMessage(data: any): void {
  current?.observeMessageEvent(data);
}
