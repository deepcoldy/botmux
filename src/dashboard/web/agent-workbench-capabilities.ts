// P1-4：工作台最小操作能力集的前端 DTO。服务端在 GET /api/workbench/capabilities
// 投影 canLocate/canControl/canInteract 三布尔（复算真实路由门禁，见
// src/dashboard/auth.ts 的 projectWorkbenchOperationCapabilities），前端只据此
// 渲染操作入口——workbenchAuthed 只证明可进工作台，绝不再被当成操作权限。
//
// type-only import：esbuild 打包会整个抹掉，不会把服务端模块（node:crypto）拖进
// 浏览器 bundle；同时把前端类型钉在服务端投影的同一形状上。
import type { WorkbenchOperationCapabilities } from '../auth.js';

export type WorkbenchCapabilities = WorkbenchOperationCapabilities;

/** fail-closed 默认值：拿不到投影（匿名 401、网络失败、响应不合形）时全 false，
 *  操作入口整体隐藏。绝不回落 true——那正是本次要修的「角色名当权限」。 */
export const NO_WORKBENCH_CAPABILITIES: Readonly<WorkbenchCapabilities> =
  Object.freeze({ canLocate: false, canControl: false, canInteract: false });

/**
 * 严格解析服务端响应 `{ ok: true, capabilities: {...} }`。逐字段要求字面量
 * `true` 才算 true：缺字段、非布尔（1/'true'）、ok !== true、外层不合形，一律
 * 回落 false。宁可对真 owner 短暂少画一个按钮，也不给无权身份画出会 401/403
 * 的入口。
 */
export function parseWorkbenchCapabilities(value: unknown): WorkbenchCapabilities {
  const body = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const raw = body?.ok === true
    && body.capabilities !== null && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
    ? body.capabilities as Record<string, unknown>
    : null;
  return {
    canLocate: raw?.canLocate === true,
    canControl: raw?.canControl === true,
    canInteract: raw?.canInteract === true,
  };
}
