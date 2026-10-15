/**
 * Dependency-free no-body GET helper for the Lark OpenAPI (see larkGet below).
 * Kept out of client.ts so lightweight modules (setup/owner-identity.ts) can
 * share it without pulling in the bot registry / config graph.
 */
export type LarkRequestParams = Record<string, string | number | boolean | undefined>;

export interface LarkRequestOptions {
  /** Axios 层的真实请求超时；不设置时保持 SDK 原有行为。 */
  timeoutMs?: number;
  /** 透传给 Axios，用于在上层截止时间到达时主动取消网络请求。 */
  signal?: AbortSignal;
}

export function larkRequestDeadline(options?: LarkRequestOptions): {
  timeout?: number;
  signal?: AbortSignal;
} {
  const timeout = options?.timeoutMs;
  return {
    ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? { timeout: Math.max(1, Math.floor(timeout)) }
      : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

/**
 * Call a Feishu GET endpoint without a request body.
 *
 * The official SDK currently lets axios attach `{}` as `data` for generated
 * GET calls such as im.v1.message.list/get, im.v1.chat.get/list,
 * im.v1.chatMembers.isInChat and contact.v3.user.get. Some gateway
 * deployments reject GET-with-body and return HTTP 411 before the OpenAPI
 * handler sees the request. The SDK's generic `client.request()` contains an
 * explicit GET empty-body guard (`fix: #153`) while still using the SDK's
 * token/cache/auth plumbing, so route every read-only GET through it.
 *
 * `url` is the API path (e.g. `/open-apis/im/v1/chats/<id>`); path params must
 * already be interpolated by the caller. Returns the parsed JSON body
 * (`{ code, msg, data }`), identical to the generated method's resolved value.
 */
export async function larkGet(
  c: any,
  url: string,
  params: LarkRequestParams = {},
  options?: LarkRequestOptions,
): Promise<any> {
  return c.request({
    method: 'GET',
    url,
    params,
    ...larkRequestDeadline(options),
  });
}
