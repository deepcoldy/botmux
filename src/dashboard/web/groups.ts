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
  type GroupMemberBot,
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

/**
 * True iff at least one roster bot is not yet in the chat — i.e. the add-bots
 * picker would still have a candidate. Drives the "添加 bot" button's disabled
 * state so a fully-covered chat greys the button out instead of opening a dialog
 * that has nothing to add. Derived purely from the current snapshot (`memberBots`
 * + `bots`), so the disabled state recovers automatically when membership or the
 * bot roster changes.
 */
export function chatHasAddableBots(chat: GroupChat, bots: GroupBot[]): boolean {
  const inChatSet = new Set(
    (chat.memberBots ?? []).filter(member => member.inChat).map(member => member.larkAppId),
  );
  return availableBotsForPicker(bots, inChatSet).length > 0;
}

/**
 * Resolve a bot's display label for the add-bots result panel: the roster's
 * `botName` when known, else the raw id. Keeps the result rows consistent with
 * the picker checkboxes, which show `botName ?? larkAppId`. (Distinct from
 * `ui.botDisplayName`, which derives a name from a live session record.)
 */
export function botNameById(larkAppId: string, bots: GroupBot[]): string {
  const meta = bots.find(bot => bot.larkAppId === larkAppId);
  return meta?.botName ?? larkAppId;
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

export interface AddBotsFollowup {
  /** Ids of bots added successfully this round — non-empty strings, deduped. */
  okIds: string[];
  /** Candidate bots still selectable after excluding inChat + prior + this round. */
  remaining: number;
  /** Close the dialog only when nothing is left to add AND nothing failed. */
  shouldClose: boolean;
}

/**
 * Decide what to do after an add-bots POST returns. The close/candidate decision
 * runs on **local optimistic state** (`alreadyExcluded` ∪ this round's okIds), NOT
 * on a freshly-reloaded group snapshot: Lark propagates `chatMembers.create` with a
 * delay (see `refreshUntilSeen`), so a single reload can still report the just-added
 * bots as missing and wrongly keep the dialog open.
 */
export function planAddBotsFollowup(
  summary: AddBotsSummary,
  allBots: GroupBot[],
  alreadyExcluded: Set<string>,
): AddBotsFollowup {
  const okIds = Array.from(new Set(
    summary.rows
      .filter(row => !!row?.ok)
      .map(row => row?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));
  const nextExcluded = new Set(alreadyExcluded);
  for (const id of okIds) nextExcluded.add(id);
  const remaining = availableBotsForPicker(allBots, nextExcluded).length;
  return { okIds, remaining, shouldClose: remaining === 0 && summary.failed === 0 };
}

/**
 * Optimistically mark `okIds` as `inChat: true` on the target chat, mirroring
 * `injectOptimisticChat`: immutable return, existing member fields preserved, and
 * any okId missing from `memberBots` is appended once (deduped) using `snapshot.bots`
 * metadata. Other chats are returned untouched.
 */
export function markBotsInChat(
  snapshot: GroupsSnapshot,
  chatId: string,
  okIds: string[],
): GroupsSnapshot {
  const addSet = new Set(okIds.filter(id => typeof id === 'string' && id.length > 0));
  if (addSet.size === 0) return snapshot;
  const botMetaById = new Map(snapshot.bots.map(bot => [bot.larkAppId, bot]));
  return {
    bots: snapshot.bots,
    chats: snapshot.chats.map(chat => {
      if (chat.chatId !== chatId) return chat;
      const seen = new Set<string>();
      const members: GroupMemberBot[] = (chat.memberBots ?? []).map(member => {
        seen.add(member.larkAppId);
        return addSet.has(member.larkAppId) ? { ...member, inChat: true } : member;
      });
      for (const id of addSet) {
        if (seen.has(id)) continue;
        const meta = botMetaById.get(id);
        members.push({ larkAppId: id, botName: meta?.botName, inChat: true, oncallChat: null });
      }
      return { ...chat, memberBots: members };
    }),
  };
}

export interface AddBotsReconcilerDeps {
  /** Force-fetch the canonical groups snapshot from the server. */
  fetchSnapshot(): Promise<GroupsSnapshot>;
  /** Resolve after `ms` (injectable so tests can drive the poll deterministically). */
  delay(ms: number): Promise<void>;
  /**
   * Commit the reconciled membership for `chatId`. The receiver MUST merge only this
   * chat's row into the live snapshot (see `mergeReconciledChat`), never replace the
   * whole snapshot — the reconciler's concurrency domain is a single chat, so blindly
   * committing `snapshot` would roll back another chat's still-optimistic memberships.
   */
  commit(chatId: string, snapshot: GroupsSnapshot): void;
  /** False once the page unmounts — stop polling and never commit. */
  isMounted(): boolean;
  /** Poll backoff schedule; defaults mirror the group-create `refreshUntilSeen`. */
  delays?: number[];
}

/**
 * Merge one reconciled chat's canonical row from `source` (a fresh full server snapshot)
 * into `base` (the live, possibly-optimistic snapshot), replacing ONLY that chat's row and
 * leaving every other chat's optimistic membership untouched.
 *
 * This is the cross-chat safety valve: the add-bots reconciler's guards are per-chat, but a
 * server snapshot fetched while reconciling chat-X still carries chat-Y's not-yet-propagated
 * (missing) membership. Committing the whole snapshot would roll Y back; merging just X's row
 * keeps Y optimistic until its own poll converges. The available-bot roster is refreshed from
 * `source` (it carries no per-chat membership, so it cannot cause a rollback). If `source` has
 * no row for `chatId`, `base` is returned unchanged.
 */
export function mergeReconciledChat(
  base: GroupsSnapshot,
  chatId: string,
  source: GroupsSnapshot,
): GroupsSnapshot {
  const sourceRow = (source.chats ?? []).find(chat => chat.chatId === chatId);
  if (!sourceRow) return base;
  return {
    bots: source.bots ?? base.bots,
    chats: (base.chats ?? []).map(chat => (chat.chatId === chatId ? sourceRow : chat)),
  };
}

export interface ReconciledChatCommitDeps {
  /**
   * Read the LIVE (possibly-optimistic) snapshot. It MUST reflect the previous commit
   * synchronously — i.e. `applySnapshot` has to update the same source this reads — so
   * two commits in one React batch chain instead of racing.
   */
  getSnapshot(): GroupsSnapshot;
  /**
   * Persist the merged snapshot. The implementation MUST route through the app's single
   * snapshot entry point, which updates the synchronous ref backing `getSnapshot` FIRST and
   * then enqueues an absolute React state value. Sync-ref-first is what lets a second chat
   * commit in the same batch read this result, and having exactly one entry point stops a
   * stale queued updater from later clobbering the ref during flush.
   */
  applySnapshot(merged: GroupsSnapshot): void;
  /** Post-commit hook (e.g. refresh role-profile context) with the exact merged snapshot. */
  onCommitted(merged: GroupsSnapshot): void;
}

/**
 * Build the add-bots reconciler `commit` callback with correct multi-commit React wiring.
 *
 * Two chat commits can land in the SAME React batch (poll-X and poll-Y converging together).
 * The naive approach — compute an absolute `merged` from `snapshotRef.current` then
 * `setSnapshot(merged)` — is broken because the ref only updates when React runs the state
 * updater, so both commits read the same pre-batch snapshot and the later absolute value
 * silently overwrites the earlier chat's canonical merge.
 *
 * Here each commit reads the live snapshot via `getSnapshot` (which `applySnapshot` keeps in
 * sync synchronously), merges only this chat's row (`mergeReconciledChat`), applies it, and
 * hands the merged snapshot to `onCommitted`. Read→merge→write is atomic per commit, so the
 * second commit sees the first's result and both chats end up canonical.
 */
export function createReconciledChatCommitter(
  deps: ReconciledChatCommitDeps,
): (chatId: string, next: GroupsSnapshot) => void {
  return (chatId, next) => {
    const merged = mergeReconciledChat(deps.getSnapshot(), chatId, next);
    deps.applySnapshot(merged);
    deps.onCommitted(merged);
  };
}

/**
 * Reconcile optimistic add-bots memberships against the (Lark-delayed) server
 * snapshot. Batches on the same chat can overlap — the dialog lets the user submit
 * batch B while batch A is still catching up — so two guards prevent an older poll
 * from committing a stale server snapshot that rolls a newer batch back to missing:
 *
 *   1. Per-chat generation id: starting a newer batch bumps it, so any older in-flight
 *      poll for that chat sees a stale generation and bails without committing.
 *   2. Per-chat union of pending okIds: the surviving newest poll only commits once the
 *      server shows *every* still-unconverged bot for the chat, not merely its own batch.
 *
 * The commit itself is scoped to `chatId` (the caller merges only that row via
 * `mergeReconciledChat`), so reconciling one chat never rolls back another chat's
 * still-optimistic memberships. A committed (fully converged) chat clears both maps,
 * so later independent batches start clean.
 */
export function createAddBotsReconciler(deps: AddBotsReconcilerDeps): {
  reconcile(chatId: string, okIds: string[]): Promise<void>;
} {
  const runByChat = new Map<string, number>();
  const pendingByChat = new Map<string, Set<string>>();
  const delays = deps.delays ?? [600, 1200, 1200, 1200, 1200, 1200];

  async function reconcile(chatId: string, okIds: string[]): Promise<void> {
    const cleanIds = okIds.filter(id => typeof id === 'string' && id.length > 0);
    if (cleanIds.length === 0) return;
    const pending = pendingByChat.get(chatId) ?? new Set<string>();
    for (const id of cleanIds) pending.add(id);
    pendingByChat.set(chatId, pending);
    const myRun = (runByChat.get(chatId) ?? 0) + 1;
    runByChat.set(chatId, myRun);

    for (const ms of delays) {
      await deps.delay(ms);
      if (!deps.isMounted()) return;
      if (runByChat.get(chatId) !== myRun) return; // a newer batch owns this chat now
      let next: GroupsSnapshot;
      try { next = await deps.fetchSnapshot(); }
      catch { continue; }
      if (!deps.isMounted()) return;
      if (runByChat.get(chatId) !== myRun) return; // superseded while fetching
      const expected = pendingByChat.get(chatId) ?? new Set<string>();
      const row = (next.chats ?? []).find(chat => chat.chatId === chatId);
      if (row && allExpectedInChat(row, expected)) {
        pendingByChat.delete(chatId);
        runByChat.delete(chatId);
        deps.commit(chatId, next);
        return;
      }
    }
  }

  return { reconcile };
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
