/**
 * Scriptable, least-privilege bot-to-bot grants.
 *
 * This service intentionally writes only `chatGrants[chatId]`. It never writes
 * `allowedUsers`, `allowedChatGroups`, global grants, team trust, or any
 * operate-capable identity store. Membership checks use Feishu's live
 * `/members/bots` result and fail closed; the long-lived observed-bot fallback
 * is suitable for discovery, not authorization.
 */
import { getBot, getBotOpenId, getOwnerOpenId } from '../bot-registry.js';
import {
  listCurrentChatBotMembers,
  resolveCurrentChatBotOpenIdsByLarkAppIds,
  type CurrentChatBotAppMapping,
  type CurrentChatBotAppResolution,
  type CurrentChatBotMember,
} from '../im/lark/client.js';
import { addChatGrant, removeChatGrant } from './grant-store.js';

export type ExactChatGrantOperation = 'grant' | 'revoke' | 'readback';

export interface ExactChatGrantInput {
  operation: unknown;
  receiverLarkAppId: string;
  chatId: unknown;
  subjectOpenIds: unknown;
}

export interface ExactChatGrantByLarkAppIdsInput {
  operation: unknown;
  receiverLarkAppId: string;
  chatId: unknown;
  subjectLarkAppIds: unknown;
}

export type ExactChatGrantRequestInput = ExactChatGrantInput | ExactChatGrantByLarkAppIdsInput;

export interface ExactChatGrantSubjectResult {
  subjectOpenId: string;
  chatGrantActive: boolean;
  changed: boolean;
  grantsTalk: boolean;
  grantsOperate: false;
}

export interface ExactChatGrantSuccess {
  ok: true;
  operation: ExactChatGrantOperation;
  permissionSource: 'chatGrant';
  talkOnly: true;
  receiverLarkAppId: string;
  chatId: string;
  grantsTalk: boolean;
  grantsOperate: false;
  subjects: ExactChatGrantSubjectResult[];
  subjectMappings?: CurrentChatBotAppMapping[];
}

export interface ExactChatGrantFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  invalidSubjectOpenIds?: string[];
  invalidSubjectLarkAppIds?: string[];
  partial?: ExactChatGrantSubjectResult[];
}

type GrantMutationResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: string };
type RevokeMutationResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: string };

export interface ExactChatGrantDeps {
  getOwnerOpenId(larkAppId: string): string | undefined;
  getReceiverBotOpenId(larkAppId: string): string | undefined;
  listCurrentChatBotMembers(larkAppId: string, chatId: string): Promise<CurrentChatBotMember[]>;
  resolveCurrentChatBotOpenIdsByLarkAppIds(
    receiverLarkAppId: string,
    chatId: string,
    subjectLarkAppIds: string[],
  ): Promise<CurrentChatBotAppResolution>;
  addChatGrant(larkAppId: string, chatId: string, openId: string): Promise<GrantMutationResult>;
  removeChatGrant(larkAppId: string, chatId: string, openId: string): Promise<RevokeMutationResult>;
  listGrantedOpenIds(larkAppId: string, chatId: string): string[];
}

const defaultDeps: ExactChatGrantDeps = {
  getOwnerOpenId,
  getReceiverBotOpenId: getBotOpenId,
  listCurrentChatBotMembers,
  resolveCurrentChatBotOpenIdsByLarkAppIds,
  addChatGrant,
  removeChatGrant,
  listGrantedOpenIds: (larkAppId, chatId) => [...(getBot(larkAppId).config.chatGrants?.[chatId] ?? [])],
};

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/;
const LARK_APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/;
export const MAX_EXACT_CHAT_GRANT_SUBJECTS = 50;

function failure(
  status: number,
  error: string,
  message: string,
  extra?: Pick<ExactChatGrantFailure, 'invalidSubjectOpenIds' | 'invalidSubjectLarkAppIds' | 'partial'>,
): ExactChatGrantFailure {
  return { ok: false, status, error, message, ...extra };
}

function normalizeSubjectLarkAppIds(raw: unknown): { ok: true; value: string[] } | ExactChatGrantFailure {
  if (!Array.isArray(raw) || !raw.every(value => typeof value === 'string')) {
    return failure(
      400,
      'subject_lark_app_ids_required',
      'subjectLarkAppIds must be an array of stable cli_ app ids',
    );
  }
  if (raw.length > MAX_EXACT_CHAT_GRANT_SUBJECTS) {
    return failure(
      400,
      'too_many_subject_lark_app_ids',
      `At most ${MAX_EXACT_CHAT_GRANT_SUBJECTS} subjects may be submitted at once`,
    );
  }
  const trimmed = raw.map(value => (value as string).trim());
  const invalid = trimmed.filter(value => !LARK_APP_ID_RE.test(value));
  if (invalid.length > 0) {
    return failure(400, 'invalid_subject_lark_app_id', 'Every subject must be a valid cli_ app id', {
      invalidSubjectLarkAppIds: [...new Set(invalid)],
    });
  }
  return { ok: true, value: [...new Set(trimmed)] };
}

