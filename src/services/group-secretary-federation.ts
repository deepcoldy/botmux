/**
 * 群秘书跨机器：经 federation 读取其它部署上 bot 在某群的会话状态与对话片段。
 *
 * 服务端（每台部署的 dashboard，`/api/federation/secretary/*`，在 token 网关之前）：
 *   - 鉴权：hub→spoke 用 spoke 发给 hub 的 delegationToken；spoke→hub 用 hub 发给 spoke 的 syncToken。
 *     两种都是 federation 组队时建立的团队内凭证，只读、只返回指定群的会话投影；
 *     指定的群必须是该凭证所属团队的团队群（与团队看板同一口径），其它群一律拒绝。
 * 客户端（秘书所在 daemon）：按本机 federation 记录列出所有对端（hub 记录的成员 + 自己加入的 hub），
 *   每拍拉一次；单个对端失败只当暂时看不到，不回退旧数据，不影响其它对端与本机。
 */
import { listAllFederatedDeployments, getDeploymentByToken } from './federation-store.js';
import { listMemberships, findMembershipByDelegationToken } from './federation-membership-store.js';
import { listTeamGroups } from './team-groups-store.js';
import type { SecretarySessionView } from './group-secretary-engine.js';
import type { SecretaryTranscriptLine } from './group-secretary-transcript.js';

export interface SecretaryPeer {
  name: string;
  baseUrl: string;
  token: string;
}

/** 本机视角的所有 federation 对端。同一个 URL 只保留一个。 */
export function listSecretaryPeers(dataDir: string): SecretaryPeer[] {
  const peers = new Map<string, SecretaryPeer>();
  for (const { deployment } of listAllFederatedDeployments(dataDir)) {
    if (!deployment.callbackUrl || !deployment.delegationToken) continue;
    peers.set(deployment.callbackUrl, { name: deployment.name, baseUrl: deployment.callbackUrl, token: deployment.delegationToken });
  }
  for (const m of listMemberships(dataDir)) {
    if (!peers.has(m.hubUrl)) peers.set(m.hubUrl, { name: m.teamName ?? m.hubUrl, baseUrl: m.hubUrl, token: m.syncToken });
  }
  return [...peers.values()];
}

/** 服务端鉴权：两种 federation 凭证任一有效即可，返回凭证所属的团队。 */
export function federationPeerTeamId(dataDir: string, token: string): string | undefined {
  if (!token) return undefined;
  return findMembershipByDelegationToken(dataDir, token)?.teamId ?? getDeploymentByToken(dataDir, token)?.teamId;
}

/** 与团队看板同一口径：只服务对端所属团队的团队群（spoke 侧是同步时从 hub 镜像来的那份）。 */
export function isTeamGroupOf(dataDir: string, teamId: string, chatId: string): boolean {
  return listTeamGroups(dataDir, teamId).some(b => b.chatId === chatId);
}

type Fetcher = typeof fetch;

async function getJson(fetcher: Fetcher, url: string, token: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function asView(raw: any): SecretarySessionView | undefined {
  if (!raw || typeof raw.sessionId !== 'string' || typeof raw.chatId !== 'string') return undefined;
  const liveness = ['alive', 'not_running', 'closed', 'unknown'].includes(raw.liveness) ? raw.liveness : 'unknown';
  return {
    sessionId: raw.sessionId.slice(0, 80),
    chatId: raw.chatId,
    ...(typeof raw.larkAppId === 'string' ? { larkAppId: raw.larkAppId } : {}),
    ...(typeof raw.botName === 'string' ? { botName: raw.botName.slice(0, 64) } : {}),
    ...(raw.scope === 'thread' || raw.scope === 'chat' ? { scope: raw.scope } : {}),
    ...(typeof raw.rootMessageId === 'string' ? { rootMessageId: raw.rootMessageId } : {}),
    liveness,
    turn: typeof raw.turn === 'string' ? raw.turn.slice(0, 24) : 'unknown',
    ...(raw.attention && typeof raw.attention.kind === 'string' && typeof raw.attention.reason === 'string' && Number.isFinite(raw.attention.at)
      ? { attention: { kind: raw.attention.kind.slice(0, 32), reason: raw.attention.reason.slice(0, 500), at: raw.attention.at } } : {}),
    ...(Number.isFinite(raw.lastActivityAt) ? { lastActivityAt: raw.lastActivityAt } : {}),
  };
}

export interface RemoteSessionsResult {
  views: Array<SecretarySessionView & { peer: string }>;
  /** larkAppId → 哪个对端，用于按 bot 回查对话片段。 */
  appPeer: Map<string, SecretaryPeer>;
}

export async function fetchRemoteSecretarySessions(
  peers: SecretaryPeer[],
  chatIds: string[],
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<RemoteSessionsResult> {
  const fetcher = opts.fetcher ?? fetch;
  const views: RemoteSessionsResult['views'] = [];
  const appPeer = new Map<string, SecretaryPeer>();
  await Promise.all(peers.flatMap(peer => chatIds.map(async chatId => {
    const j = await getJson(fetcher, `${peer.baseUrl}/api/federation/secretary/sessions?chatId=${encodeURIComponent(chatId)}`, peer.token, opts.timeoutMs ?? 4_000);
    if (!j?.ok || !Array.isArray(j.sessions)) return;
    for (const raw of j.sessions.slice(0, 200)) {
      const v = asView(raw);
      if (!v || v.chatId !== chatId) continue;
      views.push({ ...v, peer: peer.name });
      if (v.larkAppId) appPeer.set(v.larkAppId, peer);
    }
  })));
  return { views, appPeer };
}

export async function fetchRemoteSecretaryTranscript(
  peer: SecretaryPeer,
  larkAppId: string,
  sessionId: string,
  chatId: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<SecretaryTranscriptLine[] | undefined> {
  const j = await getJson(opts.fetcher ?? fetch,
    `${peer.baseUrl}/api/federation/secretary/transcript?appId=${encodeURIComponent(larkAppId)}&sessionId=${encodeURIComponent(sessionId)}&chatId=${encodeURIComponent(chatId)}`,
    peer.token, opts.timeoutMs ?? 6_000);
  if (!j?.ok || !Array.isArray(j.lines)) return undefined;
  return j.lines
    .filter((l: any) => typeof l?.role === 'string' && typeof l?.text === 'string')
    .slice(-8)
    .map((l: any) => ({ role: l.role.slice(0, 16), text: l.text.slice(0, 600) }));
}
