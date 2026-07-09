import { attentionReason, botNameForAppId } from './ui.js';
import { fetchGroupsSnapshot } from './groups-api.js';

let groupsSnapshot: { chats: any[]; bots: any[] } = { chats: [], bots: [] };

export function __setGroupsSnapshotForTest(snapshot: { chats: any[]; bots: any[] }): void {
  groupsSnapshot = snapshot;
}

export async function loadGroupsSnapshot(): Promise<void> {
  try {
    groupsSnapshot = await fetchGroupsSnapshot();
  } catch {
    // Overview stays useful even when Lark group APIs are unavailable.
  }
}

export type BotCard = {
  botName: string;
  larkAppId?: string;
  botAvatarUrl?: string;
  cliId: string;
  online: boolean;
  sessions: any[];
  active: any[];
  busy: any[];
  attention: any[];
  lastActiveAt: number;
};

const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);

/** 把会话按 bot 聚合成"数字员工"卡片数据；在线 bot 没会话也要出现（待命）。
 *  以 larkAppId 为身份键（部分会话缺 botName，按名字聚会裂成两张卡）；
 *  显示名优先 daemon 注册表，其次会话上的 botName。只剩历史 closed 会话、
 *  又不在注册表里的 bot 不出卡（避免一排灰色离线噪音）。 */
export function buildBotCards(sessions: any[]): BotCard[] {
  const byKey = new Map<string, BotCard>();
  const ensure = (key: string): BotCard => {
    let card = byKey.get(key);
    if (!card) {
      card = {
        botName: key, larkAppId: key, cliId: 'unknown', online: false,
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
  }
  // 两遍：先 active 建卡，再让 closed 会话只补充已有卡（不为其单独出卡）
  const ordered = [...sessions].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'));
  for (const s of ordered) {
    const key = s.larkAppId ?? s.botName ?? '-';
    if (s.status === 'closed' && !byKey.has(key)) continue;
    const card = ensure(key);
    if (s.botName && (card.botName === card.larkAppId || !card.botName)) card.botName = s.botName;
    card.sessions.push(s);
    if (s.cliId && card.cliId === 'unknown') card.cliId = s.cliId;
    card.lastActiveAt = Math.max(card.lastActiveAt, Number(s.lastMessageAt ?? 0));
    if (s.status !== 'closed') {
      card.active.push(s);
      if (BUSY_STATUSES.has(s.status)) card.busy.push(s);
      if (attentionReason(s)) card.attention.push(s);
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
