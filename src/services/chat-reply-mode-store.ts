/**
 * Per-chat reply mode for regular groups, layered over the per-bot default.
 *
 * Four modes — unifies #116 + #131 into one knob so a chat resolves
 * to EXACTLY ONE mode and the two thread-reply mechanisms can never compete:
 *   • chat        — flat chat-scope replies in the group. A native Lark topic
 *                    the user opens here folds back into this one chat-scope
 *                    session too (see maybeFoldMentionedRegularGroupThreadToChat).
 *   • topic/shared — 话题展示但复用同一个 session: reuse the bot's existing
 *                    chat-scope session/worker/cwd, but route this turn's reply
 *                    into the trigger message's thread (#131). A native topic
 *                    seed also folds into the shared session, not an independent one.
 *   • new-topic    — explicit fork mode: each top-level @mention opens a fresh
 *                    thread-scope session under the trigger (its own worker/cwd/context).
 *   • chat-topic   — hybrid (default): top-level @mentions stay flat in the one
 *                    chat-scope session (like `chat`), BUT a native Lark topic the
 *                    user opens runs its own independent thread-scope session (NOT
 *                    folded), whether the bot enters on the seed or a later reply.
 *                    "顶层平铺连续会话；群内原生话题各自独立会话".
 *
 * Native-topic isolation is chat-topic-only, honoring the /reply-mode config:
 * chat / shared deliberately fold native topics into the group session.
 *
 * Resolution: per-chat override (`chatReplyModes[chatId]`) wins; otherwise fall
 * back to the per-bot default (`regularGroupReplyMode`, default 'chat-topic').
 * An explicit set always persists as an override (even when equal to the
 * default); only clearChatReplyMode (`/reply-mode inherit`) restores inheritance. The
 * setting is bot-scoped: Bot A can prefer topic replies in one group while Bot B
 * or another group stays flat.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot, type ChatReplyMode, type GroupMentionMode } from '../bot-registry.js';
import { dashboardEventBus } from '../core/dashboard-events.js';
import { logger } from '../utils/logger.js';
import { signedChatMentionDefault } from './signed-chat-defaults.js';

export type { ChatReplyMode, GroupMentionMode } from '../bot-registry.js';

export function normalizeChatReplyMode(raw: string | undefined): ChatReplyMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'chat') return 'chat';
  if (v === 'chat-topic' || v === 'chattopic' || v === 'chat_topic') return 'chat-topic';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

/** Short command-word label for status / confirmation messages. */
export function replyModeLabel(mode: ChatReplyMode): 'chat' | 'topic' | 'new-topic' | 'chat-topic' {
  if (mode === 'shared') return 'topic';
  if (mode === 'new-topic') return 'new-topic';
  if (mode === 'chat-topic') return 'chat-topic';
  return 'chat';
}

/** `/reply-mode inherit` 及其别名：清除群级覆盖、恢复跟随 Bot 默认。 */
export function isChatReplyModeInheritArg(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === 'inherit' || v === 'default' || v === 'reset' || v === 'clear';
}

/** Per-bot default regular-group mode (`regularGroupReplyMode`, default 'chat-topic'). */
export function regularGroupDefaultMode(larkAppId: string): ChatReplyMode {
  try {
    return getBot(larkAppId).config.regularGroupReplyMode ?? 'chat-topic';
  } catch {
    return 'chat-topic';
  }
}

export interface ChatReplyModeState {
  /** 显式群级覆盖；`null` 表示本群继承 Bot 默认。 */
  override: ChatReplyMode | null;
  /** Bot 默认（`regularGroupReplyMode`）。 */
  default: ChatReplyMode;
  /** 当前生效值 = override ?? default。 */
  effective: ChatReplyMode;
  inherited: boolean;
}

/** 读出 (bot × chat) 的完整回复模式策略，包括生效值来自哪里。 */
export function getChatReplyModeState(larkAppId: string, chatId: string): ChatReplyModeState {
  const defaultMode = regularGroupDefaultMode(larkAppId);
  let override: ChatReplyMode | undefined;
  try {
    override = getBot(larkAppId).config.chatReplyModes?.[chatId];
  } catch { /* 与 resolveRegularGroupMode 同口径：读不到 bot 即视为继承 */ }
  return {
    override: override ?? null,
    default: defaultMode,
    effective: override ?? defaultMode,
    inherited: override === undefined,
  };
}

/** 通知 Dashboard 群矩阵快照失效（经 daemon SSE → aggregator）。chatId 缺省表示 Bot 默认变化、影响所有继承群。 */
export function publishReplyPolicyChanged(chatId?: string): void {
  dashboardEventBus.publish({ type: 'groups.reply-policy.changed', body: chatId ? { chatId } : {} });
}

