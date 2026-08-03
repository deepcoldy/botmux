/**
 * Thin wrappers over Feishu IM v1 chat APIs for the dashboard's groups board.
 *
 * Phase B (Web Dashboard) — Task 24. These wrappers are stateless; they reuse
 * the per-bot Lark SDK client created by `bot-registry`.
 *
 * The "proxy bot" pattern in `addBotToChat`: Feishu requires the inviter to
 * already be a member of the chat, so the dashboard picks an existing-member
 * bot to do the invite. This wrapper just exposes the underlying call —
 * proxy selection happens at the route layer.
 */
import { getBot, getBotClient, getOwnerOpenId } from '../bot-registry.js';
import { larkGet, listChatBotMembers } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';

export interface ChatBrief {
  chatId: string;
  name?: string;
  description?: string;
  chatMode?: string;
  ownerId?: string;
  /** 群头像 URL（/open-apis/im/v1/chats 的 avatar 字段）。 */
  avatar?: string;
}

/**
 * List chats the given bot is a member of, draining pagination internally.
 * Uses /open-apis/im/v1/chats.
 */
export async function listChats(larkAppId: string): Promise<ChatBrief[]> {
  const client = getBotClient(larkAppId);
  const out: ChatBrief[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await larkGet(client, '/open-apis/im/v1/chats', {
      page_size: 100,
      user_id_type: 'open_id',
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    if (res.code !== 0 && res.code !== undefined) {
      throw new Error(`Failed to list chats: ${res.msg} (code: ${res.code})`);
    }
    for (const c of res.data?.items ?? []) {
      out.push({
        chatId: c.chat_id,
        name: c.name,
        description: c.description,
        chatMode: c.chat_mode,
        ownerId: c.owner_id,
        avatar: c.avatar,
      });
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return out;
}

/**
 * Check whether the given bot is a member of the given chat.
 * Uses /open-apis/im/v1/chats/:chat_id/members/is_in_chat — the bot's own
 * access token implicitly identifies the bot being checked.
 *
 * Errors (chat not found, no permission, etc.) are swallowed and treated as
 * "not in chat" so callers can use this as a simple boolean predicate.
 */
export async function isInChat(larkAppId: string, chatId: string): Promise<boolean> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`);
    if (res.code !== 0 && res.code !== undefined) return false;
    return !!res.data?.is_in_chat;
  } catch {
    return false;
  }
}

export type RenameChatResult =
  | { ok: true; oldName: string; newName: string; changed: boolean }
  | {
      ok: false;
      error: 'bot_not_in_chat' | 'permission_denied' | 'lark_api_error' | 'rate_limited';
      detail?: string;
      oldName?: string;
      newName?: string;
      larkCode?: number;
      retryAfterSeconds?: number;
    };

/**
 * Rename one chat using exactly the supplied bot identity.
 *
 * Deliberately does not try another configured bot on failure: callers use
 * this for session-scoped AI actions, where credential fallback would violate
 * the "the acting bot must itself be in the chat" boundary.
 */
export async function renameChat(
  larkAppId: string,
  chatId: string,
  newName: string,
  opts: {
    beforeUpdate?: () =>
      | { ok: true }
      | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };
  } = {},
): Promise<RenameChatResult> {
  const client = getBotClient(larkAppId);
  if (!await isInChat(larkAppId, chatId)) {
    return { ok: false, error: 'bot_not_in_chat' };
  }
  let oldName: string | undefined;
  try {
    const current: any = await larkGet(
      client,
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      { user_id_type: 'open_id' },
    );
    if (current.code !== 0 && current.code !== undefined) {
      return {
        ok: false,
        error: classifyRenameChatError(current.code),
        detail: `${current.msg ?? 'unknown'} (code: ${current.code})`,
      };
    }
    const fetchedOldName = typeof current.data?.name === 'string' ? current.data.name.trim() : '';
    oldName = fetchedOldName;
    if (fetchedOldName === newName) return { ok: true, oldName: fetchedOldName, newName, changed: false };
    const gate = opts.beforeUpdate?.();
    if (gate && !gate.ok) return { ...gate, oldName: fetchedOldName, newName };

    const updated: any = await (client as any).im.v1.chat.update({
      path: { chat_id: chatId },
      data: { name: newName },
    });
    if (updated.code !== 0 && updated.code !== undefined) {
      return {
        ok: false,
        error: classifyRenameChatError(updated.code),
        detail: `${updated.msg ?? 'unknown'} (code: ${updated.code})`,
        oldName: fetchedOldName,
        newName,
        larkCode: Number.isFinite(Number(updated.code)) ? Number(updated.code) : undefined,
      };
    }
    return { ok: true, oldName: fetchedOldName, newName, changed: true };
  } catch (e: any) {
    const detail = e?.message ?? String(e);
    return {
      ok: false,
      error: /permission|forbidden|99991672|2300\d/i.test(detail)
        ? 'permission_denied'
        : 'lark_api_error',
      detail,
      oldName,
      newName,
      larkCode: Number.isFinite(Number(e?.code)) ? Number(e.code) : undefined,
    };
  }
}

function classifyRenameChatError(code: unknown): 'permission_denied' | 'lark_api_error' {
  const numeric = Number(code);
  // Lark uses 99991672 for missing app scope; 230xxx errors cover common
  // chat-role / operation-permission failures.
  return numeric === 99991672 || (numeric >= 230000 && numeric < 231000)
    ? 'permission_denied'
    : 'lark_api_error';
}

/**
 * Create a brand-new chat with `bot_id_list` as initial bot members.  The
 * `creatorLarkAppId` bot becomes the chat's owner and an implicit member; the
 * other bots in `botIds` are added in the same call.  Used by the dashboard's
 * "Create new group" flow.
 *
 * Returns the new chatId on success.  Throws on any non-zero Lark response so
 * the route can surface a real error.  We deliberately don't soften failures
 * here (unlike `isInChat`) because the caller wants to know whether the chat
 * actually got created.
 */
export async function createChat(
  creatorLarkAppId: string,
  opts: {
    name?: string;
    botIds: string[];
    userIds?: string[];
    groupMessageType?: 'chat' | 'thread';
  },
): Promise<{ chatId: string; invalidBotIds: string[]; invalidUserIds: string[] }> {
  const client = getBotClient(creatorLarkAppId);
  // Filter out the creator from bot_id_list — Lark errors if the inviter
  // appears in their own invite list.
  const otherBots = opts.botIds.filter(id => id !== creatorLarkAppId);
  const userIds = (opts.userIds ?? []).filter(Boolean);
  const data: Record<string, unknown> = {};
  if (opts.name) data.name = opts.name;
  if (opts.groupMessageType) data.group_message_type = opts.groupMessageType;
  if (otherBots.length > 0) data.bot_id_list = otherBots;
  if (userIds.length > 0) data.user_id_list = userIds;
  const params: Record<string, unknown> = {};
  if (userIds.length > 0) params.user_id_type = 'open_id';
  const res: any = await (client as any).im.v1.chat.create({ data, params });
  if (res.code !== 0 && res.code !== undefined) {
    throw new Error(`Failed to create chat: ${res.msg ?? 'unknown'} (code: ${res.code})`);
  }
  return {
    chatId: res.data?.chat_id,
    invalidBotIds: res.data?.invalid_bot_id_list ?? [],
    invalidUserIds: res.data?.invalid_user_id_list ?? [],
  };
}

/**
 * Transfer ownership of a chat from the calling bot to a Feishu user.  Used
 * after `createChat` so the dashboard operator (who's been invited as a
 * member) ends up as the actual owner — otherwise the bot stays group owner
 * and the user can't manage the chat.
 *
 * Calls /open-apis/im/v1/chats/:chat_id with `owner_id` in the body and
 * `user_id_type=open_id`. The caller's bot must currently be the owner; this
 * is the case right after createChat since the creator bot is the implicit
 * owner.
 *
 * Defaults to open_id for existing callers. Deferred federation completion can
 * pass union_id after another deployment has added the user, avoiding any
 * cross-app open_id handoff.
 */
export async function transferChatOwner(
  ownerLarkAppId: string,
  chatId: string,
  newOwnerId: string,
  userIdType: 'open_id' | 'union_id' = 'open_id',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(ownerLarkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: userIdType },
      data: { owner_id: newOwnerId },
    });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Fetch the current owner of a chat (open_id by default, optionally union_id).
 * Used by group-creator to
 * verify the post-transfer state when transferChatOwner returns an error —
 * Lark sometimes ACKs a transfer slowly (e.g. 504 Gateway Timeout) even though
 * the server-side write succeeded, so a follow-up read disambiguates "really
 * failed" from "ACK lost".
 *
 * Returns undefined when the API itself errors or doesn't include owner_id;
 * callers treat undefined as "unknown" and keep the original error.
 */
export async function getChatOwner(
  larkAppId: string,
  chatId: string,
  userIdType: 'open_id' | 'union_id' = 'open_id',
): Promise<string | undefined> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      user_id_type: userIdType,
    });
    if (res.code !== 0 && res.code !== undefined) return undefined;
    const owner = res.data?.owner_id;
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get a shareable join link for a chat — the link others can click to *join*
 * the group, unlike the applink:// "open chat" URL which only works for members
 * who are already in the chat.
 *
 * Calls POST /open-apis/im/v1/chats/:chat_id/link. Accepted scope is any of
 * im:chat / im:chat:read / im:chat:readonly (the bot already holds im:chat:read,
 * verified at startup). `validity_period` is week | year | permanently.
 *
 * Not supported for p2p / secret / team chats — those return a non-zero code,
 * which we surface as an error so the caller can fall back to the applink.
 */
export async function getChatShareLink(
  larkAppId: string,
  chatId: string,
  validityPeriod: 'week' | 'year' | 'permanently' = 'permanently',
): Promise<{ ok: true; shareLink: string } | { ok: false; error: string }> {
  try {
    // getBotClient stays inside the try: this fetch is best-effort and must
    // never turn a successful group creation into a hard failure, so even a
    // bad/unconfigured larkAppId resolves to {ok:false}, not a thrown error.
    const client = getBotClient(larkAppId);
    const res: any = await (client as any).im.v1.chat.link({
      path: { chat_id: chatId },
      data: { validity_period: validityPeriod },
    });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    const shareLink = res.data?.share_link;
    if (typeof shareLink !== 'string' || shareLink.length === 0) {
      return { ok: false, error: 'empty share_link in response' };
    }
    return { ok: true, shareLink };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Disband (delete) a chat. The Lark API only succeeds when the calling bot is
 * the chat's current owner, OR is the creator AND the app holds
 * `im:chat:operate_as_owner`. Routes that fan-out to multiple bots can use
 * this best-effort: try each in-chat bot until one succeeds.
 */
export async function disbandChat(
  larkAppId: string, chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.delete({ path: { chat_id: chatId } });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Make the calling bot leave a chat.  Per Lark docs, self-removal succeeds
 * regardless of role (owner/manager/member). Useful when the bot can't disband
 * (not owner, no operate_as_owner scope) but still wants to detach.
 */
export async function leaveChat(
  larkAppId: string, chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chatMembers.delete({
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: [larkAppId] },
    });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Add bot apps to a chat using a "proxy" bot that's already a member.
 * Uses /open-apis/im/v1/chats/:chat_id/members with member_id_type=app_id.
 * Returns per-id result derived from the API's invalid_id_list.
 *
 * On total failure (network error, non-zero code) every id reports the same
 * error so the caller can present a uniform per-id status.
 */
export async function addBotToChat(
  proxyLarkAppId: string,
  chatId: string,
  targetLarkAppIds: string[],
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (targetLarkAppIds.length === 0) return [];
  const client = getBotClient(proxyLarkAppId);
  const out: { id: string; ok: boolean; error?: string }[] = [];
  try {
    const res: any = await (client as any).im.v1.chatMembers.create({
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: targetLarkAppIds },
    });
    if (res.code !== 0 && res.code !== undefined) {
      const errMsg = `${res.msg ?? 'unknown'} (code: ${res.code})`;
      for (const id of targetLarkAppIds) out.push({ id, ok: false, error: errMsg });
      return out;
    }
    const invalid = new Set<string>(res.data?.invalid_id_list ?? []);
    for (const id of targetLarkAppIds) {
      out.push(invalid.has(id) ? { id, ok: false, error: 'invalid_id' } : { id, ok: true });
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    for (const id of targetLarkAppIds) out.push({ id, ok: false, error: msg });
  }
  return out;
}

/**
 * Add USERS to an existing chat by **union_id** (tenant-stable, NOT app-scoped
 * like open_id). Used to pull bot owners into a federated group regardless of
 * which bot they paired through. Returns the union_ids Lark could not add.
 * Best-effort: total failure reports all ids invalid.
 *
 * Uses /open-apis/im/v1/chats/:chat_id/members with member_id_type=union_id.
 */
export async function addUsersToChatByUnionId(
  proxyLarkAppId: string,
  chatId: string,
  unionIds: string[],
): Promise<{ invalidUserIds: string[] }> {
  const ids = Array.from(new Set(unionIds.filter(Boolean)));
  if (ids.length === 0) return { invalidUserIds: [] };
  const client = getBotClient(proxyLarkAppId);
  // Add ONE id per call: Lark fails the WHOLE batch (HTTP 400, code 232024) if any
  // single union_id is outside the bot's app visibility scope — that would drop
  // valid owners too. Per-id calls isolate the out-of-scope ones so the rest land.
  const invalidUserIds: string[] = [];
  for (const id of ids) {
    try {
      const res: any = await (client as any).im.v1.chatMembers.create({
        path: { chat_id: chatId },
        params: { member_id_type: 'union_id' },
        data: { id_list: [id] },
      });
      if (res.code !== 0 && res.code !== undefined) {
        logger.warn(`[groups] addUsersByUnionId rejected: code=${res.code} msg=${res.msg} (proxy=${proxyLarkAppId})`);
        invalidUserIds.push(id);
      } else if ((res.data?.invalid_id_list ?? []).length) {
        invalidUserIds.push(id);
      }
    } catch (e: any) {
      // code 232024 = user not in app's visibility scope / no collaboration perm.
      const code = e?.response?.data?.code ?? e?.code;
      logger.warn(`[groups] addUsersByUnionId threw: code=${code} ${e?.message ?? e} (proxy=${proxyLarkAppId})`);
      invalidUserIds.push(id);
    }
  }
  return { invalidUserIds };
}

/**
 * 「进群自动拉 owner」：本 bot 被加进群（im.chat.member.bot.added_v1）时，把
 * 自己的 owner 拉进群——bot 应始终处于 owner 可见的群里（不打黑工；与
 * federated-group 的 owner-in-group 策略同源，这里是单点兜底，使任意来源的
 * 拉群动作（/invite、手动添加、平台批量添加）都收敛到同一行为）。
 *
 * 与 handleBotAdded 的 autoStart 流程完全解耦：不受 autoStartOnGroupJoin 开关
 * 影响、不 spawn 会话、失败只记日志不打扰群（飞书自身会展示「xx 邀请 xx 入群」
 * 系统消息，无需我们再发一条）。
 *
 * 用 open_id + 自身 app scope 即可（owner 是本 bot 配置里的用户，open_id 天然
 * 在本 app 域内；chatMembers.create 由本 bot 自己发起，已在群/无权限等一律容错）。
 */
export type OwnerGroupJoinResult = 'added' | 'already' | 'skipped' | 'failed';

export async function autoInviteOwnerOnGroupJoin(
  larkAppId: string,
  chatId: string,
  operatorOpenId?: string,
): Promise<OwnerGroupJoinResult> {
  let bot: ReturnType<typeof getBot>;
  let ownerOpenId: string | undefined;
  try {
    bot = getBot(larkAppId);
    ownerOpenId = getOwnerOpenId(larkAppId);
  } catch (e: any) {
    logger.warn(`[groups] autoInviteOwner: bot lookup failed for ${larkAppId}: ${e?.message ?? e}`);
    return 'failed';
  }
  // 显式 false 关闭（告警/oncall 类 bot 被平台批量拉群、不想打扰 owner 的场景）。
  if (bot.config.autoInviteOwnerOnGroupAdd === false) return 'skipped';
  if (!ownerOpenId) return 'skipped';
  // owner 自己把 bot 拉进来的 → 无需再拉。
  if (operatorOpenId && operatorOpenId === ownerOpenId) return 'already';

  const client = getBotClient(larkAppId);
  try {
    // 预查一次成员表避免对「owner 早已在群」的常态产生无意义写（也顺带发现
    // 无权限拉人场景的提前失败；查不到就照样 try-add，API 自身容错）。
    const params: Record<string, string> = { member_id_type: 'open_id', page_size: '100' };
    const res = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, params);
    if ((res.code === 0 || res.code === undefined) && Array.isArray(res.data?.items)) {
      if (res.data.items.some((it: any) => it?.member_id === ownerOpenId)) return 'already';
    }
  } catch {
    // 成员表拿不到不阻断（D7 同款思路：静默拿不到 ≠ 不在群），交给 add 的返回判定。
  }

  try {
    const res: any = await (client as any).im.v1.chatMembers.create({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
      data: { id_list: [ownerOpenId] },
    });
    if (res.code !== 0 && res.code !== undefined) {
      logger.warn(`[groups] autoInviteOwner rejected: code=${res.code} msg=${res.msg} (bot=${larkAppId} chat=${chatId})`);
      return 'failed';
    }
    if (Array.isArray(res.data?.invalid_id_list) && res.data.invalid_id_list.includes(ownerOpenId)) {
      logger.warn(`[groups] autoInviteOwner: owner open_id invalid (visibility scope?) (bot=${larkAppId} chat=${chatId})`);
      return 'failed';
    }
    logger.info(`[groups] autoInviteOwner: pulled owner into chat=${chatId} (bot=${larkAppId})`);
    return 'added';
  } catch (e: any) {
    const code = e?.response?.data?.code ?? e?.code;
    logger.warn(`[groups] autoInviteOwner threw: code=${code} ${e?.message ?? e} (bot=${larkAppId} chat=${chatId})`);
    return 'failed';
  }
}

export interface ChatMemberDisplay {
  openId: string;
  name: string;
  memberType: 'user' | 'bot' | 'unknown';
}

export async function listChatMemberDisplays(larkAppId: string, chatId: string): Promise<ChatMemberDisplay[]> {
  const client = getBotClient(larkAppId);
  const out: ChatMemberDisplay[] = [];
  const seen = new Map<string, number>();
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      member_id_type: 'open_id',
      page_size: '100',
      with_member_name: 'true',
    };
    if (pageToken) params.page_token = pageToken;
    const res: any = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, params);
    if (res.code !== 0 && res.code !== undefined) {
      throw new Error(`Failed to list chat members: ${res.msg} (code: ${res.code})`);
    }
    for (const item of res.data?.items ?? []) {
      const openId = String(item?.member_id ?? '').trim();
      if (!openId) continue;
      const name = String(item?.name ?? item?.member_name ?? item?.display_name ?? openId).trim() || openId;
      const typeRaw = String(item?.member_type ?? item?.type ?? '').trim();
      const memberType: ChatMemberDisplay['memberType'] = typeRaw === 'bot' || typeRaw === 'app'
        ? 'bot'
        : typeRaw === 'user' ? 'user' : 'unknown';
      seen.set(openId, out.length);
      out.push({ openId, name, memberType });
    }
    if (!res.data?.has_more || !res.data?.page_token) break;
    pageToken = res.data.page_token;
  }
  try {
    const bots = await listChatBotMembers(larkAppId, chatId);
    for (const bot of bots) {
      const openId = String(bot.openId ?? '').trim();
      if (!openId) continue;
      const name = String(bot.displayName ?? bot.name ?? openId).trim() || openId;
      const existing = seen.get(openId);
      if (existing === undefined) {
        seen.set(openId, out.length);
        out.push({ openId, name, memberType: 'bot' });
      } else {
        out[existing] = { openId, name, memberType: 'bot' };
      }
    }
  } catch (err) {
    logger.debug(`Failed to merge chat bot displays for ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
