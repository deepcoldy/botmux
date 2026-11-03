export interface DashboardApiResult<T = any> {
  status: number;
  body: T;
}

/** 响应体按 JSON 读；非 JSON / 空体当 `{}`，调用方可以放心 `body.xxx`。 */
export async function readJson<T = any>(response: Response): Promise<T> {
  return response.json().catch(() => ({} as T));
}

export async function jget<T = any>(url: string): Promise<DashboardApiResult<T>> {
  const response = await fetch(url);
  return { status: response.status, body: await readJson<T>(response) };
}

export async function jsend<T = any>(
  method: string,
  url: string,
  body?: unknown,
): Promise<DashboardApiResult<T>> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await readJson<T>(response) };
}

export const jpost = <T = any>(url: string, body?: unknown): Promise<DashboardApiResult<T>> =>
  jsend<T>('POST', url, body);

export const jput = <T = any>(url: string, body: unknown): Promise<DashboardApiResult<T>> =>
  jsend<T>('PUT', url, body);

/** {@link sendJson} 的返回形状：`ok` 已把「HTTP 2xx」与「body.ok !== false」合在一起。 */
export interface DashboardJsonResponse<T = any> {
  ok: boolean;
  status: number;
  body: T;
}

/**
 * 发 JSON 请求，**不抛错**：失败也以 `{ ok: false, status, body }` 返回，由调用方决定怎么展示。
 * 与 {@link jsend} 的区别：多一个合并后的 `ok`（HTTP 非 2xx 或 body 里显式 `ok:false` 都算失败），
 * 且只在 `body === undefined` 时才不带请求体（`jsend` 对任何 falsy 都不带）。
 */
export async function sendJson<T = any>(
  method: string,
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<DashboardJsonResponse<T>> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await readJson<any>(response);
  return { ok: response.ok && parsed?.ok !== false, status: response.status, body: parsed };
}

/** {@link requestJson} 失败时抛出的错误，带上 HTTP 状态与已解析的响应体供调用方分支。 */
export class DashboardRequestError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'DashboardRequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 发请求并返回已解析的响应体；HTTP 非 2xx 或 body 里显式 `ok:false` 时**抛**
 * {@link DashboardRequestError}（message 取 `body.error`，缺省 `HTTP <status>`）。
 * 有请求体且调用方没给 content-type 时补 `application/json`。
 */
export async function requestJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  const body = await readJson<any>(response);
  if (!response.ok || body?.ok === false) {
    throw new DashboardRequestError(body?.error || `HTTP ${response.status}`, response.status, body);
  }
  return body as T;
}
