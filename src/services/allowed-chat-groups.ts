import type { BotState } from '../bot-registry.js';
import { hasOwnerEntry } from '../setup/bot-config-editor.js';
import { logger } from '../utils/logger.js';

/**
 * allowedChatGroups 现在是"talk-open 的 chat_id 列表"（见 event-dispatcher.canTalk）：
 * 当前消息来自其中之一即放行 canTalk，成员关系隐含在"能在该 chat 发言"里，
 * 因此不再启动时解析群成员、不存快照（退群者发不了言自动失权、新人进群即生效）。
 *
 * 这里只做一次配置校验：配了群授权却没 owner 时告警 —— 群成员能对话，但 operate
 * 对所有人关闭（含 owner）。setup 已拦交互式配置，这里兜底手动改 bots.json 的情况。
 */
export function checkAllowedChatGroupsConfig(bot: BotState): void {
  const chatIds = bot.config.allowedChatGroups ?? [];
  if (chatIds.length === 0) return;
  if (!hasOwnerEntry(bot.config.allowedUsers)) {
    logger.warn(
      `[${bot.config.larkAppId}] allowedChatGroups is configured but allowedUsers has no owner (full email address or open_id): ` +
      'chat members can talk, but sensitive operations such as /restart, /close, and /grant are unavailable to everyone. Configure at least one owner in allowedUsers.',
    );
  }
}
