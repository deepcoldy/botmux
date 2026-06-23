/**
 * Per-bot 授权（/grant）相关偏好。与 card-prefs-store / brand-store 同款：
 * 跨进程文件锁 + bots.json 原子写，外加内存 registry 同步，让 daemon 的
 * 路由 / grant 处理不必重启即可生效。
 *
 * 三个独立设置：
 *   • restrictGrantCommands     — owner 开关：被授权人只能纯对话，拦截一切 slash 命令
 *   • autoGrantRequestCards     — 未授权者/外部 bot @ 本 bot 但被权限闸挡住时，是否自动发
 *                                 /grant 申请卡给 owner（默认开启；false 显式关闭）
 *   • messageQuota.defaultLimit — 消息额度默认值。字段「是否存在」本身就是额度机制
 *                                 总开关：缺省 = 关闭（无限）；正整数 = 不带数字的
 *                                 `/grant @x` 取此值。显式 `/grant @x N` 恒生效，与此无关。
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export interface BotGrantPrefs {
  /** owner 限制被授权人只能纯对话、拦截一切 slash 命令。默认 false。 */
  restrictGrantCommands: boolean;
  /** 未授权 @ 被挡住时是否自动发 grant 申请卡。默认 true。 */
  autoGrantRequestCards: boolean;
  /** 消息额度默认值：null = 关闭（无限）；正整数 = 不带数字的 /grant 取此值。 */
  messageQuotaDefaultLimit: number | null;
}

/** 把 entry.messageQuota.defaultLimit 归一成 number|null（只认正整数，其余视作关闭）。 */
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
      messageQuotaDefaultLimit: readQuotaLimit(c),
    };
  } catch {
    return { restrictGrantCommands: false, autoGrantRequestCards: true, messageQuotaDefaultLimit: null };
  }
}

/**
 * 持久化一次 grant-prefs 局部修改。只动 patch 里出现的 key。
 *   • restrictGrantCommands=false → 删 key（bots.json 保持干净，缺省即默认）
 *   • autoGrantRequestCards=true  → 删 key（默认开启）；false → 显式写 false
 *   • messageQuotaDefaultLimit=null → 删整个 messageQuota（关闭默认额度；不动 quotaState 计数）
 *   • messageQuotaDefaultLimit=正整数 → 写入；非法值（非整数/0/负数）直接拒，返回 bad_quota
 * 返回写后解析出的完整 prefs。
 */
export async function updateBotGrantPrefs(
  larkAppId: string,
  patch: Partial<BotGrantPrefs>,
): Promise<{ ok: true; prefs: BotGrantPrefs } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // 额度值校验：null 表示关闭；否则必须是正整数。
  if (patch.messageQuotaDefaultLimit !== undefined && patch.messageQuotaDefaultLimit !== null) {
    const n = patch.messageQuotaDefaultLimit;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      return { ok: false, reason: 'bad_quota' };
    }
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
    if (patch.messageQuotaDefaultLimit !== undefined) {
      if (patch.messageQuotaDefaultLimit === null) {
        // 关闭默认额度只删 messageQuota.defaultLimit 这个开关，保留 quotaState 计数。
        delete entry.messageQuota;
      } else {
        entry.messageQuota = { ...(entry.messageQuota ?? {}), defaultLimit: patch.messageQuotaDefaultLimit };
      }
    }
    return {
      write: true,
      result: {
        restrictGrantCommands: entry.restrictGrantCommands === true,
        autoGrantRequestCards: entry.autoGrantRequestCards !== false,
        messageQuotaDefaultLimit: readQuotaLimit(entry),
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
  if (patch.messageQuotaDefaultLimit !== undefined) {
    bot.config.messageQuota = patch.messageQuotaDefaultLimit === null
      ? undefined
      : { defaultLimit: patch.messageQuotaDefaultLimit };
  }
  logger.info(
    `[grant-prefs:${larkAppId}] restrictGrantCommands=${r.result.restrictGrantCommands} ` +
    `autoGrantRequestCards=${r.result.autoGrantRequestCards} ` +
    `messageQuotaDefaultLimit=${r.result.messageQuotaDefaultLimit ?? 'off'}`,
  );
  return { ok: true, prefs: r.result };
}