/**
 * Per-bot (bot-global) @-requirement policy for regular groups, default 'always'.
 *   • always  — @ required everywhere (incl. inside shared topics).
 *   • topic   — @ required at top level, but non-@ continues inside shared topics.
 *   • never   — non-@ messages are always answered (where the bot has talk access).
 *   • ambient — like never, but stays quiet when the message @mentions another
 *               specific member (person/bot) without @ing this bot (redirect).
 *
 * Per-chat override (`chatMentionModes[chatId]`, written by `/mention-mode`)
 * wins when present; otherwise an opted-in signed chat default, then the
 * per-bot `regularGroupMentionMode` default.
 */
export function resolveGroupMentionMode(larkAppId: string, chatId?: string): GroupMentionMode {
  try {
    const cfg = getBot(larkAppId).config;
    const perChat = chatId ? cfg.chatMentionModes?.[chatId] : undefined;
    if (perChat === 'always' || perChat === 'topic' || perChat === 'never' || perChat === 'ambient') {
      return perChat;
    }
    if (cfg.signedChatDefaults === true && signedChatMentionDefault(larkAppId, chatId)) return 'ambient';
    const m = cfg.regularGroupMentionMode;
    return m === 'topic' || m === 'never' || m === 'ambient' ? m : 'always';
  } catch {
    return 'always';
  }
}

/** Only controls the solo-group exception; explicit mention policies/triggers still apply. */
export function isSoloGroupMentionBypassEnabled(larkAppId: string, chatId: string): boolean {
  try {
    const cfg = getBot(larkAppId).config;
    const perChat = cfg.chatSoloGroupMentionBypass?.[chatId];
    return typeof perChat === 'boolean' ? perChat : cfg.soloGroupMentionBypass !== false;
  } catch {
    return true;
  }
}

/** Per-bot default mention policy (`regularGroupMentionMode`, default 'always'). */
function groupMentionDefaultMode(larkAppId: string): GroupMentionMode {
  try {
    const m = getBot(larkAppId).config.regularGroupMentionMode;
    return m === 'topic' || m === 'never' || m === 'ambient' ? m : 'always';
  } catch {
    return 'always';
  }
}

/** Parse `/mention-mode` argument; 'status'/empty → undefined (status query). */
export function normalizeGroupMentionMode(raw: string | undefined): GroupMentionMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'always' || v === 'topic' || v === 'never' || v === 'ambient') return v;
  return undefined;
}

/**
 * Effective regular-group reply mode for a chat — the SINGLE source of truth for
 * routing. Per-chat override first, then the per-bot default. Both the
 * `regularGroupRouting` (new-topic) and `maybeApplySharedTopicSeed` (shared)
 * code paths read this, so they are mutually exclusive by construction.
 */
export function resolveRegularGroupMode(larkAppId: string, chatId: string | undefined): ChatReplyMode {
  try {
    const perChat = chatId ? getBot(larkAppId).config.chatReplyModes?.[chatId] : undefined;
    if (perChat) return perChat;
  } catch { /* fall through to default */ }
  return regularGroupDefaultMode(larkAppId);
}

/**
 * 同一 bot 的 chatReplyModes「落盘 + 内存同步」按进程内队列串行。
 *
 * 写路径把磁盘上的整份快照赋给内存（顺带修复陈旧/外部编辑），所以两次写的「内存
 * 赋值」必须与「落盘」同序：withFileLock 在关闭锁文件句柄前就已释放锁，较早的
 * 请求可能在较晚的请求落盘并同步内存之后才恢复，再把自己的旧快照盖回内存——两个
 * 不同群并发修改时会丢掉较晚那个群的覆盖（bots.json 里两者都在），同一群并发时
 * 内存会停在较旧的值。串行后每次都基于上一次落盘结果，内存与磁盘顺序一致。
 */
const replyModeWriteQueues = new Map<string, Promise<void>>();

