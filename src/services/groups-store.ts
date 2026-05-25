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
import { getBotClient } from '../bot-registry.js';
import { larkGet } from '../im/lark/client.js';

export interface ChatBrief {
  chatId: string;
  name?: string;
  description?: string;
  chatMode?: string;
  ownerId?: string;
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
  opts: { name?: string; botIds: string[]; userIds?: string[] },
): Promise<{ chatId: string; invalidBotIds: string[]; invalidUserIds: string[] }> {
  const client = getBotClient(creatorLarkAppId);
  // Filter out the creator from bot_id_list — Lark errors if the inviter
  // appears in their own invite list.
  const otherBots = opts.botIds.filter(id => id !== creatorLarkAppId);
  const userIds = (opts.userIds ?? []).filter(Boolean);
  const data: Record<string, unknown> = {};
  if (opts.name) data.name = opts.name;
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
 * `newOwnerOpenId` must be in the calling bot's app scope — Lark open_ids are
 * app-scoped, see operator-selector.ts for why.
 */
export async function transferChatOwner(
  ownerLarkAppId: string,
  chatId: string,
  newOwnerOpenId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(ownerLarkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
      data: { owner_id: newOwnerOpenId },
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
 * Fetch the current owner of a chat (as an open_id). Used by group-creator to
 * verify the post-transfer state when transferChatOwner returns an error —
 * Lark sometimes ACKs a transfer slowly (e.g. 504 Gateway Timeout) even though
 * the server-side write succeeded, so a follow-up read disambiguates "really
 * failed" from "ACK lost".
 *
 * Returns undefined when the API itself errors or doesn't include owner_id;
 * callers treat undefined as "unknown" and keep the original error.
 */
export async function getChatOwner(
  larkAppId: string, chatId: string,
): Promise<string | undefined> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      user_id_type: 'open_id',
    });
    if (res.code !== 0 && res.code !== undefined) return undefined;
    const owner = res.data?.owner_id;
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
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
