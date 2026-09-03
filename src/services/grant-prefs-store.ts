/**
 * Per-bot 授权（/grant）相关偏好。与 card-prefs-store / brand-store 同款：
 * 跨进程文件锁 + bots.json 原子写，外加内存 registry 同步，让 daemon 的
 * 路由 / grant 处理不必重启即可生效。
 *
 * 五个独立设置：
 *   • restrictGrantCommands     — owner 开关：被授权人只能纯对话，拦截一切 slash 命令
 *   • autoGrantRequestCards     — 未授权者/外部 bot @ 本 bot 但被权限闸挡住时，是否自动发
 *                                 /grant 申请卡给 owner（默认开启；false 显式关闭）
 *   • p2pOpen                   — 私聊对话全开：任何人都能私聊本 bot（talk-only），免逐个
 *                                 加 globalGrants。只放行 canTalk，管理操作仍只认 allowedUsers。
 *   • messageQuota.defaultLimit — 授权卡/自助申请授权放进来的**访客**默认额度。缺省时
 *                                 使用内置 3 条。**Oncall 群恒不限额、不读此值**
 *                                 （历史上读过，见 event-dispatcher 的 oncallTalk）。
 *                                 显式 `/grant @x N` 恒生效，与此无关。
 *   • grantDefaultDurationMs    — 新授权卡默认有限时长。缺省 = 产品默认 1 小时；
 *                                 只接受授权卡已有的四个有限时长。
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import { isGrantDurationOption, MAX_GRANT_QUOTA } from './grant-policy.js';

export interface BotGrantPrefs {
  /** owner 限制被授权人只能纯对话、拦截一切 slash 命令。默认 false。 */
  restrictGrantCommands: boolean;
  /** 未授权 @ 被挡住时是否自动发 grant 申请卡。默认 true。 */
  autoGrantRequestCards: boolean;
  /** 私聊对话全开（talk-only，不授管理权）。默认 false。 */
  p2pOpen: boolean;
  /** 访客消息额度覆盖值：null = 授权卡内置 3 条；正整数 = 授权卡按该值。Oncall 恒不限额。 */
  messageQuotaDefaultLimit: number | null;
  /** 新授权默认有效期：null = 产品默认 1 小时；number = 卡片支持的有限时长（毫秒）。 */
  grantDefaultDurationMs: number | null;
}

/** 把 entry.messageQuota.defaultLimit 归一成 number|null（只认正整数，其余视作无覆盖）。 */
function readQuotaLimit(c: { messageQuota?: { defaultLimit?: number } }): number | null {
  const d = c.messageQuota?.defaultLimit;
  return typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : null;
}

/** Current grant prefs for a bot（缺省 restrict=false、quota=null）。 */
export function getBotGrantPrefs(larkAppId: string): BotGrantPrefs {
  try {
    const c = getBot(larkAppId).config;
    return {
      restrictGrantCommands: c.restrictGrantCommands === true,
      autoGrantRequestCards: c.autoGrantRequestCards !== false,
      p2pOpen: c.p2pOpen === true,
      messageQuotaDefaultLimit: readQuotaLimit(c),
      grantDefaultDurationMs: isGrantDurationOption(c.grantDefaultDurationMs)
        ? c.grantDefaultDurationMs
        : null,
    };
  } catch {
    return {
      restrictGrantCommands: false,
      autoGrantRequestCards: true,
      p2pOpen: false,
      messageQuotaDefaultLimit: null,
      grantDefaultDurationMs: null,
    };
  }
}

/**
 * 持久化一次 grant-prefs 局部修改。只动 patch 里出现的 key。
 *   • restrictGrantCommands=false → 删 key（bots.json 保持干净，缺省即默认）
 *   • autoGrantRequestCards=true  → 删 key（默认开启）；false → 显式写 false
 *   • p2pOpen=false → 删 key（缺省即关闭）；true → 显式写 true
 *   • messageQuotaDefaultLimit=null → 删整个 messageQuota（恢复授权卡内置 3 条；不动 quotaState）
 *   • messageQuotaDefaultLimit=1–1000 的整数 → 写入；其它值直接拒绝，返回 bad_quota
 *   • grantDefaultDurationMs=null → 删 key（恢复产品默认 1 小时）；合法有限时长 → 写入
 * 返回写后解析出的完整 prefs。
 */
