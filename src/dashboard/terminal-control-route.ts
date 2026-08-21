import type {
  TerminalControlManager,
  TerminalDashboardActor,
} from './terminal-control.js';

/**
 * `/api/sessions/<id>/control[/takeover|/release]` 这条路由的**唯一**实现。
 *
 * 为什么单独成模块：这段分发原先内联在 dashboard.ts 那个几千行的请求处理器里，验收
 * 脚本要复现真链路只能照抄一份。于是出现了这一轮最难看的一个洞——浏览器早就在发
 * `?expect=` 条件释放，脚本里的那份也读了它，**生产那份从头到尾没读**，条件释放在
 * 真环境里等于不存在。把它抽出来之后，dashboard、生产 E2E 脚本、浏览器验收脚本调的
 * 都是同一个函数，再也漂不开。
 *
 * 这里只管「方法 × 动作 × 查询参数 → 租约调用 → 状态码」。认证、CSRF、会话可用性
 * 判定留在调用方——那几步依赖的是各自宿主的上下文，不属于这条路由的语义。
 */

const CONTROL_PATH = /^\/api\/sessions\/([^/]+)\/control(?:\/(takeover|release))?$/;

export type TerminalControlAction = 'takeover' | 'release';

export type TerminalControlRouteMatch =
  | { ok: true; sessionId: string; action?: TerminalControlAction }
  | { ok: false; error: 'invalid_session_id' };

/** 认出这条路由并解出 session id；不是这条路由返回 null。 */
export function matchTerminalControlRoute(pathname: string): TerminalControlRouteMatch | null {
  const matched = CONTROL_PATH.exec(pathname);
  if (!matched) return null;
  let sessionId: string;
  try { sessionId = decodeURIComponent(matched[1]); }
  catch { return { ok: false, error: 'invalid_session_id' }; }
  return matched[2]
    ? { ok: true, sessionId, action: matched[2] as TerminalControlAction }
    : { ok: true, sessionId };
}

export interface TerminalControlRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 查询参数里的两个 acquisition 位：
 *   `acq`    takeover 带来的、客户端在 POST **之前**就生成好的本次接管 id；
 *   `expect` release 的 CAS 条件：只还「这一次」，别人后来接管过就拒。
 *
 * 两个都是不透明等值串，不是凭证：服务端只做等值比较，权限判定全在 identity 上。
 */
export function resolveTerminalControlAction(params: {
  method: string;
  action?: TerminalControlAction;
  sessionId: string;
  search: URLSearchParams;
  identity: TerminalDashboardActor;
  control: TerminalControlManager;
}): TerminalControlRouteResponse {
  const { action, control, identity, search, sessionId } = params;
  const method = params.method.toUpperCase();

  if (method === 'GET' && !action) {
    return { status: 200, body: { ok: true, ...control.state(identity, sessionId) } };
  }
  // 只读身份的写入口一律 403（与前端「不渲染按钮」互相独立的那道门禁）。
  if (identity.terminalCapability === 'readonly') {
    return { status: 403, body: { ok: false, error: 'terminal_operation_forbidden' } };
  }
  if (method === 'POST' && action === 'takeover') {
    const requested = search.get('acq');
    const result = control.takeover(identity, sessionId, requested ?? undefined);
    if (result.ok) return { status: 200, body: { ...result, owned: true } };
    const status = result.error === 'control_busy' ? 409
      : result.error === 'invalid_acquisition' ? 400
      : result.error === 'terminal_operation_forbidden' ? 403
      : 401;
    return { status, body: { ok: false, error: result.error } };
  }
  if (method === 'POST' && action === 'release') {
    // ?expect= 是卸载补偿 / 关面板清理带来的 CAS 条件：只还「我那一次接管拿到的
    // 那一把」。不带它就是历史上的无条件释放（用户手动点「释放输入」那条路，面板
    // 就在眼前，没有别的面板可误伤）。
    const expected = search.get('expect');
    const result = control.release(identity, sessionId, expected ?? undefined);
    return result.ok
      ? { status: 200, body: { ...result, owned: false } }
      : { status: 403, body: { ok: false, error: result.error } };
  }
  return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
}
