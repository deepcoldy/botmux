/**
 * 授权卡处置人（approver / owner）解析与管理员判定。
 *
 * 核心设计：
 * 1. 管理员（owner / co-owners）：只取 resolvedAllowedUsers 中已解析出的 ou_。
 *    raw ownerOpenId 仅用于解析失败时的 DM 兜底，不得绕过 allowlist 闸门。
 * 2. 群内授权申请卡（maybeSendGrantRequestCard / requestGrantForAskClicker）：
 *    若群里有管理员，优先 @ 当前群内的管理员（按配置优先级排序）；
 *    避免在群 A 里触发授权时，@ 了一个根本不在本群的管理员打扰对方，导致群内可见的管理员反而收不到提醒。
 *    若群内无任何管理员或非群聊，回落至全局主 owner。
 *    自助申请（maybeSendGrantRequestCard）另走 resolveGrantRequestRoute：会话里没有管理员时
 *    （p2p、或群里查不到管理员），卡片改投主 owner 私聊，否则群外 owner 根本点不到卡。
 * 3. 授权卡操作闸门与 /grant 权限闸门：允许该 bot 的任意有效管理员（owner 或 co-owner）处置。
 */
import { getBot, getOwnerOpenId } from '../../bot-registry.js';
import { listChatMemberOpenIds } from './client.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';

/**
 * 获取 bot 的所有管理员 open_id 候选列表（保持 allowlist 优先级顺序）。
 * 只有 resolvedAllowedUsers 中已解析出的 ou_ 才能成为管理员，保持 fail-closed。
 */
export function getBotAdminOpenIds(larkAppId: string): string[] {
  try {
    const bot = getBot(larkAppId);
    return [...new Set((bot.resolvedAllowedUsers ?? []).filter(u => typeof u === 'string' && u.startsWith('ou_')))];
  } catch {
    return [];
  }
}

/**
 * 校验 openId 是否为当前 bot 的有效管理员（owner 或 co-owner）。
 */
export function isBotAdmin(larkAppId: string, openId: string | undefined): boolean {
  if (!openId) return false;
  return getBotAdminOpenIds(larkAppId).includes(openId);
}

interface MemberCacheEntry {
  members: Set<string>;
  expiresAt: number;
}
const chatMemberCache = new BoundedMap<string, MemberCacheEntry>(1000);
const inFlightRequests = new Map<string, Promise<string[]>>();
const CACHE_TTL_MS = 60_000;

export function clearChatMemberCache(): void {
  chatMemberCache.clear();
  inFlightRequests.clear();
}

async function getChatMemberSet(
  larkAppId: string,
  chatId: string,
  fetcher: (larkAppId: string, chatId: string) => Promise<string[]>,
): Promise<Set<string>> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const now = Date.now();
  const cached = chatMemberCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.members;
  }

  let inFlight = inFlightRequests.get(cacheKey);
  if (!inFlight) {
    inFlight = fetcher(larkAppId, chatId).finally(() => {
      inFlightRequests.delete(cacheKey);
    });
    inFlightRequests.set(cacheKey, inFlight);
  }

  const list = await inFlight;
  const set = new Set(list);
  chatMemberCache.set(cacheKey, { members: set, expiresAt: Date.now() + CACHE_TTL_MS });
  return set;
}

export interface ResolveGrantApproverDeps {
  listChatMemberOpenIds?: (larkAppId: string, chatId: string) => Promise<string[]>;
  getBotAdminOpenIds?: (larkAppId: string) => string[];
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
}

/**
 * 决定在特定会话中，授权申请卡应该 @ 哪位管理员处置。
 *
 * 策略：
 * 1. 获取该 bot 的所有管理员候选人（按 resolvedAllowedUsers 配置顺序；显式
 *    ownerOpenId 只有仍在该解析结果中时才提升优先级）。
 * 2. 若只有一个管理员（或无群 chatId / 非群聊），直接取该唯一/全局管理员（零额外网络开销）。
 * 3. 若为群聊且有多个候选管理员：
 *    - 优先检查传入 message 中的 mentions，若直接包含了某位候选管理员，且其在群中，立即可用；
 *    - 查询该群的群成员列表（带 60s 内存缓存与并发收敛），从候选管理员中按优先级挑出首个“当前群成员”；
 *    - 若候选管理员中有且仅有部分在群里，命中第一个在群管理员（例如：主 owner 不在群，但 co-owner 在群，则 @ co-owner，避免 ping 群外人员）；
 *    - 若所有管理员均不在当前群（或查群成员失败），兜底回落至全局主 owner。
 */
