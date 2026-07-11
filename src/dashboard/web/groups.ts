import { t } from './ui.js';
import type {
  EffectiveRoleValue,
  RoleProfileEntryLike,
  RoleProfileSummaryLike,
} from './role-profile-match.js';
import {
  emptyGroupsSnapshot,
  fetchGroupsSnapshot,
  type GroupBot,
  type GroupChat,
  type GroupFilters,
  type GroupsSnapshot,
} from './groups-api.js';
import { effectiveRoleKey, loadEffectiveRoleMap } from './role-batch.js';

export {
  emptyGroupsSnapshot,
  fetchGroupsSnapshot,
};
export type {
  GroupBot,
  GroupChat,
  GroupFilters,
  GroupsSnapshot,
};

const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const GROUP_ROLE_CONTEXT_CONCURRENCY = 6;
export const GROUPS_PAGE_SIZE = 30;

export interface RoleProfileContext {
  profiles: RoleProfileSummaryLike[];
  entriesById: Map<string, RoleProfileEntryLike[]>;
  groupRoleContentByBot: Map<string, EffectiveRoleValue>;
  loaded: boolean;
}

export interface GroupPageWindow<T> {
  rows: T[];
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
}

export type SaveProfileEntryStatus = 'chat' | 'team' | 'empty' | 'error';

export interface SaveProfileEntry {
  larkAppId: string;
  botName?: string;
  content: string;
  status: SaveProfileEntryStatus;
}

export interface GroupAddBotResult {
  id?: unknown;
  ok?: unknown;
  error?: unknown;
}

export interface AddBotsSummary {
  rows: GroupAddBotResult[];
  okCount: number;
  failed: number;
}

export interface RoleProfileBootstrapStatus {
  kind: 'ok' | 'warn';
  text: string;
}

export function roleKey(larkAppId: string, chatId: string): string {
  return effectiveRoleKey(larkAppId, chatId);
}

