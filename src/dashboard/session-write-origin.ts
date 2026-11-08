import type { IncomingMessage } from 'node:http';
import { controlRequestOriginState } from './control-csrf.js';

/**
 * Dashboard 写接口的跨站门禁。
 *
 * 登录 cookie 是 SameSite=Lax，跨站页面发起的 POST 在同站（含不同端口）时仍会带上它，
 * 而且 `<form enctype="text/plain">` 能构造出合法 JSON，所以带 body 的写接口一样要防。
 * 浏览器对跨站 POST 必带 `Origin`（或 `Sec-Fetch-Site`），这里只拒绝「明确判为
 * 跨站」的请求；两个信号都缺席的是非浏览器客户端（curl、脚本），保持原有行为放行。
 *
 * 对 `/api/` 下所有非读方法生效（新增写接口自动覆盖）。调用点在鉴权判决之后，
 * webhook、federation、`/__daemon/*`、`/__cli/*` 等自带身份的路由在那之前已经返回，不经过这里。
 * takeover / preview-interaction / locate 另有更严的 CSRF 票据校验，这里的拒绝对它们是叠加。
 */
function isSessionWriteRequest(method: string | undefined, pathname: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  return pathname.startsWith('/api/');
}

/** 返回 true 表示放行；false 表示应回 403 `control_origin_forbidden`。 */
export function sessionWriteOriginAllowed(req: Pick<IncomingMessage, 'method' | 'headers'>, pathname: string): boolean {
  if (!isSessionWriteRequest(req.method, pathname)) return true;
  return controlRequestOriginState(req.headers) !== 'foreign';
}
