/**
 * 群内授权持久化：全局 allowedUsers（含 email 形式条目）+ per-chat chatGrants。
 * 写路径走 config-store 的跨进程锁；撤销在单个 RMW 内同删 chat+global（原子）。
 */
import { getBot, getOwnerOpenId } from '../bot-registry.js';
import { republishResolvedAllowedUsersDescriptor } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { config } from '../config.js';
import { writeAllowedUsersResolveCache } from '../utils/allowed-users-cache.js';
import { logger } from '../utils/logger.js';

type Fail = { ok: false; reason: string };

// ─── 消息额度（scope-aware quota）─────────────────────────────────────────────
// quotaKey 的单一格式来源：chat 授权按群+人，global 授权按人。evaluateTalk 拼 key 时
// 复用这两个 builder，保证 store / enforce 两侧格式一致。
export function chatQuotaKey(chatId: string, openId: string): string { return `chat:${chatId}:${openId}`; }
export function globalQuotaKey(openId: string): string { return `global:${openId}`; }

type QuotaRec = { limit: number; used: number };
type QuotaMap = { [k: string]: QuotaRec };
type ExpiryRec = { expiresAt: number };
type ExpiryMap = { [k: string]: ExpiryRec };

/** 取 quotaState（容错：非对象/数组 → undefined）。entry（磁盘原始）与 bot.config 同形，通用。 */
function getQuotaMap(o: any): QuotaMap | undefined {
  return (o.quotaState && typeof o.quotaState === 'object' && !Array.isArray(o.quotaState)) ? o.quotaState : undefined;
}
/** 写/删一条 quota 记录（rec=null 删）。返回是否实际改动。空 map 删键。 */
function setQuotaRecord(o: any, qk: string, rec: QuotaRec | null): boolean {
  const qs = getQuotaMap(o);
  if (rec) { o.quotaState = { ...(qs ?? {}), [qk]: rec }; return true; }
  if (qs && qk in qs) {
    const next = { ...qs }; delete next[qk];
    if (Object.keys(next).length > 0) o.quotaState = next; else delete o.quotaState;
    return true;
  }
  return false;
}
/** 授权时套额度：quota>0 → 重置为 {limit,used:0}（续杯语义）；undefined → 删记录（转无限）。 */
function applyGrantQuota(o: any, qk: string, quota: number | undefined): boolean {
  return quota !== undefined && quota > 0
    ? setQuotaRecord(o, qk, { limit: quota, used: 0 })
    : setQuotaRecord(o, qk, null);
}

function getExpiryMap(o: any): ExpiryMap | undefined {
  return (o.grantExpiryState && typeof o.grantExpiryState === 'object' && !Array.isArray(o.grantExpiryState))
    ? o.grantExpiryState
    : undefined;
}

/** 写/删一条授权有效期；无有效期代表永久授权。 */
function setExpiryRecord(o: any, grantKey: string, expiresAt: number | null): boolean {
  const state = getExpiryMap(o);
  if (expiresAt !== null) {
    o.grantExpiryState = { ...(state ?? {}), [grantKey]: { expiresAt } };
    return true;
  }
  if (!state || !(grantKey in state)) return false;
  const next = { ...state };
  delete next[grantKey];
  if (Object.keys(next).length > 0) o.grantExpiryState = next;
  else delete o.grantExpiryState;
  return true;
}

function applyGrantExpiry(o: any, grantKey: string, expiresAt: number | undefined): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0
    ? setExpiryRecord(o, grantKey, expiresAt)
    : setExpiryRecord(o, grantKey, null);
}

export function getGrantExpiresAt(larkAppId: string, grantKey: string): number | undefined {
  const rec = getBot(larkAppId).config.grantExpiryState?.[grantKey];
  return typeof rec?.expiresAt === 'number' ? rec.expiresAt : undefined;
}

/** 把目标 open_id 映射回 allowedUsers 里的 raw 条目（可能是 email，也可能就是 open_id）。 */
function rawEntryForOpenId(larkAppId: string, openId: string): string | undefined {
  const bot = getBot(larkAppId);
  for (const [raw, resolved] of bot.rawAllowedUserResolution.entries()) {
    if (resolved === openId) return raw;
  }
  // 无解析映射时：raw 里若直接是该 open_id，返回它自身。
  return bot.config.allowedUsers?.includes(openId) ? openId : undefined;
}

