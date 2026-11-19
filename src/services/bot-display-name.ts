/**
 * Bot 显示名的统一解析（按 larkAppId 现查，只用于展示）。
 *
 * 权威来源是飞书开放平台 `/bot/v3/info`，由每个 bot 自己的 daemon 定期拉取
 * （services/bot-profile-refresh.ts）并派生到两份跨进程缓存：
 *  - dashboard descriptor 的 `botName`（在线 bot；已含 bots.json displayName 覆盖）
 *  - `bots-info.json` 的 `botName`（在线 + 离线 bot 的最近一次飞书名）
 *
 * 展示处一律按 appId 走这里，不再读存档里写死的名字（会话行、看板、草稿等
 * 只存 appId 语义，存档本身不改）。优先级：
 *   bots.json displayName（用户显式别名）> 在线 descriptor 名 > bots-info 飞书名 > fallback
 * 绝不回退到 bots.json 的 `name`（PM2 进程名后缀）或 cliId——它们不是 Bot 名。
 *
 * 注意：这里**不**参与任何匹配/路由/鉴权。按名字匹配的代码路径保持原样。
 */
import { normalizeBotsInfoRouteEntries } from './bots-info-shape.js';
import { readBotsInfoJson } from './bots-info-cache.js';

export interface BotDisplayNameInputs {
  larkAppId: string;
  /** bots.json displayName（用户显式别名）。 */
  displayName?: string | null;
  /** 在线 daemon descriptor 的 botName。 */
  liveName?: string | null;
  /** bots-info.json 里最近一次飞书名。 */
  persistedName?: string | null;
}

function usable(name: string | null | undefined, larkAppId: string): string | undefined {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed && trimmed !== larkAppId ? trimmed : undefined;
}

/** 纯函数：按固定优先级挑展示名；都没有时返回 undefined（由调用方决定兜底）。 */
export function pickBotDisplayName(input: BotDisplayNameInputs): string | undefined {
  return usable(input.displayName, input.larkAppId)
    ?? usable(input.liveName, input.larkAppId)
    ?? usable(input.persistedName, input.larkAppId);
}

/** bots-info.json 的 appId → 飞书名；文件缺失/损坏时为空表，不抛出。 */
export function readPersistedBotNameMap(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const entry of normalizeBotsInfoRouteEntries(readBotsInfoJson(dataDir))) {
      const name = usable(entry.botName, entry.larkAppId);
      if (name) out.set(entry.larkAppId, name);
    }
  } catch { /* unreadable → empty */ }
  return out;
}

/** 本 bot 最近一次已知的飞书名（启动时先用它占位，直到本进程第一次拉取成功）。 */
export function lastKnownBotName(larkAppId: string, dataDir?: string): string | undefined {
  if (!dataDir) return undefined;
  return readPersistedBotNameMap(dataDir).get(larkAppId);
}

export interface BotDisplayNameLookupDeps {
  /** bots.json 当前配置（取 displayName）。 */
  configs: ReadonlyArray<{ larkAppId: string; displayName?: string | null }>;
  /** 在线 descriptor 的名字。 */
  liveName: (larkAppId: string) => string | null | undefined;
  dataDir: string;
}

/**
 * 为一次请求/一次渲染构造 appId → 展示名查询。bots-info 在第一次查询时读一次
 * （readBotsInfoJson 自带按文件指纹的进程内缓存），之后同一个 lookup 内复用。
 */
export function createBotDisplayNameLookup(deps: BotDisplayNameLookupDeps): (larkAppId: string) => string | undefined {
  const displayNames = new Map<string, string>();
  for (const cfg of deps.configs) {
    if (cfg.displayName) displayNames.set(cfg.larkAppId, cfg.displayName);
  }
  let persisted: Map<string, string> | undefined;
  return (larkAppId) => pickBotDisplayName({
    larkAppId,
    displayName: displayNames.get(larkAppId),
    liveName: deps.liveName(larkAppId),
    persistedName: (persisted ??= readPersistedBotNameMap(deps.dataDir)).get(larkAppId),
  });
}
