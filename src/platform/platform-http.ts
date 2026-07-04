// 平台 HTTP 请求助手：支持强制 IP 协议族（family 4/6）的 JSON POST。
// 不用全局 fetch（undici）是因为它不透传 family、也不做 happy-eyeballs——
// IPv4 路由黑洞的机器上会直接 "fetch failed"；node:http(s) 的 family 选项
// 走 dns.lookup 单协议族解析，能确定性地把连接钉在 IPv4 或 IPv6 上。
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export interface PostJsonResult {
  status: number;
  json: unknown;
}

export interface PostJsonOptions {
  /** 强制 IP 协议族：4 / 6；缺省跟随系统默认解析（含 net 层 happy-eyeballs）。 */
  family?: 4 | 6;
  timeoutMs?: number;
}

export function postJson(url: string, body: unknown, opts: PostJsonOptions = {}): Promise<PostJsonResult> {
  const { family, timeoutMs = 10_000 } = opts;
  const u = new URL(url);
  const doRequest = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        family,
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* 非 JSON 响应按空对象处理，调用方看 status */
          }
          resolve({ status: res.statusCode || 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`连接超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end(payload);
  });
}
