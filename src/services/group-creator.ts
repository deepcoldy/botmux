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
import { createChat, transferChatOwner, getChatOwner, getChatShareLink, addUsersToChatByUnionId, addBotToChat } from './groups-store.js';
import { listChatBotMembers, sendMessage } from '../im/lark/client.js';
import { bindOncall } from './oncall-store.js';
import { isValidRoleProfileId, readRoleProfileEntry } from './role-profile-store.js';
import { writeRoleFile } from '../core/role-resolver.js';
import { config } from '../config.js';

export interface CreateGroupOpts {
  creatorLarkAppId: string;
  /** Bots expected to join the new chat. Creator is filtered out internally
   *  (Lark rejects self-invite). May be empty (creator-only chat). */
  larkAppIds: string[];
  name?: string;
  userOpenIds?: string[];
  /** Users to add by union_id (tenant-stable) — used to pull bot OWNERS into a
   *  federated group regardless of which bot they paired through (open_id is
   *  app-scoped, union_id is not). Added after the chat is created. */
  ownerUnionIds?: string[];
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
  /** Optional working directory to bind the newly created chat to oncall for
   *  every invited bot. The path is validated by callers; this service only
   *  persists the binding after chat.create succeeds. */
  bindWorkingDir?: string;
  /** Optional reusable role suite to bootstrap. The creator bot applies its
   *  local entry directly; peer bots are prompted by a multi-mention
   *  `/role profile apply` command in the newly created chat. */
  roleProfileId?: string;
}

export interface CreateGroupResult {
  ok: true;
  chatId: string;
  creator: string;
  invalidBotIds: string[];
  invalidUserIds: string[];
  /** Owner union_ids Lark could not add to the chat (best-effort). */
  invalidOwnerUnionIds: string[];
  ownerTransferredTo: string | null;
  transferError: string | null;
  notifyMessageId: string | null;
  notifyError: string | null;
  /** Shareable join link (others can click to *join*). null when the Lark
   *  link API failed — caller falls back to the member-only applink URL. */
  shareLink: string | null;
  shareLinkError: string | null;
  oncallBindings: { larkAppId: string; ok: boolean; created?: boolean; error?: string }[];
  roleProfileBootstrapMessageId: string | null;
  roleProfileBootstrapError: string | null;
}

export async function createGroupWithBots(opts: CreateGroupOpts): Promise<CreateGroupResult> {
  // Filter creator out of the bot invite list. createChat does this defensively
  // too, but doing it here makes the service contract explicit and keeps
  // invalidBotIds reporting stable across underlying API changes.
  const otherBots = opts.larkAppIds.filter(id => id !== opts.creatorLarkAppId);
  // 飞书 chat.create 的 bot_id_list 上限仅 5、chatMembers.create 的 id_list 同样很小（实测 >5 即 400）。
  // 故建群时不带 bot（只 creator + 邀请人），所有 bot 一律按每批 5 个增量加入，避免触顶。批里只要有
  // 一个非法 id（如已停用的 app），飞书会整批拒（code≠0）→ 逐个重试以保住同批的有效 bot。失败并入 invalidBotIds。
  const BOT_BATCH = 5;
  const r = await createChat(opts.creatorLarkAppId, {
    name: opts.name,
    botIds: [],
    userIds: opts.userOpenIds ?? [],
  });
  for (let i = 0; i < otherBots.length; i += BOT_BATCH) {
    const batch = otherBots.slice(i, i + BOT_BATCH);
    let added = await addBotToChat(opts.creatorLarkAppId, r.chatId, batch);
    if (added.some(a => !a.ok) && batch.length > 1) {
      added = [];
      for (const id of batch) added.push(...await addBotToChat(opts.creatorLarkAppId, r.chatId, [id]));
    }
    for (const a of added) if (!a.ok) r.invalidBotIds.push(a.id);
  }

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

  // Pull bot owners into the chat by union_id (tenant-stable; the creator bot
  // adds them). Best-effort — failures surface as invalidOwnerUnionIds, the chat
  // still exists. The creator's own owner (if any) is harmless to re-add.
  let invalidOwnerUnionIds: string[] = [];
  if (opts.ownerUnionIds && opts.ownerUnionIds.length > 0) {
    const ar = await addUsersToChatByUnionId(opts.creatorLarkAppId, r.chatId, opts.ownerUnionIds);
    invalidOwnerUnionIds = ar.invalidUserIds;
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
  const invalidBots = new Set(r.invalidBotIds);
  const joinedBotIds = Array.from(new Set([opts.creatorLarkAppId, ...opts.larkAppIds]))
    .filter(id => !invalidBots.has(id));
  const bindWorkingDir = opts.bindWorkingDir?.trim();
  if (bindWorkingDir) {
    // Bind the new chat for every bot that actually joined it. The creator is
    // an implicit member; Lark reports rejected invitees in invalidBotIds.
    for (const larkAppId of joinedBotIds) {
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

  let roleProfileBootstrapMessageId: string | null = null;
  let roleProfileBootstrapError: string | null = null;
  const roleProfileId = opts.roleProfileId?.trim();
  if (roleProfileId) {
    if (!isValidRoleProfileId(roleProfileId)) {
      roleProfileBootstrapError = 'invalid_role_profile_id';
    } else {
      try {
        const creatorContent = readRoleProfileEntry(config.session.dataDir, roleProfileId, opts.creatorLarkAppId);
        // null = no entry; '' = explicit (clear) entry — both skip the write on
        // a fresh chat, but only a truly missing entry counts as "not applicable".
        const creatorHasEntry = creatorContent !== null;
        if (creatorContent) {
          writeRoleFile(opts.creatorLarkAppId, r.chatId, creatorContent);
        }
        const peerBotIds = joinedBotIds.filter(id => id !== opts.creatorLarkAppId);
        if (peerBotIds.length > 0) {
          const members = await listChatBotMembers(opts.creatorLarkAppId, r.chatId);
          const byAppId = new Map(members.map(m => [m.larkAppId, m]));
          const mentions = peerBotIds
            .map(id => byAppId.get(id))
            .filter((m): m is NonNullable<typeof m> => !!m && !!m.openId && m.mentionable)
            .map(m => `<at user_id="${m.openId}"></at>`);
          if (mentions.length === 0) {
            roleProfileBootstrapError = 'no_mentionable_bots';
          } else {
            roleProfileBootstrapMessageId = await sendMessage(
              opts.creatorLarkAppId,
              r.chatId,
              `${mentions.join(' ')} /role profile apply ${roleProfileId} --quiet`,
              'text',
            );
          }
        } else if (!creatorHasEntry) {
          // Solo group whose creator has no entry in this profile: nothing was
          // written and no peer bootstrap was sent. Surface it rather than
          // reporting a misleading "bootstrap started". An explicit empty entry
          // ('') is still a valid entry (clears on apply), so it is NOT flagged.
          roleProfileBootstrapError = 'no_applicable_entries';
        }
      } catch (e: any) {
        roleProfileBootstrapError = e?.message ?? String(e);
      }
    }
  }

  return {
    ok: true,
    chatId: r.chatId,
    creator: opts.creatorLarkAppId,
    invalidBotIds: r.invalidBotIds,
    invalidUserIds: r.invalidUserIds,
    invalidOwnerUnionIds,
    ownerTransferredTo,
    transferError,
    notifyMessageId,
    notifyError,
    shareLink,
    shareLinkError,
    oncallBindings,
    roleProfileBootstrapMessageId,
    roleProfileBootstrapError,
  };
}
