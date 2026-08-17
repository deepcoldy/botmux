/**
 * P1-13：previewTarget 的生命周期收口。
 *
 * previewTarget 是**当代 worker 的路由状态**，不是会话的持久属性：它指向那一代
 * CLI 在本机 loopback 上拉起来的 Web 服务。worker 一换代（refork / 切 CLI / adopt /
 * 崩溃退出 / suspend），或者会话被关闭，那个进程就没了，端口号随时可能被别的本机
 * 进程抢走 —— 留着它等于把一条已登录用户可达的同源代理路由，交给一个我们不再认识
 * 的进程。
 *
 * 所以每个「权威换代边界」都必须做两件事，缺一不可：
 *   1. **原子地**把 previewTarget 从内存与磁盘上同时抹掉（并进调用方自己的那次
 *      `updateSession`，失败可回滚，不留下「内存清了磁盘没清」的中间态）；
 *   2. 向 Dashboard 广播 `preview: null`，否则浏览器侧的会话卡片会继续显示预览入口，
 *      SSE/WS 也没有信号去断开既有的预览长连接。
 *
 * 这里只提供这两个动作的最小原语，好让每个边界按自己的事务形状组合：
 *   - `takeSessionPreviewTarget` —— 只摘字段（调用方随后自己 save，可回滚）；
 *   - `publishSessionPreviewCleared` —— 只广播；
 *   - `clearSessionPreviewTarget` —— 自带 save + 广播，给没有自带事务的边界用。
 */

import { dashboardEventBus } from './dashboard-events.js';
import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';

/**
 * 摘掉内存里的 previewTarget，返回被摘掉的旧值（本来就没有则返回 undefined）。
 * 不落盘、不广播：调用方要把它并进自己的原子 `updateSession`，并在 save 失败时用
 * 返回值回滚。
 */
export function takeSessionPreviewTarget(session: Session): Session['previewTarget'] {
  const previous = session.previewTarget;
  if (previous === undefined) return undefined;
  session.previewTarget = undefined;
  return previous;
}

/**
 * 广播「这个会话已经没有预览目标了」。走 `previewTarget: null` 而不是省略字段——
 * preview-contract 的投影把它翻译成浏览器可见的 `preview: null`，浏览器 store 据此
 * 丢弃旧描述符；省略字段则会被当成「本次 patch 不涉及预览」而保留旧值。
 */
export function publishSessionPreviewCleared(sessionId: string): void {
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId, patch: { previewTarget: null } },
  });
}

/**
 * 清 + 落盘 + 广播。返回是否真的清掉了东西（没有目标时不产生任何事件与写盘）。
 *
 * 落盘失败**不**回滚内存：此刻内存里的会话已经不再持有那个目标（这正是我们要的
 * fail-closed 方向），而下一次成功的 save 会让磁盘收敛。广播照发，Dashboard 立刻
 * 停止把用户导向一个已经不属于本会话的端口。
 */
export function clearSessionPreviewTarget(session: Session, why: string): boolean {
  if (takeSessionPreviewTarget(session) === undefined) return false;
  try {
    sessionStore.updateSession(session);
  } catch (err) {
    logger.error(
      `[${session.sessionId.substring(0, 8)}] Could not persist preview-target cleanup (${why}): `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  publishSessionPreviewCleared(session.sessionId);
  logger.debug(`[${session.sessionId.substring(0, 8)}] Dropped preview target (${why})`);
  return true;
}
