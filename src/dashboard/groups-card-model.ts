/**
 * Groups card model (PR1) — pure projection of the dashboard groups matrix
 * (`/api/groups` fan-out, see `dashboard.ts:595-650`) into list-card and
 * detail-card DTOs.
 *
 * Zero IO. Self-contained input shape; no imports from `web/`,
 * `dashboard.ts`, or the registry.
 */

import type { ButtonState, PaginationMeta } from './card-model-types.js';

/** Possible coverage states for one (chat, bot) cell. */
export type GroupCoverageStatus = 'in' | 'out' | 'unknown' | 'error';

/** Oncall binding shape — mirrors `services/oncall-store.ts:28-35 OncallChat`. */
export interface GroupsOncallChatInput {
  chatId: string;
  workingDir: string;
}

/** Per-bot membership row inside a chat. Caller fans out across all configured bots. */
export interface GroupsMemberBotInput {
  larkAppId: string;
  botName: string;
  /** True/false from the daemon `/api/groups/<chat>/membership`. Absent → status decides. */
  inChat?: boolean;
  /** Oncall binding object when bound; null/undefined when not bound.
   *  Following dashboard's contract (`web/groups.ts:440-451`), the mere presence of
   *  the object marks "bound" — `workingDir` may be empty string and still indicates
   *  an explicit bind. */
  oncallChat?: GroupsOncallChatInput | null;
  /** Failure / unknown signal supplied by the aggregator (e.g. daemon offline → 'unknown'; fetch error → 'error'). */
  status?: 'error' | 'unknown';
  hasRole?: boolean;
}

/** One chat row (a Lark group / topic group / multi-user chat). */
export interface GroupsChatInput {
  chatId: string;
  name?: string;
  ownerId?: string;
  memberBots: GroupsMemberBotInput[];
}

/** Configured bot metadata for the matrix column header order. */
export interface GroupsBotInput {
  larkAppId: string;
  botName: string;
}

export interface GroupsFilter {
  query?: string;
  /** When true, keep only chats where at least one configured bot is NOT in chat. */
  missingOnly?: boolean;
}

/** Single (chat, bot) matrix cell. */
export interface CoverageCell {
  larkAppId: string;
  botName: string;
  status: GroupCoverageStatus;
}

export interface GroupRowDto {
  chatId: string;
  /** Last `chatIdLen` (default 4) chars of `chatId`, for compact display. */
  chatIdSuffix: string;
  name: string;
  ownerId?: string;
  /** Coverage cells in `bots` argument order. */
  coverage: CoverageCell[];
  /** Number of cells whose status !== 'in'. */
  missingCount: number;
  totalBots: number;
}

export interface GroupDetailMemberDto {
  larkAppId: string;
  botName: string;
  status: GroupCoverageStatus;
  /** True when this bot is the owner of the chat (ownerId === larkAppId). */
  isOwnerBot: boolean;
  /** Raw oncall binding passthrough; null when unbound. */
  oncallChat: GroupsOncallChatInput | null;
  /** Convenience projection of `oncallChat.workingDir` (or null when unbound). */
  oncallWorkingDir: string | null;
  /** True when this bot has a per-chat role description configured. */
  hasRole: boolean;
  /** bind action button availability. */
  bind: ButtonState;
  /** unbind action button availability. */
  unbind: ButtonState;
}

export interface GroupDetailDto {
  chatId: string;
  chatIdSuffix: string;
  name: string;
  ownerId?: string;
  members: GroupDetailMemberDto[];
}

export interface GroupListPage {
  rows: GroupRowDto[];
  meta: PaginationMeta;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SUFFIX_LEN = 4;

/** Return the last `len` characters of a chatId (whole string when too short). */
export function chatIdSuffix(chatId: string, len = DEFAULT_SUFFIX_LEN): string {
  if (!chatId || chatId.length <= len) return chatId ?? '';
  return chatId.slice(-len);
}

function coverageStatusOf(member: GroupsMemberBotInput | undefined): GroupCoverageStatus {
  if (!member) return 'unknown';
  if (member.status === 'error') return 'error';
  if (member.status === 'unknown') return 'unknown';
  if (member.inChat === true) return 'in';
  if (member.inChat === false) return 'out';
  return 'unknown';
}

/**
 * Filter groups by query / missingOnly. missingOnly keeps a chat when
 * at least one configured bot is NOT effectively covered — covers all four
 * gap types: inChat=false / member row absent / status='unknown' / status='error'.
 *
 * When the optional `bots` universe is provided, `missingOnly` also detects
 * chats whose memberBots list omits a configured bot entirely. Without `bots`,
 * it falls back to the three gap types observable from memberBots alone.
 */
export function filterGroups(
  chats: ReadonlyArray<GroupsChatInput>,
  filter: GroupsFilter,
  bots?: ReadonlyArray<GroupsBotInput>,
): GroupsChatInput[] {
  let out = chats.slice();
  const q = filter.query?.trim().toLowerCase();
  if (q && q.length > 0) {
    out = out.filter(c =>
      (c.name ?? '').toLowerCase().includes(q) ||
      c.chatId.toLowerCase().includes(q) ||
      (c.ownerId ?? '').toLowerCase().includes(q),
    );
  }
  if (filter.missingOnly === true) {
    out = out.filter(c => {
      if (c.memberBots.some(mb => coverageStatusOf(mb) !== 'in')) return true;
      if (bots && bots.length > 0) {
        const present = new Set(c.memberBots.map(mb => mb.larkAppId));
        return bots.some(b => !present.has(b.larkAppId));
      }
      return false;
    });
  }
  return out;
}

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(pageSize);
}

