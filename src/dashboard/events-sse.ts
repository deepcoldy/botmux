/**
 * P1-8：`/events` 管理 SSE 的身份寿命绑定。
 *
 * SSE 的门禁只在建立连接的那一刻跑过一次，之后帧是**服务端主动推**的，请求门禁
 * 再也没有机会说话。于是登出 / token rotate / 平台解绑之后，旧连接照旧收帧——不
 * 只是「多看了会话板一会儿」，而是会收到 **吊销之后新产生的** 数据：会话行里的
 * `riffAccessUrl` 是 Riff 沙箱的写凭据，rotate 的本意就是让旧链接失效，结果旧
 * SSE 把 rotate 之后新签的写凭据继续送给上一任持有者。
 *
 * 这里给每条流两层保护：
 *  1. **推送前复核**：每帧写出前重查 authSession 是否仍有效，失效就结束响应，
 *    这一帧不写。哪怕主动关闭那条路径漏掉了某个入口（新增的吊销来源），也不会
 *    把新数据送出去。
 *  2. **主动关闭**：建流时登记进 authSession→连接索引，吊销时遍历 destroy，
 *    不等下一帧、不等心跳。
 *
 * 匿名（publicReadOnly）连接没有认证会话，不属于任何身份，行为保持原样。
 */
import type { ServerResponse } from 'node:http';

export interface DashboardEventsStreamOptions {
  res: ServerResponse;
  /** 本流归属的认证会话；匿名 public-read 连接为 null。 */
  authSessionId: string | null;
  /** 认证会话是否仍然有效（H5 会话表 / 活跃 token / 平台绑定的统一口径）。 */
  isAuthSessionLive: (authSessionId: string) => boolean;
  /** 登记进 authSession→长连接索引，返回注销闭包。 */
  bind?: (authSessionId: string, close: () => void) => () => void;
}

export interface DashboardEventsStream {
  /** 写一帧；身份已失效或流已关闭时返回 false 且不写任何字节。 */
  write(event: string, data: unknown): boolean;
  /** 客户端断开 / 服务端吊销后的清理（幂等）。 */
  dispose(): void;
  readonly closed: boolean;
}

export function createDashboardEventsStream(options: DashboardEventsStreamOptions): DashboardEventsStream {
  let closed = false;
  let unbind: (() => void) | undefined;

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    unbind?.();
    unbind = undefined;
  };

  const revoke = (): void => {
    if (closed) return;
    dispose();
    // end() 而不是 destroy()：给浏览器一个干净的流结束，EventSource 会按
    // `retry:` 重连，重连那一跳会被正常的 401 门禁挡住并弹登录态。
    try { options.res.end(); } catch { /* already torn down */ }
  };

  if (options.authSessionId && options.bind) {
    unbind = options.bind(options.authSessionId, revoke);
  }

  return {
    get closed() { return closed; },
    dispose,
    write(event, data) {
      if (closed || options.res.writableEnded) return false;
      const authSessionId = options.authSessionId;
      if (authSessionId && !options.isAuthSessionLive(authSessionId)) {
        revoke();
        return false;
      }
      options.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
  };
}