function normalizeSubjects(raw: unknown): { ok: true; value: string[] } | ExactChatGrantFailure {
  if (!Array.isArray(raw) || !raw.every(value => typeof value === 'string')) {
    return failure(400, 'subject_open_ids_required', 'subjectOpenIds must be an array of open_id strings');
  }
  if (raw.length > MAX_EXACT_CHAT_GRANT_SUBJECTS) {
    return failure(
      400,
      'too_many_subject_open_ids',
      `At most ${MAX_EXACT_CHAT_GRANT_SUBJECTS} subjects may be submitted at once`,
    );
  }
  const trimmed = raw.map(value => (value as string).trim());
  const invalid = trimmed.filter(value => !OPEN_ID_RE.test(value));
  if (invalid.length > 0) {
    return failure(400, 'invalid_subject_open_id', 'Every subject must be a valid ou_ open_id', {
      invalidSubjectOpenIds: [...new Set(invalid)],
    });
  }
  return { ok: true, value: [...new Set(trimmed)] };
}

/**
 * Validate and apply one exact chat-grant batch. For grants, every target is
 * validated against one live membership snapshot before the first mutation,
 * so a bad or stale subject cannot produce a partially-authorized batch.
 */
export async function applyExactChatGrant(
  input: ExactChatGrantInput,
  deps: ExactChatGrantDeps = defaultDeps,
): Promise<ExactChatGrantSuccess | ExactChatGrantFailure> {
  if (input.operation !== 'grant' && input.operation !== 'revoke' && input.operation !== 'readback') {
    return failure(400, 'invalid_operation', 'operation must be grant, revoke, or readback');
  }
  const operation = input.operation;
  if (typeof input.chatId !== 'string' || !CHAT_ID_RE.test(input.chatId)) {
    return failure(400, 'invalid_chat_id', 'chatId must be a valid oc_ chat id');
  }
  const chatId = input.chatId;
  const normalized = normalizeSubjects(input.subjectOpenIds);
  if (!normalized.ok) return normalized;
  const subjectOpenIds = normalized.value;
  if (subjectOpenIds.length === 0) {
    return failure(400, 'subject_open_ids_required', 'At least one subjectOpenId is required');
  }
  if (operation === 'grant' && !deps.getOwnerOpenId(input.receiverLarkAppId)) {
    return failure(422, 'receiver_owner_missing', 'Receiver bot has no resolved owner');
  }
  const receiverBotOpenId = deps.getReceiverBotOpenId(input.receiverLarkAppId);
  if (operation === 'grant' && !receiverBotOpenId) {
    return failure(409, 'receiver_bot_open_id_unavailable', 'Receiver bot open_id is not ready');
  }
  if (operation === 'grant' && receiverBotOpenId && subjectOpenIds.includes(receiverBotOpenId)) {
    return failure(400, 'receiver_cannot_be_subject', 'Receiver bot cannot grant itself chat access', {
      invalidSubjectOpenIds: [receiverBotOpenId],
    });
  }

  // Grant requires current membership. Revoke deliberately does not: an
  // operator must still be able to clean a grant after the subject left the
  // chat. Readback returns only explicitly requested ids and does not enumerate
  // the grant table.
  if (operation === 'grant') {
    let members: CurrentChatBotMember[];
    try {
      members = await deps.listCurrentChatBotMembers(input.receiverLarkAppId, chatId);
    } catch (err: any) {
      return failure(
        502,
        'live_membership_unavailable',
        err?.message ?? 'Feishu live bot membership lookup failed',
      );
    }
    const currentOpenIds = new Set(members.map(member => member.openId));
    const missing = subjectOpenIds.filter(openId => !currentOpenIds.has(openId));
    if (missing.length > 0) {
      return failure(
        409,
        'subject_not_current_chat_bot',
        'Every subject must appear in the receiver-scoped live /members/bots result',
        { invalidSubjectOpenIds: missing },
      );
    }
  }

  if (operation === 'readback') {
    let granted: Set<string>;
    try {
      granted = new Set(deps.listGrantedOpenIds(input.receiverLarkAppId, chatId));
    } catch (err: any) {
      return failure(500, 'grant_read_failed', err?.message ?? 'Unable to read chat grants');
    }
    const subjects = subjectOpenIds.map((subjectOpenId): ExactChatGrantSubjectResult => {
      const isGranted = granted.has(subjectOpenId);
      return {
        subjectOpenId,
        chatGrantActive: isGranted,
        changed: false,
        grantsTalk: isGranted,
        grantsOperate: false,
      };
    });
    return {
      ok: true,
      operation,
      permissionSource: 'chatGrant',
      talkOnly: true,
      receiverLarkAppId: input.receiverLarkAppId,
      chatId,
      grantsTalk: subjects.every(subject => subject.grantsTalk),
      grantsOperate: false,
      subjects,
    };
  }

  const subjects: ExactChatGrantSubjectResult[] = [];
  for (const subjectOpenId of subjectOpenIds) {
    if (operation === 'grant') {
      const result = await deps.addChatGrant(input.receiverLarkAppId, chatId, subjectOpenId);
      if (!result.ok) {
        return failure(500, 'grant_write_failed', result.reason, { partial: subjects });
      }
      subjects.push({
        subjectOpenId,
        chatGrantActive: true,
        changed: result.created,
        grantsTalk: true,
        grantsOperate: false,
      });
    } else {
      const result = await deps.removeChatGrant(input.receiverLarkAppId, chatId, subjectOpenId);
      if (!result.ok) {
        return failure(500, 'grant_write_failed', result.reason, { partial: subjects });
      }
      subjects.push({
        subjectOpenId,
        chatGrantActive: false,
        changed: result.removed,
        grantsTalk: false,
        grantsOperate: false,
      });
    }
  }

  return {
    ok: true,
    operation,
    permissionSource: 'chatGrant',
    talkOnly: true,
    receiverLarkAppId: input.receiverLarkAppId,
    chatId,
    grantsTalk: operation === 'grant',
    grantsOperate: false,
    subjects,
  };
}

