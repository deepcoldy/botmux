/**
 * Group creation service — execution layer shared by dashboard and CLI.
 *
 * Decision layers (dashboard handler / CLI subcommand) are responsible for
 * choosing `creatorLarkAppId`, resolving bot refs, deriving user_open_ids, etc.
 * This service only orchestrates the Lark API sequence:
 *
 *   1. createChat (creator + invited users), then synchronously announce chatId
 *   2. add peer bots / owners and fetch the share link, then the owners' local
 *      stewards (decision board; see steward-auto-join.ts — best-effort, silent)
 *   3. transferChatOwner + notify + bindings, then the optional bot-collaboration
 *      hook, then role bootstrap / kickoff (best-effort where noted)
 *
 * The progress hook is the durable side-effect boundary: once it fires, the
 * chat exists and retrying would create a duplicate even if a later API call
 * throws or stalls. Transfer/notify failures are returned as `*Error` fields.
 *
 * Lark open_id is app-scoped: `userOpenIds`, `transferOwnerTo`, and
 * `notifyOwnerOpenId` MUST be in `creatorLarkAppId`'s app scope. The team-group
 * path may instead provide `transferOwnerUnionId`; this service resolves that
 * tenant-stable ID into the creator app's open_id before transfer.
 */
import { createChat, transferChatOwner, getChatOwner, getChatShareLink, addUsersToChatByOpenId, addUsersToChatByUnionId, addBotToChat, addChatManagers } from './groups-store.js';
import type { ChatMode } from './groups-store.js';
import type { GroupAvatarMode } from './group-creation-options.js';
import { listChatBotMembers, resolveAllowedUsersWithMap, resolveUnionIdFromOpenIdStrict, sendMessage } from '../im/lark/client.js';
import { loadBotConfigsCached } from '../bot-registry.js';
import { bindOncall } from './oncall-store.js';
import { readBotAdminUnions } from './bot-admin-unions-store.js';
import {
  clearStewardSilentJoin,
  joinStewardsToNewChat,
  markStewardSilentJoin,
  type StewardJoinResult,
} from './steward-auto-join.js';
import { isValidRoleProfileId, readRoleProfileEntry } from './role-profile-store.js';
import { writeRoleFile } from '../core/role-resolver.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { t, localeForBot } from '../i18n/index.js';

