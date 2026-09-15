/**
 * `/fork --create` 专属群的进程内登记表。
 *
 * `/fork --create` 把分身会话固定注册为 **chat-scope，anchor = 新群 chatId**
 * （新群是空的，这是唯一稳定的路由锚点）。但目标 Bot 的普通群默认回复模式若是
 * `new-topic`，新群的顶层入站消息会被 event-dispatcher 路由成 thread-scope、
 * anchor = 当前消息 messageId —— 每条消息都是一个新锚点，永远命不中分身会话，
 * 于是误建空白会话并弹仓库选择卡（issue #1400）。
 *
 * 修复分两层，本模块是第二层（进程内安全网）：
 *
 *   1. 持久真相：`/fork --create` 在建群时把该群的 per-chat 回复模式钉成
 *      `chat-topic`（写入 bots.json 的 chatReplyModes，跨重启生效，可用
 *      `/reply-mode` 再改）。所有常规路由读取的仍是 resolveRegularGroupMode
 *      这唯一真相源，不为 fork 群发明第二套持久配置。
 *
 *   2. 进程内安全网：createChat 一返回 chatId 就同步登记到这里，覆盖
 *      「建群 → 钉模式落盘」之间数百毫秒的竞态窗口——期间用户已被加进群，
 *      可能立刻发消息；bot.added 事件也可能在此窗口投递。路由层
 *      （regularGroupRouting）与入群自动开工（handleBotAdded）都查本表：
 *      专属群里顶层消息一律平铺到 chatId，自动开工让位给分身会话。
 *
 * 本表不持久化：重启后第 1 层的 per-chat 钉模式已足以让路由归位（bot.added
 * 不会为存量群重放）；restoreActiveSessions 仍会把磁盘上的 chat-scope 分身
 * 行重新登记进来，作为钉模式曾经落盘失败时的兜底。
 */

const forkDestinationChats = new Set<string>();

function entryKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}␦${chatId}`;
}

/** 标记一个群为 `/fork --create` 分身专属群（幂等）。 */
export function markForkDestinationChat(larkAppId: string, chatId: string): void {
  forkDestinationChats.add(entryKey(larkAppId, chatId));
}

/**
 * 用户在该群显式执行 `/reply-mode` 后退出 fork 路由保护。
 *
 * 语义优先级（issue #1400 收敛）：用户对该群的显式 per-chat 设置 > fork marker
 * （仅覆盖建群竞态 / restore 兜底）> Bot 全局默认。显式切换由
 * chat-reply-mode-store 的 setChatReplyMode 调用本函数，保证内存态不再强制平铺。
 * （持久侧的退出信号是 per-chat chatReplyModes 条目本身，重启后路由读显式模式，
 * marker 由 restore 兜底重建也不会再压过它。）
 */
export function unmarkForkDestinationChat(larkAppId: string, chatId: string): void {
  forkDestinationChats.delete(entryKey(larkAppId, chatId));
}

/** 该群是否是 `/fork --create` 建出的分身专属群（本进程内建群或本进程恢复出分身会话）。 */
export function isForkDestinationChat(larkAppId: string, chatId: string): boolean {
  return forkDestinationChats.has(entryKey(larkAppId, chatId));
}

/**
 * 启动恢复兜底：从持久化会话行重新登记 fork 专属群。
 *
 * `/fork --create` 的子会话行为 group chat-scope 且带 `forkedFrom`（同群子话题
 * fork 是 thread-scope，不在此列）。建群时写入的 per-chat chat-topic 钉模式是持久
 * 真相；本兜底覆盖「钉模式曾落盘失败 / daemon 在落盘前重启」的情况，依据是子会话
 * 行本身。只改进程内状态，不在恢复路径写任何配置。
 */
export function markForkDestinationChatsFromSessions(
  sessions: ReadonlyArray<{
    forkedFrom?: string;
    scope?: string;
    chatType?: string;
    chatId?: string | null;
    larkAppId?: string | null;
  }>,
): void {
  for (const session of sessions) {
    if (
      session.forkedFrom
      && session.scope === 'chat'
      && (session.chatType ?? 'group') === 'group'
      && session.chatId
      && session.larkAppId
    ) {
      markForkDestinationChat(session.larkAppId, session.chatId);
    }
  }
}

/** 测试隔离用：清空登记表。 */
export function __clearForkDestinationChatsForTest(): void {
  forkDestinationChats.clear();
}
