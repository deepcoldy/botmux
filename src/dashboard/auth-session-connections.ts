/**
 * P1-8：把「长连接」挂到签发它的认证会话下，认证一结束就立刻掐断。
 *
 * 背景：H5 logout / 会话到期、legacy token rotate、平台解绑之后，短请求会立刻
 * 401，但**已经建立的流**不会——`/events` SSE、Preview 的 SSE/长响应、Preview
 * WebSocket 都是登出前握好的手，握完就一直流，直到对端自己断开。这等于登出只
 * 关了前门，后窗还开着：一台被借走的手机、一个已经交接掉的工作台页面，仍然能持
 * 续看到会话板与预览内容，旧的 management SSE 甚至会收到**登出之后新产生**的
 * `riffAccessUrl`（Riff 沙箱写凭据）。
 *
 * 这里只做一件事：authSessionId → 一组「关闭器」。建流时登记，流自然结束时注销，
 * 身份结束时遍历关闭。它不认识 HTTP，也不认识 WebSocket——调用方给什么关闭动作
 * 就执行什么（`res.destroy()` / `socket.destroy()`），因此同一份索引可以同时管
 * SSE 响应和 WS 桥接 socket。
 *
 * 与 `TerminalControlManager.registerReadSocket` 的关系：那份索引是终端读流专用
 * 的（P1-5），语义与写租约耦合；本索引是通用的，覆盖终端之外的所有长连接。两者
 * 都由 `dashboardSessions.onEnd` / rotate / unbind 同一批钩子驱动。
 */

/** 关闭一条已建立的长连接。必须幂等：可能与对端自己断开竞争。 */
export type AuthSessionConnectionCloser = () => void;

export class AuthSessionConnectionRegistry {
  private readonly byAuthSession = new Map<string, Set<AuthSessionConnectionCloser>>();

  /**
   * 登记一条属于 `authSessionId` 的长连接，返回注销闭包。
   * 调用方必须在连接自然关闭时调用注销闭包，否则 Map 会随连接数无限增长。
   */
  register(authSessionId: string, close: AuthSessionConnectionCloser): () => void {
    let closers = this.byAuthSession.get(authSessionId);
    if (!closers) {
      closers = new Set();
      this.byAuthSession.set(authSessionId, closers);
    }
    closers.add(close);
    return () => {
      const current = this.byAuthSession.get(authSessionId);
      if (!current) return;
      current.delete(close);
      if (current.size === 0) this.byAuthSession.delete(authSessionId);
    };
  }

  /**
   * 身份结束（logout / 到期 / rotate / 解绑）时调用：关闭该认证会话名下的全部
   * 长连接，返回关闭条数。先把整组摘下来再逐个关，避免关闭回调同步触发注销时
   * 改动正在遍历的集合。别的认证会话的连接一条都不动。
   */
  closeAuthSession(authSessionId: string): number {
    const closers = this.byAuthSession.get(authSessionId);
    if (!closers) return 0;
    this.byAuthSession.delete(authSessionId);
    let closed = 0;
    for (const close of closers) {
      closed++;
      // 单条关闭失败（socket 已被对端销毁等）不能拖垮同批其它连接的撤销。
      try { close(); } catch { /* already gone */ }
    }
    return closed;
  }

  /** 当前登记的连接数：不传参是全量，传参是单个认证会话。仅用于测试与自检。 */
  count(authSessionId?: string): number {
    if (authSessionId !== undefined) return this.byAuthSession.get(authSessionId)?.size ?? 0;
    let total = 0;
    for (const closers of this.byAuthSession.values()) total += closers.size;
    return total;
  }
}
