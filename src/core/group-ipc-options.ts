/**
 * Shared validation & request-preparation helpers for group management IPC and
 * Dashboard routes (`/api/groups/create`, `/api/groups/:chatId/top-notice`,
 * `/api/groups/:chatId/share-link`).
 *
 * Pure and zero-I/O so both Daemon IPC and Dashboard share identical fail-closed
 * validation rules and remain 100% compatible with standalone compiled binaries.
 */

import { isValidRoleProfileId } from '../services/role-profile-store.js';
import { pickCreatorForGroup, type DaemonInfoForPick } from '../dashboard/operator-selector.js';
import type { ChatMode } from '../services/groups-store.js';

export const GROUP_CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
export const GROUP_MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
export const GROUP_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
export const MAX_GROUP_MANAGER_USER_IDS = 50;

export type ShareLinkValidityPeriod = 'week' | 'year' | 'permanently';

const SHARE_LINK_VALIDITY_SET = new Set<string>(['week', 'year', 'permanently']);
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyAllowedJsonKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  for (const key of FORBIDDEN_JSON_KEYS) {
    if (Object.hasOwn(value, key)) return false;
  }
  return Object.keys(value).every(key => allowed.has(key));
}

export type NormalizeGroupLarkAppIdsResult =
  | { ok: true; larkAppIds: string[] }
  | { ok: false; error: 'larkAppIds_required' };

/**
 * Strictly validate, trim, and deduplicate `larkAppIds` while preserving order.
 * Rejects non-arrays, non-string or blank elements, and empty arrays unless
 * `allowEmpty: true` is explicitly requested.
 */
export function normalizeGroupLarkAppIds(
  raw: unknown,
  opts?: { allowEmpty?: boolean },
): NormalizeGroupLarkAppIdsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'larkAppIds_required' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'larkAppIds_required' };
    const trimmed = item.trim();
    if (!trimmed) return { ok: false, error: 'larkAppIds_required' };
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  if (!opts?.allowEmpty && out.length === 0) {
    return { ok: false, error: 'larkAppIds_required' };
  }
  return { ok: true, larkAppIds: out };
}

export interface GroupCreateOptionsInput {
  chatMode?: unknown;
  botCollaboration?: unknown;
  kickoffBotLarkAppId?: unknown;
  kickoffPrompt?: unknown;
  ownerNotice?: unknown;
  managerUserIds?: unknown;
}

export interface GroupCreateOptionsContext {
  larkAppIds?: readonly string[];
  creatorLarkAppId?: string;
}

export interface ParsedGroupCreateOptions {
  ok: true;
  chatMode?: ChatMode;
  botCollaboration: boolean;
  kickoffBotLarkAppId?: string;
  kickoffPrompt?: string;
  ownerNotice?: boolean;
  managerUserIds?: string[];
}

export type ParseGroupCreateOptionsResult =
  | ParsedGroupCreateOptions
  | { ok: false; error: string };

/**
 * Parse and fail-closed validate the optional fields accepted by both Daemon IPC
 * and Dashboard `POST /api/groups/create`. Absent fields preserve legacy
 * behaviour byte for byte.
 */
