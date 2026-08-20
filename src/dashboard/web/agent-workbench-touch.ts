import { useCallback, useEffect, useState } from 'react';
import type { WorkbenchApi } from './agent-workbench-api.js';

/**
 * 触屏鉴权契约（P1-17）。
 *
 * 工作台上凡是要把终端塞进浏览器的地方，鉴权走哪条路都不看登录态，只看「这个浏览器
 * 发 WebSocket 时带不带 Cookie」：
 *   • 桌面登录态 → 同源 `/s/<id>`。Cookie 带得过去，而且它捎带接管授权。
 *   • 触屏（iOS WebView / 飞书内嵌浏览器）→ 必须换成带 `?viewToken=` 的能力地址。
 *     iOS WebView 发起 WS 升级时不带 Cookie，同源地址即使页面本身能加载，紧接着的
 *     握手也会被 403 掉，终端永远停在 disconnected。
 *   • 未登录 → 同样只能走 viewToken。
 *
 * 这两个 hook 就是那份契约本身。以前它只长在终端面板里，会话坞另起一套「永远发裸
 * /s/ 链接」的写法，于是手机上点开就是 403 空白——同一份判断只能有一处实现，坞和面板
 * 都从这里取。
 */

/** 当前是不是触屏环境。matchMedia + change 订阅，卸载时退订；`maxTouchPoints` 兜住
 *  那些同时报 hover 的混合设备（iPad 接键盘、Windows 触屏本）。 */
export function useTouchEnvironment(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(hover: none)');
    const sync = () => setTouch(
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) || query.matches,
    );
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return touch;
}

export interface TerminalViewLink {
  sessionId: string;
  url: string;
  expiresAt: number | null;
}

export type TerminalViewLinkPhase = 'idle' | 'loading' | 'ready' | 'failed';

export interface TerminalViewLinkState {
  /** 当前可用的只读链接。`null` 表示还没拿到——调用方必须停在等待态，
   *  **绝不能**回退到裸同源地址：那条路在触屏上必然是黑屏。 */
  link: TerminalViewLink | null;
  phase: TerminalViewLinkPhase;
  /** 手动重试。effect 的 cleanup 会取消挂起的自动重试，所以连点不会叠定时器。 */
  retry(): void;
}

/**
 * 拉取并维护一条短时 viewToken 只读链接（`GET /api/sessions/<id>/view-link`）。
 * 服务端只返回同源路径，api 层已经做了形状校验与同源改写（P1-5）。
 *
 * `enabled=false` 时不发任何请求，phase 停在 idle：桌面登录态、外部 Riff 终端这些
 * 用不上能力凭证的场合就该一次都不问。
 */
export function useTerminalViewLink(params: {
  api: WorkbenchApi;
  sessionId: string;
  enabled: boolean;
}): TerminalViewLinkState {
  const { api, enabled, sessionId } = params;
  const [link, setLink] = useState<TerminalViewLink | null>(null);
  const [phase, setPhase] = useState<TerminalViewLinkPhase>('idle');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    // 换会话才清掉手上的链接；同一会话的到期前换链（下面那个 effect 触发的重取）让旧
    // 链接一直顶到新链接就位，避免闪一下「正在获取…」空态。
    setLink(previous => (previous?.sessionId === sessionId ? previous : null));
    setPhase('loading');
    void api.getTerminalViewLink(sessionId, controller.signal)
      .then(fresh => {
        // Every failure — abort included — comes back as null rather than a
        // rejection, so this still runs after cleanup. Never schedule past it.
        if (controller.signal.aborted) return;
        if (fresh) {
          setLink({ sessionId, url: fresh.url, expiresAt: fresh.expiresAt });
          setPhase('ready');
          return;
        }
        setPhase('failed');
        // 手上的旧链接没过期就先继续用它顶着（后台重试换新）；已过期的链接 worker 端
        // 已经关了 WS，留着只会是假活着的黑屏，撤下换诚实的失败态。
        setLink(previous => (
          previous?.sessionId === sessionId && previous.expiresAt !== null && previous.expiresAt <= Date.now()
            ? null
            : previous
        ));
        // A missing link usually means the login lapsed or the worker has not
        // registered its terminal yet; both recover without the viewer acting.
        retry = setTimeout(() => setAttempt(value => value + 1), 8_000);
      });
    return () => {
      controller.abort();
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [api, attempt, enabled, sessionId]);

  // 短时 viewToken（P1-5）到期前主动换链：提前 30 秒重拉一条 view-link，成功后调用方
  // 平滑接续；真到期后 worker 会按签名边界关掉 WS，旧链接自己救不回来。至少 5 秒的
  // 下限防止服务端给出过近的到期时间时打转。
  useEffect(() => {
    if (phase !== 'ready' || link?.expiresAt == null) return undefined;
    const lead = link.expiresAt - Date.now() - 30_000;
    const timer = setTimeout(() => setAttempt(value => value + 1), Math.max(5_000, lead));
    return () => clearTimeout(timer);
  }, [link, phase]);

  const retry = useCallback(() => {
    setPhase('loading');
    setAttempt(value => value + 1);
  }, []);

  return { link, phase, retry };
}
