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
import { createChat, transferChatOwner } from './groups-store.js';
import { sendMessage } from '../im/lark/client.js';

export interface CreateGroupOpts {
  creatorLarkAppId: string;
  /** Bots expected to join the new chat. Creator is filtered out internally
   *  (Lark rejects self-invite). May be empty (creator-only chat). */
  larkAppIds: string[];
  name?: string;
  userOpenIds?: string[];
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
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

  let ownerTransferredTo: string | null = null;
  let transferError: string | null = null;
  if (opts.transferOwnerTo) {
    // Skip transfer if Feishu rejected the invite — transferring to a
    // non-member returns "user not in chat" anyway.
    if (r.invalidUserIds.includes(opts.transferOwnerTo)) {
      transferError = 'invitee_rejected';
    } else {
      const tr = await transferChatOwner(opts.creatorLarkAppId, r.chatId, opts.transferOwnerTo);
      if (tr.ok) ownerTransferredTo = opts.transferOwnerTo;
      else transferError = tr.error;
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
  };
}
