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
   * P1-13：同一批连接的第二个索引——按被预览的**业务会话** id。
   *
   * 身份还在、但预览目标没了（worker 换代 / 切 CLI / 会话关闭 / 端口被别的进程接管）
   * 时，authSession 那把钥匙开不了这扇门：登录用户完全合法，只是他正在看的那条流已经
   * 指向一个不再属于这个会话的进程。必须能按 sessionId 单独把这批流掐掉，且不碰同一
   * 认证会话名下其它会话的连接。
   */
  private readonly bySession = new Map<string, Set<AuthSessionConnectionCloser>>();

  /**
   * 登记一条属于 `authSessionId` 的长连接，返回注销闭包。
   * 调用方必须在连接自然关闭时调用注销闭包，否则 Map 会随连接数无限增长。
   *
   * `sessionId` 可选：预览类长连接传它，好让预览目标失效时能定点断流。
   */
  register(
    authSessionId: string,
    close: AuthSessionConnectionCloser,
    sessionId?: string,
  ): () => void {
    this.add(this.byAuthSession, authSessionId, close);
    if (sessionId !== undefined) this.add(this.bySession, sessionId, close);
    return () => {
      this.drop(this.byAuthSession, authSessionId, close);
      if (sessionId !== undefined) this.drop(this.bySession, sessionId, close);
    };
  }

  private add(
    index: Map<string, Set<AuthSessionConnectionCloser>>,
    key: string,
    close: AuthSessionConnectionCloser,
  ): void {
    let closers = index.get(key);
    if (!closers) {
      closers = new Set();
      index.set(key, closers);
    }
    closers.add(close);
  }

  private drop(
    index: Map<string, Set<AuthSessionConnectionCloser>>,
    key: string,
    close: AuthSessionConnectionCloser,
  ): void {
    const current = index.get(key);
    if (!current) return;
    current.delete(close);
    if (current.size === 0) index.delete(key);
  }

  /**
   * 身份结束（logout / 到期 / rotate / 解绑）时调用：关闭该认证会话名下的全部
   * 长连接，返回关闭条数。先把整组摘下来再逐个关，避免关闭回调同步触发注销时
   * 改动正在遍历的集合。别的认证会话的连接一条都不动。
   */
  closeAuthSession(authSessionId: string): number {
    return this.closeAll(this.byAuthSession, authSessionId);
  }

  /** 当前有长连接在册的全部认证会话。解绑吊销要按前缀筛平台身份，见
   *  `TerminalControlManager.authSessionIds`。 */
  authSessionIds(): string[] {
    return [...this.byAuthSession.keys()];
  }

  /**
   * P1-13：预览目标失效（换代 / 关闭 / 端口易主）时，关闭这个业务会话名下的全部
   * 长连接。注销闭包会把它们同时从 authSession 索引里摘掉，两个索引不会漂移。
   */
  closeSessionStreams(sessionId: string): number {
    return this.closeAll(this.bySession, sessionId);
  }

  private closeAll(
    index: Map<string, Set<AuthSessionConnectionCloser>>,
    key: string,
  ): number {
    const closers = index.get(key);
    if (!closers) return 0;
    // 先把整组摘下来再逐个关：关闭回调会同步触发注销闭包，那会改动这个集合。
    index.delete(key);
    let closed = 0;
    for (const close of [...closers]) {
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

  /** 某个业务会话名下的连接数。仅用于测试与自检。 */
  countSessionStreams(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }
}
