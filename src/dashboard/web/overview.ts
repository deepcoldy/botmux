import { publishProviderRoster } from './provider-roster.js';
import { isWecomSource, providerBotKey } from './providers/registry.js';
import type { WecomConnectionDto } from '../../im/wecom/contract/dashboard-dto.js';
import { botNameForAppId } from './ui.js';
import { deriveSessionTaskStatus } from '../../core/session-task-status.js';
import { fetchGroupsNamesSnapshot } from './groups-api.js';

let wecomSnapshot: WecomConnectionDto[] = [];
let groupsSnapshot: { chats: any[]; bots: any[] } = { chats: [], bots: [] };
let groupsSnapshotLoaded = false;

export function __setGroupsSnapshotForTest(snapshot: { chats: any[]; bots: any[] }): void {
  groupsSnapshot = snapshot;
  groupsSnapshotLoaded = true;
}

export function hasLoadedGroupsSnapshot(): boolean {
  return groupsSnapshotLoaded;
}

export async function loadGroupsSnapshot(options: { force?: boolean } = {}): Promise<void> {
  try {
    // 轻量视图：buildBotCards() 只遍历 snapshot.bots，且只读 larkAppId /
    // botName / botAvatarUrl / cliId / brand 这 5 个字段；`snapshot.chats` 在
    // 本文件里零读取（attentionReason() 只看传入的 session row，与 groups
    // 快照无关）。所以完整矩阵里那 12.34MB 的 chats[].memberBots 是纯浪费。
    //
    // ⚠️ 更要紧的是**去重**：app.tsx 启动时并行跑 loadNameMaps() 与本函数。
    // 两者必须落在 groups-api 的**同一个 in-flight** 上，否则会变成
    // 「names 387KB + full 12.73MB」两发（MEASURED 13.11MB，比改动前的
    // 12.73MB 更差）。loadNameMaps 走 names，本函数也必须走 names。
    groupsSnapshot = await fetchGroupsNamesSnapshot(options.force ? { force: true } : {});
    groupsSnapshotLoaded = true;
    publishProviderRoster('lark', groupsSnapshot.bots.length);
  } catch {
    // Overview stays useful even when Lark group APIs are unavailable.
  }
}

/**
 * 企业微信连接名单（总览卡片与 provider 名册的来源）。和 {@link loadGroupsSnapshot}
 * 分开：飞书名称快照只在启动和进总览时拉一次，企业微信名单则只在确实有企业微信连接时
 * 才需要定期刷新，两者不能绑在一起重拉。返回名单是否有变化，调用方据此决定要不要重渲染。
 */
export async function loadWecomConnectionsSnapshot(): Promise<boolean> {
  try {
    const response = await fetch('/api/wecom/connections');
    const body = response.ok ? await response.json() : null;
    if (!Array.isArray(body?.connections)) return false;
    const changed = JSON.stringify(body.connections) !== JSON.stringify(wecomSnapshot);
    wecomSnapshot = body.connections;
    publishProviderRoster('wecom', wecomSnapshot.length);
    return changed;
  } catch {
    // Keep the last confirmed provider roster during transient failures.
    return false;
  }
}

export type BotCard = {
  botName: string;
  provider?: 'wecom';
  providerBotId?: string;
  providerConnection?: WecomConnectionDto['connection'];
  larkAppId?: string;
  /** 租户品牌，决定飞书后台深链的 host（feishu.cn vs larksuite.com）。
   *  缺省（旧 payload / 未注册）→ larkConsoleUrl 内 normalizeBrand 兜底 feishu。 */
  brand?: string;
  botAvatarUrl?: string;
  cliId: string;
  online: boolean;
  sessions: any[];
  active: any[];
  busy: any[];
  attention: any[];
  lastActiveAt: number;
};

/** 把会话按 bot 聚合成"数字员工"卡片数据；在线 bot 没会话也要出现（待命）。
 *  以 larkAppId 为身份键（部分会话缺 botName，按名字聚会裂成两张卡）；
 *  显示名优先 daemon 注册表，其次会话上的 botName。只剩历史 closed 会话、
 *  又不在注册表里的 bot 不出卡（避免一排灰色离线噪音）。 */
export function buildBotCards(sessions: any[]): BotCard[] {
  const byKey = new Map<string, BotCard>();
  // 企业微信卡片带上连接 id（不编造飞书 appId）；其余卡片的身份键就是 appId（或兜底的名字）。
  const ensure = (key: string, wecomBotId?: string): BotCard => {
    let card = byKey.get(key);
    if (!card) {
      const identity = wecomBotId !== undefined
        ? { provider: 'wecom' as const, providerBotId: wecomBotId }
        : { larkAppId: key };
      card = {
        botName: key, ...identity, cliId: 'unknown', online: false,
        sessions: [], active: [], busy: [], attention: [], lastActiveAt: 0,
      };
      byKey.set(key, card);
    }
    return card;
  };
  for (const b of groupsSnapshot.bots ?? []) {
    const card = ensure(b.larkAppId ?? b.botName ?? '-');
    card.online = true;
    if (b.botName) card.botName = b.botName;
    if (b.botAvatarUrl) card.botAvatarUrl = b.botAvatarUrl;
    if (b.cliId) card.cliId = b.cliId;
    if (b.brand) card.brand = b.brand;
  }
  for (const connection of wecomSnapshot) {
    const card = ensure(providerBotKey({ provider: 'wecom', providerBotId: connection.id }), connection.id);
    card.botName = connection.label;
    // 状态文件写入失败的网关仍连着企业微信，但已不再处理消息：不算在线。
    card.online = connection.connection === 'connected' && !connection.stateWriteFailure;
    card.providerConnection = connection.connection;
  }
  // 两遍：先 active 建卡，再让 closed 会话只补充已有卡（不为其单独出卡）
  const ordered = [...sessions].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'));
  for (const s of ordered) {
    const wecom = isWecomSource(s);
    const key = wecom ? providerBotKey(s) : s.larkAppId ?? s.botName ?? '-';
    if (s.status === 'closed' && !byKey.has(key)) continue;
    const card = ensure(key, wecom ? String(s.providerBotId ?? '') : undefined);
    if (s.botName && (card.botName === key || card.botName === card.larkAppId || !card.botName)) card.botName = s.botName;
    card.sessions.push(s);
    if (s.cliId && card.cliId === 'unknown') card.cliId = s.cliId;
    card.lastActiveAt = Math.max(card.lastActiveAt, Number(s.lastMessageAt ?? 0));
    if (s.status !== 'closed') {
      card.active.push(s);
      const task = deriveSessionTaskStatus(s).kind;
      if (task === 'working') card.busy.push(s);
      if (task === 'needs_you') card.attention.push(s);
    }
  }
  for (const card of byKey.values()) {
    // 首屏 /api/groups 还没回来时 botName 只能是 larkAppId（cli_xxx）——
    // 用 localStorage 回灌的名字缓存先把人话名字顶上，避免每次刷新闪 id。
    if (card.botName === card.larkAppId) {
      const cached = botNameForAppId(card.larkAppId);
      if (cached) card.botName = cached;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // 等你的排最前，其次干活中，再按最近活跃
    const rank = (c: BotCard) => (c.attention.length ? 0 : c.busy.length ? 1 : c.online || c.active.length ? 2 : 3);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.lastActiveAt - a.lastActiveAt;
  });
}