/**
 * Resolve stable subject app ids inside the receiver daemon, then delegate the
 * actual membership validation, mutation, and readback contract to the existing
 * exact open-id grant primitive.
 */
export async function applyExactChatGrantByLarkAppIds(
  input: ExactChatGrantByLarkAppIdsInput,
  deps: ExactChatGrantDeps = defaultDeps,
): Promise<ExactChatGrantSuccess | ExactChatGrantFailure> {
  if (input.operation !== 'grant') {
    return failure(
      400,
      'subject_lark_app_ids_grant_only',
      'subjectLarkAppIds may only be used with operation=grant',
    );
  }
  if (typeof input.chatId !== 'string' || !CHAT_ID_RE.test(input.chatId)) {
    return failure(400, 'invalid_chat_id', 'chatId must be a valid oc_ chat id');
  }
  const normalized = normalizeSubjectLarkAppIds(input.subjectLarkAppIds);
  if (!normalized.ok) return normalized;
  const subjectLarkAppIds = normalized.value;
  if (subjectLarkAppIds.length === 0) {
    return failure(400, 'subject_lark_app_ids_required', 'At least one subjectLarkAppId is required');
  }

  let resolved: CurrentChatBotAppResolution;
  try {
    resolved = await deps.resolveCurrentChatBotOpenIdsByLarkAppIds(
      input.receiverLarkAppId,
      input.chatId,
      subjectLarkAppIds,
    );
  } catch (err: any) {
    return failure(
      502,
      'live_membership_unavailable',
      err?.message ?? 'Stable subject identity resolution failed',
      { invalidSubjectLarkAppIds: subjectLarkAppIds },
    );
  }
  if (!resolved.ok) {
    return failure(
      resolved.error === 'live_membership_unavailable' ? 502 : 409,
      resolved.error,
      resolved.message,
      { invalidSubjectLarkAppIds: resolved.invalidSubjectLarkAppIds },
    );
  }

  const mappingByAppId = new Map<string, CurrentChatBotAppMapping>();
  const mappedOpenIds = new Set<string>();
  let invalidMapping = false;
  for (const mapping of resolved.mappings) {
    if (
      !subjectLarkAppIds.includes(mapping.larkAppId)
      || mappingByAppId.has(mapping.larkAppId)
      || !OPEN_ID_RE.test(mapping.subjectOpenId)
      || mappedOpenIds.has(mapping.subjectOpenId)
    ) {
      invalidMapping = true;
      break;
    }
    mappingByAppId.set(mapping.larkAppId, mapping);
    mappedOpenIds.add(mapping.subjectOpenId);
  }
  const subjectMappings = subjectLarkAppIds.map(appId => mappingByAppId.get(appId));
  if (invalidMapping || subjectMappings.some(mapping => !mapping)) {
    return failure(502, 'subject_mapping_invalid', 'Stable subject resolution returned an incomplete mapping', {
      invalidSubjectLarkAppIds: subjectLarkAppIds.filter(appId => !mappingByAppId.has(appId)),
    });
  }
  const completeMappings = subjectMappings as CurrentChatBotAppMapping[];
  const result = await applyExactChatGrant({
    operation: 'grant',
    receiverLarkAppId: input.receiverLarkAppId,
    chatId: input.chatId,
    subjectOpenIds: completeMappings.map(mapping => mapping.subjectOpenId),
  }, deps);
  if (!result.ok) return result;
  return { ...result, subjectMappings: completeMappings };
}

/** Shared endpoint entry point; callers must provide exactly one subject form. */
export async function applyExactChatGrantRequest(
  input: ExactChatGrantRequestInput,
  deps: ExactChatGrantDeps = defaultDeps,
): Promise<ExactChatGrantSuccess | ExactChatGrantFailure> {
  if ('subjectLarkAppIds' in input) return applyExactChatGrantByLarkAppIds(input, deps);
  return applyExactChatGrant(input, deps);
}
