/**
 * 平台 Issue Board 的 machine-auth 客户端（打 `/v1/machine/*`，Bearer = machineToken）。
 *
 * 平台侧入口见 platform 仓 `src/server/machine-issues-http.ts` / DESIGN-issue-board.md §三之二。
 * 只有五个端点：teams / issues(list) / claim / bind / status。创建、编辑、force-detach、
 * 归档是**人的决策**，只在平台 Web 上做，这里没有也不该有。
 *
 * 鉴权材料全部来自 `~/.botmux/platform.json`（[[platform/binding]]）：未绑定平台时所有调用
 * 直接返回 `{ ok:false, reason:'unbound' }`，调用方据此把整个 issue board 功能关掉。
 *
 * 错误分型是这层的重点——上层 outbox pump 要据此决定「退避重试」还是「就此打住」：
 *  - `network`  ：连不上/超时 → **必须重试**（daemon 离线期间状态照样变，回来要补上）
 *  - `conflict` ：平台返回 409（state_rev_conflict / stale_epoch / claim_expired…）
 *                 → 重新投影后再发，不是简单重试
 *  - `forbidden`：401/403（token 失效、解绑、machine_mismatch）→ **停手**，重试无意义
 *  - `server`   ：5xx → 退避重试（含平台 ByteDoc 降级的 503）
 */
import { getJson, postJson } from './platform-http.js';
import { readPlatformBinding } from './binding.js';
import type { AttentionReason, IssueStatus } from '../services/issue-board-store.js';

export interface PlatformIssueClaim {
  claimId: string;
  claimEpoch: number;
  unionId: string;
  name: string;
  machineId: string;
  localTaskRef?: string;
  /** 本地任务的可读名（本仓传 issue 群的群名）。平台详情页优先显示它而不是 localTaskRef。 */
  localTaskLabel?: string;
  /** 本地任务深链（本仓传飞书群 applink）。平台只接受 https，非法值会被静默丢弃。 */
  localTaskUrl?: string;
  agent?: string;
  repoLabel?: string;
  claimedAt: number;
  leaseExpiresAt: number;
  bound: boolean;
  lastSourceSeq: number;
}

export interface PlatformIssue {
  _id: string;
  teamId: string;
  title: string;
  body: string;
  status: IssueStatus;
  labels?: string[];
  targetRepoId?: string;
  targetRepoLabel?: string;
  suggestedAssigneeUnionId?: string;
  claim?: PlatformIssueClaim;
  attentionSince?: number;
  attentionReason?: AttentionReason;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  rev: number;
  stateRev: number;
  claimEpochCounter: number;
}

export interface PlatformIssueSections {
  needsAttention: PlatformIssue[];
  todo: PlatformIssue[];
  inProgress: PlatformIssue[];
  inReview: PlatformIssue[];
  done: PlatformIssue[];
}

export type IssueClientFailure =
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'network'; error: string }
  | { ok: false; reason: 'conflict'; status: number; error: string }
  | { ok: false; reason: 'forbidden'; status: number; error: string }
  /** 其余 4xx（400 invalid / 404 not_found …）：请求本身有问题，重发多少次都一样。 */
  | { ok: false; reason: 'client'; status: number; error: string }
  | { ok: false; reason: 'server'; status: number; error: string };

export type IssueClientResult<T> = { ok: true; value: T } | IssueClientFailure;

/**
 * 该失败是否值得退避后重投。
 *
 * 只有 `network` 与**真正的 5xx** 值得：4xx 全都是「再发一次结果不变」——401/403 是凭证/
 * 归属问题，409 要先重新投影再发（不是盲重试），400/404 是请求本身错了。把它们混进可重试
 * 一类，pump 会对着一个永远不会成功的请求指数退避到天荒地老，日志里还只看得到"在重试"。
 */
export function isRetriable(f: IssueClientFailure): boolean {
  return f.reason === 'network' || (f.reason === 'server' && f.status >= 500);
}

/**
 * 这次失败是否**永远**不会成功——发件箱据此把行标 fatal，彻底停止重投。
 *
 * 注意它**不是** `!isRetriable`，那两个的补集差着两类，混用会把好行判死：
 *  - `conflict`（409）：是竞争不是错误。上层先重新对账再重发，对账本身可能因为网络问题
 *    没做成，此时判死等于把一条完全正常的回写扔了。留给下一轮。
 *  - `unbound`：本机当前没绑平台。绑回来之后这条行照样该发，判死就再也发不出去了。
 *
 * 剩下的两类才是真死：`forbidden`（401/403，凭证失效 / machine_mismatch / claim 被 revoke）
 * 与 `client`（400 参数错 / 404 issue 被删或归档）。对它们退避重投，就是每 5 分钟朝一个
 * 永远不会变的死端点打一发，同时 `/issue status` 上那句「N 条回写没发出去」永不清零。
 */
export function isPermanentFailure(f: IssueClientFailure): boolean {
  return f.reason === 'forbidden' || f.reason === 'client';
}

export interface IssueClientOptions {
  /** 覆盖平台地址与凭证（测试用；缺省读 ~/.botmux/platform.json）。 */
  binding?: { platformUrl: string; machineToken: string; machineId: string } | null;
  timeoutMs?: number;
  /** 注入 HTTP 实现（测试用）。 */
  http?: {
    get: typeof getJson;
    post: typeof postJson;
  };
}

function resolveBinding(opts: IssueClientOptions) {
  if (opts.binding !== undefined) return opts.binding;
  const b = readPlatformBinding();
  return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
}