/** Keep the expensive group coverage matrix bounded to one client-side page. */
export function paginateGroupRows<T>(
  rows: T[],
  requestedPage: number,
  pageSize = GROUPS_PAGE_SIZE,
): GroupPageWindow<T> {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : GROUPS_PAGE_SIZE;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(totalPages, Math.max(1, normalizedPage));
  const start = (page - 1) * safePageSize;
  const to = Math.min(total, start + safePageSize);
  return {
    rows: rows.slice(start, to),
    page,
    totalPages,
    from: total === 0 ? 0 : start + 1,
    to,
    total,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export function isValidProfileId(profileId: string): boolean {
  return PROFILE_ID_RE.test(profileId) && profileId !== '.' && profileId !== '..';
}

export function suggestRoleProfileIdFromChat(value: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return isValidProfileId(cleaned) ? cleaned : 'profile';
}

export async function fetchRoleProfileSummaries(): Promise<RoleProfileSummaryLike[]> {
  const r = await fetch('/api/role-profiles');
  const body = await r.json().catch(() => ({}));
  return Array.isArray(body.profiles) ? body.profiles as RoleProfileSummaryLike[] : [];
}

export async function loadGroupRoleProfileContext(snapshot: GroupsSnapshot): Promise<RoleProfileContext> {
  const nextProfiles = await fetchRoleProfileSummaries();
  const detailPairs = await mapWithConcurrency(nextProfiles, GROUP_ROLE_CONTEXT_CONCURRENCY, async profile => {
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profile.profileId)}`);
      const body = await r.json().catch(() => ({}));
      return [profile.profileId, Array.isArray(body.entries) ? body.entries as RoleProfileEntryLike[] : []] as const;
    } catch {
      return [profile.profileId, [] as RoleProfileEntryLike[]] as const;
    }
  });

  const seenRoleKeys = new Set<string>();
  const roleTargets: Array<{ chatId: string; larkAppId: string }> = [];
  for (const chat of snapshot.chats ?? []) {
    for (const bot of chat.memberBots ?? []) {
      // Profile matching intentionally considers explicit chat roles only.
      // /api/groups already tells us whether one exists, so skip every
      // unconfigured membership instead of reading its effective team role.
      if (!bot?.inChat || !bot?.hasRole || !bot?.larkAppId) continue;
      const key = roleKey(bot.larkAppId, chat.chatId);
      if (seenRoleKeys.has(key)) continue;
      seenRoleKeys.add(key);
      roleTargets.push({ chatId: chat.chatId, larkAppId: bot.larkAppId });
    }
  }
  const nextGroupRoles = await loadEffectiveRoleMap(roleTargets);

  return {
    profiles: nextProfiles,
    entriesById: new Map(detailPairs),
    groupRoleContentByBot: nextGroupRoles,
    loaded: true,
  };
}

export async function collectGroupProfileEntries(chat: GroupChat): Promise<SaveProfileEntry[]> {
  const inChat = (chat.memberBots ?? []).filter(bot => bot?.inChat && bot?.larkAppId);
  return mapWithConcurrency(inChat, GROUP_ROLE_CONTEXT_CONCURRENCY, async bot => {
    try {
      const r = await fetch(`/api/roles/${encodeURIComponent(bot.larkAppId)}/${encodeURIComponent(chat.chatId)}`);
      const body = await r.json().catch(() => ({}));
      const hasEffectiveRole = body?.hasEffectiveRole ?? body?.hasRole;
      const effectiveContent = 'effectiveContent' in body ? body.effectiveContent : body.content;
      const content = hasEffectiveRole ? String(effectiveContent ?? '').trim() : '';
      const source = body?.effectiveSource === 'chat' || body?.effectiveSource === 'team'
        ? body.effectiveSource as SaveProfileEntryStatus
        : null;
      return {
        larkAppId: bot.larkAppId,
        botName: bot.botName,
        content,
        status: content ? (source ?? 'chat') : 'empty',
      };
    } catch {
      return {
        larkAppId: bot.larkAppId,
        botName: bot.botName,
        content: '',
        status: 'error' as const,
      };
    }
  });
}

export function availableBotsForPicker(
  bots: GroupBot[],
  excludeIds?: Set<string>,
): GroupBot[] {
  return bots.filter(bot => !excludeIds || !excludeIds.has(bot.larkAppId));
}

export function filterGroupChats(chats: GroupChat[], filters: GroupFilters): GroupChat[] {
  const q = filters.q.trim().toLowerCase();
  return chats
    .filter(chat => !q ||
      (chat.name ?? '').toLowerCase().includes(q) ||
      chat.chatId.toLowerCase().includes(q) ||
      (chat.ownerId ?? '').toLowerCase().includes(q)
    )
    .filter(chat => !filters.missingOnly || (chat.memberBots ?? []).some(member => !member.inChat));
}

/** True iff every expected bot id appears in the row's memberBots with
 *  inChat:true. Used by refreshUntilSeen to defer committing a canonical
 *  snapshot until all invited bots have caught up Lark-side. */
export function allExpectedInChat(row: GroupChat | null | undefined, expectedBotIds: Set<string>): boolean {
  if (expectedBotIds.size === 0) return true;
  const members = (row?.memberBots ?? []) as Array<{ larkAppId: string; inChat: boolean }>;
  for (const id of expectedBotIds) {
    if (!members.some(m => m.larkAppId === id && m.inChat)) return false;
  }
  return true;
}

export function summarizeAddBotsResult(result: GroupAddBotResult[]): AddBotsSummary {
  const rows = Array.isArray(result) ? result : [];
  const okCount = rows.filter(row => !!row?.ok).length;
  return { rows, okCount, failed: rows.length - okCount };
}

export function roleProfileBootstrapStatus(
  profileId: string,
  messageId?: unknown,
  error?: unknown,
): RoleProfileBootstrapStatus | null {
  const cleanProfileId = String(profileId ?? '').trim();
  if (!cleanProfileId) return null;

  if (error) {
    return {
      kind: 'warn',
      text: t('groups.roleProfileBootstrapFailed', {
        name: cleanProfileId,
        reason: String(error),
      }),
    };
  }

  const cleanMessageId = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : '';
  if (cleanMessageId) {
    return {
      kind: 'ok',
      text: t('groups.roleProfileBootstrapSent', {
        name: cleanProfileId,
        messageId: cleanMessageId,
      }),
    };
  }

  return {
    kind: 'ok',
    text: t('groups.roleProfileBootstrapDone', { name: cleanProfileId }),
  };
}

export function injectOptimisticChat(
  snapshot: GroupsSnapshot,
  chatId: string,
  displayName: string,
  memberIds: string[],
  creator: string | undefined,
): GroupsSnapshot {
  const inChatSet = new Set(memberIds);
  if (creator) inChatSet.add(creator);
  const optimistic: GroupChat = {
    chatId,
    name: displayName,
    ownerId: creator ?? null,
    memberBots: snapshot.bots.map(bot => ({
      larkAppId: bot.larkAppId,
      botName: bot.botName,
      inChat: inChatSet.has(bot.larkAppId),
      oncallChat: null,
    })),
  };
  return {
    bots: snapshot.bots,
    chats: [optimistic, ...snapshot.chats.filter(chat => chat.chatId !== chatId)],
  };
}
