/**
 * 决策看板核实群时用哪些 bot、按什么顺序：管家 bot 自己在最前，其后是 bots.json 里本机其他
 * 同品牌（飞书 / Lark 的群互相查不到）、有飞书凭据、**和管家同一个 owner** 的 bot，按 bots.json 顺序；
 * 管家关了 trustSameOwnerBots 时只用管家自己。
 * 多人共用一台机器时，不拿别人的 bot 替你的管家查群（只有对方 bot 在的外部群，群名不会因此进你的看板）。
 *
 * 其他 bot 的客户端按需建在本进程内存里（{@link createDetachedLarkClient}），按 appId 缓存，
 * 凭据变了（指纹不同）就重建；缓存里只存 secret 的 sha256 指纹做比较，不另存 secret。
 */
import { createHash } from 'node:crypto';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../bot-registry.js';
import type { ChatProbe } from '../core/decision-board/chat-lookup.js';
import type { BotAdminUnions } from './bot-admin-unions-store.js';
import { larkGet } from '../im/lark/lark-get.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';

type ProbeConfig = Pick<BotConfig, 'larkAppId' | 'larkAppSecret' | 'brand' | 'apiOnly' | 'allowedUsers'>;

/**
 * 同 owner：沿用同 owner 同机 Bot 互信的判定（isTrustedSameOwnerSiblingBot），连同它的上位闸——管家
 * 配了 `trustSameOwnerBots: false`（owner 明确不认同机兄弟 bot）就一个都不借。否则要求对方 daemon
 * 发布的管理员 union_id 是精确快照、非空，且都在管家自己的管理员里。任何一边的快照缺失、过期
 *（allowedUsers 改过还没重新发布）或不精确都不算，宁可少借一个 bot。
 */
export function sameOwnerAs(
  self: { larkAppId: string; allowedUsers?: readonly string[]; trustSameOwnerBots?: boolean },
  read: (larkAppId: string, allowedUsers: readonly string[] | undefined) => BotAdminUnions | undefined,
): (cfg: Pick<BotConfig, 'larkAppId' | 'allowedUsers'>) => boolean {
  return cfg => {
    if (self.trustSameOwnerBots === false) return false;
    const mine = read(self.larkAppId, self.allowedUsers);
    if (!mine) return false;
    const theirs = read(cfg.larkAppId, cfg.allowedUsers);
    if (!theirs?.exact || theirs.admins.size === 0) return false;
    for (const admin of theirs.admins) if (!mine.admins.has(admin)) return false;
    return true;
  };
}

/** 管家之后要试的其他 bot：同品牌、非 apiOnly、有 secret、同 owner、不是管家自己，按 appId 去重、保持 bots.json 顺序。 */
export function siblingChatProbeConfigs<T extends ProbeConfig>(
  self: { larkAppId: string; brand?: BotConfig['brand'] },
  configs: readonly T[],
  sameOwner: (cfg: T) => boolean,
): T[] {
  const brand = normalizeBrand(self.brand);
  const seen = new Set([self.larkAppId]);
  const out: T[] = [];
  for (const cfg of configs) {
    if (!cfg.larkAppId || seen.has(cfg.larkAppId)) continue;
    if (cfg.apiOnly === true || !cfg.larkAppSecret) continue;
    if (normalizeBrand(cfg.brand) !== brand) continue;
    if (!sameOwner(cfg)) continue;
    seen.add(cfg.larkAppId);
    out.push(cfg);
  }
  return out;
}

function chatProbe(appId: string, client: () => Lark.Client): ChatProbe {
  return {
    appId,
    fetchChat: (chatId, signal) => larkGet(client(), `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {}, { signal }),
  };
}

export interface BoardChatProbeDeps {
  self: { larkAppId: string; brand?: BotConfig['brand'] };
  /** 管家 bot 自己的客户端（daemon 注册的那个）。 */
  ownClient(): Lark.Client;
  /** bots.json 里的全部 bot；读不到时抛，只用管家自己查。 */
  configs(): readonly ProbeConfig[];
  /** 这个 bot 和管家是不是同一个 owner（{@link sameOwnerAs}）。 */
  sameOwner(cfg: ProbeConfig): boolean;
  createClient(cfg: ProbeConfig): Lark.Client;
}

export function createBoardChatProbes(deps: BoardChatProbeDeps): () => ChatProbe[] {
  const cache = new Map<string, { fingerprint: string; client: Lark.Client }>();
  const clientFor = (cfg: ProbeConfig): Lark.Client => {
    const fingerprint = createHash('sha256').update(`${normalizeBrand(cfg.brand)}\0${cfg.larkAppSecret}`).digest('hex');
    const cached = cache.get(cfg.larkAppId);
    if (cached?.fingerprint === fingerprint) return cached.client;
    const client = deps.createClient(cfg);
    cache.set(cfg.larkAppId, { fingerprint, client });
    return client;
  };
  return () => {
    let siblings: ProbeConfig[] = [];
    try {
      siblings = siblingChatProbeConfigs(deps.self, deps.configs(), deps.sameOwner);
    } catch {
      // bots.json 读不到：只用管家自己查，查不到照常报错。
    }
    const live = new Set(siblings.map(cfg => cfg.larkAppId));
    for (const appId of cache.keys()) if (!live.has(appId)) cache.delete(appId);
    return [
      chatProbe(deps.self.larkAppId, deps.ownClient),
      ...siblings.map(cfg => chatProbe(cfg.larkAppId, () => clientFor(cfg))),
    ];
  };
}
