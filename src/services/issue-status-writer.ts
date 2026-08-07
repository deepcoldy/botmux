/**
 * 状态回写：把「本会话应该处于什么状态」推到平台。
 *
 * 这是 [[issue-board-store]] 那个发件箱的**唯一**发送端。所有想改 issue 状态的调用方
 * （开工、交付、验收、释放）都走 `projectStatus`，谁都不许直接调 `writeIssueStatus`——
 * sourceSeq 的分配、串行、退避、409 对账全都只在这里实现一次。
 *
 * ## 为什么必须有它（不是架构洁癖）
 *
 * 平台在 bind 之后给一个 **5 分钟的 activation 租约**：到期时 issue 还停在 `claimed`，
 * sweeper 就把它翻成 `needs_attention/claim_activate_timeout`（platform `src/store/issues.ts`
 * 的 sweepExpiredLeases，每 60s 扫一次）。证明「我真的在跑」的唯一方式就是回写
 * `in_progress`。
 *
 * 在这一刀之前 botmux 一个状态都不写，于是那条本该罕见的保护路径变成了**必经之路**：
 * 每个领取的任务 5 分钟后必然掉进需要关注，而且**回不来**——平台只放行
 * `task_blocked` 的 needs_attention 恢复成 in_progress，`claim_activate_timeout` 只能
 * open/reopened（都清 claim），那个群的工作就废了。所以「开工即写 in_progress」不是
 * 锦上添花，是拆引信。
 *
 * ## 409 的两种含义
 *
 * 与 [[issue-release]] 同一套判据：撞 409 先问「平台还认不认我这个 claim」——
 *  - **stateRev 过期** → claim 还是我的，拿新基线重发**同一条行**（它上次没被应用，
 *    复用 sourceSeq 是安全的：平台只在 `<= lastSourceSeq` 时才当重复丢弃）
 *  - **claim 已不归本机** → 平台侧这条早就结束了（force-detach/租约过期/被别人领走），
 *    再打多少次都一样，直接判定"已结算"让调用方收尾
 */
import {
  claimNextOutboxRow,
  listOutbox,
  enqueueDesiredStatus,
  failOutboxRow,
  getBinding,
  isActiveBindState,
  settleOutboxRow,
  type AttentionReason,
  type IssueStatus,
} from './issue-board-store.js';
import { isPermanentFailure } from '../platform/issue-client.js';
import type { IssueClientResult, PlatformIssue } from '../platform/issue-client.js';

export interface StatusWriterDeps {
  dataDir: string;
  writeStatus: (
    issueId: string,
    args: {
      claimId: string;
      claimEpoch: number;
      sourceSeq: number;
      status: IssueStatus;
      attentionReason?: AttentionReason;
      expectedStateRev: number;
    },
  ) => Promise<IssueClientResult<{ issue: PlatformIssue }>>;
  /** 撞 409 时用来判断「平台还认不认这个 claim」。拿不到就当无法判定，不猜。 */
  fetchIssue: (teamId: string, issueId: string) => Promise<PlatformIssue | null>;
  now?: () => number;
}

export type FlushOutcome =
  /** 平台接受了这次回写。 */
  | { ok: true; applied: true; issue: PlatformIssue }
  /** 平台侧这条 claim 已经不归本机了 —— 无需再发，调用方按"已结算"收尾。 */
  | { ok: true; applied: false; detached: true }
  /** 没有待发行（已经同步到位，或压根没排队）。 */
  | { ok: false; reason: 'idle' }
  /** 同一 binding 已有 inflight —— 串行约束，稍后再来。 */
  | { ok: false; reason: 'busy' }
  /** binding 不存在或已是终态。 */
  | { ok: false; reason: 'no_binding' }
  /** `permanent` = 平台明确拒绝且重试无意义，行已标 fatal 不再重投（见 isPermanentFailure）。 */
  | { ok: false; reason: 'platform'; detail: string; permanent?: boolean };

/**
 * 把发件箱里该 binding 的下一条待发行发出去。
 *
 * 不排队、只发送——用于后台 pump 重投那些失败退避过的行。
 */
