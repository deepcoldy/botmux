import { createHash } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildReplayTerminalSrcdoc } from '../src/dashboard/web/v3-terminal.js';
import {
  WEB_TERMINAL_VENDOR_SCRIPTS,
  WEB_TERMINAL_VENDOR_STYLES,
  XTERM_VENDOR_ASSETS,
  XTERM_VENDOR_MARKER,
  xtermVendorDocumentWriteSource,
  type XtermVendorAsset,
} from '../src/core/xterm-vendor-assets.js';
import { XTERM_VENDOR_ASSET_DATA } from '../src/core/xterm-vendor-assets-data.js';
import { acceptsGzip, handleXtermVendorHttp } from '../src/core/xterm-vendor-serve.js';

// ── 真实 HTTP 服务：两种挂法与 worker / Dashboard 一致，没认领的请求落到「页面」 ──

interface Got { status: number; headers: IncomingHttpHeaders; body: Buffer }

function startServer(mode: 'root' | 'anyPrefix'): Promise<Server> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (handleXtermVendorHttp(req, res, pathname, mode)) return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!-- terminal page -->');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function get(server: Server, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Got> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const ALL_ASSETS: XtermVendorAsset[] = Object.values(XTERM_VENDOR_ASSETS);

let worker: Server;
let dashboard: Server;
beforeAll(async () => {
  worker = await startServer('anyPrefix');
  dashboard = await startServer('root');
});
afterAll(async () => {
  await Promise.all([worker, dashboard].map((s) => new Promise((r) => s.close(r))));
});

describe('worker 终端页的 xterm 组件由本进程提供', () => {
  // 三种入口到 worker 时看到的路径前缀：直连 worker 端口 / daemon 终端代理剥掉前缀后是 ''；
  // 平台与 Dashboard 前门原样转发 `/s/<会话>`；自建反代可能再多一段前缀。
  const PREFIXES = ['', '/s/sess-1', '/proxy/s/sess-1'];

  it.each(PREFIXES)('前缀 %j 下每个文件都能取到，gzip 解开后与内嵌原文一致', async (prefix) => {
    for (const a of ALL_ASSETS) {
      const res = await get(worker, `${prefix}${XTERM_VENDOR_MARKER}${a.path}`, { 'accept-encoding': 'gzip, deflate, br' });
      expect(res.status, a.path).toBe(200);
      expect(res.headers['content-type']).toBe(a.contentType);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['cache-control']).toContain('immutable');
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
      const raw = gunzipSync(res.body);
      expect(raw.length).toBe(XTERM_VENDOR_ASSET_DATA[a.path].bytes);
      expect(sha256(raw)).toBe(XTERM_VENDOR_ASSET_DATA[a.path].sha256);
    }
  });

  it('不接受 gzip 的客户端拿到原文；HEAD 只有头；带上 ETag 再取得 304', async () => {
    const path = `/s/sess-1${XTERM_VENDOR_MARKER}${XTERM_VENDOR_ASSETS.xterm.path}`;
    const identity = await get(worker, path);
    expect(identity.status).toBe(200);
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(sha256(identity.body)).toBe(XTERM_VENDOR_ASSET_DATA[XTERM_VENDOR_ASSETS.xterm.path].sha256);

    const refused = await get(worker, path, { 'accept-encoding': 'gzip;q=0, br' });
    expect(refused.headers['content-encoding']).toBeUndefined();
    expect(refused.body.equals(identity.body)).toBe(true);

    const head = await get(worker, path, { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);

    const etag = String(identity.headers.etag);
    const cached = await get(worker, path, { 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
  });

  it('标记下不在清单里的路径一律 404，不落回终端页；其它路径照常是终端页', async () => {
    for (const rel of ['xterm-5.5.0/xterm.js.map', '', 'xterm-5.5.0/', 'xterm-6.0.0/xterm.js', 'xterm-5.5.0/xterm.min.js']) {
      const res = await get(worker, `/s/sess-1${XTERM_VENDOR_MARKER}${rel}`);
      expect(res.status, rel).toBe(404);
      expect(res.body.toString()).not.toContain('terminal page');
    }
    const page = await get(worker, '/s/sess-1/?viewToken=abc');
    expect(page.body.toString()).toContain('terminal page');
    const post = await get(worker, `${XTERM_VENDOR_MARKER}${XTERM_VENDOR_ASSETS.xterm.path}`, {}, 'POST');
    expect(post.status).toBe(405);
  });
});

describe('Dashboard 只在根路径提供', () => {
  it('根路径取得到；/s/<会话>/ 下的同名路径不截胡，仍交给终端前门转发到 worker', async () => {
    const root = await get(dashboard, `${XTERM_VENDOR_MARKER}${XTERM_VENDOR_ASSETS.css.path}`);
    expect(root.status).toBe(200);
    expect(root.headers['content-type']).toBe('text/css; charset=utf-8');
    const underSession = await get(dashboard, `/s/sess-1${XTERM_VENDOR_MARKER}${XTERM_VENDOR_ASSETS.css.path}`);
    expect(underSession.body.toString()).toContain('terminal page');
  });

  it('v3 终端回放页引用的每个资源都由 Dashboard 提供，且不引用任何外部地址', async () => {
    const srcdoc = buildReplayTerminalSrcdoc('/api/v3/runs/r/nodes/n/pty-log', 'r / n');
    const refs = [...srcdoc.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gi)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, ref).toMatch(/^\//);
      expect(ref.startsWith('//'), ref).toBe(false);
      const res = await get(dashboard, ref, { 'accept-encoding': 'gzip' });
      expect(res.status, ref).toBe(200);
    }
  });
});

describe('内嵌的是完整可用的 xterm 组件', () => {
  it('内嵌数据与清单一一对应，每份解压后与记录的原文校验和一致', () => {
    expect(Object.keys(XTERM_VENDOR_ASSET_DATA).sort()).toEqual(ALL_ASSETS.map((a) => a.path).sort());
    for (const [path, d] of Object.entries(XTERM_VENDOR_ASSET_DATA)) {
      const raw = gunzipSync(Buffer.from(d.gzipBase64, 'base64'));
      expect(raw.length, path).toBe(d.bytes);
      expect(sha256(raw), path).toBe(d.sha256);
    }
  });

  it('按终端页的顺序执行这些脚本后，页面用到的全局构造器都在，且插件能装进 Terminal', async () => {
    // 按页面同样的顺序把实际发出去的脚本跑在一个空白全局环境里（UMD 包挂在 globalThis 上）。
    const sandbox: Record<string, unknown> = { navigator: { userAgent: '', platform: '' }, console };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    for (const a of WEB_TERMINAL_VENDOR_SCRIPTS) {
      const res = await get(worker, `/s/sess-1${XTERM_VENDOR_MARKER}${a.path}`);
      vm.runInContext(res.body.toString('utf8'), sandbox, { filename: a.path });
    }
    const probe = vm.runInContext(`(function(){
      var term=new Terminal({allowProposedApi:true});
      term.loadAddon(new FitAddon.FitAddon());
      term.loadAddon(new WebLinksAddon.WebLinksAddon());
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion='11';
      return {
        unicode:term.unicode.activeVersion,
        webgl:typeof WebglAddon.WebglAddon,
        canvas:typeof CanvasAddon.CanvasAddon
      };
    })()`, sandbox) as { unicode: string; webgl: string; canvas: string };
    expect(probe).toEqual({ unicode: '11', webgl: 'function', canvas: 'function' });
  });
});

// ── 页面侧加载器：在假的 location/document 里跑真正嵌进页面的那段源码 ──

interface Written { tag: string; url: string }

function runLoader(assets: readonly XtermVendorAsset[], loc: { protocol: string; host: string; pathname: string }): { html: string; refs: Written[] } {
  let html = '';
  const ctx = { location: loc, document: { write: (s: string) => { html += s; } } };
  vm.createContext(ctx);
  vm.runInContext(xtermVendorDocumentWriteSource(assets), ctx);
  const refs = [...html.matchAll(/<(script|link)\b([^>]*)>/gi)].map((m) => {
    const attr = /\b(?:src|href)="([^"]*)"/i.exec(m[2]);
    const url = (attr?.[1] ?? '').replace(/&#(\d+);/g, (_s, n: string) => String.fromCharCode(Number(n)));
    return { tag: m[1].toLowerCase(), url };
  });
  return { html, refs };
}

