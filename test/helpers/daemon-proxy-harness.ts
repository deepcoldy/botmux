/**
 * Harness for driving `handleDaemonProxyRoute` (src/dashboard/daemon-proxy-routes.ts)
 * without a real HTTP server: a fake request stream, a recording response, and a
 * recording `proxyToDaemon`.
 *
 * `readJsonBody` here is a minimal stand-in with the same contract as the one in
 * src/dashboard.ts (which cannot be imported — that module starts the server):
 * over `maxBytes` → throws {@link FakeBodyTooLarge}, unparsable → SyntaxError,
 * empty → `{}`.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BOT_PROXY_ROUTES,
  handleDaemonProxyRoute,
  type DaemonProxyDeps,
  type ProxyMethod,
  type ProxyRoute,
} from '../../src/dashboard/daemon-proxy-routes.js';

export class FakeBodyTooLarge extends Error {}

export async function fakeReadJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.byteLength;
    if (maxBytes !== undefined && total > maxBytes) throw new FakeBodyTooLarge('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export interface ProxyCall {
  appId: string;
  path: string;
  init: RequestInit;
}

export interface ProxyRunResult {
  handled: boolean;
  /** `res.writeHead` 的 [status, headers]；未命中时为 undefined。 */
  head?: [number, Record<string, string>];
  /** `res.end` 收到的正文。 */
  body?: string;
  proxyCalls: ProxyCall[];
  /** handler 抛出的错误（不会向外 reject，便于同时检查抛出前已写出的 head / 已读的 body）。 */
  error?: unknown;
  /** 请求流是否已被读取（命中且需要 body 的路由才会读）。 */
  bodyConsumed: boolean;
}

export interface ProxyRunOptions {
  method: string;
  /** pathname 加可选 query，如 `/api/bots/cli_a/feedback/effective?chatId=oc_1`。 */
  url: string;
  /** 请求 body：字符串按 utf8 作为单个 chunk；数组按多个 chunk 依次送出。 */
  body?: string | Buffer | Buffer[];
  /** 上游 daemon 的响应；缺省 `200 {"ok":true}`。传函数可抛错。 */
  upstream?: Response | ((call: ProxyCall) => Response | Promise<Response>);
  routes?: readonly ProxyRoute[];
}

export async function runProxyRoute(opts: ProxyRunOptions): Promise<ProxyRunResult> {
  const parts: Buffer[] = opts.body === undefined
    ? []
    : Array.isArray(opts.body)
      ? opts.body
      : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8')];
  const req = Readable.from(parts, { objectMode: false }) as unknown as IncomingMessage;
  (req as { method?: string }).method = opts.method;
  (req as { headers?: Record<string, string> }).headers = {};

  const result: ProxyRunResult = { handled: false, proxyCalls: [], bodyConsumed: false };
  const res = {
    writeHead(status: number, headers: Record<string, string>) { result.head = [status, headers]; return this; },
    end(body?: string) { result.body = body; return this; },
  } as unknown as ServerResponse;

  const deps: DaemonProxyDeps = {
    async proxyToDaemon(appId, path, init) {
      const call = { appId, path, init };
      result.proxyCalls.push(call);
      if (typeof opts.upstream === 'function') return opts.upstream(call);
      return opts.upstream ?? new Response('{"ok":true}', { status: 200 });
    },
    readJsonBody: fakeReadJsonBody,
    isBodyTooLarge: err => err instanceof FakeBodyTooLarge,
  };

  try {
    result.handled = await handleDaemonProxyRoute(
      opts.routes ?? BOT_PROXY_ROUTES,
      req,
      res,
      new URL(opts.url, 'http://dashboard.test'),
      deps,
    );
  } catch (error) {
    result.error = error;
  }
  // 读到底 → readableEnded；超限提前 return → for-await 销毁流 → destroyed。两者任一即「被读取过」。
  const stream = req as unknown as Readable;
  result.bodyConsumed = stream.readableEnded || stream.destroyed;
  return result;
}

/** 按 method + pathname 找表里第一条命中的路由（只用于断言「表里存在等价条目」）。 */
export function proxyRouteFor(method: ProxyMethod, pathname: string): ProxyRoute | undefined {
  return BOT_PROXY_ROUTES.find(route => route.method === method && route.path.test(pathname));
}

/** 解析某条路由对给定 pathname/query 实际会转发到的上游路径。 */
export function resolveUpstream(route: ProxyRoute, pathname: string, search = ''): string {
  if (typeof route.upstream === 'string') return route.upstream;
  const match = pathname.match(route.path);
  if (!match) throw new Error(`route does not match ${pathname}`);
  return route.upstream(match, new URL(`${pathname}${search}`, 'http://dashboard.test'));
}
