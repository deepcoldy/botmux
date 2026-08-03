/**
 * 「同团队」bot 的跨部署名字目录（/invite 名字解析用）。
 *
 * 问题背景：/invite 的目标 bot 大多**不在本机部署**（另一台机器的 botmux
 * fleet、或同租户同事的应用），本机 bots-info.json 查不到，早期实现只能
 * unresolved 让用户改 --app。但「同团队」在 botmux 里有两个既有信任域，
 * 各自维护了权威的 bot 名册（名字 + app_id）：
 *
 *  1. **平台团队**（[[platform-team-store]]）：中心平台经隧道推下来的全量
 *     团队名册（sg1/cn2… 全在里面），本地文件直读；
 *  2. **联邦**（旧版 hub/spoke，[[federation-store]]）：
 *     - 本机托管团队的 federations.json（hub 侧成员广告名册）；
 *     - 本机作为 spoke 加入的 hub —— `GET /api/federation/roster` 正是 hub
 *       提供给成员拉聚合名册的端点，用 membership 的 syncToken 现拉。
 *
 * 本模块把这三路合并成一个团队 bot 目录（整目录一次装载，调用方自行批量
 * 匹配名字——远端 hub 拉取有 HTTP 成本，不能只把单个名字当查询粒度）。
 * 按 appId 去重（同一 app 可能同时出现在平台名册和联邦名册），同名多个
 * 不同 app → 留给调用方报歧义。
 *
 * 纯解析用途：这里只给出名字→appId 的映射，不构成任何授权变更——被拉进
 * 群的团队 bot 本来就享有既有 team-trust 语义（talk 免 grant），/invite
 * 只是完成成员变更动作本身。
 *
 * ⚠️ **能力边界**：core-only / apiOnly（`larkTransportEnabled === false`）的 bot
 * 没有飞书传输身份，既不能作群成员也不能作群创建者（#668 的硬不变量）。这类
 * bot 必须从目录里剔除——否则 /invite 会尝试把一个进不了飞书群的 app 拉进去，
 * 留下收不到事件的「死 bot」。与既有拉群路径（dashboard.ts 用
 * `buildFederatedRoster(...).bots.filter(b => b.larkTransportEnabled === false)`
 * 过滤）同源。`undefined`=旧版 spoke 未上报能力 → 按可传输（legacy normal）保留。
 * 平台团队同步名册（PlatformTeamBot）没有该能力字段，其成员一律按可传输对待。
 */
import { listPlatformTeams } from './platform-team-store.js';
import { listAllFederatedDeployments } from './federation-store.js';
import { listMemberships } from './federation-membership-store.js';
import { logger } from '../utils/logger.js';

/** #668 能力边界：只有显式 `false`（core-only/apiOnly，无飞书传输）不可入群；
 *  `true` 或 `undefined`（旧版未上报）按可传输保留。 */
function isNoTransport(larkTransportEnabled: unknown): boolean {
  return larkTransportEnabled === false;
}

export interface TeamBotMatch {
  larkAppId: string;
  botName: string;
  /** 来源标识（歧义提示展示用）：platform:<teamId> | federation:<teamId>/<dep> | <hubUrl>[/<dep>] */
  source: string;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json: () => Promise<any>;
}>;

const HUB_ROSTER_TIMEOUT_MS = 2_500;

/** 本地两源的全部团队 bot（平台团队同步名册 + 本机托管的联邦团队名册），纯文件读。 */
export function readLocalTeamBotDirectory(dataDir: string): TeamBotMatch[] {
  const out: TeamBotMatch[] = [];

  for (const team of listPlatformTeams(dataDir)) {
    for (const b of team.bots) {
      if (b?.name && b.appId) {
        out.push({ larkAppId: b.appId, botName: b.name, source: `platform:${team.teamId}` });
      }
    }
  }

  for (const { teamId, deployment } of listAllFederatedDeployments(dataDir)) {
    for (const b of deployment.bots) {
      // #668：core-only/apiOnly（transport=false）不能作群成员 → 不进目录。
      if (b?.botName && b.larkAppId && !isNoTransport(b.larkTransportEnabled)) {
        out.push({ larkAppId: b.larkAppId, botName: b.botName, source: `federation:${teamId}/${deployment.name}` });
      }
    }
  }

  return dedupeByAppId(out);
}

/** 远端源：本机作为 spoke 加入的每个 hub，拉 /api/federation/roster。单 hub 失败不拖垮整体。 */
export async function fetchRemoteHubBotDirectory(
  dataDir: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<TeamBotMatch[]> {
  const fetcher: Fetcher = opts.fetcher ?? (fetch as unknown as Fetcher);
  const out: TeamBotMatch[] = [];

  for (const m of listMemberships(dataDir)) {
    try {
      const r = await fetcher(`${m.hubUrl}/api/federation/roster`, {
        headers: { authorization: `Bearer ${m.syncToken}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? HUB_ROSTER_TIMEOUT_MS),
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok || j?.ok !== true || !Array.isArray(j?.bots)) {
        logger.warn(`[team-bot-directory] hub roster from ${m.hubUrl} failed: status=${r.status} err=${j?.error ?? 'no bots'}`);
        continue;
      }
      for (const b of j.bots) {
        const bname = typeof b?.name === 'string' ? b.name : '';
        // #668：hub roster 也带 larkTransportEnabled（buildFederatedRoster 透传）——
        // 显式 false 的 core-only bot 不能作群成员，剔除。
        if (bname && typeof b?.larkAppId === 'string' && b.larkAppId && !isNoTransport(b?.larkTransportEnabled)) {
          const dep = typeof b?.deployment?.name === 'string' ? `${m.hubUrl}/${b.deployment.name}` : m.hubUrl;
          out.push({ larkAppId: b.larkAppId, botName: bname, source: dep });
        }
      }
    } catch (e: any) {
      logger.warn(`[team-bot-directory] hub roster from ${m.hubUrl} errored: ${e?.message ?? e}`);
    }
  }

  return dedupeByAppId(out);
}

/** 是否有任何团队名册源可读（没有时 /invite 直接走 unresolved，不花 HTTP）。 */
export function hasAnyTeamDirectorySource(dataDir: string): boolean {
  return listPlatformTeams(dataDir).length > 0
    || listAllFederatedDeployments(dataDir).length > 0
    || listMemberships(dataDir).length > 0;
}

/** 三源合并的完整目录：本地两源 + 每个 membership hub。按 appId 去重，保留先出现的来源标签。 */
export async function fetchTeamBotDirectory(
  dataDir: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<TeamBotMatch[]> {
  return dedupeByAppId([
    ...readLocalTeamBotDirectory(dataDir),
    ...await fetchRemoteHubBotDirectory(dataDir, opts),
  ]);
}

function dedupeByAppId(list: TeamBotMatch[]): TeamBotMatch[] {
  const seen = new Set<string>();
  const out: TeamBotMatch[] = [];
  for (const m of list) {
    if (seen.has(m.larkAppId)) continue;
    seen.add(m.larkAppId);
    out.push(m);
  }
  return out;
}