function serializeReplyModeWrite<T>(larkAppId: string, task: () => Promise<T>): Promise<T> {
  const previous = replyModeWriteQueues.get(larkAppId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  replyModeWriteQueues.set(larkAppId, tail);
  void tail.then(() => {
    if (replyModeWriteQueues.get(larkAppId) === tail) replyModeWriteQueues.delete(larkAppId);
  });
  return run;
}

export function setChatReplyMode(
  larkAppId: string,
  chatId: string,
  mode: ChatReplyMode,
): Promise<({ ok: true; mode: ChatReplyMode } & ChatReplyModeState) | { ok: false; reason: string }> {
  return serializeReplyModeWrite(larkAppId, () => setChatReplyModeNow(larkAppId, chatId, mode));
}

async function setChatReplyModeNow(
  larkAppId: string,
  chatId: string,
  mode: ChatReplyMode,
): Promise<({ ok: true; mode: ChatReplyMode } & ChatReplyModeState) | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // 显式设置一律落盘为群级覆盖，即使当前恰好等于 Bot 默认：否则日后改 Bot 默认会
  // 悄悄改变这个群。恢复继承只走 clearChatReplyMode（`/reply-mode inherit`）。
  const r = await rmwBotEntry<Record<string, ChatReplyMode>>(larkAppId, (entry) => {
    const next = normalizeChatReplyModeMap(entry.chatReplyModes);
    next[chatId] = mode;
    entry.chatReplyModes = next;
    return { write: true, result: next };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const othersResynced = !sameModesExcept(bot.config.chatReplyModes, r.result, chatId);
  bot.config.chatReplyModes = r.result;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=${mode}${othersResynced ? ' (resynced other chats from disk)' : ''}`);
  // 磁盘快照若同时改变了其它群（bots.json 被外部改过），按整表失效而不只本群。
  publishReplyPolicyChanged(othersResynced ? undefined : chatId);
  return { ok: true, mode, ...getChatReplyModeState(larkAppId, chatId) };
}

/** 删除群级覆盖，让本群重新跟随 Bot 默认。幂等：没有覆盖时 cleared=false。 */
export function clearChatReplyMode(
  larkAppId: string,
  chatId: string,
): Promise<({ ok: true; cleared: boolean } & ChatReplyModeState) | { ok: false; reason: string }> {
  return serializeReplyModeWrite(larkAppId, () => clearChatReplyModeNow(larkAppId, chatId));
}

async function clearChatReplyModeNow(
  larkAppId: string,
  chatId: string,
): Promise<({ ok: true; cleared: boolean } & ChatReplyModeState) | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ cleared: boolean; modes?: Record<string, ChatReplyMode> }>(larkAppId, (entry) => {
    const raw = entry.chatReplyModes;
    const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const cleared = rawRecord !== undefined && Object.prototype.hasOwnProperty.call(rawRecord, chatId);
    const next = normalizeChatReplyModeMap(raw);
    delete next[chatId];
    const modes = Object.keys(next).length > 0 ? next : undefined;
    if (!cleared) return { write: false, result: { cleared, modes } };
    if (modes) entry.chatReplyModes = modes;
    else delete entry.chatReplyModes;
    return { write: true, result: { cleared, modes } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // 即使是幂等空清除，也用磁盘快照覆盖内存，顺手修复陈旧的内存覆盖。这种重同步可能
  // 改变其它群（甚至本群）的生效策略：只要内存表实际变了就发失效事件，不论请求的 key
  // 在磁盘上是否存在——经飞书 `/reply-mode inherit` 触发时 dashboard 只能靠这条事件得知。
  const before = bot.config.chatReplyModes;
  const othersResynced = !sameModesExcept(before, r.result.modes, chatId);
  const selfChanged = before?.[chatId] !== r.result.modes?.[chatId];
  bot.config.chatReplyModes = r.result.modes;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=inherit cleared=${r.result.cleared}${othersResynced ? ' (resynced other chats from disk)' : ''}`);
  if (othersResynced) publishReplyPolicyChanged();
  else if (r.result.cleared || selfChanged) publishReplyPolicyChanged(chatId);
  return { ok: true, cleared: r.result.cleared, ...getChatReplyModeState(larkAppId, chatId) };
}

/** 两张覆盖表在忽略 `chatId` 之后是否完全相同（用于判断重同步是否波及其它群）。 */
function sameModesExcept(
  a: Record<string, ChatReplyMode> | undefined,
  b: Record<string, ChatReplyMode> | undefined,
  chatId: string,
): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  keys.delete(chatId);
  for (const key of keys) if (a?.[key] !== b?.[key]) return false;
  return true;
}

function normalizeChatReplyModeMap(raw: unknown): Record<string, ChatReplyMode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ChatReplyMode> = {};
  for (const [chatId, value] of Object.entries(raw)) {
    if (!chatId.trim() || typeof value !== 'string') continue;
    const mode = normalizeChatReplyMode(value);
    if (mode) out[chatId] = mode;
  }
  return out;
}

/**
 * Persist the per-chat @-requirement policy (`/mention-mode`). Same tidy rule as
 * setChatReplyMode: only store when it differs from the per-bot default, so
 * bots.json stays clean in the common case while an explicit opt-out still
 * sticks (e.g. per-bot default 'never', this chat pinned back to 'always').
 */
export async function setChatMentionMode(
  larkAppId: string,
  chatId: string,
  mode: GroupMentionMode,
): Promise<{ ok: true; mode: GroupMentionMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // Keep explicit intent for signed-default bots even if the proof cache is
  // cold/expired; removing a "redundant" topic override could re-enable ambient.
  const redundant = bot.config.signedChatDefaults !== true && mode === groupMentionDefaultMode(larkAppId);

  const r = await rmwBotEntry<GroupMentionMode>(larkAppId, (entry) => {
    if (!entry.chatMentionModes || typeof entry.chatMentionModes !== 'object' || Array.isArray(entry.chatMentionModes)) {
      entry.chatMentionModes = {};
    }
    if (redundant) {
      delete entry.chatMentionModes[chatId];
      if (Object.keys(entry.chatMentionModes).length === 0) delete entry.chatMentionModes;
    } else {
      entry.chatMentionModes[chatId] = mode;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const next = { ...(bot.config.chatMentionModes ?? {}) };
  if (redundant) delete next[chatId];
  else next[chatId] = mode;
  bot.config.chatMentionModes = Object.keys(next).length > 0 ? next : undefined;
  logger.info(`[mention-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  return { ok: true, mode };
}
