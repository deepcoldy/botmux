/**
 * 飞书开放平台错误分类（周期轮询的熔断判定专用）。
 *
 * 周期轮询必须区分两类失败，否则一个永久错误（bot 被移出群、文档被删、
 * 权限被收回）会被当成瞬时抖动以固定间隔无限重试——message-listener 曾对
 * 230002 空转 19 天约 11 万次。
 *
 * 本模块只做归一与分类，不定义新的错误类：业务码的单一事实源是
 * `lark-errors.ts`（具名常量、`LarkApiError`、`extractLarkBusinessCode`），
 * 瞬时限流码的单一事实源是 `api-gate.ts`（`TRANSIENT_LARK_CODES`），
 * 这里只引用、不复制，避免两份码表漂移（曾把限流码 230020/99991400
 * 误抄进永久表，导致活跃群被误熔断并给 owner 发假的「被移出群」告警）。
 *
 * 到达调用方的错误形态（已逐一核对真实抛出点）：
 *  1. axios/SDK HTTP 非 2xx：业务码在 `err.response.data.code`，HTTP 状态在
 *     `err.response.status`（230002 现场即 HTTP 400）。
 *  2. HTTP 200 但业务 code!=0：原语抛普通 Error，code 只在 message 文本
 *     `(code: N)` 里（`extractLarkBusinessCode` 覆盖）。
 *  3. doc-comment 的自定义错误类：没有 `response`，HTTP 状态挂在自身
 *     `httpStatus` 字段、业务码挂在 `larkCode` 字段（message 里是全角括号，
 *     ASCII 正则提不到）——删除文档抛 `DocProviderRejectedError`（httpStatus
 *     404/403），失权抛 `UserTokenForbiddenError`（larkCode 1069603 +
 *     httpStatus 403）/ `DocSubscriptionPermissionError`（larkCode 1069603）。
 */
import { TRANSIENT_LARK_CODES } from './api-gate.js';
import { extractLarkBusinessCode } from './lark-errors.js';

export type LarkErrorClass = 'permanent' | 'transient';

export interface ClassifiedLarkError {
  readonly classification: LarkErrorClass;
  readonly larkCode?: number;
  readonly httpStatus?: number;
  readonly message: string;
}

/**
 * 高置信度的「轮询目标永久不可达」业务码：在同一资源目标上重试不会自愈。
 * 只放有仓库内实测证据的码——拿不准的码宁可不放，由「未知按瞬时」兜底。
 */
const PERMANENT_TARGET_CODES: ReadonlySet<number> = new Set([
  230002, // Bot/User can NOT be out of the chat：被移出群/群解散（IM 轮询现场码，HTTP 400）
  1069603, // 云文档权限被拒（doc-comment 唯一有实测证据的 drive 权限码，见 DocSubscriptionPermissionError）
]);

/**
 * 轮询链路会撞到的其它已知瞬时代码（api-gate 的发送侧限流码之外）。
 * 注意 99991663 语义随语境变化（发送侧当限流重试、setup 侧当凭据无效），
 * 对轮询一律按瞬时：它是应用级状态，绝不能按 per-key 永久错误逐个目标熔断。
 */
const TRANSIENT_POLL_CODES: ReadonlySet<number> = new Set([
  99991401, // 系统繁忙
  99991500, // 服务内部错误
  99991661, // 频率限制
  99991662, // 频率限制
  99991663, // 语境敏感（限流/凭据），轮询按瞬时，避免误熔断与告警风暴
  99991665, // app_ticket 拉取暂时失败
]);

type ErrorShape = {
  message?: unknown;
  response?: { status?: unknown; data?: { code?: unknown } };
  status?: unknown;
  httpStatus?: unknown;
  larkCode?: unknown;
} | null | undefined;

/**
 * 从任意抛出值中尽力提取飞书业务码与 HTTP 状态。不抛异常。
 */
export function extractLarkErrorShape(err: unknown): {
  larkCode?: number;
  httpStatus?: number;
  message: string;
} {
  const e = err as ErrorShape;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  // 业务码先走 lark-errors 的归一提取（response.data.code → err.code →
  // message 内 "(code: N)"），再补 doc-comment 错误类自定义的 larkCode 字段
  // （它们的 message 用全角括号，ASCII 正则匹配不到）。
  let larkCode = extractLarkBusinessCode(err);
  if (larkCode === undefined) {
    const fieldCode = e?.larkCode;
    if (typeof fieldCode === 'number') larkCode = fieldCode;
  }
  // HTTP 状态：axios 在 response.status；doc-comment 错误类直接挂 httpStatus。
  let httpStatus: number | undefined;
  const rawStatus = e?.response?.status ?? e?.status ?? e?.httpStatus;
  if (typeof rawStatus === 'number') httpStatus = rawStatus;
  return { larkCode, httpStatus, message };
}

function transient(shape: { larkCode?: number; httpStatus?: number; message: string }): ClassifiedLarkError {
  return { classification: 'transient', ...shape };
}

function permanent(shape: { larkCode?: number; httpStatus?: number; message: string }): ClassifiedLarkError {
  return { classification: 'permanent', ...shape };
}

/**
 * 分类一个错误。未知错误按瞬时处理（重试安全），由调用方的连续失败上限兜底；
 * 只有高置信度的永久码/HTTP 状态才会熔断，避免误杀。
 *
 * 401 不进永久：它表示应用级凭据失效（对所有目标同时失败），per-key 熔断会
 * 让每个目标各告警一次形成告警风暴；按瞬时处理并保留原有 warn 日志。
 */
export function classifyLarkError(err: unknown): ClassifiedLarkError {
  const shape = extractLarkErrorShape(err);
  const { larkCode, httpStatus } = shape;

  if (larkCode !== undefined) {
    if (PERMANENT_TARGET_CODES.has(larkCode)) return permanent(shape);
    if (TRANSIENT_LARK_CODES.has(larkCode) || TRANSIENT_POLL_CODES.has(larkCode)) {
      return transient(shape);
    }
  }
  if (httpStatus !== undefined) {
    if (httpStatus === 429 || httpStatus >= 500) return transient(shape);
    // 404/410：轮询目标资源（群/文档）已删除；403：对该目标失权。
    // 均为 per-target 永久失败（重新授权/被拉回后由慢探测恢复）。
    if (httpStatus === 404 || httpStatus === 410 || httpStatus === 403) return permanent(shape);
    // 400/401 等其它 4xx：可能是应用级凭据/参数问题，不按目标永久失败熔断。
  }
  return transient(shape);
}