export async function flushNextStatus(deps: StatusWriterDeps, anchorId: string): Promise<FlushOutcome> {
  const now = deps.now ?? Date.now;
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };

  const row = claimNextOutboxRow(deps.dataDir, anchorId, now());
  if (!row) {
    // claimNextOutboxRow 返回 null 有两种截然不同的原因，不能都当 idle：**有 inflight 挡着**
    // （串行约束，稍后能发）vs **确实没有待发行**（已同步到位）。调用方要据此区分"发不出去"
    // 和"已经是这个状态了"——释放就靠这个判断是补完本地还是报错让人重试。
    const mine = listOutbox(deps.dataDir, anchorId);
    return mine.some((r) => r.state === 'inflight')
      ? { ok: false, reason: 'busy' }
      : { ok: false, reason: 'idle' };
  }

  let expectedStateRev = row.expectedStateRev ?? binding.platformStateRev ?? 0;
  let res = await deps.writeStatus(binding.issueId, {
    claimId: row.claimId,
    claimEpoch: row.claimEpoch,
    sourceSeq: row.sourceSeq,
    status: row.targetStatus,
    ...(row.attentionReason ? { attentionReason: row.attentionReason } : {}),
    expectedStateRev,
  });

  if (!res.ok && res.reason === 'conflict') {
    const fresh = await deps.fetchIssue(binding.teamId, binding.issueId);
    if (fresh && fresh.claim?.claimId !== binding.claimId) {
      // `applied: false` 是关键：这条状态平台**没有**采纳。记成已同步的话，下一次投影同一
      // 状态会走幂等分支直接回成功，而平台那边纹丝不动——一次静默的谎报。
      settleOutboxRow(deps.dataDir, row.writeId, { platformStateRev: fresh.stateRev, applied: false }, now());
      return { ok: true, applied: false, detached: true };
    }
    if (fresh) {
      expectedStateRev = fresh.stateRev;
      res = await deps.writeStatus(binding.issueId, {
        claimId: row.claimId,
        claimEpoch: row.claimEpoch,
        sourceSeq: row.sourceSeq,
        status: row.targetStatus,
        ...(row.attentionReason ? { attentionReason: row.attentionReason } : {}),
        expectedStateRev,
      });
    }
  }

  if (!res.ok) {
    const detail = 'error' in res ? `${res.reason}: ${res.error}` : res.reason;
    // 分清「等会儿再试」和「再试也没用」。401/403（凭证失效、machine_mismatch、claim 被
    // revoke）与 400/404（参数错、issue 被删或归档）是后者：不标 fatal 的话这条行会每 ≤5
    // 分钟朝一个永远不会变的死端点打一发，而且 `/issue status` 上那句「N 条回写没发出去」
    // 永不清零，验收的人会一直以为"过会儿就好"。判据见 [[issue-client]] 的
    // isPermanentFailure——它刻意不等于 !isRetriable（409 与 unbound 都不该判死）。
    const fatal = isPermanentFailure(res);
    failOutboxRow(deps.dataDir, row.writeId, detail, fatal ? { fatal: true } : {}, now());
    return { ok: false, reason: 'platform', detail, ...(fatal ? { permanent: true as const } : {}) };
  }

  settleOutboxRow(
    deps.dataDir,
    row.writeId,
    {
      platformStateRev: res.value.issue.stateRev,
      ...(res.value.issue.claim ? { platformLastSourceSeq: res.value.issue.claim.lastSourceSeq } : {}),
    },
    now(),
  );
  return { ok: true, applied: true, issue: res.value.issue };
}

/**
 * 投影一个目标状态并立刻尝试发送。
 *
 * 排队交给 `enqueueDesiredStatus`（sourceSeq 的唯一分配入口 + 去重合并），发送交给
 * `flushNextStatus`。发失败时行留在发件箱里退避，后台 pump 会接着重投——所以调用方
 * 拿到 `platform` 失败也不代表这次投影丢了。
 */
export async function projectStatus(
  deps: StatusWriterDeps,
  anchorId: string,
  desired: IssueStatus,
  opts: { attentionReason?: AttentionReason } = {},
): Promise<FlushOutcome> {
  const now = deps.now ?? Date.now;
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };

  const queued = enqueueDesiredStatus(deps.dataDir, anchorId, desired, opts, now());
  if (!queued) {
    // enqueue 返回 null 有三种情况，要分开：终态 binding（no_binding 语义）、已经同步
    // 到位（idle）、有 inflight 挡着（busy）。混成一个"失败"会让调用方分不清
    // "已经是这个状态了" 和 "发不出去"。
    if (!isActiveBindState(binding.bindState)) return { ok: false, reason: 'no_binding' };
    if (binding.lastSyncedStatus === desired) return { ok: false, reason: 'idle' };
    // 已经在追同一个目标：那条行还没发出去，直接发它，不要另起一条。
    return flushNextStatus(deps, anchorId);
  }
  return flushNextStatus(deps, anchorId);
}