/** 移除目标后运行时 open_id 集合（R2#3：按 resolved 判，不看 raw 长度）。 */
function resolvedAfterRemoval(larkAppId: string, openId: string): string[] {
  return getBot(larkAppId).resolvedAllowedUsers.filter(u => u !== openId);
}

export async function addChatGrant(
  larkAppId: string, chatId: string, openId: string, quota?: number, expiresAt?: number,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = chatQuotaKey(chatId, openId);
  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
    const cur: string[] = Array.isArray(map[chatId]) ? map[chatId] : [];
    const created = !cur.includes(openId);
    if (created) cur.push(openId);
    map[chatId] = cur;
    entry.chatGrants = map;
    // 带额度即（重）设记录；无额度则删除已有记录（转无限）。重新授权 = 续杯/重置。
    const qChanged = applyGrantQuota(entry, qk, quota);
    const expiryChanged = applyGrantExpiry(entry, qk, expiresAt);
    return { write: created || qChanged || expiryChanged, result: { created } };
  });
  if (!r.ok) return r;
  if (r.result.created) {
    const map = (bot.config.chatGrants ??= {});
    if (!map[chatId]?.includes(openId)) map[chatId] = [...(map[chatId] ?? []), openId];
  }
  applyGrantQuota(bot.config, qk, quota); // 同步内存
  applyGrantExpiry(bot.config, qk, expiresAt);
  logger.info(`[grant:${larkAppId}] +chat ${chatId} ${openId}${quota ? ` quota=${quota}` : ''}${expiresAt ? ` expiresAt=${expiresAt}` : ''}`);
  return { ok: true, created: r.result.created };
}

/**
 * 全局对话授权：把 open_id 加入 globalGrants（被授权在任意群与本 bot 对话的名单，人/bot 通用）。
 * talk-only —— 只进 canTalk / bot 路由闸，绝不写 allowedUsers、不授 canOperate（与 addChatGrant 同源）。
 */
export async function addGlobalGrant(
  larkAppId: string, openId: string, quota?: number, expiresAt?: number,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = globalQuotaKey(openId);
  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.globalGrants) ? entry.globalGrants : [];
    const created = !cur.includes(openId);
    if (created) cur.push(openId);
    entry.globalGrants = cur;
    const qChanged = applyGrantQuota(entry, qk, quota);
    const expiryChanged = applyGrantExpiry(entry, qk, expiresAt);
    return { write: created || qChanged || expiryChanged, result: { created } };
  });
  if (!r.ok) return r;
  if (r.result.created && !bot.config.globalGrants?.includes(openId)) {
    bot.config.globalGrants = [...(bot.config.globalGrants ?? []), openId];
  }
  applyGrantQuota(bot.config, qk, quota); // 同步内存
  applyGrantExpiry(bot.config, qk, expiresAt);
  logger.info(`[grant:${larkAppId}] +global ${openId}${quota ? ` quota=${quota}` : ''}${expiresAt ? ` expiresAt=${expiresAt}` : ''}`);
  return { ok: true, created: r.result.created };
}

/**
 * scope-aware talk-only 移除：删本群 chatGrants[chatId] 中的 openId + 其 chat quota 记录。
 * 额度用尽/崩溃自愈时调。不碰 allowedUsers、不碰 globalGrants，故无 would_open_bot 守卫。
 */
