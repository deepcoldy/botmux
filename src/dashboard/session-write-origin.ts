import type { IncomingMessage } from 'node:http';
import { controlRequestOriginState } from './control-csrf.js';

/** 不在 /api/sessions/ 下、同样靠 cookie 鉴权的写接口：触发会话 turn、回答 ask 卡。 */
const COOKIE_WRITE_PATHS: ReadonlySet<string> = new Set(['/api/trigger', '/api/asks/answer']);

/**
 * Dashboard 会话写操作的跨站门禁。
 *
 * 登录 cookie 是 SameSite=Lax，跨站页面发起的 POST 在同站（含不同端口）时仍会带上它，
 * 而且 `<form enctype="text/plain">` 能构造出合法 JSON，所以带 body 的写接口一样要防。
 * 浏览器对跨站 POST 必带 `Origin`（或 `Sec-Fetch-Site`），这里只拒绝「明确判为
 * 跨站」的请求；两个信号都缺席的是非浏览器客户端（curl、脚本），保持原有行为放行。
 *
 * 对 `/api/sessions/` 前缀下所有非读方法生效（新增会话写接口自动覆盖），另加
 * `COOKIE_WRITE_PATHS` 里显式列出的非 sessions 写接口；后者新增时要手工补进名单。
 * takeover / preview-interaction / locate 另有更严的 CSRF 票据校验，这里的拒绝对它们是叠加。
 */
export function isSessionWriteRequest(method: string | undefined, pathname: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  return pathname.startsWith('/api/sessions/') || COOKIE_WRITE_PATHS.has(pathname);
}


/** 返回 true 表示放行；false 表示应回 403 `control_origin_forbidden`。 */
export function sessionWriteOriginAllowed(req: Pick<IncomingMessage, 'method' | 'headers'>, pathname: string): boolean {
  if (!isSessionWriteRequest(req.method, pathname)) return true;
  return controlRequestOriginState(req.headers) !== 'foreign';
}
