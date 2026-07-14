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
}

export interface GroupChat {
  chatId: string;
  name?: string;
  ownerId?: string | null;
  avatar?: string;
  memberBots: GroupMemberBot[];
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

export function primeGroupsSnapshotCache(snapshot: GroupsSnapshot): void {
  cachedSnapshot = snapshot;
  cachedAt = Date.now();
}

export async function fetchGroupsSnapshot(options: FetchGroupsSnapshotOptions = {}): Promise<GroupsSnapshot> {
  const cacheMs = options.cacheMs ?? 3000;
  const now = Date.now();
  if (!options.force && cachedAt > 0 && now - cachedAt <= cacheMs) return cachedSnapshot;
  if (!options.force && inFlight) return inFlight;

  const seq = ++requestSeq;
  latestRequestSeq = seq;
  const request = (async () => {
    const r = await fetch('/api/groups');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snapshot = normalizeGroupsSnapshot(body);
    if (seq === latestRequestSeq) primeGroupsSnapshotCache(snapshot);
    return snapshot;
  })();

  if (!options.force) {
    inFlight = request.finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return request;
}
