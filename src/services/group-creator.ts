/**
 * Group creation service — execution layer shared by dashboard and CLI.
 *
 * Decision layers (dashboard handler / CLI subcommand) are responsible for
 * choosing `creatorLarkAppId`, resolving bot refs, deriving user_open_ids, etc.
 * This service only orchestrates the Lark API sequence:
 *
 *   1. createChat (bots + invited users)
 *   2. transferChatOwner (best-effort, skipped if invitee was rejected)
 *   3. send @-mention notify (best-effort, skipped if invitee was rejected)
 *
 * Partial failures (transfer/notify) are returned as `*Error` fields without
 * throwing — the chat already exists at that point and retrying would create
 * duplicate groups. Only createChat throwing surfaces as an exception.
 *
 * Lark open_id is app-scoped: `userOpenIds`, `transferOwnerTo`, and
 * `notifyOwnerOpenId` MUST be in `creatorLarkAppId`'s app scope. Enforcing
 * this is the decision layer's job — the service trusts its inputs.
 */
import { createChat, transferChatOwner, getChatOwner, getChatShareLink } from './groups-store.js';
import { sendMessage } from '../im/lark/client.js';
import { bindOncall } from './oncall-store.js';

export interface CreateGroupOpts {
  creatorLarkAppId: string;
  /** Bots expected to join the new chat. Creator is filtered out internally
   *  (Lark rejects self-invite). May be empty (creator-only chat). */
  larkAppIds: string[];
  name?: string;
  userOpenIds?: string[];
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
  /** Optional working directory to bind the newly created chat to oncall for
   *  every invited bot. The path is validated by callers; this service only
   *  persists the binding after chat.create succeeds. */
  bindWorkingDir?: string;
}

export interface CreateGroupResult {
  ok: true;
  chatId: string;
  creator: string;
  invalidBotIds: string[];
  invalidUserIds: string[];
  ownerTransferredTo: string | null;
  transferError: string | null;
  notifyMessageId: string | null;
  notifyError: string | null;
  /** Shareable join link (others can click to *join*). null when the Lark
   *  link API failed — caller falls back to the member-only applink URL. */
  shareLink: string | null;
  shareLinkError: string | null;
  oncallBindings: { larkAppId: string; ok: boolean; created?: boolean; error?: string }[];
}

export async function createGroupWithBots(opts: CreateGroupOpts): Promise<CreateGroupResult> {
  // Filter creator out of the bot invite list. createChat does this defensively
  // too, but doing it here makes the service contract explicit and keeps
  // invalidBotIds reporting stable across underlying API changes.
  const otherBots = opts.larkAppIds.filter(id => id !== opts.creatorLarkAppId);
  const r = await createChat(opts.creatorLarkAppId, {
    name: opts.name,
    botIds: otherBots,
    userIds: opts.userOpenIds ?? [],
  });

  // Fetch the shareable join link BEFORE transferring ownership: the creator bot
  // is the chat owner right after createChat, so it can always read the link. If
  // we did this after transfer and the tenant restricts "share group" to
  // owner/admin, the (now demoted) bot would get a permission error. Best-effort:
  // on failure the caller falls back to the member-only applink URL.
  let shareLink: string | null = null;
  let shareLinkError: string | null = null;
  {
    const sl = await getChatShareLink(opts.creatorLarkAppId, r.chatId);
    if (sl.ok) shareLink = sl.shareLink;
    else shareLinkError = sl.error;
  }

  let ownerTransferredTo: string | null = null;
  let transferError: string | null = null;
  if (opts.transferOwnerTo) {
    // Skip transfer if Feishu rejected the invite — transferring to a
    // non-member returns "user not in chat" anyway.
    if (r.invalidUserIds.includes(opts.transferOwnerTo)) {
      transferError = 'invitee_rejected';
    } else {
      const tr = await transferChatOwner(opts.creatorLarkAppId, r.chatId, opts.transferOwnerTo);
      if (tr.ok) {
        ownerTransferredTo = opts.transferOwnerTo;
      } else {
        // Lark occasionally ACKs the owner transfer slowly (504 Gateway Timeout
        // or transient network error) even though the write actually committed
        // server-side. Verify by reading back the current owner before
        // surfacing the error — if the chat is already owned by the target,
        // the transfer really did succeed and the warning would mislead.
        const currentOwner = await getChatOwner(opts.creatorLarkAppId, r.chatId);
        if (currentOwner === opts.transferOwnerTo) {
          ownerTransferredTo = opts.transferOwnerTo;
        } else {
          transferError = tr.error;
        }
      }
    }
  }

  let notifyMessageId: string | null = null;
  let notifyError: string | null = null;
  if (opts.notifyOwnerOpenId) {
    if (r.invalidUserIds.includes(opts.notifyOwnerOpenId)) {
      notifyError = 'invitee_rejected';
    } else {
      try {
        notifyMessageId = await sendMessage(
          opts.creatorLarkAppId,
          r.chatId,
          `<at user_id="${opts.notifyOwnerOpenId}"></at>`,
          'text',
        );
      } catch (e: any) {
        notifyError = e?.message ?? String(e);
      }
    }
  }

  const oncallBindings: CreateGroupResult['oncallBindings'] = [];
  const bindWorkingDir = opts.bindWorkingDir?.trim();
  if (bindWorkingDir) {
    // Bind the new chat for every bot that actually joined it. The creator is
    // an implicit member; Lark reports rejected invitees in invalidBotIds.
    const invalidBots = new Set(r.invalidBotIds);
    const targetBotIds = Array.from(new Set([opts.creatorLarkAppId, ...opts.larkAppIds]))
      .filter(id => !invalidBots.has(id));
    for (const larkAppId of targetBotIds) {
      try {
        const br = await bindOncall(larkAppId, r.chatId, bindWorkingDir);
        if (br.ok) {
          oncallBindings.push({ larkAppId, ok: true, created: br.created });
        } else {
          oncallBindings.push({ larkAppId, ok: false, error: br.reason });
        }
      } catch (e: any) {
        oncallBindings.push({ larkAppId, ok: false, error: e?.message ?? String(e) });
      }
    }
  }

  return {
    ok: true,
    chatId: r.chatId,
    creator: opts.creatorLarkAppId,
    invalidBotIds: r.invalidBotIds,
    invalidUserIds: r.invalidUserIds,
    ownerTransferredTo,
    transferError,
    notifyMessageId,
    notifyError,
    shareLink,
    shareLinkError,
    oncallBindings,
  };
}