export async function resolveGrantApprover(
  larkAppId: string,
  chatId?: string,
  message?: any,
  deps: ResolveGrantApproverDeps = {},
): Promise<string | undefined> {
  const getAdmins = deps.getBotAdminOpenIds ?? getBotAdminOpenIds;
  const getOwner = deps.getOwnerOpenId ?? getOwnerOpenId;
  const listMembers = deps.listChatMemberOpenIds ?? listChatMemberOpenIds;

  const owner = getOwner(larkAppId);
  const adminCandidates = getAdmins(larkAppId);
  const candidates = owner && !adminCandidates.includes(owner) ? [owner, ...adminCandidates] : adminCandidates;
  const fallbackOwner = owner ?? candidates[0];
  if (!fallbackOwner) return undefined;

  // 只有一个候选人或非群聊，无需网络往返，直接返回。测试依赖不能改变
  // 生产判据，否则测试会覆盖生产永远走不到的分支。
  const isLarkChat = typeof chatId === 'string' && chatId.startsWith('oc_');
  if (candidates.length <= 1 || !isLarkChat) {
    return fallbackOwner;
  }

  // 快速路径：如果消息显式 @ 了候选管理员之一，飞书群里只能 @ 群成员，优先命中
  if (message?.mentions && Array.isArray(message.mentions)) {
    const mentionedOpenIds = new Set<string>();
    for (const m of message.mentions) {
      const openId = m?.id?.open_id ?? m?.open_id;
      if (typeof openId === 'string') mentionedOpenIds.add(openId);
    }
    const mentionedAdmin = candidates.find(admin => mentionedOpenIds.has(admin));
    if (mentionedAdmin) {
      return mentionedAdmin;
    }
  }

  try {
    const memberSet = await getChatMemberSet(larkAppId, chatId, listMembers);
    const inChatAdmin = candidates.find(admin => memberSet.has(admin));
    if (inChatAdmin) {
      return inChatAdmin;
    }
  } catch (err) {
    logger.debug(`[grant] Failed to list chat members for ${chatId}: ${err}`);
  }

  return fallbackOwner;
}

/**
 * 授权申请卡的投递路线：
 * - `in_chat`：卡片回复在原会话里，由会话内的管理员处置（原行为）；
 * - `dm`：会话里没有任何管理员可点卡片，改投 approver 自己的私聊。
 */
export interface GrantRequestRoute {
  approver: string;
  delivery: 'in_chat' | 'dm';
}

/**
 * 决定无权限者自助申请（maybeSendGrantRequestCard）的卡片投给谁、投在哪。
 *
 * 与 resolveGrantApprover 的区别：后者只挑「@ 谁」，单管理员时零网络开销直接回主 owner，
 * 无法区分「owner 在群里」和「兜底回落」。这里需要这个区分，所以群聊恒查一次群成员
 * （复用同一份 60s 缓存）：
 * - p2p：会话里只有申请人和 bot，管理员必然不在 → `dm` 给主 owner；
 * - 群聊且消息显式 @ 了某位管理员 → `in_chat`（飞书只能 @ 群成员）；
 * - 群成员里有管理员 → `in_chat`，@ 按配置优先级的首位在群管理员；
 * - 群成员查询成功但没有任何管理员 → `dm` 给主 owner；
 * - 查询失败 / 非飞书群 id → `in_chat` 回落主 owner（与改动前一致，fail 到旧行为）。
 */
export async function resolveGrantRequestRoute(
  larkAppId: string,
  chatId: string | undefined,
  chatType: 'p2p' | 'group',
  message?: any,
  deps: ResolveGrantApproverDeps = {},
): Promise<GrantRequestRoute | undefined> {
  const getAdmins = deps.getBotAdminOpenIds ?? getBotAdminOpenIds;
  const getOwner = deps.getOwnerOpenId ?? getOwnerOpenId;
  const listMembers = deps.listChatMemberOpenIds ?? listChatMemberOpenIds;

  const owner = getOwner(larkAppId);
  const adminCandidates = getAdmins(larkAppId);
  const candidates = owner && !adminCandidates.includes(owner) ? [owner, ...adminCandidates] : adminCandidates;
  const fallbackOwner = owner ?? candidates[0];
  if (!fallbackOwner) return undefined;

  if (chatType === 'p2p') return { approver: fallbackOwner, delivery: 'dm' };
  if (typeof chatId !== 'string' || !chatId.startsWith('oc_')) {
    return { approver: fallbackOwner, delivery: 'in_chat' };
  }

  if (message?.mentions && Array.isArray(message.mentions)) {
    const mentionedOpenIds = new Set<string>();
    for (const m of message.mentions) {
      const openId = m?.id?.open_id ?? m?.open_id;
      if (typeof openId === 'string') mentionedOpenIds.add(openId);
    }
    const mentionedAdmin = candidates.find(admin => mentionedOpenIds.has(admin));
    if (mentionedAdmin) return { approver: mentionedAdmin, delivery: 'in_chat' };
  }

  try {
    const memberSet = await getChatMemberSet(larkAppId, chatId, listMembers);
    const inChatAdmin = candidates.find(admin => memberSet.has(admin));
    return inChatAdmin
      ? { approver: inChatAdmin, delivery: 'in_chat' }
      : { approver: fallbackOwner, delivery: 'dm' };
  } catch (err) {
    logger.debug(`[grant] Failed to list chat members for ${chatId}: ${err}`);
    return { approver: fallbackOwner, delivery: 'in_chat' };
  }
}
