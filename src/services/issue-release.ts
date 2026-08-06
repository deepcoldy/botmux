/**
 * 结束一次领取。两种结局，共用一套写法：
 *  - **释放**（`/issue release`）→ 平台 `open`，任务退回待领取池，本地 `released`
 *  - **验收完成**（`/issue done`）→ 平台 `done`，任务终结，本地 `done`
 *
 * 放在同一个文件是因为它们在协议层是**同一件事**：平台侧只有 `open`/`reopened`/`done` 会
 * 清 claim（`clearsClaim`），所以两者都是「平台先行、本地后写」加同一套 409 判据，差别只在
 * 目标状态与本地终态。分成两份实现的话，那套顺序与 409 语义就得维护两遍——这正是本仓已经
 * 踩过一次的坑（三份回写实现，缺的那份恰好是最要命的）。
 *
 * 释放是 [[issue-claim-flow]] 的逆操作，但**不是回滚**——领取过程中的失败靠「留下可对账的
 * 状态」收拾（见那边的注释），这里处理的是完全不同的场景：领取成功、干到一半、人决定不做了。
 *
 * ## 为什么释放写 `open` 而不是别的
 *
 * 三个会清 claim 的目标里，`open` 是唯一语义正确的：任务没做完，退回去让别人领。`done` 是
 * 撒谎，`reopened` 是"做完又被打回"。
 *
 * ## 平台先行，本地后写
 *
 * 顺序是**先让平台确认清掉 claim，再改本地 binding**，不能反：
 *  - 先本地后平台：中间崩溃 → 本机认为已释放（群不再回写）、平台仍记着这台机器持有，
 *    直到 lease 到期才回收。这段时间 issue 卡在 in_progress，谁也领不走。
 *  - 先平台后本地：中间崩溃 → 平台已放开可以被别人领，本机 binding 还在。下次回写会被
 *    平台按 claim 不匹配拒掉（stale_epoch / claim_mismatch），是**响的**失败，能查。
 *
 * 宁可留一条会报错的本地记录，也不要留一个静默卡死的平台状态。
 *
 * ## 409 的两种含义要分开
 *
 * 撞 409 时必须先弄清楚"平台还认不认我这个 claim"，两种情况的正确动作相反：
 *  - **stateRev 过期**（别人改了这条 issue）→ claim 还是我的，拿新 stateRev 重发一次即可
 *  - **claim 已经不是我的**（平台上被 force-detach / lease 过期 / 别人领走）→ 平台早就
 *    释放了，这里只需把本地补记成 released。这正是"我想撒手但平台一直拒绝我"的死结场景，
 *    不处理的话人只能去手改 JSON。
 */
import {
  clearClaimIntent,
  getBinding,
  isActiveBindState,
  updateBinding,
  type IssueBinding,
  type IssueStatus,
} from './issue-board-store.js';
import { projectStatus, type StatusWriterDeps } from './issue-status-writer.js';

/** 发送侧完全复用 [[issue-status-writer]]：回写只有一条路径。 */
export type ReleaseDeps = StatusWriterDeps;

export type ReleaseResult =
  | { ok: true; binding: IssueBinding; issueId: string; alreadyReleasedOnPlatform: boolean }
  /** 这个锚点上没有 issue 绑定——不是错误，只是没什么可释放的。 */
  | { ok: false; reason: 'no_binding' }
  /** 已经是终态（释放过 / 作废 / 已验收完成）。幂等，不重复打平台。终态是哪一种看 `binding.bindState`。 */
  | { ok: false; reason: 'already_released'; binding: IssueBinding }
  /** 平台拒绝且 claim 仍归本机所有 —— 本地**不改**。`permanent` 时重试也不会好（见
   *  [[issue-client]] 的 isPermanentFailure），调用方别再劝人"稍后再试一次"。 */
  | { ok: false; reason: 'platform'; detail: string; binding: IssueBinding; permanent?: boolean };

/**
 * 结束一次领取的共同实现：投影终态 → 平台确认 → 才改本地 bindState。
 *
 * 走 outbox 而不是裸调 `writeStatus`：`enqueueDesiredStatus` 是 sourceSeq 的**唯一**分配
 * 入口（含落后自愈，见那边注释），绕过它自己编号迟早会撞上平台的静默去重。发送失败时行留在
 * outbox 里，[[issue-outbox-pump]] 会接着重投——不会因为一次网络抖动就丢。
 */
async function settleTerminal(
  deps: ReleaseDeps,
  anchorId: string,
  target: IssueStatus,
  localTerminal: IssueBinding['bindState'],
): Promise<ReleaseResult> {
  const now = deps.now ?? Date.now;
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };
  if (!isActiveBindState(binding.bindState)) {
    return { ok: false, reason: 'already_released', binding };
  }

  const r = await projectStatus(deps, anchorId, target);

  // `idle` = 发件箱里没有待发行且 lastSyncedStatus 已经是目标态 —— 上一次发成功了、只是崩在
  // 改本地 binding 之前（"平台先行、本地后写"留下的可恢复形态）。补完本地那一半。
  // `r.ok && !r.applied` = 409 对账发现 claim 已不归本机：平台侧这条早就结束了，同样只需补本地。
  const alreadySettledOnPlatform =
    (r.ok && !r.applied) || (!r.ok && r.reason === 'idle' && binding.lastSyncedStatus === target);

  if (!r.ok && !alreadySettledOnPlatform) {
    // 平台还认为这台机器持有，本机也得继续这么认，否则就是分裂。
    const detail = r.reason === 'busy'
      ? 'outbox_busy（上一条回写还在发送中，稍后重试）'
      : r.reason === 'platform' ? r.detail : r.reason;
    const permanent = !r.ok && r.reason === 'platform' && r.permanent === true;
    return { ok: false, reason: 'platform', detail, binding, ...(permanent ? { permanent } : {}) };
  }

  // 平台已确认，现在才动本地。
  const settled = updateBinding(deps.dataDir, anchorId, { bindState: localTerminal }, now()) ?? binding;
  // 领取意图正常情况下在领取成功时就清了；这里兜底清一次，免得对账把一条已结束的领取
  // 当成悬空领取再去补建群。
  clearClaimIntent(deps.dataDir, binding.claimId);
  return { ok: true, binding: settled, issueId: binding.issueId, alreadyReleasedOnPlatform: alreadySettledOnPlatform };
}

/** 释放 `anchorId` 上绑定的 issue：平台退回 `open`，本地记 `released`。 */
export function releaseIssue(deps: ReleaseDeps, anchorId: string): Promise<ReleaseResult> {
  return settleTerminal(deps, anchorId, 'open', 'released');
}

/**
 * 验收完成 `anchorId` 上绑定的 issue：平台 `done`，本地记 `done`。
 *
 * ⚠️ 平台的追赶白名单里 `needs_attention` **不能**直接到 `done`（只放行 in_progress /
 * open / reopened），所以对一条已经掉进「需要关注」的任务发 `/issue done` 会拿到
 * `invalid_transition`。这不是 bug 是设计：出过状况的任务得先在平台上处理干净，不能靠
 * 本地一句命令抹平。调用方需要把这个原因原样说给人听。
 */
export function completeIssue(deps: ReleaseDeps, anchorId: string): Promise<ReleaseResult> {
  return settleTerminal(deps, anchorId, 'done', 'done');
}