export async function updateBotGrantPrefs(
  larkAppId: string,
  patch: Partial<BotGrantPrefs>,
): Promise<{ ok: true; prefs: BotGrantPrefs } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // 额度值校验：null 表示恢复内置策略；新写入必须与授权卡支持范围一致。
  if (patch.messageQuotaDefaultLimit !== undefined && patch.messageQuotaDefaultLimit !== null) {
    const n = patch.messageQuotaDefaultLimit;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > MAX_GRANT_QUOTA) {
      return { ok: false, reason: 'bad_quota' };
    }
  }
  if (patch.grantDefaultDurationMs !== undefined
    && patch.grantDefaultDurationMs !== null
    && !isGrantDurationOption(patch.grantDefaultDurationMs)) {
    return { ok: false, reason: 'bad_duration' };
  }

  const r = await rmwBotEntry<BotGrantPrefs>(larkAppId, (entry) => {
    if (patch.restrictGrantCommands !== undefined) {
      if (patch.restrictGrantCommands) entry.restrictGrantCommands = true;
      else delete entry.restrictGrantCommands;
    }
    if (patch.autoGrantRequestCards !== undefined) {
      if (patch.autoGrantRequestCards === false) entry.autoGrantRequestCards = false;
      else delete entry.autoGrantRequestCards;
    }
    if (patch.p2pOpen !== undefined) {
      // 与 parseBotConfigsFromText 一致：只落显式 true，关闭时删 key（bots.json 保持干净）。
      if (patch.p2pOpen) entry.p2pOpen = true;
      else delete entry.p2pOpen;
    }
    if (patch.messageQuotaDefaultLimit !== undefined) {
      if (patch.messageQuotaDefaultLimit === null) {
        // 恢复内置策略只删 messageQuota.defaultLimit，保留已有 quotaState 计数。
        delete entry.messageQuota;
      } else {
        entry.messageQuota = { ...(entry.messageQuota ?? {}), defaultLimit: patch.messageQuotaDefaultLimit };
      }
    }
    if (patch.grantDefaultDurationMs !== undefined) {
      if (patch.grantDefaultDurationMs === null) delete entry.grantDefaultDurationMs;
      else entry.grantDefaultDurationMs = patch.grantDefaultDurationMs;
    }
    return {
      write: true,
      result: {
        restrictGrantCommands: entry.restrictGrantCommands === true,
        autoGrantRequestCards: entry.autoGrantRequestCards !== false,
        p2pOpen: entry.p2pOpen === true,
        messageQuotaDefaultLimit: readQuotaLimit(entry),
        grantDefaultDurationMs: isGrantDurationOption(entry.grantDefaultDurationMs)
          ? entry.grantDefaultDurationMs
          : null,
      },
    };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // 同步内存 config，路由 / grant 处理不重启即生效。
  if (patch.restrictGrantCommands !== undefined) {
    bot.config.restrictGrantCommands = patch.restrictGrantCommands || undefined;
  }
  if (patch.autoGrantRequestCards !== undefined) {
    bot.config.autoGrantRequestCards = patch.autoGrantRequestCards === false ? false : undefined;
  }
  if (patch.p2pOpen !== undefined) {
    bot.config.p2pOpen = patch.p2pOpen || undefined;
    // 与 bot-registry 加载期同款告警：只开 p2pOpen 而没有管理员 = 谁都能私聊，
    // 但没人能执行需要 canOperate 的管理操作（p2pOpen 只授 canTalk）。⚠️ 唯一例外是
    // canTalkDaemonCommands 里被显式降级到 canTalk 的命令——那份名单非空时，私聊者
    // 也能执行它列出的命令，所以两个开关要一起权衡。
    if (patch.p2pOpen && (bot.config.allowedUsers?.length ?? 0) === 0) {
      const downgraded = bot.config.canTalkDaemonCommands ?? [];
      logger.warn(
        `[grant-prefs:${larkAppId}] p2pOpen 已开启但未配 allowedUsers：`
        + '任何人都能私聊，但没有人能执行 /restart、/cd、卡片按钮等管理操作。请补上 allowedUsers。'
        + (downgraded.length
          ? ` 另注意 canTalkDaemonCommands=[${downgraded.join(' ')}] 已被降级到「能对话即可用」，私聊者可执行。`
          : ''),
      );
    }
  }
  if (patch.messageQuotaDefaultLimit !== undefined) {
    bot.config.messageQuota = patch.messageQuotaDefaultLimit === null
      ? undefined
      : { defaultLimit: patch.messageQuotaDefaultLimit };
  }
  if (patch.grantDefaultDurationMs !== undefined) {
    bot.config.grantDefaultDurationMs = patch.grantDefaultDurationMs ?? undefined;
  }
  logger.info(
    `[grant-prefs:${larkAppId}] restrictGrantCommands=${r.result.restrictGrantCommands} ` +
    `autoGrantRequestCards=${r.result.autoGrantRequestCards} ` +
    `p2pOpen=${r.result.p2pOpen} ` +
    `messageQuotaDefaultLimit=${r.result.messageQuotaDefaultLimit ?? 'built-in'} ` +
    `grantDefaultDurationMs=${r.result.grantDefaultDurationMs ?? 'default'}`,
  );
  return { ok: true, prefs: r.result };
}
