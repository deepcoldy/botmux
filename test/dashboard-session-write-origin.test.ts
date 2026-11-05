import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionWriteOriginAllowed } from '../src/dashboard/session-write-origin.js';

let server: Server;
let base: string;
let reached: string[];

beforeEach(async () => {
  reached = [];
  server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    if (!sessionWriteOriginAllowed(req, url.pathname)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'control_origin_forbidden' }));
      return;
    }
    reached.push(`${req.method} ${url.pathname}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const writes = ['trigger-result/supersede', 'close', 'restart', 'rename', 'suspend', 'resume', 'start', 'lock', 'board', 'live-stage', 'turns/t1/interrupt'];
const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/sessions/s1/${path}`, { method: 'POST', headers });

describe('dashboard 会话写操作跨站 Origin 门禁', () => {
  it.each(writes)('%s：跨站与同站不同端口的 Origin 被拒，请求不会到达后面', async path => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:1', 'null']) {
      const res = await post(path, { origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'control_origin_forbidden' });
    }
    const site = await post(path, { 'sec-fetch-site': 'same-site' });
    expect(site.status).toBe(403);
    expect(reached).toEqual([]);
  });

  it.each(writes)('%s：同源放行', async path => {
    expect((await post(path, { origin: base })).status).toBe(200);
    expect((await post(path, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it.each(writes)('%s：没有任何来源信号的非浏览器调用保持放行', async path => {
    expect((await post(path)).status).toBe(200);
  });

  it.each(['cleanup-idle', 'create'])('会话集合级写接口 %s 同样被拦', async op => {
    const res = await fetch(`${base}/api/sessions/${op}`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/api/sessions/${op}`, { method: 'POST', headers: { origin: base } })).status).toBe(200);
    expect(reached).toEqual([`POST /api/sessions/${op}`]);
  });

  it.each(['cleanup-idle', 'create'])('会话集合级写接口 %s 同样被拦', async op => {
    const url = `${base}/api/sessions/${op}`;
    expect((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { origin: base } })).status).toBe(200);
    expect(reached).toEqual([`POST /api/sessions/${op}`]);
  });

  it('不影响 GET 与无关路径', async () => {
    const get = await fetch(`${base}/api/sessions/s1/close`, { headers: { origin: 'https://evil.example' } });
    expect(get.status).toBe(200);
    const other = await fetch(`${base}/api/other`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(other.status).toBe(200);
  });
});
