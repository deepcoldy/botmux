/**
 * 群内授权：全局 allowedUsers（含 email 形式条目，bots.json）+ per-user talk 授权
 * （chatGrants / globalGrants 及其额度、有效期，持久层见 grant-state-store.ts）。
 * 授权状态的每次读改写都是一个事务（mutateGrantState），内存缓存按提交的操作回放同步；
 * /revoke 跨 allowedUsers 与授权两类数据，走 mutateBotEntryAndGrantState。
 */
import { getBot, getOwnerOpenId } from '../bot-registry.js';
import { republishResolvedAllowedUsersDescriptor } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { mutateBotEntryAndGrantState, mutateGrantState } from './grant-state-store.js';
import { objectGrantTx, parseGrantKey, type GrantTx } from './grant-state.js';
import { config } from '../config.js';
import { writeAllowedUsersResolveCache } from '../utils/allowed-users-cache.js';
import { logger } from '../utils/logger.js';

type Fail = { ok: false; reason: string };

// ─── 消息额度（scope-aware quota）─────────────────────────────────────────────
// quotaKey 的单一格式来源：chat 授权按群+人，global 授权按人。evaluateTalk 拼 key 时
// 复用这两个 builder，保证 store / enforce 两侧格式一致。
export function chatQuotaKey(chatId: string, openId: string): string { return `chat:${chatId}:${openId}`; }
export function globalQuotaKey(openId: string): string { return `global:${openId}`; }

/** 授权时套额度：quota>0 → 重置为 {limit,used:0}（续杯语义）；undefined → 删记录（转无限）。 */
function applyGrantQuota(tx: GrantTx, qk: string, quota: number | undefined): boolean {
  return quota !== undefined && quota > 0
    ? tx.quotaSet(qk, { limit: quota, used: 0 })
    : tx.quotaSet(qk, null);
}