describe('终端页按自己的路径拼资源地址', () => {
  const scripts = WEB_TERMINAL_VENDOR_SCRIPTS;

  it.each([
    // [页面路径, 资源基址] —— 与 WebSocket 同一条规则：去掉结尾斜杠再接 /
    ['/', 'https://t.example/__botmux/vendor/'],
    ['/s/sess-1', 'https://t.example/s/sess-1/__botmux/vendor/'],
    ['/s/sess-1/', 'https://t.example/s/sess-1/__botmux/vendor/'],
    ['/s/sess-1//', 'https://t.example/s/sess-1/__botmux/vendor/'],
    ['/proxy/s/sess-1', 'https://t.example/proxy/s/sess-1/__botmux/vendor/'],
  ])('页面在 %j 时资源在 %s 下，且按依赖顺序写出', (pathname, base) => {
    const { refs } = runLoader(scripts, { protocol: 'https:', host: 't.example', pathname });
    expect(refs).toEqual(scripts.map((a) => ({ tag: 'script', url: `${base}${a.path}` })));
  });

  it('写出的地址经上面的 worker 路由都能取到', async () => {
    const { port } = worker.address() as AddressInfo;
    const { refs } = runLoader([...WEB_TERMINAL_VENDOR_STYLES, ...scripts], {
      protocol: 'http:', host: `127.0.0.1:${port}`, pathname: '/s/sess-1',
    });
    expect(refs.map((r) => r.tag)).toEqual(['link', ...scripts.map(() => 'script')]);
    for (const r of refs) {
      const res = await get(worker, new URL(r.url).pathname);
      expect(res.status, r.url).toBe(200);
    }
  });

  it('协议相对形状的路径（//evil.example/…）也只会从本站加载', () => {
    const { refs } = runLoader(scripts, { protocol: 'https:', host: 't.example', pathname: '//evil.example/x' });
    for (const r of refs) expect(new URL(r.url).host).toBe('t.example');
  });

  it('路径里夹带引号/尖括号/实体也闭合不了属性、写不出额外标签', () => {
    const pathname = `/s/x"><img src=x onerror=alert(1)>&quot;'/`;
    const { html, refs } = runLoader(scripts, { protocol: 'https:', host: 't.example', pathname });
    expect(html).not.toMatch(/<img/i);
    expect(refs).toHaveLength(scripts.length);
    expect(refs[0].url).toBe(`https://t.example/s/x"><img src=x onerror=alert(1)>&quot;'/__botmux/vendor/${scripts[0].path}`);
  });

  it('加载器源码里没有会提前结束内联脚本的 </script', () => {
    expect(xtermVendorDocumentWriteSource([...WEB_TERMINAL_VENDOR_STYLES, ...scripts])).not.toMatch(/<\/script/i);
  });
});

describe('acceptsGzip', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['gzip', true],
    ['br, gzip;q=0.5', true],
    ['gzip;q=0', false],
    ['GZIP', true],
    ['deflate, br', false],
    ['*', true],
    ['*;q=0', false],
    ['gzip;q=0, *', false],
  ] as const)('%j → %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});