export function parseGroupCreateOptions(
  body: GroupCreateOptionsInput,
  ctx?: GroupCreateOptionsContext,
): ParseGroupCreateOptionsResult {
  if (body.chatMode !== undefined && body.chatMode !== 'topic' && body.chatMode !== 'group') {
    return { ok: false, error: 'invalid_chat_mode' };
  }
  if (body.botCollaboration !== undefined && typeof body.botCollaboration !== 'boolean') {
    return { ok: false, error: 'invalid_bot_collaboration' };
  }
  if (body.ownerNotice !== undefined && typeof body.ownerNotice !== 'boolean') {
    return { ok: false, error: 'invalid_owner_notice' };
  }

  let managerUserIds: string[] | undefined;
  if (body.managerUserIds !== undefined) {
    if (!Array.isArray(body.managerUserIds) || body.managerUserIds.length > MAX_GROUP_MANAGER_USER_IDS) {
      return { ok: false, error: 'invalid_manager_user_ids' };
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of body.managerUserIds) {
      if (typeof item !== 'string') return { ok: false, error: 'invalid_manager_user_ids' };
      const trimmed = item.trim();
      if (!GROUP_OPEN_ID_RE.test(trimmed)) return { ok: false, error: 'invalid_manager_user_ids' };
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        deduped.push(trimmed);
      }
    }
    managerUserIds = deduped;
  }

  let kickoffBotLarkAppId: string | undefined;
  if (body.kickoffBotLarkAppId !== undefined) {
    if (typeof body.kickoffBotLarkAppId !== 'string' || !body.kickoffBotLarkAppId.trim()) {
      return { ok: false, error: 'invalid_kickoff_bot_lark_app_id' };
    }
    kickoffBotLarkAppId = body.kickoffBotLarkAppId.trim();
  }

  let kickoffPrompt: string | undefined;
  if (body.kickoffPrompt !== undefined) {
    if (typeof body.kickoffPrompt !== 'string' || !body.kickoffPrompt.trim()) {
      return { ok: false, error: 'invalid_kickoff_prompt' };
    }
    kickoffPrompt = body.kickoffPrompt.trim();
  }

  if ((kickoffBotLarkAppId !== undefined) !== (kickoffPrompt !== undefined)) {
    return { ok: false, error: 'kickoff_args_must_be_paired' };
  }

  if (kickoffBotLarkAppId !== undefined) {
    const trimmedCreator = ctx?.creatorLarkAppId?.trim();
    if (trimmedCreator && kickoffBotLarkAppId === trimmedCreator) {
      return { ok: false, error: 'creator_cannot_kickoff_self' };
    }
    if (ctx?.larkAppIds !== undefined) {
      const normalizedCtxIds = ctx.larkAppIds.map(id => id.trim()).filter(Boolean);
      if (!normalizedCtxIds.includes(kickoffBotLarkAppId)) {
        return { ok: false, error: 'kickoff_bot_not_selected' };
      }
      if (!trimmedCreator && normalizedCtxIds.every(id => id === kickoffBotLarkAppId)) {
        return { ok: false, error: 'creator_cannot_kickoff_self' };
      }
    }
  }

  return {
    ok: true,
    ...(body.chatMode !== undefined ? { chatMode: body.chatMode } : {}),
    botCollaboration: body.botCollaboration === true,
    ...(body.ownerNotice !== undefined ? { ownerNotice: body.ownerNotice } : {}),
    ...(managerUserIds !== undefined ? { managerUserIds } : {}),
    ...(kickoffBotLarkAppId !== undefined ? { kickoffBotLarkAppId, kickoffPrompt } : {}),
  };
}

export interface DashboardGroupCreateForwardPlan {
  ok: true;
  creatorLarkAppId: string;
  autoInvited: string | null;
  roleProfileId: string | null;
  forwardBody: Record<string, unknown>;
}

export type DashboardGroupCreatePlanResult =
  | DashboardGroupCreateForwardPlan
  | { ok: false; status: number; error: string };

export interface PrepareDashboardGroupCreateOpts {
  /** Optional predicate identifying core-only (`apiOnly`) bots with no Feishu transport. */
  isApiOnly?: (larkAppId: string) => boolean;
}

/**
 * Validate a Dashboard `POST /api/groups/create` payload, pick an online
 * transport-capable creator daemon (honouring optional `creatorLarkAppId`
 * pinning and excluding `kickoffBotLarkAppId` so the creator never attempts to
 * @-kickoff itself), and build the JSON payload forwarded to Daemon IPC.
 */