function classify(status: number, json: unknown): IssueClientFailure {
  const error = typeof (json as { error?: unknown })?.error === 'string' ? String((json as { error: string }).error) : `http_${status}`;
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden', status, error };
  if (status === 409) return { ok: false, reason: 'conflict', status, error };
  // 其余 4xx 单列一类：既不是鉴权问题（别误导排查方向），也绝不该被重试。
  if (status >= 400 && status < 500) return { ok: false, reason: 'client', status, error };
  return { ok: false, reason: 'server', status, error };
}

async function call<T>(
  opts: IssueClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  pick: (json: any) => T = (j) => j as T,
): Promise<IssueClientResult<T>> {
  const binding = resolveBinding(opts);
  if (!binding) return { ok: false, reason: 'unbound' };
  const http = opts.http ?? { get: getJson, post: postJson };
  const url = `${binding.platformUrl.replace(/\/+$/, '')}${path}`;
  const reqOpts = {
    headers: { authorization: `Bearer ${binding.machineToken}` },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  let res: { status: number; json: unknown };
  try {
    res = method === 'GET' ? await http.get(url, reqOpts) : await http.post(url, body ?? {}, reqOpts);
  } catch (e) {
    return { ok: false, reason: 'network', error: String((e as Error)?.message ?? e) };
  }
  // 2xx 之外一律走分型；平台的成功响应恒为 200。
  if (res.status < 200 || res.status >= 300) return classify(res.status, res.json);
  return { ok: true, value: pick(res.json) };
}

/** 本机 owner 所属的平台团队。注意：日常判断「本机在不在团队里」应读本地
 *  `platform-team-sync.json`（[[platform-team-store]]），这个接口是不依赖 team-sync
 *  是否已收敛的权威兜底。 */
export function fetchTeams(
  opts: IssueClientOptions = {},
): Promise<IssueClientResult<Array<{ teamId: string; teamName: string }>>> {
  return call(opts, 'GET', '/v1/machine/teams', undefined, (j) => (Array.isArray(j?.teams) ? j.teams : []));
}

export function fetchIssues(
  teamId: string,
  opts: IssueClientOptions = {},
): Promise<IssueClientResult<PlatformIssueSections>> {
  return call(
    opts,
    'GET',
    `/v1/machine/issues?teamId=${encodeURIComponent(teamId)}`,
    undefined,
    (j) => (j?.sections ?? { needsAttention: [], todo: [], inProgress: [], inReview: [], done: [] }) as PlatformIssueSections,
  );
}

/**
 * 按 id 单查一条 issue。
 *
 * 平台**没有**「按 id 单查」的机器接口，只能从分段列表里捞——这是唯一的实现方式，所以收口
 * 在这里，别让每个调用方各抄一遍（回写的 409 对账、领取确认、交付都要用它）。
 *
 * 返回 null 有两种含义且**无法区分**：拉列表失败，或 issue 不在活跃分段里（已归档）。
 * 调用方一律按「无法判定」处理，不要把 null 当成「平台上没有/不是我的」——那会让
 * 409 对账做出相反的决定。
 */
export async function findIssueById(
  teamId: string,
  issueId: string,
  opts: IssueClientOptions = {},
): Promise<PlatformIssue | null> {
  const list = await fetchIssues(teamId, opts);
  if (!list.ok) return null;
  for (const section of Object.values(list.value)) {
    const hit = (section as PlatformIssue[]).find((i) => i._id === issueId);
    if (hit) return hit;
  }
  return null;
}

/**
 * 领取。`claimId` 必须是**高熵随机**（`crypto.randomBytes(16).toString('hex')`），
 * 绝不能由 issueId 派生——平台的幂等分支现在会连 machineId/unionId 一起校验，派生键在
 * 多机场景下会直接撞 409 `already_claimed`（早失败，好过静默把别人的 claim 当成自己的）。
 *
 * `machineId` 不用传：平台以 token 为准（传了且不一致会 403 machine_mismatch）。
 */
export function claimIssue(
  issueId: string,
  args: { claimId: string; agent?: string; repoLabel?: string; expectedStateRev: number },
  opts: IssueClientOptions = {},
): Promise<IssueClientResult<{ claim: PlatformIssueClaim; issue: PlatformIssue }>> {
  return call(opts, 'POST', `/v1/machine/issues/${encodeURIComponent(issueId)}/claim`, args);
}

/**
 * 绑定本地任务。`localTaskRef` = `<anchorId>::<larkAppId>`（见 [[issue-board-store]] 的
 * `buildLocalTaskRef`）。
 *
 * `localTaskLabel` / `localTaskUrl` 是**纯展示**的可选项：前者给人看（群名），后者是点进去
 * 的深链。平台只接受 https 深链，其余静默丢弃且**不会**让 bind 失败——展示字段不该有能力
 * 弄砸一次真实绑定。
 */
export function bindIssue(
  issueId: string,
  args: {
    claimId: string;
    localTaskRef: string;
    expectedStateRev: number;
    localTaskLabel?: string;
    localTaskUrl?: string;
  },
  opts: IssueClientOptions = {},
): Promise<IssueClientResult<{ issue: PlatformIssue }>> {
  return call(opts, 'POST', `/v1/machine/issues/${encodeURIComponent(issueId)}/bind`, args);
}

/**
 * 状态回写。幂等只认 `sourceSeq`（每 binding 单调、串行发送），所以同一条 outbox 行重发
 * 是安全的：平台见到 `sourceSeq <= lastSourceSeq` 直接回当前态、零副作用。
 */
export function writeIssueStatus(
  issueId: string,
  args: {
    claimId: string;
    claimEpoch: number;
    sourceSeq: number;
    status: IssueStatus;
    attentionReason?: AttentionReason;
    expectedStateRev: number;
  },
  opts: IssueClientOptions = {},
): Promise<IssueClientResult<{ issue: PlatformIssue }>> {
  return call(opts, 'POST', `/v1/machine/issues/${encodeURIComponent(issueId)}/status`, args);
}
