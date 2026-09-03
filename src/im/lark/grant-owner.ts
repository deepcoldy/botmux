/**
 * 授权卡处置人（approver / owner）解析与管理员判定。
 *
 * 核心设计：
 * 1. 管理员（owner / co-owners）：取 bot 配置的 static ownerOpenId 与 resolvedAllowedUsers 中的全部 ou_。
 * 2. 群内授权申请卡（maybeSendGrantRequestCard / requestGrantForAskClicker）：
 *    若群里有管理员，优先 @ 当前群内的管理员（按配置优先级排序）；
 *    避免在群 A 里触发授权时，@ 了一个根本不在本群的管理员打扰对方，导致群内可见的管理员反而收不到提醒。
 *    若群内无任何管理员或非群聊，回落至全局主 owner。
 * 3. 授权卡操作闸门与 /grant 权限闸门：允许该 bot 的任意有效管理员（owner 或 co-owner）处置。
 */
import { getBot, getOwnerOpenId } from '../../bot-registry.js';
import { listChatMemberOpenIds } from './client.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';

/**
 * 获取 bot 的所有管理员 open_id 候选列表（保持优先级顺序）：
 * 1. 配置中显式指定的 ownerOpenId（若为 ou_）
 * 2. resolvedAllowedUsers 中的所有 ou_ 用户（已通过飞书联系人真实性校验，保持 fail-closed）
 */
export function getBotAdminOpenIds(larkAppId: string): string[] {
  try {
    const bot = getBot(larkAppId);
    const out: string[] = [];
    if (bot.config.ownerOpenId && typeof bot.config.ownerOpenId === 'string' && bot.config.ownerOpenId.startsWith('ou_')) {
      out.push(bot.config.ownerOpenId);
    }
    for (const u of (bot.resolvedAllowedUsers ?? [])) {
      if (typeof u === 'string' && u.startsWith('ou_') && !out.includes(u)) {
        out.push(u);
      }
    }
    return out;
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
 * 1. 获取该 bot 的所有管理员候选人（按配置顺序：ownerOpenId、resolvedAllowedUsers 等）。
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

  // 只有一个候选人或非群聊，无需网络往返，直接返回
  const isLarkChat = chatId && (chatId.startsWith('oc_') || deps.listChatMemberOpenIds !== undefined);
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
