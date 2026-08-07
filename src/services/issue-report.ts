/**
 * issue 交付：agent 在领取群里跑完后执行 `botmux report`，把平台 issue 推到 `in_review`（待验收）。
 *
 * 这是 kickoff 正文里那句「完成后执行 botmux report 交付」的落地实现——见
 * [[issue-command-deps]] 的 buildKickoffPrompt。平台生命周期：
 *   claimed → in_progress → **in_review** → done
 * （`/status` 允许正向追赶，所以 claimed 也可直接到 in_review。）
 *
 * ## 为什么不复用 dispatch 的 report 路径
 *
 * `botmux report` 原本只服务「多话题协作」：把回报发回主编排会话。领取群是 chat-scope
 * 会话，没有 creatorOpenId / dispatch 注册表，那条路会硬失败。issue 交付的「验收人」
 * 在平台看板，不在飞书主编排话题，所以这里走 binding → outbox → `/status`，与
 * [[issue-release]] 同一套发件箱。
 *
 * ## 平台先行，本地 lastSynced 后写
 *
 * 与 release 相同：先让平台确认 `in_review`，再 settle outbox。中间崩溃最多多发一次
 * （sourceSeq 幂等），不会出现「本机以为已交付、平台还停在 claimed」。
 *
 * 与 release 的差异：交付**不**改 bindState——claim 仍归本机，等人在平台上 accept/reject。
 */
import { getBinding, isActiveBindState, type IssueBinding } from './issue-board-store.js';
import { projectStatus, type StatusWriterDeps } from './issue-status-writer.js';

/** 发送侧复用 [[issue-status-writer]]：回写只有一条路径（409 对账、退避、串行都在那边）。 */
export type ReportDeps = StatusWriterDeps;

export type ReportIssueResult =
  | { ok: true; binding: IssueBinding; issueId: string; alreadyInReview: boolean }
  | { ok: false; reason: 'no_binding' }
  | { ok: false; reason: 'not_active'; binding: IssueBinding }
  /** 平台上这条 claim 已经不归本机（force-detach / 租约过期 / 被别人领走）。交付**没有**落地，
   *  而且重试也不会落地——单列一类，别混进 platform 让人以为再跑一次就好。 */
  | { ok: false; reason: 'detached'; binding: IssueBinding }
  /** `permanent` 时重试也不会好（平台 401/403/400/404），别劝人再跑一次 report。 */
  | { ok: false; reason: 'platform'; detail: string; binding: IssueBinding; permanent?: boolean };

/**
 * 从会话候选锚点里找活跃 issue binding。
 *
 * 拉群领取的 binding 主键是 chatId；话题领取（若将来支持）主键是 rootMessageId。
 * 两个候选都查一遍，先命中活跃 binding 的为准。
 */
export function findActiveBindingForSession(
  dataDir: string,
  session: { chatId?: string; rootMessageId?: string },
): IssueBinding | null {
  const candidates: string[] = [];
  if (session.rootMessageId) candidates.push(session.rootMessageId);
  if (session.chatId && session.chatId !== session.rootMessageId) candidates.push(session.chatId);
  const seen = new Set<string>();
  for (const anchorId of candidates) {
    if (seen.has(anchorId)) continue;
    seen.add(anchorId);
    const binding = getBinding(dataDir, anchorId);
    if (binding && isActiveBindState(binding.bindState)) return binding;
  }
  return null;
}

/**
 * 把 `anchorId` 上绑定的 issue 推到平台 `in_review`。
 *
 * 走 outbox：`enqueueDesiredStatus` 是 sourceSeq 唯一分配入口。发送失败时行留在
 * pending，可重试同一 `botmux report`。
 */
export async function reportIssueInReview(deps: ReportDeps, anchorId: string): Promise<ReportIssueResult> {
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };
  if (!isActiveBindState(binding.bindState)) return { ok: false, reason: 'not_active', binding };

  const r = await projectStatus(deps, anchorId, 'in_review');

  // 409 对账后发现 claim 已易主：交付**没有**落地。这和 release 相反——释放时"claim 已不在
  // 本机"正好就是想要的结果，交付时它意味着这次汇报根本没写上去，报成功就是骗人。
  if (r.ok && !r.applied) return { ok: false, reason: 'detached', binding };

  // `idle` = 没有待发行且已同步到位 —— 重复交付（同一次 report 跑了两遍），不是失败。
  const alreadyInReview = !r.ok && r.reason === 'idle';

  if (!r.ok && !alreadyInReview) {
    const detail =
      r.reason === 'busy'
        ? '上一条回写还在发送中，稍后重试同一条 botmux report'
        : r.reason === 'platform'
          ? r.detail
          : r.reason;
    const permanent = !r.ok && r.reason === 'platform' && r.permanent === true;
    return { ok: false, reason: 'platform', detail, binding, ...(permanent ? { permanent } : {}) };
  }

  // 交付**不**改 bindState：claim 仍归本机，等人在平台上 accept/reject。
  return {
    ok: true,
    binding: getBinding(deps.dataDir, anchorId) ?? binding,
    issueId: binding.issueId,
    alreadyInReview,
  };
}
