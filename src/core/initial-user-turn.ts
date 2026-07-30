/**
 * 「CLI 已空启动，但还没吃过任何真实用户轮」的一次性会话状态。
 *
 * 背景：`/repo <name>` / 选仓卡 / 跳过 / mid-session 切仓这几条路径，在**没有**
 * 任何 buffered 用户输入时会 `forkWorker(ds, '', false)` 把 CLI 拉起来待命。这时
 * 进程活着、`ds.worker` 非空，但 CLI 从没见过 `<botmux_routing>` /
 * `<botmux_builtin_skills>` / `<identity>` —— 这些只由 `buildNewTopicCliInput`
 * 产出。下一条业务消息若只按「worker 活没活」判定，就会被当 follow-up，开场上下文
 * 永久丢失（见 `Session.initialUserTurnPending` 的注释与 PR #477）。
 *
 * 状态放在**持久化的 `Session`** 上而不是内存 `DaemonSession`：空启动之后、首条
 * 业务消息之前 daemon 重启，重启后那条消息仍必须是 opening。`ds.session` 在
 * restore 时就是从磁盘读回来的同一个对象，所以恢复是自动的。
 *
 * 并发语义：`claimInitialUserTurn` 是**同步**的读-改-写，Node 单线程下天然互斥，
 * 因此紧邻/并发到达的两条首消息只有一条能成为 opener，另一条按既有队列顺序退化为
 * 普通 follow-up。投递失败（fork 抛错 / worker 拒收）时用 `releaseInitialUserTurn`
 * 把状态放回去，下一条消息重新竞争。
 *
 * 边界（刻意不消费的路径）：adopt/bridge 会话从不接受 botmux 包装，因此
 * `isInitialUserTurnPending` 直接对它们返回 false；botmux 控制命令、CLI raw
 * passthrough、卡片回调等在到达输入构造点之前就 return 了，天然不消费。
 */
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';
import type { DaemonSession } from './types.js';

/** 落盘失败绝不能掀翻消息路由：状态最差退化成「只在本进程生效」。 */
function persist(ds: DaemonSession): void {
  try {
    sessionStore.updateSession(ds.session);
  } catch (e) {
    logger.warn(
      `[${ds.session.sessionId.substring(0, 8)}] Failed to persist initialUserTurnPending: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** CLI 空启动后置位。幂等。 */
export function markInitialUserTurnPending(ds: DaemonSession): void {
  if (ds.session.initialUserTurnPending === true) return;
  ds.session.initialUserTurnPending = true;
  persist(ds);
}

/** 只读探测——用于在 await 之前判断「这轮可能要走 opening」，不消费状态。 */
export function isInitialUserTurnPending(ds: DaemonSession): boolean {
  // 外部 CLI 的桥接会话从不接受 botmux 的 XML 包装，opening 对它们无意义。
  if (ds.adoptedFrom) return false;
  return ds.session.initialUserTurnPending === true;
}

/**
 * 同步一次性认领。返回 true 表示**本轮**是 opening；返回 false 表示别人已经拿走
 * 了（或本来就没有），按普通 follow-up 处理。调用点与真正的 fork/send 之间可以有
 * await，失败时用 {@link releaseInitialUserTurn} 归还。
 */
export function claimInitialUserTurn(ds: DaemonSession): boolean {
  if (!isInitialUserTurnPending(ds)) return false;
  delete ds.session.initialUserTurnPending;
  persist(ds);
  return true;
}

/** 认领后投递失败（fork 抛错 / worker 拒收）时归还，下一条消息重新竞争。 */
export function releaseInitialUserTurn(ds: DaemonSession): void {
  markInitialUserTurnPending(ds);
}
