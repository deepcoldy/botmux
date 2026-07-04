// test/platform-http-family.test.ts
// postJson：平台 HTTP 助手的 IP 协议族强制路由——family 6 只走 IPv6、family 4 只走 IPv4。
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import { postJson } from '../src/platform/platform-http.js';

function listen(host: string): Promise<{ server: Server; port: number } | null> {
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
    server.listen(0, host, () => {
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

describe('postJson IP 协议族', () => {
  it('基本收发：POST JSON 并解析响应', async () => {
    const srv = await listen('127.0.0.1');
    expect(srv).not.toBeNull();
    servers.push(srv!.server);
    const res = await postJson(`http://127.0.0.1:${srv!.port}/api/bind`, { code: 'x' });
    expect(res.status).toBe(200);
    expect((res.json as { echo: { code: string } }).echo.code).toBe('x');
  });

  it('family: 6 不会连到仅监听 IPv4 的服务（强制走 IPv6）', async () => {
    const srv = await listen('127.0.0.1');
    expect(srv).not.toBeNull();
    servers.push(srv!.server);
    // localhost 的 IPv6 解析结果是 ::1（或解析失败），都到不了 127.0.0.1 上的服务
    await expect(postJson(`http://localhost:${srv!.port}/api/bind`, {}, { family: 6 })).rejects.toThrow();
  });

  it.skipIf(!canV6)('family: 6 能连到仅监听 ::1 的服务（IPv4 服务不存在时的兜底路径）', async () => {
    const res = await postJson(`http://localhost:${v6Server!.port}/api/bind`, { code: 'y' }, { family: 6 });
    expect(res.status).toBe(200);
    expect((res.json as { echo: { code: string } }).echo.code).toBe('y');
  });
});
