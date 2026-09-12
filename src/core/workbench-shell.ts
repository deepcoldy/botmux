/**
 * 工作台「沉浸式」壳标记——从直达入口进工作台时不带 Dashboard 的 topbar / 侧栏。
 *
 * 背景：#948 之后 `#/agent-workbench` 从侧边栏「驾驶舱」进入时套普通 Dashboard 壳，
 * 无边框只留给桌面 / 移动客户端（`botmuxClientShell`）。但 `/dashboard` 卡片的
 * 「打开工作台」按钮、`botmux dashboard` 打印的工作台链接、常驻链接、短票兑换这些
 * **直达入口**，语义上就是「一整屏工作台」，不该落进带侧栏的壳。它们统一在目标 hash
 * 里带上本标记，前端认到就渲染无边框壳；侧栏导航不带标记，仍是正常壳。
 *
 * 标记放在 **hash 查询串**而不是 `?` 查询串：`?t=<token>` 登录跳转会把查询串整个
 * 剥掉（auth.ts 的 `allow+set-cookie`），而浏览器跟随无 fragment 的 302 时会保留
 * 原 fragment；前端启动时再把它提升进查询串（client-shell.ts），之后的 hash 导航
 * （选中会话改成 `#/agent-workbench/<id>`）才不会把标记冲掉。与 `botmuxClientShell`
 * 同一套机制，但**不**复用它——客户端壳还会过滤导航、拦 Workflow / Web 终端路由，
 * 网页直达入口不该被连带限制。
 *
 * 本模块保持零依赖：Dashboard 服务端（auth / 路由 / 票据）与 web bundle 都从这里
 * 取常量，避免两边手写字符串漂移。
 */

export const WORKBENCH_SHELL_PARAM = 'botmuxWorkbenchShell';
export const WORKBENCH_SHELL_IMMERSIVE = 'immersive';
export type DashboardWorkbenchShell = typeof WORKBENCH_SHELL_IMMERSIVE;

/** `#/agent-workbench` → `#/agent-workbench?botmuxWorkbenchShell=immersive`。 */
export function immersiveWorkbenchHash(hashRoute: string): string {
  return `${hashRoute}?${WORKBENCH_SHELL_PARAM}=${WORKBENCH_SHELL_IMMERSIVE}`;
}

/** 完整工作台 / 会话坞的沉浸式 hash，以及服务端 302 用的入口（以 `/` 开头）。 */
export const WORKBENCH_IMMERSIVE_HASH = immersiveWorkbenchHash('#/agent-workbench');
export const WORKBENCH_DOCK_IMMERSIVE_HASH = immersiveWorkbenchHash('#/agent-workbench-dock');
export const WORKBENCH_IMMERSIVE_ENTRY = `/${WORKBENCH_IMMERSIVE_HASH}`;
export const WORKBENCH_DOCK_IMMERSIVE_ENTRY = `/${WORKBENCH_DOCK_IMMERSIVE_HASH}`;