export function prepareDashboardGroupCreate(
  parsed: unknown,
  getOnlineDaemon: (larkAppId: string) => DaemonInfoForPick | undefined,
  opts?: PrepareDashboardGroupCreateOpts,
): DashboardGroupCreatePlanResult {
  if (!isPlainJsonObject(parsed)) {
    return { ok: false, status: 400, error: 'bad_json' };
  }

  const normalizedIds = normalizeGroupLarkAppIds(parsed.larkAppIds);
  if (!normalizedIds.ok) {
    return { ok: false, status: 400, error: normalizedIds.error };
  }
  const selectedIds = normalizedIds.larkAppIds;

  let pinnedCreator: string | undefined;
  if (parsed.creatorLarkAppId !== undefined) {
    if (typeof parsed.creatorLarkAppId !== 'string' || !parsed.creatorLarkAppId.trim()) {
      return { ok: false, status: 400, error: 'invalid_creator_lark_app_id' };
    }
    pinnedCreator = parsed.creatorLarkAppId.trim();
    if (!selectedIds.includes(pinnedCreator)) {
      return { ok: false, status: 400, error: 'invalid_creator_lark_app_id' };
    }
  }

  const roleProfileId = typeof parsed.roleProfileId === 'string' && parsed.roleProfileId.trim()
    ? parsed.roleProfileId.trim()
    : null;
  if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
    return { ok: false, status: 400, error: 'invalid_role_profile_id' };
  }

  const options = parseGroupCreateOptions(parsed, {
    larkAppIds: selectedIds,
    creatorLarkAppId: pinnedCreator,
  });
  if (!options.ok) {
    return { ok: false, status: 400, error: options.error };
  }

  const isApiOnly = opts?.isApiOnly ?? (() => false);
  if (pinnedCreator && isApiOnly(pinnedCreator)) {
    return { ok: false, status: 400, error: 'lark_transport_disabled' };
  }
  if (options.kickoffBotLarkAppId && isApiOnly(options.kickoffBotLarkAppId)) {
    return { ok: false, status: 400, error: 'lark_transport_disabled' };
  }

  const explicit = Array.isArray(parsed.userOpenIds)
    ? (parsed.userOpenIds as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map(x => x.trim())
        .filter(Boolean)
    : [];

  // Creator must be transport-capable and cannot @-kickoff itself (self-mentions
  // are ignored by Feishu). When `creatorLarkAppId` is explicitly pinned, never
  // fall back to another bot so app-scoped `open_id`s stay bound to that app.
  const creatorCandidates = pinnedCreator
    ? [pinnedCreator]
    : (options.kickoffBotLarkAppId
        ? selectedIds.filter(id => id !== options.kickoffBotLarkAppId)
        : selectedIds);

  const pick = pickCreatorForGroup(creatorCandidates, (id) => (
    isApiOnly(id) ? undefined : getOnlineDaemon(id)
  ));
  if (!pick) {
    return { ok: false, status: 503, error: 'no_online_daemon' };
  }

  const autoInvited: string | null = explicit[0] ?? pick.userOpenIds[0] ?? null;
  // Invite every requested managerUserId so Feishu `addManagers` does not fail
  // with 232011 (user not in chat); `autoInvited` stays derived strictly from
  // `explicit[0] ?? pick.userOpenIds[0]` to preserve owner-transfer semantics.
  const merged = new Set<string>([
    ...explicit,
    ...pick.userOpenIds,
    ...(options.managerUserIds ?? []),
  ]);
  const ownerUnionIds = Array.isArray(parsed.ownerUnionIds)
    ? (parsed.ownerUnionIds as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map(x => x.trim())
        .filter(Boolean)
    : [];

  // Exclude core-only (apiOnly) bots from the Feishu invite list, matching
  // createTeamGroup: they have no Feishu identity to invite.
  const memberIds = selectedIds.filter(id => !isApiOnly(id));

  const forwardBody: Record<string, unknown> = {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    creatorLarkAppId: pick.creatorLarkAppId,
    larkAppIds: memberIds,
    userOpenIds: [...merged],
    ownerUnionIds,
    transferOwnerTo: autoInvited ?? undefined,
    notifyOwnerOpenId: autoInvited ?? undefined,
    bindWorkingDir: typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
      ? parsed.bindWorkingDir.trim()
      : undefined,
    roleProfileId: roleProfileId ?? undefined,
    ...(options.chatMode !== undefined ? { chatMode: options.chatMode } : {}),
    ...(parsed.botCollaboration !== undefined ? { botCollaboration: options.botCollaboration } : {}),
    ...(options.ownerNotice !== undefined ? { ownerNotice: options.ownerNotice } : {}),
    ...(options.managerUserIds !== undefined ? { managerUserIds: options.managerUserIds } : {}),
    ...(options.kickoffBotLarkAppId !== undefined ? {
      kickoffBotLarkAppId: options.kickoffBotLarkAppId,
      kickoffPrompt: options.kickoffPrompt,
    } : {}),
  };

  return {
    ok: true,
    creatorLarkAppId: pick.creatorLarkAppId,
    autoInvited,
    roleProfileId,
    forwardBody,
  };
}

const TOP_NOTICE_ALLOWED_KEYS = new Set(['messageId', 'larkAppId']);

export type ParsedGroupTopNoticeRequest =
  | { ok: true; chatId: string; messageId: string }
  | { ok: false; status: 400 | 409; error: string };

export function parseGroupTopNoticeRequest(
  chatId: string,
  body: unknown,
  boundLarkAppId: string,
): ParsedGroupTopNoticeRequest {
  if (!isPlainJsonObject(body)) {
    return { ok: false, status: 400, error: 'bad_json' };
  }
  if (!hasOnlyAllowedJsonKeys(body, TOP_NOTICE_ALLOWED_KEYS)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (!GROUP_CHAT_ID_RE.test(chatId)) {
    return { ok: false, status: 400, error: 'invalid_chat_id' };
  }
  if (typeof body.messageId !== 'string' || !GROUP_MESSAGE_ID_RE.test(body.messageId)) {
    return { ok: false, status: 400, error: 'invalid_message_id' };
  }
  if (body.larkAppId !== undefined) {
    if (typeof body.larkAppId !== 'string' || !body.larkAppId.trim() || body.larkAppId !== body.larkAppId.trim()) {
      return { ok: false, status: 400, error: 'invalid_lark_app_id' };
    }
    if (body.larkAppId !== boundLarkAppId) {
      return { ok: false, status: 409, error: 'bot_mismatch' };
    }
  }
  return { ok: true, chatId, messageId: body.messageId };
}

const SHARE_LINK_ALLOWED_KEYS = new Set(['validityPeriod', 'larkAppId']);

export type ParsedGroupShareLinkRequest =
  | { ok: true; chatId: string; validityPeriod: ShareLinkValidityPeriod }
  | { ok: false; status: 400 | 409; error: string };

export function parseGroupShareLinkRequest(
  chatId: string,
  body: unknown,
  boundLarkAppId: string,
): ParsedGroupShareLinkRequest {
  if (!isPlainJsonObject(body)) {
    return { ok: false, status: 400, error: 'bad_json' };
  }
  if (!hasOnlyAllowedJsonKeys(body, SHARE_LINK_ALLOWED_KEYS)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (!GROUP_CHAT_ID_RE.test(chatId)) {
    return { ok: false, status: 400, error: 'invalid_chat_id' };
  }
  let validityPeriod: ShareLinkValidityPeriod = 'permanently';
  if (body.validityPeriod !== undefined) {
    if (typeof body.validityPeriod !== 'string' || !SHARE_LINK_VALIDITY_SET.has(body.validityPeriod)) {
      return { ok: false, status: 400, error: 'invalid_validity_period' };
    }
    validityPeriod = body.validityPeriod as ShareLinkValidityPeriod;
  }
  if (body.larkAppId !== undefined) {
    if (typeof body.larkAppId !== 'string' || !body.larkAppId.trim() || body.larkAppId !== body.larkAppId.trim()) {
      return { ok: false, status: 400, error: 'invalid_lark_app_id' };
    }
    if (body.larkAppId !== boundLarkAppId) {
      return { ok: false, status: 409, error: 'bot_mismatch' };
    }
  }
  return { ok: true, chatId, validityPeriod };
}