export interface CreateGroupOpts {
  creatorLarkAppId: string;
  /** Bots expected to join the new chat. Creator is filtered out internally
   *  (Lark rejects self-invite). May be empty (creator-only chat). */
  larkAppIds: string[];
  name?: string;
  /** Opt-in decorations; the personal tag requires the invoking user's open_id
   * in this creator app's scope. Failures never discard an existing chat. */
  customization?: { tag?: string; avatar?: GroupAvatarMode; userOpenId: string };
  /** Chat topology at creation time. 'topic' creates a 话题群; omit to let
   *  Feishu use its default 普通群 ('group'). Fixed for the chat's lifetime —
   *  it cannot be changed afterwards through this API. */
  chatMode?: ChatMode;
  userOpenIds?: string[];
  /** Users to add by union_id (tenant-stable) — used to pull bot OWNERS into a
   *  federated group regardless of which bot they paired through (open_id is
   *  app-scoped, union_id is not). Added after the chat is created. */
  ownerUnionIds?: string[];
  /** Tenant-stable owner target for federated/team groups. Resolved to an
   *  app-scoped open_id after the owner has been added to the chat. */
  transferOwnerUnionId?: string;
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
  /** `false`: no @-the-new-owner notice at all, not even the one a
   *  `transferOwnerUnionId` transfer posts by default. A Dashboard workflow
   *  launch (design 2026-11-03 workflow-dashboard-orchestration §4.5) builds a
   *  topic group whose first top-level message must be its root card.
   *  The machine-wide `groupOwnerNotice: false` (global-config) has the same
   *  effect for every call; a per-call `false` wins even when it is on. */
  ownerNotice?: false;
  /** Users to grant group manager permissions to. Added while the creator bot is owner. */
  managerUserIds?: string[];
  /** Optional working directory to bind the newly created chat to oncall for
   *  every invited bot. The path is validated by callers; this service only
   *  persists the binding after chat.create succeeds. */
  bindWorkingDir?: string;
  /** Optional reusable role suite to bootstrap. The creator bot applies its
   *  local entry directly; peer bots are prompted by a multi-mention
   *  `/role profile apply` command in the newly created chat. */
  roleProfileId?: string;
  /** Optional kickoff: after the chat is created, the creator @-mentions this
   *  bot and posts `kickoffPrompt` as a top-level message. Used to
   *  auto-trigger a bot (e.g. a reviewer) in the new group without a human
   *  having to @ it. The kickoff bot must be present in `larkAppIds`. */
  kickoffBotLarkAppId?: string;
  kickoffPrompt?: string;
  /** Best-effort collaboration setup for the bots that actually joined. CLI
   * cold-group creation uses it to write the talk-only grant matrix between
   * them. Runs after owner transfer, notify and oncall binding, and before any
   * role/kickoff bot message. A throw is reported as `collaborationError`; it
   * never skips the remaining steps — the chat already exists, and an aborted
   * initialization would leave the owner without the group. */
  ensureBotCollaboration?: (chatId: string, joinedBotAppIds: string[]) => Promise<void>;
  /** Task launches reserve their opening here before deferred user invites.
   * Existing synchronous callers keep their behavior; the hook is awaited. */
  onChatCreated?: (chatId: string) => void | Promise<void>;
  /** Opt-in for `/g --start`: create without users, await the durable opening
   * reservation in onChatCreated, then invite userOpenIds. */
  deferUserInvites?: true;
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
  managersAdded: string[];
  managerError: string | null;
  notifyMessageId: string | null;
  notifyError: string | null;
  /** Shareable join link (others can click to *join*). null when the Lark
   *  link API failed — caller falls back to the member-only applink URL. */
  shareLink: string | null;
  shareLinkError: string | null;
  oncallBindings: { larkAppId: string; ok: boolean; created?: boolean; error?: string }[];
  roleProfileBootstrapMessageId: string | null;
  roleProfileBootstrapError: string | null;
  kickoffMessageId: string | null;
  kickoffError: string | null;
  /** Present only when `ensureBotCollaboration` was supplied: null when it
   * completed, otherwise the error it threw. */
  collaborationError?: string | null;
  customization?: { tagError?: string; avatarError?: string };
  /** Local stewards (decision board) this chat belongs to, and whether each was
   *  pulled in. Absent when no steward applied. Never part of invalidBotIds:
   *  a steward that could not join does not make the group incomplete. */
  stewardJoins?: StewardJoinResult[];
}

export interface TransferGroupOwnerOpts {
  creatorLarkAppId: string;
  chatId: string;
  ownerId: string;
  ownerIdType?: 'open_id' | 'union_id';
}

export interface TransferGroupOwnerResult {
  ownerTransferredTo: string | null;
  transferError: string | null;
}

/**
 * Best-effort ownership transfer for an already-created group. Federation uses
 * this after an out-of-scope operator has been added by their own deployment;
 * accepting union_id avoids leaking an app-scoped open_id back to the creator.
 */
export async function transferGroupOwner(opts: TransferGroupOwnerOpts): Promise<TransferGroupOwnerResult> {
  const ownerId = opts.ownerId.trim();
  if (!ownerId) return { ownerTransferredTo: null, transferError: 'owner_id_required' };
  const ownerIdType = opts.ownerIdType ?? 'open_id';
  const tr = ownerIdType === 'open_id'
    ? await transferChatOwner(opts.creatorLarkAppId, opts.chatId, ownerId)
    : await transferChatOwner(opts.creatorLarkAppId, opts.chatId, ownerId, ownerIdType);
  if (tr.ok) return { ownerTransferredTo: ownerId, transferError: null };

  // A timed-out update may still have committed. Read back using the SAME ID
  // type as the request so union_id retries remain app-scope independent.
  const currentOwner = ownerIdType === 'open_id'
    ? await getChatOwner(opts.creatorLarkAppId, opts.chatId)
    : await getChatOwner(opts.creatorLarkAppId, opts.chatId, ownerIdType);
  if (currentOwner === ownerId) return { ownerTransferredTo: ownerId, transferError: null };
  return { ownerTransferredTo: null, transferError: tr.error };
}