export async function removeChatGrant(
  larkAppId: string, chatId: string, openId: string,
): Promise<{ ok: true; removed: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = chatQuotaKey(chatId, openId);
  const r = await rmwBotEntry<{ removed: boolean }>(larkAppId, (entry) => {
    let removed = false;
    const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
    if (Array.isArray(map[chatId]) && map[chatId].includes(openId)) {
      map[chatId] = map[chatId].filter((u: string) => u !== openId);
      if (map[chatId].length === 0) delete map[chatId];
      entry.chatGrants = map;
      removed = true;
    }
    const qChanged = setQuotaRecord(entry, qk, null);
    const expiryChanged = setExpiryRecord(entry, qk, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;
  if (r.result.removed && bot.config.chatGrants?.[chatId]) {
    bot.config.chatGrants[chatId] = bot.config.chatGrants[chatId].filter(u => u !== openId);
    if (bot.config.chatGrants[chatId].length === 0) delete bot.config.chatGrants[chatId];
  }
  setQuotaRecord(bot.config, qk, null);
  setExpiryRecord(bot.config, qk, null);
  logger.info(`[grant:${larkAppId}] -chat ${chatId} ${openId} (quota exhausted/heal)`);
  return { ok: true, removed: r.result.removed };
}

/**
 * scope-aware talk-only 移除：删 globalGrants 中的 openId + 其 global quota 记录。
 * talk-only，不碰 allowedUsers，无 would_open_bot 守卫（清空它不放大 operate）。
 */
export async function removeGlobalGrant(
  larkAppId: string, openId: string,
): Promise<{ ok: true; removed: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = globalQuotaKey(openId);
  const r = await rmwBotEntry<{ removed: boolean }>(larkAppId, (entry) => {
    let removed = false;
    const gg: string[] = Array.isArray(entry.globalGrants) ? entry.globalGrants : [];
    if (gg.includes(openId)) {
      const next = gg.filter((u: string) => u !== openId);
      if (next.length > 0) entry.globalGrants = next; else delete entry.globalGrants;
      removed = true;
    }
    const qChanged = setQuotaRecord(entry, qk, null);
    const expiryChanged = setExpiryRecord(entry, qk, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;
  if (r.result.removed) {
    const next = (bot.config.globalGrants ?? []).filter(u => u !== openId);
    if (next.length > 0) bot.config.globalGrants = next; else delete bot.config.globalGrants;
  }
  setQuotaRecord(bot.config, qk, null);
  setExpiryRecord(bot.config, qk, null);
  logger.info(`[grant:${larkAppId}] -global ${openId} (quota exhausted/heal)`);
  return { ok: true, removed: r.result.removed };
}

/**
 * 仅当磁盘中的过期时间仍等于观察值且确已到期时回收，避免异步清理误删刚续期的授权。
 */
export async function removeExpiredGrant(
  larkAppId: string,
  scope: 'chat' | 'global',
  chatId: string | undefined,
  openId: string,
  observedExpiresAt: number,
  now: number = Date.now(),
): Promise<{ ok: true; removed: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const grantKey = scope === 'chat' ? chatQuotaKey(chatId!, openId) : globalQuotaKey(openId);
  const r = await rmwBotEntry<{ removed: boolean }>(larkAppId, (entry) => {
    const current = getExpiryMap(entry)?.[grantKey]?.expiresAt;
    if (current !== observedExpiresAt || current > now) {
      return { write: false, result: { removed: false } };
    }
    let removed = false;
    if (scope === 'chat') {
      const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
      if (Array.isArray(map[chatId!]) && map[chatId!].includes(openId)) {
        map[chatId!] = map[chatId!].filter((id: string) => id !== openId);
        if (map[chatId!].length === 0) delete map[chatId!];
        entry.chatGrants = map;
        removed = true;
      }
    } else {
      const grants: string[] = Array.isArray(entry.globalGrants) ? entry.globalGrants : [];
      if (grants.includes(openId)) {
        const next = grants.filter(id => id !== openId);
        if (next.length > 0) entry.globalGrants = next;
        else delete entry.globalGrants;
        removed = true;
      }
    }
    const qChanged = setQuotaRecord(entry, grantKey, null);
    const expiryChanged = setExpiryRecord(entry, grantKey, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;

  if (r.result.removed && getExpiryMap(bot.config)?.[grantKey]?.expiresAt === observedExpiresAt) {
    if (scope === 'chat' && bot.config.chatGrants?.[chatId!]) {
      bot.config.chatGrants[chatId!] = bot.config.chatGrants[chatId!].filter(id => id !== openId);
      if (bot.config.chatGrants[chatId!].length === 0) delete bot.config.chatGrants[chatId!];
    } else if (scope === 'global') {
      const next = (bot.config.globalGrants ?? []).filter(id => id !== openId);
      if (next.length > 0) bot.config.globalGrants = next;
      else delete bot.config.globalGrants;
    }
    setQuotaRecord(bot.config, grantKey, null);
    setExpiryRecord(bot.config, grantKey, null);
    logger.info(`[grant:${larkAppId}] expired ${grantKey}`);
  }
  return { ok: true, removed: r.result.removed };
}

/**
 * 扣一次额度（一条对话输入）。RMW 锁内递增、内存以锁内磁盘快照 used 为准。
 * 无记录 → tracked:false（无需 enforce，放行）。
 * 已达/超上限 → allow:false（应拦本条 + 自愈 revoke）。
 * 正常递增 → allow:true，exhausted=（used 恰好达 limit），调用方放行本条、若 exhausted 则处理后 revoke。
 * 基础设施失败（getBot / RMW）会 throw —— 调用方 catch 后 fail-closed（拒发以保硬上限）。
 *
 * defaultLimit>0 且 quotaKey 对应记录不存在时：懒初始化 {limit:defaultLimit, used:1}
 * （oncall 群默认额度场景，避免每条消息都要显式 /grant 才落记录）。
 *
 * `expiredGrant`（可选）：oncall ∩ chatGrant 交集用。传入时**锁内**以「本 key 的**当前** expiry」
 *   为唯一权威判定（不看调用方 evaluate 时的观察值——那可能已陈旧）：
 *   • 当前 expiry 存在且 <= now → grant 确已过期 → 同一把锁内原子清「成员+quota+expiry」，本条
 *     按「grant 已消失」处理（回落 defaultLimit 懒初始化 / 无 default 则 tracked:false）。
 *   • 当前无 expiry / expiry 在未来（永久/已续期）→ 仍是成员则 grant **live**：不兜 default，按现有
 *     记录消费（无记录=显式不限→tracked:false）；已非成员（被 revoke/整条清）→ 普通 oncall→回落 default。
 * 这样「过期清理 + 本次 oncall 额度决策」收口在同一原子 RMW，杜绝跨 await 用陈旧 ev 决策。
 */
export async function consumeQuota(
  larkAppId: string,
  quotaKey: string,
  defaultLimit?: number,
  expiredGrant?: { scope: 'chat' | 'global'; chatId?: string; openId: string; now?: number },
): Promise<{ tracked: boolean; allow: boolean; exhausted: boolean; used: number; limit: number }> {
  const bot = getBot(larkAppId); // throw → 调用方 fail-closed
  type Res = { tracked: boolean; allow: boolean; exhausted: boolean; used: number; limit: number };
  const initLimitRaw = typeof defaultLimit === 'number' && Number.isInteger(defaultLimit) && defaultLimit > 0 ? defaultLimit : 0;
  const now = expiredGrant?.now ?? Date.now();
  // grantCleared: RMW 锁内是否真的清掉了整条 grant（CAS 命中）。内存同步据此，而非从 tracked 反推。
  let grantCleared = false;
  const r = await rmwBotEntry<Res>(larkAppId, (entry) => {
    // 交集原子清理（收口在同一把锁，基于**当锁快照**而非陈旧 evaluate 观察值决策）：
    //   本 key 的**当前** expiry 存在且 <= now → grant 确已过期 → 原子清「成员+quota+expiry」，
    //   本条按「无记录」走 oncall default。否则（无 expiry=永久 / expiry 在未来=已续期）→ grant
    //   仍 live → 不兜 default，按现有记录消费（无记录=显式不限→保持不限）。以当前 expiry 为准，
    //   天然覆盖各交错时序：
    //     • 同一 expiry 仍过期 → 清；• 续期为未来/永久 → 不清、live；• 换成另一个但也已过期 → 照清
    //       （不遗留陈旧已耗尽 rec 误拒本条，也无需等下一条自愈）；• 已被别处整条清（无 expiry
    //       且非成员）→ 走「无 expiry」分支不清，按普通 oncall 回落 default。
    let initLimit = initLimitRaw;
    if (expiredGrant) {
      const cur = getExpiryMap(entry)?.[quotaKey]?.expiresAt;
      if (cur !== undefined && cur <= now) {
        // 当前 expiry 确已过期 → 原子清整条 grant，回落 default
        if (expiredGrant.scope === 'chat' && expiredGrant.chatId) {
          const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
          if (Array.isArray(map[expiredGrant.chatId]) && map[expiredGrant.chatId].includes(expiredGrant.openId)) {
            map[expiredGrant.chatId] = map[expiredGrant.chatId].filter((id: string) => id !== expiredGrant.openId);
            if (map[expiredGrant.chatId].length === 0) delete map[expiredGrant.chatId];
            entry.chatGrants = map;
          }
        } else if (expiredGrant.scope === 'global') {
          const grants: string[] = Array.isArray(entry.globalGrants) ? entry.globalGrants : [];
          if (grants.includes(expiredGrant.openId)) {
            const next = grants.filter(id => id !== expiredGrant.openId);
            if (next.length > 0) entry.globalGrants = next; else delete entry.globalGrants;
          }
        }
        setQuotaRecord(entry, quotaKey, null);
        setExpiryRecord(entry, quotaKey, null);
        grantCleared = true;
      } else {
        // 当前无 expiry（永久 / 已被整条清）或 expiry 在未来（已续期）→ grant 仍 live 或该用户已
        // 非成员：靠**当前是否仍是成员**决定是否抑制 default。
        //   • 仍是成员 → live grant（续期/改永久/永久不限）→ 不兜 default，按现有记录/不限消费；
        //   • 已非成员（被 revoke / 已被别处整条清）→ 普通 oncall 访客 → 回落 default（保留 initLimit）。
        const isMember = expiredGrant.scope === 'chat' && expiredGrant.chatId
          ? !!(entry.chatGrants?.[expiredGrant.chatId]?.includes?.(expiredGrant.openId))
          : Array.isArray(entry.globalGrants) && entry.globalGrants.includes(expiredGrant.openId);
        if (isMember) initLimit = 0; // 仍是成员且未过期 → live → 抑制 default
      }
    }
    const qs = getQuotaMap(entry);
    const rec = qs?.[quotaKey];
    if (!rec) {
      if (!initLimit) return { write: grantCleared, result: { tracked: false, allow: true, exhausted: false, used: 0, limit: 0 } };
      // 懒初始化：defaultLimit 生效，首次命中即 used=1
      entry.quotaState = { ...(qs ?? {}), [quotaKey]: { limit: initLimit, used: 1 } };
      return { write: true, result: { tracked: true, allow: true, exhausted: 1 >= initLimit, used: 1, limit: initLimit } };
    }
    if (rec.used >= rec.limit) {
      return { write: false, result: { tracked: true, allow: false, exhausted: true, used: rec.used, limit: rec.limit } };
    }
    const used = rec.used + 1;
    entry.quotaState = { ...qs, [quotaKey]: { limit: rec.limit, used } };
    return { write: true, result: { tracked: true, allow: true, exhausted: used >= rec.limit, used, limit: rec.limit } };
  });
  if (!r.ok) throw new Error(`consumeQuota RMW failed: ${r.reason}`);
  // 内存同步：① 若锁内清掉了整条 grant（CAS 命中）→ 先同步删内存的成员+quota+expiry；
  //           ② 再按扣费结果同步 quota 记录（tracked 写快照 / 否则无记录）。两步独立，互不遮蔽。
  if (grantCleared) {
    setQuotaRecord(bot.config, quotaKey, null);
    setExpiryRecord(bot.config, quotaKey, null);
    if (expiredGrant!.scope === 'chat' && expiredGrant!.chatId && bot.config.chatGrants?.[expiredGrant!.chatId]) {
      bot.config.chatGrants[expiredGrant!.chatId] = bot.config.chatGrants[expiredGrant!.chatId].filter(id => id !== expiredGrant!.openId);
      if (bot.config.chatGrants[expiredGrant!.chatId].length === 0) delete bot.config.chatGrants[expiredGrant!.chatId];
    } else if (expiredGrant!.scope === 'global') {
      const next = (bot.config.globalGrants ?? []).filter(id => id !== expiredGrant!.openId);
      if (next.length > 0) bot.config.globalGrants = next; else delete bot.config.globalGrants;
    }
  }
  if (r.result.tracked) setQuotaRecord(bot.config, quotaKey, { limit: r.result.limit, used: r.result.used });
  return r.result;
}

/**
 * 整群 talk 授权：把 chatId 加入 allowedChatGroups（"talk-open 的 chat_id 列表"）。
 * 命中后该 chat 任何成员都过 canTalk（见 event-dispatcher.canTalk），不授 canOperate。
 */
export async function addAllowedChatGroup(
  larkAppId: string, chatId: string,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.allowedChatGroups) ? entry.allowedChatGroups : [];
    const created = !cur.includes(chatId);
    if (created) cur.push(chatId);
    entry.allowedChatGroups = cur;
    return { write: created, result: { created } };
  });
  if (!r.ok) return r;
  if (r.result.created) {
    bot.config.allowedChatGroups = [...(bot.config.allowedChatGroups ?? []), chatId];
    logger.info(`[grant:${larkAppId}] +chatGroup ${chatId}`);
  }
  return { ok: true, created: r.result.created };
}

/** 撤销整群 talk 授权：把 chatId 从 allowedChatGroups 移除。 */
export async function removeAllowedChatGroup(
  larkAppId: string, chatId: string,
): Promise<{ ok: true; removed: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<{ removed: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.allowedChatGroups) ? entry.allowedChatGroups : [];
    const removed = cur.includes(chatId);
    const next = cur.filter((c: string) => c !== chatId);
    if (next.length > 0) entry.allowedChatGroups = next;
    else delete entry.allowedChatGroups;
    return { write: removed, result: { removed } };
  });
  if (!r.ok) return r;
  if (r.result.removed) {
    const next = (bot.config.allowedChatGroups ?? []).filter(c => c !== chatId);
    if (next.length > 0) bot.config.allowedChatGroups = next;
    else delete bot.config.allowedChatGroups;
    logger.info(`[grant:${larkAppId}] -chatGroup ${chatId}`);
  }
  return { ok: true, removed: r.result.removed };
}

/**
 * 原子彻底撤销：同一 RMW 内删 chatGrants[chatId]、全局 allowedUsers（email 反查）与
 * globalGrants（全局对话授权）。三重防开放守卫只约束 allowedUsers 这一支（operate/owner 安全），
 * chatGrants / globalGrants 是 talk-only，删空不会让 bot 对所有人开放 operate，无需守卫：
 *   #2  禁止撤销当前 owner 本人（否则 owner 身份会漂移到别人）。
 *   R2#3 移除后运行时 resolvedAllowedUsers 不能变空（catch 未解析 email 导致 resolved 空）。
 *   R3#3 在 RMW 锁内按最新磁盘 entry 再判一次（catch 并发写把 allowlist 删空）。
 */
export async function revokeGrant(
  larkAppId: string, chatId: string, openId: string,
): Promise<{ ok: true; removed: { chat: boolean; global: boolean; globalTalk: boolean } } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // #2：owner 本人不可撤。
  if (openId === getOwnerOpenId(larkAppId)) return { ok: false, reason: 'would_open_bot' };

  const rawEntry = rawEntryForOpenId(larkAppId, openId); // email / open_id / undefined
  // R2#3：进程内 resolved 视角的早判（含未解析 email 兜底），失败给即时反馈。
  if (rawEntry && resolvedAfterRemoval(larkAppId, openId).length === 0) {
    return { ok: false, reason: 'would_open_bot' };
  }

  type Res = { chat: boolean; global: boolean; globalTalk: boolean };
  const r = await rmwBotEntry<Res | { guard: 'would_open_bot' }>(larkAppId, (entry) => {
    const rawList: string[] = Array.isArray(entry.allowedUsers) ? entry.allowedUsers : [];
    const willRemoveGlobal = !!rawEntry && rawList.includes(rawEntry);
    // R3#3：在锁内、对最新磁盘快照判定——移除全局会清空 allowlist 则拒绝（防并发删空）。
    if (willRemoveGlobal && rawList.filter(u => u !== rawEntry).length === 0) {
      return { write: false, result: { guard: 'would_open_bot' as const } };
    }
    let chat = false, global = false, globalTalk = false;
    const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
    if (Array.isArray(map[chatId]) && map[chatId].includes(openId)) {
      map[chatId] = map[chatId].filter((u: string) => u !== openId);
      if (map[chatId].length === 0) delete map[chatId];
      chat = true;
    }
    entry.chatGrants = map;
    if (willRemoveGlobal) {
      entry.allowedUsers = rawList.filter((u: string) => u !== rawEntry);
      global = true;
    }
    // 全局对话授权（talk-only）：从 globalGrants 移除 open_id。与 allowedUsers 无关，
    // 因此不受 would_open_bot 守卫约束（清空它只是收回对话权，不会让 bot 对所有人开放 operate）。
    const gg: string[] = Array.isArray(entry.globalGrants) ? entry.globalGrants : [];
    if (gg.includes(openId)) {
      const next = gg.filter((u: string) => u !== openId);
      if (next.length > 0) entry.globalGrants = next; else delete entry.globalGrants;
      globalTalk = true;
    }
    // 手动 /revoke 一并清两 scope 的额度记录（与三支授权同 RMW 原子）。
    const qChat = setQuotaRecord(entry, chatQuotaKey(chatId, openId), null);
    const qGlobal = setQuotaRecord(entry, globalQuotaKey(openId), null);
    const eChat = setExpiryRecord(entry, chatQuotaKey(chatId, openId), null);
    const eGlobal = setExpiryRecord(entry, globalQuotaKey(openId), null);
    return { write: chat || global || globalTalk || qChat || qGlobal || eChat || eGlobal, result: { chat, global, globalTalk } };
  });
  if (!r.ok) return r;
  if ('guard' in r.result) return { ok: false, reason: r.result.guard };

  // 同步内存
  if (r.result.chat && bot.config.chatGrants?.[chatId]) {
    bot.config.chatGrants[chatId] = bot.config.chatGrants[chatId].filter(u => u !== openId);
    if (bot.config.chatGrants[chatId].length === 0) delete bot.config.chatGrants[chatId];
  }
  if (r.result.global) {
    if (rawEntry) {
      bot.config.allowedUsers = (bot.config.allowedUsers ?? []).filter(u => u !== rawEntry);
      bot.rawAllowedUserResolution.delete(rawEntry);
    }
    bot.resolvedAllowedUsers = bot.resolvedAllowedUsers.filter(u => u !== openId);
    // Keep the last-known-good sidecar + dashboard descriptor in lockstep with
    // the revoke. Drop the revoked raw key from the cache (retainKeys = the
    // post-revoke config) so a later restart during an API blip cannot revive
    // the just-revoked user from a stale cache. republish so create-group's
    // creator picker doesn't keep offering the removed open_id.
    if (rawEntry) {
      writeAllowedUsersResolveCache(config.session.dataDir, larkAppId, {
        map: {},
        deleteEntries: [rawEntry],
        retainKeys: bot.config.allowedUsers ?? [],
      });
    }
    republishResolvedAllowedUsersDescriptor(larkAppId, bot.resolvedAllowedUsers);
  }
  if (r.result.globalTalk) {
    const next = (bot.config.globalGrants ?? []).filter(u => u !== openId);
    if (next.length > 0) bot.config.globalGrants = next; else delete bot.config.globalGrants;
  }
  // 同步内存额度记录（两 scope）
  setQuotaRecord(bot.config, chatQuotaKey(chatId, openId), null);
  setQuotaRecord(bot.config, globalQuotaKey(openId), null);
  setExpiryRecord(bot.config, chatQuotaKey(chatId, openId), null);
  setExpiryRecord(bot.config, globalQuotaKey(openId), null);
  logger.info(`[grant:${larkAppId}] revoke chat=${chatId} ${openId} removed=${JSON.stringify(r.result)}`);
  return { ok: true, removed: r.result };
}
