/**
 * 飞书开放平台错误分类。
 *
 * 周期任务必须能区分两类失败，否则一个永久错误（bot 被移出群、文档被删、
 * 权限被收回）会被当成瞬时抖动以固定间隔无限重试——message-listener 曾对
 * 230002 空转 19 天约 11 万次。
 *
 * 错误可能以两种形态到达调用方：
 *  1. HTTP 非 2xx：axios error，业务码在 `err.response.data.code`，HTTP 状态在
 *     `err.response.status`（230002 现场即此形态：HTTP 400）。
 *  2. HTTP 200 但业务 code!=0：各原语抛出的普通 Error，code 只在 message
 *     文本 "(code: 230002)" 里。
 * 本模块把两种形态归一为带分类的 LarkApiError。
 */

export type LarkErrorClass = 'permanent' | 'transient';

export class LarkApiError extends Error {
  readonly larkCode: number | undefined;
  readonly httpStatus: number | undefined;
  readonly classification: LarkErrorClass;
  /** 永久错误是否可能因重新授权/被重新拉入而恢复（用于决定是否保留慢探测）。 */
  readonly rejoinable: boolean;

  constructor(params: {
    message: string;
    larkCode?: number;
    httpStatus?: number;
    classification: LarkErrorClass;
    rejoinable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'LarkApiError';
    this.larkCode = params.larkCode;
    this.httpStatus = params.httpStatus;
    this.classification = params.classification;
    this.rejoinable = params.rejoinable ?? false;
  }
}

/** 高置信度的永久业务码：在同一资源目标上重试不会自愈。 */
const PERMANENT_CODES: ReadonlySet<number> = new Set([
  230002, // Bot/User can NOT be out of the chat（被移出群/群解散）
  230020, // chat_id 不存在
  230031, // 卡片已过期（继续 PATCH 同一卡片无意义）
  99991400, // 非法请求（参数结构性错误）
  99991663, // tenant access token 无效（应用被停用/删除）
  99991671, // invalid app access token
  99991673, // app token 未授权（缺权限不会自动补齐）
  1254000, // 文档/节点不存在
  1254003, // 无文档权限
  1254030, // node 不存在
]);

/** 瞬时业务码：稍等重试即可恢复。 */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  99991409, // 频率限制（部分接口）
  99991661, // 频率限制
  99991662, // 频率限制
  99991665, // app_ticket 拉取暂时失败
  99991401, // 系统繁忙
  99991500, // 服务内部错误
]);

const CODE_IN_MESSAGE = /code:\s*(\d+)/i;
const CODE_IN_BRACKETS = /\((\d{6,})\)/;

/**
 * 从任意抛出值中尽力提取飞书业务码与 HTTP 状态。不抛异常。
 */
export function extractLarkErrorShape(err: unknown): {
  larkCode?: number;
  httpStatus?: number;
  message: string;
} {
  if (err instanceof LarkApiError) {
    return { larkCode: err.larkCode, httpStatus: err.httpStatus, message: err.message };
  }
  const e = err as {
    message?: string;
    response?: { status?: number; data?: { code?: number; msg?: string } };
    status?: number;
    code?: number | string;
  } | null | undefined;
  const message = e?.message ?? String(err);
  const httpStatus = e?.response?.status ?? e?.status;
  const dataCode = e?.response?.data?.code;
  let larkCode = typeof dataCode === 'number' ? dataCode : undefined;
  if (larkCode === undefined && typeof e?.code === 'number') larkCode = e.code;
  if (larkCode === undefined) {
    const m = CODE_IN_MESSAGE.exec(message) ?? CODE_IN_BRACKETS.exec(message);
    if (m) larkCode = Number(m[1]);
  }
  return { larkCode, httpStatus, message };
}

/**
 * 分类一个错误。未知错误按瞬时处理（重试安全），由调用方的连续失败上限兜底；
 * 只有高置信度的永久码/HTTP 状态才会熔断，避免误杀。
 */
export function classifyLarkError(err: unknown): LarkApiError {
  if (err instanceof LarkApiError) return err;
  const { larkCode, httpStatus, message } = extractLarkErrorShape(err);

  if (larkCode !== undefined && PERMANENT_CODES.has(larkCode)) {
    const rejoinable = larkCode === 230002;
    return new LarkApiError({
      message,
      larkCode,
      httpStatus,
      classification: 'permanent',
      rejoinable,
      cause: err,
    });
  }
  if (larkCode !== undefined && TRANSIENT_CODES.has(larkCode)) {
    return new LarkApiError({ message, larkCode, httpStatus, classification: 'transient', cause: err });
  }
  if (httpStatus !== undefined) {
    if (httpStatus === 429 || httpStatus >= 500) {
      return new LarkApiError({ message, larkCode, httpStatus, classification: 'transient', cause: err });
    }
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404 || httpStatus === 410) {
      return new LarkApiError({
        message,
        larkCode,
        httpStatus,
        classification: 'permanent',
        rejoinable: httpStatus === 403,
        cause: err,
      });
    }
  }
  const name = (err as { name?: string } | null)?.name;
  if (name === 'MessageWithdrawnError') {
    return new LarkApiError({ message, larkCode, httpStatus, classification: 'permanent', cause: err });
  }
  return new LarkApiError({ message, larkCode, httpStatus, classification: 'transient', cause: err });
}
