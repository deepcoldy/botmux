/**
 * Dashboard 转发看板附件：说明页的响应头由 Dashboard 自己写（上游漏了或放宽了 CSP 也照样套上 sandbox），
 * 视频把单段 Range 转给 daemon、把 206 / 416 和 Content-Range 原样带回来；没要 Range 时按块从 daemon 拿、
 * 拼成整份 200（浏览器读得慢就等、断开就停）；截图和报错照旧。
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleDecisionBoardApi, type DecisionBoardApiDeps } from '../src/dashboard/decision-board-api.js';
import { BOARD_HTML_CSP } from '../src/core/decision-board/files.js';

const FILE = '/api/decision-board/cli_s/files/abcdef1234567890';
let server: Server;
let port: number;
let upstream: (path: string, init: RequestInit) => Response;
let forwarded: Array<{ path: string; init: RequestInit }>;

beforeEach(async () => {
  forwarded = [];
  const deps: DecisionBoardApiDeps = {
    identity: null,
    canManageHost: true,
    proxyToDaemon: async (_app, path, init) => { forwarded.push({ path, init }); return upstream(path, init); },
    bots: () => [{ larkAppId: 'cli_s', botName: '管家', steward: { enabled: true, chatId: 'oc_s' }, online: true }],
    readJsonBody: async () => ({}),
  };
  server = createServer((req, res) => { void handleDecisionBoardApi(req, res, new URL(req.url!, 'http://x'), deps); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const get = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${FILE}`, { headers });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const forwardedRange = (i: number) => new Headers(forwarded[i]!.init.headers).get('range');

/** 假 daemon：按 `bytes=N-` 每次最多回 chunk 字节的 206，内容由 body(起点, 长度) 给出。 */
function chunkedDaemon(size: number, chunk: number, body: (start: number, length: number) => Buffer) {
  upstream = (_path, init) => {
    const m = /^bytes=(\d+)-$/.exec(new Headers(init.headers).get('range') ?? '');
    if (!m) throw new Error(`unexpected range ${new Headers(init.headers).get('range')}`);
    const start = Number(m[1]);
    const end = Math.min(size, start + chunk) - 1;
    return new Response(body(start, end - start + 1), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' },
    });
  };
}

const pattern = (start: number, length: number) => Buffer.from(Array.from({ length }, (_, i) => ((start + i) * 7) % 256));

/** 用 node:http 取：响应头到了就返回，正文读不读由用例决定。 */
function openRaw(): Promise<{ res: IncomingMessage; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: FILE }, res => resolve({ res, abort: () => req.destroy() }));
    req.on('error', err => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    req.end();
  });
}

describe('说明页', () => {
  it.each([
    ['上游没带 CSP', {}],
    ['上游放宽了 CSP', { 'content-security-policy': 'sandbox allow-scripts allow-same-origin' }],
  ])('%s：Dashboard 照样套上 sandbox，按 UTF-8 HTML 回', async (_label, extra) => {
    upstream = () => new Response('<h1>说明</h1>', { headers: { 'content-type': 'text/html', ...extra } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(BOARD_HTML_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe('<h1>说明</h1>');
  });
});

describe('视频', () => {
  it('Range 转给 daemon，206 和 Content-Range 原样带回，正文完整', async () => {
    const part = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 256));
    upstream = () => new Response(part, {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 1000-300999/5000000', 'content-length': String(part.length), 'accept-ranges': 'bytes' },
    });
    const res = await get({ range: 'bytes=1000-' });
    expect(new Headers(forwarded[0]!.init.headers).get('range')).toBe('bytes=1000-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 1000-300999/5000000');
    expect(res.headers.get('content-length')).toBe(String(part.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer()).equals(part)).toBe(true);
  });

  it('越界的 416 原样带回', async () => {
    upstream = () => new Response(null, { status: 416, headers: { 'content-type': 'video/webm', 'content-range': 'bytes */10' } });
    const res = await get({ range: 'bytes=99-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it.each([
    ['不带 Range', {}],
    ['多段 Range', { range: 'bytes=0-1,5-9' }],
    ['别的单位', { range: 'items=0-5' }],
    ['起点大于终点', { range: 'bytes=9-1' }],
    ['超长的 Range 头', { range: `bytes=0-${' '.repeat(300)}1` }],
  ])('%s：按块从 daemon 拿，拼成整份 200', async (_label, headers) => {
    const size = 10_000;
    chunkedDaemon(size, 3000, pattern);
    const res = await get(headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(size));
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer()).equals(pattern(0, size))).toBe(true);
    expect(forwarded.map((_, i) => forwardedRange(i))).toEqual(['bytes=0-', 'bytes=3000-', 'bytes=6000-', 'bytes=9000-']);
  });

  it('浏览器读得慢就等、断开就停：不会把整份从 daemon 拉进内存', async () => {
    const chunk = 1024 * 1024;
    const chunks = 64;
    chunkedDaemon(chunks * chunk, chunk, (start, length) => Buffer.alloc(length, start / chunk));
    const { res, abort } = await openRaw();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(chunks * chunk));
    res.pause();
    await sleep(500);
    const whilePaused = forwarded.length;
    expect(whilePaused).toBeLessThan(chunks / 2);

    abort();
    await sleep(300);
    expect(forwarded.length).toBeLessThanOrEqual(whilePaused + 1);
  });

  it('上游的第一块不对回 502；中途哪块对不上就断开，不拼出错的文件', async () => {
    upstream = () => new Response(Buffer.from('webm!'), { headers: { 'content-type': 'video/webm', 'content-length': '5' } });
    const whole = await get();
    expect(whole.status).toBe(502);
    expect(await whole.json()).toMatchObject({ ok: false });

    upstream = () => new Response(Buffer.from('xy'), { status: 206, headers: { 'content-type': 'video/webm', 'content-range': 'bytes 5-6/10' } });
    expect((await get()).status).toBe(502);

    let calls = 0;
    upstream = () => {
      calls += 1;
      const [start, end] = calls === 1 ? [0, 4] : [6, 9];
      return new Response(Buffer.alloc(end - start + 1), { status: 206, headers: { 'content-type': 'video/webm', 'content-range': `bytes ${start}-${end}/10` } });
    };
    const outcome = await get().then(r => r.arrayBuffer()).then(() => 'complete', () => 'aborted');
    expect(outcome).toBe('aborted');
    expect(calls).toBe(2);
  });
});

describe('截图和报错照旧', () => {
  it('截图不带 CSP；报错按 JSON 回', async () => {
    upstream = () => new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } });
    const img = await get();
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-security-policy')).toBeNull();
    expect(img.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');

    upstream = () => new Response(JSON.stringify({ ok: false, error: 'file_not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const missing = await get();
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(await missing.json()).toEqual({ ok: false, error: 'file_not_found' });
  });

  it('上游的 HTML 报错页不会被当成说明页渲染', async () => {
    upstream = () => new Response('<h1>oops</h1>', { status: 500, headers: { 'content-type': 'text/html' } });
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});
