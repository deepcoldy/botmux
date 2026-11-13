import type { BotState } from '../bot-registry.js';

/**
 * 是否配置了任何白名单（限制态）。判定用 **原始** config.allowedUsers, 不用
 * resolvedAllowedUsers——否则「配了 owner 但启动时邮箱/union 解析失败 → resolved 为空」
 * 会 fall through 成「无白名单 = 全开放」，把误配/解析失败 fail-open 成谁都能 operate。
 * 配了就算限制态：解析为空时成员判定一律落空 → fail-closed（由 owner 修配置）。
 *
 * canOperate / evaluateTalk（event-dispatcher）与项目无主会话认领的 canHumanOperateBot
 * 共用这一个判定，避免各自维护字段清单而漂移。独立成模块（只引类型）是为了不改变
 * 整体 mock bot-registry 的测试的导出面。
 */
export function botHasConfiguredAllowlist(bot: Pick<BotState, 'config'>): boolean {
  return (bot.config.allowedUsers?.length ?? 0) > 0
    || (bot.config.allowedChatGroups?.length ?? 0) > 0
    || (bot.config.globalGrants?.length ?? 0) > 0
    || !!bot.config.ownerOpenId
    // p2pOpen 也是一次显式的权限边界声明：配了它 = 进入限制态。否则「只配 p2pOpen、
    // 没配 allowedUsers」会 fall through 到 open 模式，把**群聊**和 **canOperate** 一起
    // 放开（陌生人能 /restart /cd），与 p2pOpen「只开私聊 talk」的语义正好相反。
    // 此时若没配 allowedUsers → 谁都不能 operate（fail-closed），bot-registry 会告警。
    || bot.config.p2pOpen === true;
}