export async function createGroupWithBots(opts: CreateGroupOpts): Promise<CreateGroupResult> {
  const creatorLarkAppId = opts.creatorLarkAppId.trim();
  const normalizedLarkAppIds = Array.from(
    new Set(opts.larkAppIds.map(id => id.trim()).filter(Boolean)),
  );
  // Filter creator out of the bot invite list. createChat does this defensively
  // too, but doing it here makes the service contract explicit and keeps
  // invalidBotIds reporting stable across underlying API changes.
  const otherBots = normalizedLarkAppIds.filter(id => id !== creatorLarkAppId);
  // 飞书 chat.create 的 bot_id_list 上限仅 5、chatMembers.create 的 id_list 同样很小（实测 >5 即 400）。
  // 故建群时不带 bot（只 creator + 邀请人），所有 bot 一律按每批 5 个增量加入，避免触顶。批里只要有
  // 一个非法 id（如已停用的 app），飞书会整批拒（code≠0）→ 逐个重试以保住同批的有效 bot。失败并入 invalidBotIds。
  const BOT_BATCH = 5;
  const r = await createChat(creatorLarkAppId, {
    name: opts.name,
    botIds: [],
    userIds: opts.deferUserInvites ? [] : (opts.userOpenIds ?? []),
    chatMode: opts.chatMode,
  });
  await opts.onChatCreated?.(r.chatId);
  if (opts.deferUserInvites && opts.userOpenIds?.length) {
    const added = await addUsersToChatByOpenId(creatorLarkAppId, r.chatId, opts.userOpenIds);
    for (const id of added.invalidUserIds) {
      if (!r.invalidUserIds.includes(id)) r.invalidUserIds.push(id);
    }
  }
  for (let i = 0; i < otherBots.length; i += BOT_BATCH) {
    const batch = otherBots.slice(i, i + BOT_BATCH);
    let added = await addBotToChat(creatorLarkAppId, r.chatId, batch);
    if (added.some(a => !a.ok) && batch.length > 1) {
      added = [];
      for (const id of batch) added.push(...await addBotToChat(creatorLarkAppId, r.chatId, [id]));
    }
    for (const a of added) if (!a.ok) r.invalidBotIds.push(a.id);
  }

  const invalidBots = new Set(r.invalidBotIds);
  const joinedBotIds = Array.from(new Set([creatorLarkAppId, ...normalizedLarkAppIds]))
    .filter(id => !invalidBots.has(id));

  // Optional decoration must never delay inviting the requested teammates.
  // Avatar runs now (after invites, before owner transfer) so the chat already
  // looks right by the time the sender becomes owner. The personal feed-group
  // tag runs *after* the share-link fetch and owner transfer below so a slow
  // user-token refresh cannot delay the hand-over.
  const customization: CreateGroupResult['customization'] = opts.customization ? {} : undefined;
  if (opts.customization?.avatar === 'name') {
    try {
      const { applyGroupNameAvatar } = await import('./group-name-avatar.js');
      await applyGroupNameAvatar(creatorLarkAppId, r.chatId, opts.name ?? '');
    } catch (err: any) { customization!.avatarError = err?.message ?? String(err); }
  } else if (opts.customization?.avatar === 'logo') {
    try {
      const { applyLogoGroupAvatar } = await import('./session-group-avatar.js');
      await applyLogoGroupAvatar(creatorLarkAppId, r.chatId);
    } catch (err: any) { customization!.avatarError = err?.message ?? String(err); }
  }

  // Fetch the shareable join link BEFORE transferring ownership: the creator bot
  // is the chat owner right after createChat, so it can always read the link. If
  // we did this after transfer and the tenant restricts "share group" to
  // owner/admin, the (now demoted) bot would get a permission error. Best-effort:
  // on failure the caller falls back to the member-only applink URL.
  let shareLink: string | null = null;
  let shareLinkError: string | null = null;
  {
    const sl = await getChatShareLink(creatorLarkAppId, r.chatId);
    if (sl.ok) shareLink = sl.shareLink;
    else shareLinkError = sl.error;
  }

  // Pull bot owners into the chat by union_id (tenant-stable; the creator bot
  // adds them). Best-effort — failures surface as invalidOwnerUnionIds, the chat
  // still exists. The creator's own owner (if any) is harmless to re-add.
  let invalidOwnerUnionIds: string[] = [];
  if (opts.ownerUnionIds && opts.ownerUnionIds.length > 0) {
    const ar = await addUsersToChatByUnionId(creatorLarkAppId, r.chatId, opts.ownerUnionIds);
    invalidOwnerUnionIds = ar.invalidUserIds;
  }

  // Stewards join after the requested bots and owners are in, and while the
  // creator still owns the chat. They stay out of joinedBotIds on purpose: no
  // collaboration grant, oncall binding, role bootstrap or kickoff for them.
  // A chat that ends up with one person and one bot keeps that bot answering
  // without an @ (solo-group bypass); a steward would make it two bots, so such
  // chats only get stewards that opted in. Counted from who actually joined;
  // open_id and union_id may be the same person, so the larger count is used.
  const dataDir = config.session.dataDir;
  const memberOpenIds = (opts.userOpenIds ?? []).filter(id => !r.invalidUserIds.includes(id));
  const memberUnionIds = (opts.ownerUnionIds ?? []).filter(id => !invalidOwnerUnionIds.includes(id));
  const soloGroup = joinedBotIds.length <= 1 && Math.max(new Set(memberOpenIds).size, new Set(memberUnionIds).size) <= 1;
  const stewardJoins = await joinStewardsToNewChat({
    creatorLarkAppId,
    requestedBotAppIds: normalizedLarkAppIds,
    soloGroup,
    memberOpenIds,
    memberUnionIds,
    initiatorOpenIds: [opts.transferOwnerTo, opts.notifyOwnerOpenId]
      .filter((id): id is string => !!id && !r.invalidUserIds.includes(id)),
    initiatorUnionIds: [opts.transferOwnerUnionId].filter((id): id is string => !!id && !invalidOwnerUnionIds.includes(id)),
  }, {
    loadConfigs: loadBotConfigsCached,
    readAdminUnions: (appId, allowedUsers) => readBotAdminUnions(dataDir, appId, allowedUsers),
    lookupUnion: async openId => {
      const found = await resolveUnionIdFromOpenIdStrict(creatorLarkAppId, openId);
      return found.status === 'resolved' ? found.unionId : undefined;
    },
    markSilentJoin: appId => markStewardSilentJoin(dataDir, appId, r.chatId),
    clearSilentJoin: appId => clearStewardSilentJoin(dataDir, appId, r.chatId),
    addBot: async appId => (await addBotToChat(creatorLarkAppId, r.chatId, [appId]))[0] ?? { ok: false, error: 'no_result' },
    log: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message)),
  });

  let transferOwnerTo = opts.transferOwnerTo?.trim() || null;
  const transferOwnerUnionId = opts.transferOwnerUnionId?.trim() || null;
  let transferError: string | null = null;
  if (!transferOwnerTo && transferOwnerUnionId) {
    if (invalidOwnerUnionIds.includes(transferOwnerUnionId)) {
      transferError = 'invitee_rejected';
    } else {
      try {
        const resolved = await resolveAllowedUsersWithMap(creatorLarkAppId, [transferOwnerUnionId]);
        transferOwnerTo = resolved.map.get(transferOwnerUnionId) ?? null;
        if (!transferOwnerTo) transferError = 'owner_union_id_unresolved';
      } catch {
        transferError = 'owner_union_id_unresolved';
      }
    }
  }

  // Grant group manager role to non-owner managers BEFORE transferring ownership:
  // Feishu `im.v1.chatManagers.addManagers` is strictly owner-only (code 232025
  // once the creator bot is demoted, with no `operate_as_owner` override).
  // - Any user in `invalidUserIds` is skipped (not in chat).
  // - The planned `transferOwnerTo` target is deferred until after transfer so
  //   we don't redundantly promote someone who is about to become owner; if
  //   transfer fails, the creator bot is still owner and can add them as a
  //   manager fallback below.
  let managersAdded: string[] = [];
  let managerError: string | null = null;
  const rawManagerIds = Array.from(
    new Set((opts.managerUserIds ?? []).map(id => id.trim()).filter(Boolean)),
  );
  const willAttemptTransfer = Boolean(
    transferOwnerTo && !transferError && !r.invalidUserIds.includes(transferOwnerTo),
  );
  if (rawManagerIds.length > 0) {
    const preTransferManagers = rawManagerIds.filter(
      id => !r.invalidUserIds.includes(id) && (!willAttemptTransfer || id !== transferOwnerTo),
    );
    if (preTransferManagers.length > 0) {
      const mr = await addChatManagers(creatorLarkAppId, r.chatId, preTransferManagers);
      if (mr.ok) {
        managersAdded = mr.addedManagers;
      } else {
        managerError = mr.error;
        logger.warn(`[group-creator] addChatManagers failed after retries for ${r.chatId.substring(0, 12)}: ${mr.error}`);
      }
    }
  }

  let ownerTransferredTo: string | null = null;
  if (transferOwnerTo && !transferError) {
    // Skip transfer if Feishu rejected the invite — transferring to a
    // non-member returns "user not in chat" anyway.
    if (r.invalidUserIds.includes(transferOwnerTo)) {
      transferError = 'invitee_rejected';
    } else {
      const transferred = await transferGroupOwner({
        creatorLarkAppId,
        chatId: r.chatId,
        ownerId: transferOwnerTo,
      });
      ownerTransferredTo = transferred.ownerTransferredTo;
      transferError = transferred.transferError;
    }
  }

  // Personal feed-group tag runs after ownership hand-over: tagging needs the
  // invoking user's OAuth token, whose refresh can stall; keeping it here means
  // the owner-transfer window is as short as the invite + avatar + share-link
  // calls. Failure is independent — the chat is already handed over.
  if (opts.customization?.tag) {
    try {
      const { addCreatedChatToFeedGroup } = await import('./feed-group-tagger.js');
      await addCreatedChatToFeedGroup(creatorLarkAppId, r.chatId, opts.customization.userOpenId, opts.customization.tag);
    } catch (err: any) { customization!.tagError = err?.message ?? String(err); }
  }

  // Fallback: if ownership transfer failed, the creator bot is still the chat
  // owner; promote `transferOwnerTo` to manager if it was also in managerUserIds.
  if (willAttemptTransfer && !ownerTransferredTo && transferOwnerTo && rawManagerIds.includes(transferOwnerTo)) {
    const mr = await addChatManagers(creatorLarkAppId, r.chatId, [transferOwnerTo]);
    if (mr.ok) {
      managersAdded = Array.from(new Set([...managersAdded, ...mr.addedManagers]));
    } else {
      managerError = managerError ? `${managerError}; ${mr.error}` : mr.error;
      logger.warn(`[group-creator] addChatManagers fallback failed after retries for ${r.chatId.substring(0, 12)}: ${mr.error}`);
    }
  }

  // The machine-wide switch is read here, per creation, so a Dashboard / CLI
  // flip reaches the next group without a restart. Off behaves exactly like a
  // per-call `ownerNotice: false`: no notice, and no notify error either.
  const ownerNoticeWanted = opts.ownerNotice !== false && config.groupOwnerNotice !== false;
  const notifyOwnerOpenId = !ownerNoticeWanted
    ? null
    : opts.notifyOwnerOpenId?.trim() || (transferOwnerUnionId ? transferOwnerTo : null);
  let notifyMessageId: string | null = null;
  let notifyError: string | null = !notifyOwnerOpenId && transferOwnerUnionId && ownerNoticeWanted ? transferError : null;
  if (notifyOwnerOpenId) {
    if (r.invalidUserIds.includes(notifyOwnerOpenId)) {
      notifyError = 'invitee_rejected';
    } else {
      try {
        notifyMessageId = await sendMessage(
          creatorLarkAppId,
          r.chatId,
          `<at user_id="${notifyOwnerOpenId}"></at> ${t('cmd.group.owner_notice', undefined, localeForBot(creatorLarkAppId))}`,
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

  // Bot collaboration setup goes after everything the owner is waiting for
  // (ownership, the @ notice) and before the first bot-to-bot message, so its
  // grants are in place when role bootstrap / kickoff arrive. The receivers'
  // live membership checks also need the invitations above to have settled.
  let collaborationError: string | null = null;
  if (opts.ensureBotCollaboration) {
    try {
      await opts.ensureBotCollaboration(r.chatId, joinedBotIds);
    } catch (e: any) {
      collaborationError = e?.message ?? String(e);
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
        const creatorContent = readRoleProfileEntry(config.session.dataDir, roleProfileId, creatorLarkAppId);
        // null = no entry; '' = explicit (clear) entry — both skip the write on
        // a fresh chat, but only a truly missing entry counts as "not applicable".
        const creatorHasEntry = creatorContent !== null;
        if (creatorContent) {
          writeRoleFile(creatorLarkAppId, r.chatId, creatorContent);
        }
        const peerBotIds = joinedBotIds.filter(id => id !== creatorLarkAppId);
        if (peerBotIds.length > 0) {
          const members = await listChatBotMembers(creatorLarkAppId, r.chatId);
          const byAppId = new Map(members.map(m => [m.larkAppId, m]));
          const mentions = peerBotIds
            .map(id => byAppId.get(id))
            .filter((m): m is NonNullable<typeof m> => !!m && !!m.openId && m.mentionable)
            .map(m => `<at user_id="${m.openId}"></at>`);
          if (mentions.length === 0) {
            roleProfileBootstrapError = 'no_mentionable_bots';
          } else {
            roleProfileBootstrapMessageId = await sendMessage(
              creatorLarkAppId,
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

  // Kickoff: creator @-mentions a target bot with a prompt so it auto-starts
  // working (e.g. a PR review). Resolve the @ handle from the creator's view of
  // the new chat: Lark open_id values are app-scoped, so the target bot's
  // self-reported open_id cannot be used directly by the creator app.
  let kickoffMessageId: string | null = null;
  let kickoffError: string | null = null;
  const kickoffBot = opts.kickoffBotLarkAppId?.trim();
  const kickoffPrompt = opts.kickoffPrompt?.trim();
  if (!!kickoffBot !== !!kickoffPrompt) {
    kickoffError = 'kickoff_args_must_be_paired';
  } else if (kickoffBot && kickoffPrompt) {
    if (kickoffBot === creatorLarkAppId) {
      kickoffError = 'creator_cannot_kickoff_self';
    } else if (!normalizedLarkAppIds.includes(kickoffBot)) {
      kickoffError = 'kickoff_bot_not_selected';
    } else if (r.invalidBotIds.includes(kickoffBot)) {
      kickoffError = 'invitee_rejected';
    }

    try {
      if (!kickoffError) {
        const members = await listChatBotMembers(creatorLarkAppId, r.chatId);
        const target = members.find(member => member.larkAppId === kickoffBot);
        if (!target) {
          kickoffError = 'kickoff_bot_not_found_in_chat';
        } else if (!target.mentionable) {
          kickoffError = 'kickoff_bot_not_mentionable';
        } else {
          kickoffMessageId = await sendMessage(
            creatorLarkAppId,
            r.chatId,
            `<at user_id="${target.openId}"></at> ${kickoffPrompt}`,
            'text',
          );
        }
      }
    } catch (e: any) {
      kickoffError = e?.message ?? String(e);
    }
  }

  return {
    ok: true,
    chatId: r.chatId,
    creator: creatorLarkAppId,
    invalidBotIds: r.invalidBotIds,
    invalidUserIds: r.invalidUserIds,
    invalidOwnerUnionIds,
    ownerTransferredTo,
    transferError,
    managersAdded,
    managerError,
    notifyMessageId,
    notifyError,
    shareLink,
    shareLinkError,
    oncallBindings,
    roleProfileBootstrapMessageId,
    roleProfileBootstrapError,
    kickoffMessageId,
    kickoffError,
    ...(opts.ensureBotCollaboration ? { collaborationError } : {}),
    ...(customization ? { customization } : {}),
    ...(stewardJoins.length ? { stewardJoins } : {}),
  };
}