/** 授权时套有效期；无有效期代表永久授权（删记录）。 */
function applyGrantExpiry(tx: GrantTx, grantKey: string, expiresAt: number | undefined): boolean {
  return tx.expirySet(
    grantKey,
    typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
  );
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
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = chatQuotaKey(chatId, openId);
  const r = await mutateGrantState<{ created: boolean }>(larkAppId, (tx) => {
    const created = tx.chatAdd(chatId, openId);
    // 带额度即（重）设记录；无额度则删除已有记录（转无限）。重新授权 = 续杯/重置。
    const qChanged = applyGrantQuota(tx, qk, quota);
    const expiryChanged = applyGrantExpiry(tx, qk, expiresAt);
    return { write: created || qChanged || expiryChanged, result: { created } };
  });
  if (!r.ok) return r;
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
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = globalQuotaKey(openId);
  const r = await mutateGrantState<{ created: boolean }>(larkAppId, (tx) => {
    const created = tx.globalAdd(openId);
    const qChanged = applyGrantQuota(tx, qk, quota);
    const expiryChanged = applyGrantExpiry(tx, qk, expiresAt);
    return { write: created || qChanged || expiryChanged, result: { created } };
  });
  if (!r.ok) return r;
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
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = chatQuotaKey(chatId, openId);
  const r = await mutateGrantState<{ removed: boolean }>(larkAppId, (tx) => {
    const removed = tx.chatRemove(chatId, openId);
    const qChanged = tx.quotaSet(qk, null);
    const expiryChanged = tx.expirySet(qk, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;
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
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const qk = globalQuotaKey(openId);
  const r = await mutateGrantState<{ removed: boolean }>(larkAppId, (tx) => {
    const removed = tx.globalRemove(openId);
    const qChanged = tx.quotaSet(qk, null);
    const expiryChanged = tx.expirySet(qk, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;
  logger.info(`[grant:${larkAppId}] -global ${openId} (quota exhausted/heal)`);
  return { ok: true, removed: r.result.removed };
}

/**
 * 仅当持久层中的过期时间仍等于观察值且确已到期时回收，避免异步清理误删刚续期的授权。
 */
export async function removeExpiredGrant(
  larkAppId: string,
  scope: 'chat' | 'global',
  chatId: string | undefined,
  openId: string,
  observedExpiresAt: number,
  now: number = Date.now(),
): Promise<{ ok: true; removed: boolean } | Fail> {
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const grantKey = scope === 'chat' ? chatQuotaKey(chatId!, openId) : globalQuotaKey(openId);
  const r = await mutateGrantState<{ removed: boolean }>(larkAppId, (tx) => {
    const current = tx.expiryGet(grantKey);
    if (current !== observedExpiresAt || current > now) {
      return { write: false, result: { removed: false } };
    }
    const removed = scope === 'chat' ? tx.chatRemove(chatId!, openId) : tx.globalRemove(openId);
    const qChanged = tx.quotaSet(grantKey, null);
    const expiryChanged = tx.expirySet(grantKey, null);
    return { write: removed || qChanged || expiryChanged, result: { removed } };
  });
  if (!r.ok) return r;
  if (r.result.removed) logger.info(`[grant:${larkAppId}] expired ${grantKey}`);
  return { ok: true, removed: r.result.removed };
}

/**
 * 回收本 bot 所有已到期的授权（成员 + 额度 + 有效期记录）。授权**只在过期时**自动回收：
 * 平时由 grantNotExpired 在对方下一条消息时顺手清，对方此后不再说话的过期授权会一直留着，
 * 由 daemon 启动时和定期调用本函数清掉。逐条走 removeExpiredGrant 的条件式清理，
 * 不会误删刚续期的授权。返回实际撤掉的授权数（只剩有效期记录、成员早已不在的也会清掉，但不计入）。
 */
export async function sweepExpiredGrants(larkAppId: string, now: number = Date.now()): Promise<number> {
  let expiry: { [grantKey: string]: { expiresAt: number } } | undefined;
  try { expiry = getBot(larkAppId).config.grantExpiryState; } catch { return 0; }
  let revoked = 0;
  for (const [grantKey, { expiresAt }] of Object.entries(expiry ?? {})) {
    if (expiresAt > now) continue;
    const parsed = parseGrantKey(grantKey);
    if (!parsed) continue;
    const r = await removeExpiredGrant(
      larkAppId,
      parsed.scope,
      parsed.scope === 'chat' ? parsed.chatId : undefined,
      parsed.openId,
      expiresAt,
      now,
    );
    if (r.ok && r.removed) revoked++;
  }
  return revoked;
}

/**
 * 扣一次额度（一条对话输入）。RMW 锁内递增、内存以锁内磁盘快照 used 为准。
 * 无记录 → tracked:false（无需 enforce，放行）。
 * 已达/超上限 → allow:false（应拦本条 + 自愈 revoke）。
 * 正常递增 → allow:true，exhausted=（used 恰好达 limit），调用方放行本条、若 exhausted 则处理后 revoke。
 * 基础设施失败（getBot / RMW）会 throw —— 调用方 catch 后 fail-closed（拒发以保硬上限）。
 *
 * defaultLimit>0 且 quotaKey 对应记录不存在时：懒初始化 {limit:defaultLimit, used:1}。
 * **当前生产路径下没有调用方会传入 defaultLimit**：它原是 oncall 腿的兜底，而 oncall 现在恒不挂
 * quotaKey（见 event-dispatcher.oncallTalk）；访客额度记录是发卡那一刻按 `defaultLimit ?? 3` 写好的。
 * 参数保留是为了不改签名（留作独立 cleanup），懒初始化分支因此也不再有生产调用方。
 *
 * `expiredGrant`（可选）：**同样已无生产产出方**。原是「oncall ∩ chatGrant 交集」用——传入时锁内以
 *   「本 key 的当前 expiry」为唯一权威判定，过期则原子清「成员+quota+expiry」并回落 default。
 *   oncall 不再挂 quotaKey 后这个描述符不再被产生（纯 chatGrant / globalGrant 的过期一直走
 *   grantNotExpired 拒发 + 条件式清理，与本参数无关）。逻辑保留、行为未改。
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
  const r = await mutateGrantState<Res>(larkAppId, (tx) => {
    // grantCleared: 事务内是否真的清掉了整条 grant（CAS 命中）；清掉了就必须落盘。
    let grantCleared = false;
    // 交集原子清理（收口在同一个事务，基于**事务内快照**而非陈旧 evaluate 观察值决策）：
    //   本 key 的**当前** expiry 存在且 <= now → grant 确已过期 → 原子清「成员+quota+expiry」，
    //   本条按「无记录」走 oncall default。否则（无 expiry=永久 / expiry 在未来=已续期）→ grant
    //   仍 live → 不兜 default，按现有记录消费（无记录=显式不限→保持不限）。以当前 expiry 为准，
    //   天然覆盖各交错时序：
    //     • 同一 expiry 仍过期 → 清；• 续期为未来/永久 → 不清、live；• 换成另一个但也已过期 → 照清
    //       （不遗留陈旧已耗尽 rec 误拒本条，也无需等下一条自愈）；• 已被别处整条清（无 expiry
    //       且非成员）→ 走「无 expiry」分支不清，按普通 oncall 回落 default。
    let initLimit = initLimitRaw;
    if (expiredGrant) {
      const cur = tx.expiryGet(quotaKey);
      if (cur !== undefined && cur <= now) {
        // 当前 expiry 确已过期 → 原子清整条 grant，回落 default
        if (expiredGrant.scope === 'chat' && expiredGrant.chatId) {
          tx.chatRemove(expiredGrant.chatId, expiredGrant.openId);
        } else if (expiredGrant.scope === 'global') {
          tx.globalRemove(expiredGrant.openId);
        }
        tx.quotaSet(quotaKey, null);
        tx.expirySet(quotaKey, null);
        grantCleared = true;
      } else {
        // 当前无 expiry（永久 / 已被整条清）或 expiry 在未来（已续期）→ grant 仍 live 或该用户已
        // 非成员：靠**当前是否仍是成员**决定是否抑制 default。
        //   • 仍是成员 → live grant（续期/改永久/永久不限）→ 不兜 default，按现有记录/不限消费；
        //   • 已非成员（被 revoke / 已被别处整条清）→ 普通 oncall 访客 → 回落 default（保留 initLimit）。
        const isMember = expiredGrant.scope === 'chat' && expiredGrant.chatId
          ? tx.chatHas(expiredGrant.chatId, expiredGrant.openId)
          : tx.globalHas(expiredGrant.openId);
        if (isMember) initLimit = 0; // 仍是成员且未过期 → live → 抑制 default
      }
    }
    const rec = tx.quotaGet(quotaKey);
    if (!rec) {
      if (!initLimit) return { write: grantCleared, result: { tracked: false, allow: true, exhausted: false, used: 0, limit: 0 } };
      // 懒初始化：defaultLimit 生效，首次命中即 used=1
      tx.quotaSet(quotaKey, { limit: initLimit, used: 1 });
      return { write: true, result: { tracked: true, allow: true, exhausted: 1 >= initLimit, used: 1, limit: initLimit } };
    }
    if (rec.used >= rec.limit) {
      return { write: false, result: { tracked: true, allow: false, exhausted: true, used: rec.used, limit: rec.limit } };
    }
    const used = rec.used + 1;
    tx.quotaSet(quotaKey, { limit: rec.limit, used });
    return { write: true, result: { tracked: true, allow: true, exhausted: used >= rec.limit, used, limit: rec.limit } };
  });
  if (!r.ok) throw new Error(`consumeQuota RMW failed: ${r.reason}`);
  // 已提交的成员/额度改动已按操作回放进内存；未写盘的「已超额」也把内存额度对齐到持久层快照。
  if (r.result.tracked) objectGrantTx(bot.config).quotaSet(quotaKey, { limit: r.result.limit, used: r.result.used });
  return r.result;
}

/**
 * Atomically charge one dispatch launch at most once. The durable receipt and
 * quota increment share one grant-state transaction, closing the crash window
 * between an irreversible charge and admission-store commit.
 */
export async function consumeDispatchLaunchQuotaOnce(
  input: { larkAppId: string; quotaKey: string; receiptId: string; sourceOpenId: string; grantChatId?: string },
): Promise<{ allow: boolean }> {
  const { larkAppId, quotaKey, receiptId, sourceOpenId, grantChatId } = input;
  getBot(larkAppId); // throw → 调用方 fail-closed
  const chargedAt = new Date().toISOString();
  const r = await mutateGrantState<{ allow: boolean }>(larkAppId, (tx) => {
    const existing = tx.receiptGet(receiptId);
    if (existing && typeof existing.allow === 'boolean') {
      return { write: false, result: { allow: existing.allow } };
    }
    const rec = tx.quotaGet(quotaKey);
    const chatGrantMatches = grantChatId !== undefined
      && quotaKey === chatQuotaKey(grantChatId, sourceOpenId)
      && tx.chatHas(grantChatId, sourceOpenId);
    const globalGrantMatches = grantChatId === undefined
      && quotaKey === globalQuotaKey(sourceOpenId)
      && tx.globalHas(sourceOpenId);
    const allow = (chatGrantMatches || globalGrantMatches) && (!rec || rec.used < rec.limit);
    if (allow && rec) {
      const quota = { limit: rec.limit, used: rec.used + 1 };
      tx.quotaSet(quotaKey, quota);
      if (quota.used >= quota.limit) {
        if (quotaKey.startsWith('chat:') && grantChatId) {
          tx.chatRemove(grantChatId, sourceOpenId);
        } else if (quotaKey.startsWith('global:')) {
          tx.globalRemove(sourceOpenId);
        }
        tx.quotaSet(quotaKey, null);
        tx.expirySet(quotaKey, null);
      }
    }
    tx.receiptSet(receiptId, { allow, chargedAt });
    return { write: true, result: { allow } };
  });
  if (!r.ok) throw new Error(`dispatch launch quota RMW failed: ${r.reason}`);
  return { allow: r.result.allow };
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
 * 彻底撤销：同一次读改写内删 chatGrants[chatId]、全局 allowedUsers（email 反查）与
 * globalGrants（全局对话授权）。bots.json 后端下三支同一次落盘；SQLite 后端下授权事务嵌在
 * bots.json 锁内先提交（见 mutateBotEntryAndGrantState）。三重防开放守卫只约束 allowedUsers 这一支（operate/owner 安全），
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
  const r = await mutateBotEntryAndGrantState<Res | { guard: 'would_open_bot' }>(larkAppId, (entry, tx) => {
    const rawList: string[] = Array.isArray(entry.allowedUsers) ? entry.allowedUsers : [];
    const willRemoveGlobal = !!rawEntry && rawList.includes(rawEntry);
    // R3#3：在锁内、对最新磁盘快照判定——移除全局会清空 allowlist 则拒绝（防并发删空）。
    if (willRemoveGlobal && rawList.filter(u => u !== rawEntry).length === 0) {
      return { entryChanged: false, grantsChanged: false, result: { guard: 'would_open_bot' as const } };
    }
    const chat = tx.chatRemove(chatId, openId);
    let global = false;
    if (willRemoveGlobal) {
      entry.allowedUsers = rawList.filter((u: string) => u !== rawEntry);
      global = true;
    }
    // 全局对话授权（talk-only）：从 globalGrants 移除 open_id。与 allowedUsers 无关，
    // 因此不受 would_open_bot 守卫约束（清空它只是收回对话权，不会让 bot 对所有人开放 operate）。
    const globalTalk = tx.globalRemove(openId);
    // 手动 /revoke 一并清两 scope 的额度与有效期记录（与三支授权同一次读改写）。
    const qChat = tx.quotaSet(chatQuotaKey(chatId, openId), null);
    const qGlobal = tx.quotaSet(globalQuotaKey(openId), null);
    const eChat = tx.expirySet(chatQuotaKey(chatId, openId), null);
    const eGlobal = tx.expirySet(globalQuotaKey(openId), null);
    return {
      entryChanged: global,
      grantsChanged: chat || globalTalk || qChat || qGlobal || eChat || eGlobal,
      result: { chat, global, globalTalk },
    };
  });
  if (!r.ok) return r;
  if ('guard' in r.result) return { ok: false, reason: r.result.guard };

  // 授权侧的内存缓存已按提交的操作回放；这里只同步 allowedUsers 这一支。
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
    // retainKeys 必须并上 blockedUsers：sidecar 与黑名单共用，/revoke 写回不得
    // 把黑名单的 raw→ou_ 缓存剪掉（否则 contact API 降级期重启会让 email/on_
    // 形式的黑名单条目解析为空而漏拦，P1c）。
    if (rawEntry) {
      writeAllowedUsersResolveCache(config.session.dataDir, larkAppId, {
        map: {},
        deleteEntries: [rawEntry],
        retainKeys: [...new Set([...(bot.config.allowedUsers ?? []), ...(bot.config.blockedUsers ?? [])])],
      });
    }
    republishResolvedAllowedUsersDescriptor(larkAppId, bot.resolvedAllowedUsers);
  }
  logger.info(`[grant:${larkAppId}] revoke chat=${chatId} ${openId} removed=${JSON.stringify(r.result)}`);
  return { ok: true, removed: r.result };
}
