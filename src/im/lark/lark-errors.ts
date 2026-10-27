/**
 * 飞书业务错误码的单一来源：具名常量、带结构化 `code` 的错误类型、统一的
 * 错误码提取函数。
 *
 * 历史包袱：client.ts 的 `res.code !== 0` 分支只把业务码拼进 message 字符串
 * （`... (code: NNN)`），下游（api-gate / ask-card / card-image-fallback）不得不用
 * 正则从 message 尾部反解。{@link LarkApiError} 在保持 message 逐字不变的同时把
 * 码挂到 `.code` 上——仍按正则解析的老调用点（以及构造 plain Error 的测试）照常
 * 工作，新调用点可以直接读结构化字段。
 *
 * 本文件零 import（叶子模块），任何层都可以依赖，不会引入环。
 */

// ─── 具名业务码 ───────────────────────────────────────────────────────────────

/** 应用身份（tenant_access_token）缺少接口所需 scope：Access denied，常见于
 *  admin:app.info:readonly / contact:user.base:readonly / im:chat.* 未开通。 */
export const LARK_CODE_APP_SCOPE_MISSING = 99991672;
/** 用户身份（user_access_token）缺少 scope（响应里带结构化 missing_scopes）。 */
export const LARK_CODE_USER_SCOPE_MISSING = 99991679;
/** 通用 OpenAPI 频控（新网关 = HTTP 429，老网关 = HTTP 400）。 */
export const LARK_CODE_FREQUENCY_LIMITED = 99991400;
/** open_id 属于另一个飞书应用（app-scoped），换用同一应用重试永远修不好。 */
export const LARK_CODE_CROSS_APP_OPEN_ID = 99992361;
/** Contact API：参数非法 / 无此用户（确定性失败）。 */
export const LARK_CODE_CONTACT_INVALID_PARAM = 40001;
export const LARK_CODE_CONTACT_NO_SUCH_USER = 41012;
/** Contact API：目标用户在本应用通讯录可见范围之外。 */
export const LARK_CODE_CONTACT_NOT_VISIBLE = 41050;

/** 消息 API 内部错误；合并转发请求 user_card_content 时可触发。 */
export const LARK_CODE_MESSAGE_INTERNAL_ERROR = 2200;
/** 目标消息已撤回。 */
export const LARK_CODE_MESSAGE_WITHDRAWN = 230011;
/** 消息超出可编辑时限（仍存在，只是不能再 PATCH）。 */
export const LARK_CODE_MESSAGE_UPDATE_EXPIRED = 230031;
/** 消息正在发送中——官方口径「请重试」。 */
export const LARK_CODE_MESSAGE_BEING_SENT = 230049;
/** 消息 API 单会话频控。 */
export const LARK_CODE_CHAT_RATE_LIMITED = 230020;
/** 卡片内容被拒（含 ErrCode 200570 的无效图片 key 子类，见 card-image-fallback）。 */
export const LARK_CODE_CARD_CONTENT_REJECTED = 230099;
/** 消息内容超出长度上限（"The length of the message content reaches its limit."），
 *  同一份内容重试永远发不出去。 */
export const LARK_CODE_MESSAGE_CONTENT_TOO_LONG = 230025;
/** ephemeral/v1/send 的目标是话题群 / thread 会话（临时卡片只支持普通 group）。 */
export const LARK_CODE_EPHEMERAL_NOT_GROUP = 18053;

// ─── Contact API 确定性失败分类 ──────────────────────────────────────────────

/** Contact API 单查端点「重试也不会变」的失败类别：
 *  cross_app=99992361 标识属于其他应用；not_visible=41050 目标不在本应用通讯录
 *  可见范围；invalid_id=41012 无此用户 / 40001 参数非法。其余非零码
 *  （如 40003 internal error、99991400 频控）与网络异常不在此列，必须保持可重试。
 *  该分类同时适用两种返回形状：HTTP 200 body 里的 `res.code`，以及 SDK（axios）
 *  非 2xx 抛出异常时 `err.response.data.code`——catch 分支需先用
 *  {@link structuredLarkCode} 取码再分类。 */
