export interface GroupBot {
  larkAppId: string;
  botName?: string;
  botAvatarUrl?: string;
}

export interface GroupMemberBot extends GroupBot {
  inChat: boolean;
  hasRole?: boolean;
  error?: unknown;
  oncallChat?: { workingDir?: string } | null;
  replyPolicy?: GroupReplyPolicy;
}

export interface GroupChat {
  chatId: string;
  name?: string;
  ownerId?: string | null;
  avatar?: string;
  chatMode?: string;
  memberBots: GroupMemberBot[];
}

export type GroupReplyMode = 'chat' | 'chat-topic' | 'shared' | 'new-topic';
export type GroupReplyModeSelection = 'inherit' | 'chat' | 'chat-topic' | 'topic' | 'new-topic';

export interface GroupReplyPolicy {
  chatId: string;
  override: GroupReplyMode | null;
  default: GroupReplyMode;
  effective: GroupReplyMode;
  inherited: boolean;
}

export interface GroupsSnapshot {
  chats: GroupChat[];
  bots: GroupBot[];
}

export interface GroupFilters {
  q: string;
  missingOnly: boolean;
}

export interface FetchGroupsSnapshotOptions {
  cacheMs?: number;
  force?: boolean;
}

export const emptyGroupsSnapshot: GroupsSnapshot = { chats: [], bots: [] };

let cachedSnapshot: GroupsSnapshot = emptyGroupsSnapshot;
let cachedAt = 0;
let inFlight: Promise<GroupsSnapshot> | null = null;
let requestSeq = 0;
let latestRequestSeq = 0;

function normalizeGroupsSnapshot(body: any): GroupsSnapshot {
  return {
    chats: Array.isArray(body?.chats) ? body.chats as GroupChat[] : [],
    bots: Array.isArray(body?.bots) ? body.bots as GroupBot[] : [],
  };
}

function normalizeReplyMode(value: unknown): GroupReplyMode | null {
  if (value === 'chat' || value === 'chat-topic' || value === 'new-topic') return value;
  if (value === 'shared' || value === 'topic') return 'shared';
  return null;
}

export function normalizeGroupReplyPolicy(value: unknown, chatId = ''): GroupReplyPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const defaultMode = normalizeReplyMode(record.default);
  const effective = normalizeReplyMode(record.effective);
  const override = record.override == null ? null : normalizeReplyMode(record.override);
  if (!defaultMode || !effective || (record.override != null && !override)) return null;
  return {
    chatId: typeof record.chatId === 'string' && record.chatId ? record.chatId : chatId,
    override,
    default: defaultMode,
    effective,
    inherited: record.inherited === true || override === null,
  };
}

async function readReplyPolicyResponse(response: Response, chatId: string): Promise<GroupReplyPolicy> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(String(body?.error ?? body?.reason ?? `HTTP ${response.status}`));
  }
  const policy = normalizeGroupReplyPolicy(body, chatId);
  if (!policy) throw new Error('invalid_reply_policy_response');
  return policy;
}

function replyPolicyUrl(chatId: string, larkAppId: string): string {
  return `/api/groups/${encodeURIComponent(chatId)}/reply-mode/${encodeURIComponent(larkAppId)}`;
}

export async function fetchGroupReplyPolicy(chatId: string, larkAppId: string): Promise<GroupReplyPolicy> {
  const response = await fetch(replyPolicyUrl(chatId, larkAppId));
  return readReplyPolicyResponse(response, chatId);
}

export async function setGroupReplyMode(
  chatId: string,
  larkAppId: string,
  selection: GroupReplyModeSelection,
): Promise<GroupReplyPolicy> {
  const url = replyPolicyUrl(chatId, larkAppId);
  const response = selection === 'inherit'
    ? await fetch(url, { method: 'DELETE' })
    : await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: selection === 'topic' ? 'shared' : selection }),
      });
  return readReplyPolicyResponse(response, chatId);
}

/** Apply a successful per-chat write to the client snapshot without mutating it. */
export function withGroupReplyPolicy(
  snapshot: GroupsSnapshot,
  chatId: string,
  larkAppId: string,
  policy: GroupReplyPolicy,
): GroupsSnapshot {
  let changed = false;
  const chats = snapshot.chats.map(chat => {
    if (chat.chatId !== chatId) return chat;
    const memberBots = chat.memberBots.map(member => {
      if (member.larkAppId !== larkAppId) return member;
      changed = true;
      return { ...member, replyPolicy: policy };
    });
    return changed ? { ...chat, memberBots } : chat;
  });
  return changed ? { ...snapshot, chats } : snapshot;
}

export function primeGroupsSnapshotCache(snapshot: GroupsSnapshot): void {
  cachedSnapshot = snapshot;
  cachedAt = Date.now();
}

/**
 * Drop the browser-side Groups snapshot after another page changes data that
 * contributes to the matrix (for example a bot's regular-group default).
 * Advancing the request sequence also prevents an older in-flight response
 * from repopulating the cache after this invalidation.
 */
export function invalidateGroupsSnapshotCache(): void {
  cachedAt = 0;
  latestRequestSeq = ++requestSeq;
  inFlight = null;
}

export async function fetchGroupsSnapshot(options: FetchGroupsSnapshotOptions = {}): Promise<GroupsSnapshot> {
  const cacheMs = options.cacheMs ?? 3000;
  const now = Date.now();
  if (!options.force && cachedAt > 0 && now - cachedAt <= cacheMs) return cachedSnapshot;
  if (!options.force && inFlight) return inFlight;

  const seq = ++requestSeq;
  latestRequestSeq = seq;
  const request = (async () => {
    const r = await fetch(options.force ? '/api/groups?refresh=1' : '/api/groups');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snapshot = normalizeGroupsSnapshot(body);
    if (seq === latestRequestSeq) primeGroupsSnapshotCache(snapshot);
    return snapshot;
  })();

  if (!options.force) {
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }

  return request;
}
