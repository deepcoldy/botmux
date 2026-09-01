export interface GroupBot {
  larkAppId: string;
  /** Bot open_id used to resolve readable worker and reviewer names. */
  botOpenId?: string;
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

// ─── 名称/头像专用轻量缓存（与上面的完整矩阵缓存**完全分离**）──────────────
//
// 为什么必须分开存：完整矩阵（12.59MB）里 chats[].memberBots 占 12341KB，而
// 名称/头像链路一个字节都不用它。但群组页 / 角色页 / 日程页 / 本页的反馈设置
// 区块（FeedbackSettingsSection）都**真的**要读 memberBots —— 如果把轻量结果
// 灌进共享的 `cachedSnapshot`，那些页面会拿到 `memberBots: []`，表现为「群里
// 一个 bot 都没有」的静默错数据（不是报错，更难发现）。
//
// 所以轻量视图有自己的 cachedNames/cachedNamesAt，两条缓存互不写入。
let cachedNames: GroupsSnapshot = emptyGroupsSnapshot;
let cachedNamesAt = 0;
let namesInFlight: Promise<GroupsSnapshot> | null = null;

/**
 * 拉取「只含 bot 名称/头像 + 会话名称/头像」的轻量快照（`?view=names`）。
 *
 * **实时性**：缓存语义与完整矩阵逐字一致（同样默认 3s，仅用于消掉同一次挂载内
 * 的重复请求；服务端也是同一份 30s 快照 + 同一条 roster 失效通知）。也就是说
 * 名称/头像的新鲜度**与改动前完全相同**，变化的只有同一次请求传多少字节。
 * 这里刻意不加长任何 TTL：名称/头像正是最忌讳陈旧的数据。
 *
 * 需要 memberBots 的调用方必须继续用 {@link fetchGroupsSnapshot}。
 */
export async function fetchGroupsNamesSnapshot(
  options: FetchGroupsSnapshotOptions = {},
): Promise<GroupsSnapshot> {
  const cacheMs = options.cacheMs ?? 3000;
  const now = Date.now();
  // 完整矩阵是轻量视图的超集：若它刚拿过新鲜数据，直接复用，省掉一次请求。
  // （反向不成立——轻量结果永远不能喂给完整矩阵的消费方。）
  if (!options.force && cachedAt > 0 && now - cachedAt <= cacheMs) return cachedSnapshot;
  if (!options.force && cachedNamesAt > 0 && now - cachedNamesAt <= cacheMs) return cachedNames;
  if (!options.force && namesInFlight) return namesInFlight;

  const request = (async () => {
    const r = await fetch('/api/groups?view=names');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snapshot = normalizeGroupsSnapshot(body);
    cachedNames = snapshot;
    cachedNamesAt = Date.now();
    return snapshot;
  })();

  if (!options.force) {
    namesInFlight = request.finally(() => {
      namesInFlight = null;
    });
    return namesInFlight;
  }
  return request;
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
    inFlight = request.finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return request;
}