export type DefinitiveContactErrorCode = 'cross_app' | 'not_visible' | 'invalid_id';

/** Contact API 确定性失败码 → 类别；非确定性码 / undefined → undefined（可重试）。 */
export function classifyContactErrorCode(code: number | undefined): DefinitiveContactErrorCode | undefined {
  if (code === LARK_CODE_CROSS_APP_OPEN_ID) return 'cross_app';
  if (code === LARK_CODE_CONTACT_NOT_VISIBLE) return 'not_visible';
  if (code === LARK_CODE_CONTACT_NO_SUCH_USER || code === LARK_CODE_CONTACT_INVALID_PARAM) return 'invalid_id';
  return undefined;
}

// ─── 带结构化 code 的错误类型 ────────────────────────────────────────────────

/**
 * 飞书 HTTP 200 + `res.code !== 0` 时抛出的业务错误。
 *
 * - `message` 与历史上的 `new Error('Failed to …: <msg> (code: N)')` 逐字一致，
 *   仍按 `(code: N)` 尾部正则解析的调用点（api-gate / ask-card / card-image-fallback
 *   及测试里手搓的 plain Error）不受影响。
 * - `code` 是结构化业务码；`larkMsg` 是飞书返回的原始 msg（未拼前缀）。
 */
export class LarkApiError extends Error {
  readonly code: number | undefined;
  readonly larkMsg: string | undefined;

  constructor(message: string, code?: unknown, larkMsg?: unknown) {
    super(message);
    this.name = 'LarkApiError';
    this.code = typeof code === 'number' ? code : undefined;
    this.larkMsg = typeof larkMsg === 'string' ? larkMsg : undefined;
  }
}

/**
 * 由 `res.code !== 0` 的响应构造 {@link LarkApiError}，message 形如
 * `Failed to <action>: <msg> (code: <code>)`。
 *
 * `msgFallback` 仅在 `res.msg` 为 null/undefined 时替代它（urgent 用 `''`、
 * pins 用 `'unknown error'`）；不传则按模板字符串原样插值 `res.msg`（缺失时是
 * 字面量 "undefined"——历史行为，故意保留）。
 */
export function larkApiError(
  action: string,
  res: { code?: unknown; msg?: unknown } | null | undefined,
  msgFallback?: string,
): LarkApiError {
  const msg = msgFallback === undefined ? res?.msg : (res?.msg ?? msgFallback);
  return new LarkApiError(`Failed to ${action}: ${msg} (code: ${res?.code})`, res?.code, res?.msg);
}

// ─── 错误码提取 ──────────────────────────────────────────────────────────────

type ErrorLike = {
  response?: { data?: { code?: unknown } };
  code?: unknown;
  message?: unknown;
} | null | undefined;

/** 结构化业务码：axios `response.data.code`，缺省取顶层 `code`；非 number 一律
 *  视为没有（`'ENOENT'` 之类的字符串错误码不是飞书业务码）。 */
export function structuredLarkCode(err: unknown): number | undefined {
  const e = err as ErrorLike;
  const code = e?.response?.data?.code ?? e?.code;
  return typeof code === 'number' ? code : undefined;
}

/** 从文本里反解 `(code: NNN)`——200 + `res.code !== 0` 的历史抛错只把业务码写进了
 *  message 字符串。取首个匹配。 */
export function larkCodeFromMessage(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  const m = /\(code:\s*(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** message 里是否带有指定业务码的 `(code: N)` 标记（出现在任意位置即可）。 */
export function messageHasLarkCode(message: unknown, code: number): boolean {
  return typeof message === 'string' && new RegExp(`\\(code:\\s*${code}\\)`).test(message);
}

/**
 * 提取 Lark 业务码：结构化 code 优先（有限数），回落 message 尾部 `(code: NNN)`。
 * 覆盖 axios `response.data.code` / 顶层 `code` / {@link LarkApiError} / 历史 plain
 * Error 四种形态。
 */
export function extractLarkBusinessCode(err: unknown): number | undefined {
  const structured = structuredLarkCode(err);
  if (structured !== undefined && Number.isFinite(structured)) return structured;
  return larkCodeFromMessage((err as ErrorLike)?.message);
}
