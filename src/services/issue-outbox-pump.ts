/**
 * 发件箱后台泵：把 [[issue-board-store]] 里积压的状态回写真的发出去。
 *
 * ## 没有它的话，那些「留待重投」的注释全是假的
 *
 * 回写失败时各处都写着「行留在 outbox 里，pump 会接着重投」——在这个文件存在之前，**没有
 * 任何东西会重投**。后果不是"晚一点同步"，而是不可恢复：
 *
 *  - `in_progress` 那一次写只要失败（网络抖动、平台 502、一次 409），5 分钟后平台 sweeper
 *    就把任务打成 `needs_attention(claim_activate_timeout)`，而那是**单向门**——平台只放行
 *    `task_blocked` 恢复成 in_progress，超时的只能 open/reopened（都清 claim）。群里的活废了。
 *  - `in_review` 交付失败 → 验收的人永远等不到。
 *
 * 所以这个泵不是"优化吞吐"，是让那条防护路径真的闭环。
 *
 * ## 启动先解卡：inflight 是会永久堵死的
 *
 * `claimNextOutboxRow` 见到 inflight 就返回 null（同一 issue 的 sourceSeq 必须单调到达，
 * 所以必须串行）。进程若在「标了 inflight、还没记下响应」之间挂掉，那一行**永远**停在
 * inflight：此后该 binding 的所有回写都发不出去，`botmux report` / `/issue release` 每次
 * 都回「稍后重试」而永远不会好。
 *
 * `resetInflightToPending` 就是为这个写的（store 里连注释都备好了），但一直没人调。启动时
 * 无脑退回即可——平台的 sourceSeq 单调 + 终态幂等保证重复投递是安全的，不需要发送租约。
 */
import { logger } from '../utils/logger.js';
import { readPlatformBinding } from '../platform/binding.js';
import { findIssueById, writeIssueStatus } from '../platform/issue-client.js';
import {
  isActiveBindState,
  listBindings,
  listOutbox,
  pruneOutbox,
  resetInflightToPending,
} from './issue-board-store.js';
import { flushNextStatus, type StatusWriterDeps } from './issue-status-writer.js';

/** 扫描间隔。回写不是实时通道（平台那边是人在看板上看），30s 足够；退避本身也在行上。 */
const PUMP_INTERVAL_MS = 30_000;

export interface OutboxPumpOptions {
  dataDir: string;
  intervalMs?: number;
  /** 注入发送侧（测试用）。缺省接真实平台客户端。 */
  writer?: Omit<StatusWriterDeps, 'dataDir'>;
  /** 平台是否已绑定。未绑定时整个 issue 功能是关的，空转没意义。 */
  isBound?: () => boolean;
}

/**
 * 跑一轮：把每个活跃 binding 的下一条待发行发出去。
 *
 * 每个 binding 每轮**只发一条**——同一 issue 要求 sourceSeq 单调到达，串行是硬约束；
 * 一次多发只会让顺序乱掉被平台静默丢弃。积压多条时下一轮继续，30s 一条对人看的看板足够。
 *
 * 返回这一轮发出去的条数，便于日志与测试断言。
 */
export async function pumpOnce(opts: OutboxPumpOptions): Promise<number> {
  const deps: StatusWriterDeps = {
    dataDir: opts.dataDir,
    writeStatus: opts.writer?.writeStatus ?? ((issueId, args) => writeIssueStatus(issueId, args) as any),
    fetchIssue: opts.writer?.fetchIssue ?? ((teamId, issueId) => findIssueById(teamId, issueId)),
    ...(opts.writer?.now ? { now: opts.writer.now } : {}),
  };

  let sent = 0;
  for (const binding of listBindings(opts.dataDir)) {
    // 终态 binding（void/released）不再回写：它的 issue 已经不归本机管，发过去只会被拒。
    if (!isActiveBindState(binding.bindState)) continue;
    // 先看有没有到期的待发行，没有就不进 flush——避免每轮对每个 binding 都读一遍文件。
    const due = listOutbox(opts.dataDir, binding.anchorId).some(
      (r) => r.state === 'pending' && (r.nextRetryAt ?? 0) <= Date.now(),
    );
    if (!due) continue;

    const r = await flushNextStatus(deps, binding.anchorId);
    if (r.ok) {
      sent += 1;
      logger.info(
        `[issue] 发件箱重投成功 issue=${binding.issueId} ${r.applied ? `→ ${r.issue.status}` : '（平台已不认本机 claim，就此结算）'}`,
      );
    } else if (r.reason === 'platform') {
      // permanent = 平台明确拒绝（凭证失效 / issue 已删或归档），行已标 fatal 不再重投。
      // 用 error 而不是 warn：它不会自愈，等人去看；`/issue status` 上也会显示这一条。
      if (r.permanent) {
        logger.error(`[issue] 发件箱回写被平台拒绝、已放弃重投 issue=${binding.issueId}: ${r.detail}`);
      } else {
        logger.warn(`[issue] 发件箱重投失败 issue=${binding.issueId}: ${r.detail}`);
      }
    }
  }
  return sent;
}

/**
 * 启动后台泵。返回 stop 函数。
 *
 * 启动时先 `resetInflightToPending` 解卡（见文件头），再起定时器。
 */
export function startIssueOutboxPump(opts: OutboxPumpOptions): () => void {
  const isBound = opts.isBound ?? (() => !!readPlatformBinding());

  const requeued = resetInflightToPending(opts.dataDir);
  if (requeued > 0) {
    logger.info(`[issue] 启动对账：${requeued} 条卡在 inflight 的回写已退回待发`);
  }

  const tick = (): void => {
    if (!isBound()) return;
    void pumpOnce(opts)
      .then((n) => {
        // 顺手做一次发件箱清理，别让 done 行无限增长。放在有实际发送的那一轮，
        // 避免空闲时也反复重写文件。
        if (n > 0) pruneOutbox(opts.dataDir);
      })
      .catch((e) => logger.warn(`[issue] 发件箱泵异常：${String((e as Error)?.message ?? e)}`));
  };

  const timer = setInterval(tick, opts.intervalMs ?? PUMP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
