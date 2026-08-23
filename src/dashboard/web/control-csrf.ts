/**
 * P1-11 前端侧：读页面注入的一次性 CSRF 票据，随控制类写请求一起发。
 *
 * 服务端在每次返回 SPA 壳时现签一枚票据并注入 `<meta name="botmux-csrf">`（见
 * dashboard.ts 的 `injectControlCsrfMeta`）。票据绑定当前认证会话，登出/rotate
 * 后立即作废；跨站页面读不到本源的 DOM，`<form>` 也设不了自定义头，所以「无 body
 * 表单触发接管/解锁」这条路就此断掉。
 *
 * 拿不到票据（匿名壳、注入前的旧缓存页、非浏览器环境）时返回空对象：请求照发，
 * 由服务端回 403 `control_csrf_invalid`，前端按普通错误提示，不在客户端二次判权。
 */
const CONTROL_CSRF_HEADER = 'x-botmux-csrf';
const CONTROL_CSRF_META_NAME = 'botmux-csrf';

export function readControlCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector(`meta[name="${CONTROL_CSRF_META_NAME}"]`);
  const value = meta?.getAttribute('content')?.trim();
  return value ? value : null;
}

/** 控制类写请求要带的头；没有票据时是空对象（展开进 headers 无副作用）。 */
export function controlCsrfHeaders(): Record<string, string> {
  const token = readControlCsrfToken();
  return token ? { [CONTROL_CSRF_HEADER]: token } : {};
}
