// test/platform-http-family.test.ts
// 平台 HTTP 助手的 IP 协议族强制路由——family 6 只走 IPv6、family 4 只走 IPv4。
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { getDefaultResultOrder, setDefaultResultOrder } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { getJson, postJson } from '../src/platform/platform-http.js';

function listen(host: string, port = 0): Promise<{ server: Server; port: number } | null> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
    });
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? { server, port: addr.port } : null);
    });
  });
}

// 环境探测：本机有 ::1 且 localhost 能解析出 IPv6 才跑「family 6 连通」正向用例
const v6Server = await listen('::1');
const v6Resolvable = await lookup('localhost', { family: 6 }).then(() => true, () => false);
const canV6 = Boolean(v6Server) && v6Resolvable;

const servers: Server[] = [];
afterAll(() => {
  if (v6Server) v6Server.server.close();
  for (const s of servers) s.close();
});

async function expectFamily6Route(
  request: (url: string) => Promise<unknown>,
): Promise<void> {
  const v4 = await listen('127.0.0.1');
  expect(v4).not.toBeNull();
  servers.push(v4!.server);

  let reachedV4 = 0;
  v4!.server.on('request', () => { reachedV4++; });

  // 能控制 ::1 同端口时，正向断言 family: 6 请求确实落到 IPv6，
  // 避免只数 IPv4 请求时在跨协议族端口号撞车窗口内漏掉回归。
  const v6 = v6Resolvable ? await listen('::1', v4!.port) : null;
  let reachedV6 = 0;
  if (v6) {
    servers.push(v6.server);
    v6.server.on('request', () => { reachedV6++; });
  }

  const previousOrder = getDefaultResultOrder();
  setDefaultResultOrder('ipv4first');
  try {
    await request(`http://localhost:${v4!.port}/api/bind`).catch(() => undefined);
  } finally {
    setDefaultResultOrder(previousOrder);
  }

  if (v6) expect(reachedV6).toBe(1);
  expect(reachedV4).toBe(0);
}

describe('platform HTTP IP 协议族', () => {
  it('基本收发：POST JSON 并解析响应', async () => {
    const srv = await listen('127.0.0.1');
    expect(srv).not.toBeNull();
    servers.push(srv!.server);
    const res = await postJson(`http://127.0.0.1:${srv!.port}/api/bind`, { code: 'x' });
    expect(res.status).toBe(200);
    expect((res.json as { echo: { code: string } }).echo.code).toBe('x');
  });

  it('postJson family: 6 只会连到 IPv6 服务', async () => {
    await expectFamily6Route(url => postJson(url, {}, { family: 6 }));
  });

  it('getJson family: 6 只会连到 IPv6 服务', async () => {
    await expectFamily6Route(url => getJson(url, { family: 6 }));
  });

  it.skipIf(!canV6)('family: 6 能连到仅监听 ::1 的服务（IPv4 服务不存在时的兜底路径）', async () => {
    const res = await postJson(`http://localhost:${v6Server!.port}/api/bind`, { code: 'y' }, { family: 6 });
    expect(res.status).toBe(200);
    expect((res.json as { echo: { code: string } }).echo.code).toBe('y');
  });
});
