/**
 * `/issue status`：把「这个群到底绑着哪条任务、现在什么状态」摊开给人看。
 *
 * 纯只读——不排队、不回写、不改 binding。之所以单独一个服务而不是让命令层直接读 store：
 * 它要同时看**本机**和**平台**两边，而这两边不一致恰恰是最需要被看见的东西：
 *
 *  - 本机 `lastSyncedStatus` 与平台 `status` 不同 → 有回写没发出去（发件箱里躺着）
 *  - 平台 `claim` 已经不是本机的 → 领取被回收/被别人领走了，这个群里干的活白干
 *  - 平台 `needs_attention` → 任务掉进了那扇单向门，得去平台处理
 *
 * 这三种状况在出问题时都是静默的，命令的价值就是把它们变成一眼可见。
 */
import { getBinding, listOutbox, type IssueBinding } from './issue-board-store.js';
import type { PlatformIssue } from '../platform/issue-client.js';

export interface IssueStatusDeps {
  dataDir: string;
  /** 拉平台当前状态。返回 null 表示**拉不到**（网络/已归档），不是"任务不存在"。 */
  fetchIssue: (teamId: string, issueId: string) => Promise<PlatformIssue | null>;
}

export interface IssueStatusView {
  binding: IssueBinding;
  /** 平台侧当前的 issue；null = 没拉到（下游必须说"拉不到"，不能说"没有这条任务"）。 */
  issue: PlatformIssue | null;
  /** 发件箱里还没发出去的回写条数。>0 说明本机与平台之间存在滞后。 */
  pendingWrites: number;
  /**
   * 已被判死、不再重投的回写条数（平台 401/403/400/404，见 `isPermanentFailure`）。
   *
   * 必须单独报出来：这些行不在 `pendingWrites` 里，界面上一声不吭就等于"已经同步好了"，
   * 而实际上那次状态变更**永远不会**到平台。给了 fatal 就得给能看见它的地方。
   */
  failedWrites: number;
  /** 最后一条判死行的错误，直接给人看，省得去翻日志。 */
  lastFailure?: string;
  /** 平台上这条 claim 是否还归本机。issue 拉不到时为 undefined（无法判定，别猜）。 */
  claimMine?: boolean;
}

export type IssueStatusResult =
  | { ok: true; view: IssueStatusView }
  | { ok: false; reason: 'no_binding' };

/**
 * 查 `anchorId` 上绑定的 issue 现状。
 *
 * 与 release/report 不同，**终态 binding 也照查**：`/issue status` 的用处正是在"这个群是不是
 * 已经结束了"存疑的时候回答它，此时把它当成"没有绑定"是把唯一的答案藏起来。
 */
export async function describeIssue(deps: IssueStatusDeps, anchorId: string): Promise<IssueStatusResult> {
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };

  const issue = await deps.fetchIssue(binding.teamId, binding.issueId);
  const rows = listOutbox(deps.dataDir, anchorId);
  const pendingWrites = rows.filter((r) => r.state === 'pending' || r.state === 'inflight').length;
  const failed = rows.filter((r) => r.state === 'failed');
  const lastFailure = failed[failed.length - 1]?.lastError;

  return {
    ok: true,
    view: {
      binding,
      issue,
      pendingWrites,
      failedWrites: failed.length,
      ...(lastFailure ? { lastFailure } : {}),
      // claim 字段被平台清掉（done/open/reopened）时也是"不归本机"，与被别人领走同样处理。
      ...(issue ? { claimMine: issue.claim?.claimId === binding.claimId } : {}),
    },
  };
}