/** Slice a filtered group list into one page. Clamp rules apply. */
export function paginateGroups(
  chats: ReadonlyArray<GroupsChatInput>,
  page?: number,
  pageSize?: number,
): { total: number; page: number; pageSize: number; pageItems: GroupsChatInput[] } {
  const total = chats.length;
  const size = clampPageSize(pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  let active = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 1;
  if (active < 1) active = 1;
  if (active > totalPages) active = totalPages;
  const start = (active - 1) * size;
  return {
    total,
    page: active,
    pageSize: size,
    pageItems: chats.slice(start, start + size),
  };
}

/** Build one matrix row DTO. Coverage column order follows the `bots` argument. */
export function buildGroupRow(chat: GroupsChatInput, bots: ReadonlyArray<GroupsBotInput>): GroupRowDto {
  const memberMap = new Map<string, GroupsMemberBotInput>();
  for (const mb of chat.memberBots) memberMap.set(mb.larkAppId, mb);

  const coverage: CoverageCell[] = bots.map(b => ({
    larkAppId: b.larkAppId,
    botName: b.botName,
    status: coverageStatusOf(memberMap.get(b.larkAppId)),
  }));
  const missingCount = coverage.reduce((n, c) => (c.status === 'in' ? n : n + 1), 0);
  return {
    chatId: chat.chatId,
    chatIdSuffix: chatIdSuffix(chat.chatId),
    name: chat.name ?? chat.chatId,
    ownerId: chat.ownerId,
    coverage,
    missingCount,
    totalBots: bots.length,
  };
}

/** Pipeline: filter → paginate → row-mapping. */
export function buildGroupRows(
  chats: ReadonlyArray<GroupsChatInput>,
  bots: ReadonlyArray<GroupsBotInput>,
  filter: GroupsFilter,
  page?: number,
  pageSize?: number,
): GroupListPage {
  const filtered = filterGroups(chats, filter, bots);
  const paged = paginateGroups(filtered, page, pageSize);
  const totalPages = Math.max(1, Math.ceil(paged.total / paged.pageSize));
  return {
    rows: paged.pageItems.map(c => buildGroupRow(c, bots)),
    meta: {
      total: paged.total,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages,
    },
  };
}

/** Build the detail-card DTO including per-bot bind/unbind action availability. */
export function buildGroupDetail(chat: GroupsChatInput, bots: ReadonlyArray<GroupsBotInput>): GroupDetailDto {
  const memberMap = new Map<string, GroupsMemberBotInput>();
  for (const mb of chat.memberBots) memberMap.set(mb.larkAppId, mb);

  const members: GroupDetailMemberDto[] = bots.map(b => {
    const member = memberMap.get(b.larkAppId);
    const status = coverageStatusOf(member);
    const inChat = status === 'in';
    const oncallRaw = member?.oncallChat;
    // Bound is decided by object presence, not workingDir truthiness — matches
    // `web/groups.ts:440-451` where `m.oncallChat?.workingDir` may be '' yet the
    // bind row still renders as bound.
    const oncallChat: GroupsOncallChatInput | null = oncallRaw && typeof oncallRaw === 'object'
      ? { chatId: oncallRaw.chatId, workingDir: oncallRaw.workingDir }
      : null;
    const oncallWorkingDir = oncallChat ? oncallChat.workingDir : null;
    const isBound = oncallChat !== null;
    const isOwnerBot = chat.ownerId !== undefined && chat.ownerId === b.larkAppId;

    let bind: ButtonState;
    if (!inChat) bind = { enabled: false, reasonKey: 'groups.action.bind.notInChat' };
    else if (isBound) bind = { enabled: false, reasonKey: 'groups.action.bind.alreadyBound' };
    else bind = { enabled: true };

    let unbind: ButtonState;
    if (!inChat) unbind = { enabled: false, reasonKey: 'groups.action.unbind.notInChat' };
    else if (!isBound) unbind = { enabled: false, reasonKey: 'groups.action.unbind.notBound' };
    else unbind = { enabled: true };

    return {
      larkAppId: b.larkAppId,
      botName: b.botName,
      status,
      isOwnerBot,
      oncallChat,
      oncallWorkingDir,
      hasRole: member?.hasRole === true,
      bind,
      unbind,
    };
  });

  return {
    chatId: chat.chatId,
    chatIdSuffix: chatIdSuffix(chat.chatId),
    name: chat.name ?? chat.chatId,
    ownerId: chat.ownerId,
    members,
  };
}
