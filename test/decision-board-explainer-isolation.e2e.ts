/**
 * 说明页隔离（真浏览器）：说明页是 bot 生成的 HTML，挂在控制台同源下也跑不了脚本，读不到控制台的 cookie / localStorage，
 * 打不到控制台 API。链路是真的：看板服务存文件 → daemon IPC 出文件 → Dashboard 转发 → 事项页组件里的 iframe。
 * 对照组：同一份 HTML 不加防护地放在控制台同源下，脚本会把三样都偷到——证明这里的观测手段确实抓得到泄露。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDecisionBoardService, setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { DecisionBoardService } from '../src/core/decision-board/service.js';
import { handleDecisionBoardApi, type DecisionBoardApiDeps } from '../src/dashboard/decision-board-api.js';

const APP = 'cli_steward';
const SID = 'sess-steward';
const SECRET = 'e2e-board-isolation-secret';
const COOKIE = 'console-cookie-SECRET';
const STORED = 'console-localstorage-SECRET';
const API = 'console-api-SECRET';

/** 一份「恶意」说明页：读 cookie / localStorage / 父页面，打控制台 API，再把结果用 postMessage 和图片信标送出去。 */
const EXPLAINER = `<!doctype html><html><head><meta charset="utf-8"><title>说明</title></head>
<body><h1 id="title">改了什么</h1>
<script>
(function () {
  var out = { ran: true };
  try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked:' + e.name; }
  try { out.stored = localStorage.getItem('botmux.token'); } catch (e) { out.stored = 'blocked:' + e.name; }
  try { out.parentCookie = parent.document.cookie; } catch (e) { out.parentCookie = 'blocked:' + e.name; }
  function report() {
    try { parent.postMessage(out, '*'); } catch (e) {}
    new Image().src = '/collect?d=' + encodeURIComponent(JSON.stringify(out));
  }
  fetch('/api/secret', { credentials: 'include' })
    .then(function (r) { return r.text(); })
    .then(function (t) { out.api = t; report(); }, function (e) { out.api = 'blocked:' + e.name; report(); });
})();
</script>
<img src="data:image/png;base64,AAAA" onerror="new Image().src='/collect?d=onerror'">
</body></html>`;

let dir: string;
let service: DecisionBoardService;
let ipc: IpcServerHandle;
let server: Server;
let origin: string;
let seq: number;
let fileId: string;
let bundle: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let stripCsp = false;
const seen = { api: [] as Array<{ cookie?: string; origin?: string }>, collect: [] as string[] };

const consolePage = () => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head>
<body><div id="root"></div>
<script>
document.cookie = 'botmux_dash=${COOKIE}; path=/';
localStorage.setItem('botmux.token', '${STORED}');
window.__board = { appId: '${APP}', seq: ${seq} };
window.__messages = [];
window.addEventListener('message', function (e) { window.__messages.push(e.data); });
</script>
<script src="/app.js"></script></body></html>`;

/** 模拟中间有个代理把 CSP 响应头吃掉了：只剩 iframe 的 sandbox 这一层。 */
function withoutCsp(res: ServerResponse): void {
  const writeHead = res.writeHead.bind(res) as (status: number, headers?: OutgoingHttpHeaders) => ServerResponse;
  (res as unknown as { writeHead: typeof writeHead }).writeHead = (status, headers) => {
    const kept = { ...headers };
    delete kept['content-security-policy'];
    return writeHead(status, kept);
  };
}

function handle(req: IncomingMessage, res: ServerResponse, deps: DecisionBoardApiDeps): void {
  const url = new URL(req.url!, origin);
  const send = (type: string, body: string) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/') return send('text/html; charset=utf-8', consolePage());
  if (url.pathname === '/app.js') return send('text/javascript', bundle);
  if (url.pathname === '/style.css') return send('text/css', readFileSync('src/dashboard/web/style.css', 'utf8'));
  if (url.pathname === '/control/explainer.html') return send('text/html; charset=utf-8', EXPLAINER);
  if (url.pathname === '/api/secret') {
    seen.api.push({ cookie: req.headers.cookie, origin: req.headers.origin });
    return send('text/plain', API);
  }
  if (url.pathname === '/collect') {
    seen.collect.push(url.searchParams.get('d') ?? '');
    res.writeHead(204);
    res.end();
    return;
  }
  if (stripCsp) withoutCsp(res);
  void handleDecisionBoardApi(req, res, url, deps).then(done => {
    if (!done) { res.writeHead(404); res.end(); }
  });
}

async function settle(): Promise<void> {
  await page.waitForTimeout(1500);
}

async function explainerFrame(selector: string): Promise<Frame> {
  const element = await page.waitForSelector(selector);
  const frame = await element.contentFrame();
  if (!frame) throw new Error(`no frame behind ${selector}`);
  await frame.waitForLoadState('load');
  return frame;
}

/** 就算说明页文档里真跑起代码（用 DevTools 强行执行），它也是一个不透明源：拿不到 cookie / localStorage，API 请求发不出去。 */
async function probe(target: Page | Frame) {
  return target.evaluate(async () => {
    const attempt = (fn: () => unknown) => { try { return String(fn()); } catch (e) { return `blocked:${(e as Error).name}`; } };
    let api: string;
    try { api = await (await fetch('/api/secret', { credentials: 'include' })).text(); } catch (e) { api = `blocked:${(e as Error).name}`; }
    return {
      origin: self.origin,
      cookie: attempt(() => document.cookie),
      stored: attempt(() => localStorage.getItem('botmux.token')),
      api,
    };
  });
}

function expectNothingLeaked(result: { origin: string; cookie: string; stored: string; api: string }) {
  expect(result.origin).toBe('null');
  expect(result.cookie).toMatch(/^blocked:/);
  expect(result.stored).toMatch(/^blocked:/);
  expect(result.api).toMatch(/^blocked:/);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-isolation-'));
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => ({ enabled: true, chatId: 'oc_steward' }),
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => undefined,
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => 'owner',
    timeZone: () => 'UTC',
    batchAttachmentsDir: id => join(dir, 'att', String(id)),
    banner: () => 'b',
    deliver: async () => ({ sessionId: 'x' }),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: chatId }),
  });
  setLarkAppId(APP);
  setDecisionBoardService(service);
  setIpcAuthSecret(SECRET);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

  const added = await service.cli({ action: 'add', title: '说明页隔离', noChat: '用例' }, { sessionId: SID }) as { item: { seq: number } };
  seq = added.item.seq;
  const staged = await service.stageExplainer({ ref: String(seq), name: 'evil.html', mime: 'text/html', body: [Buffer.from(EXPLAINER)] }, { sessionId: SID });
  const attached = await service.cli({ action: 'attach', ref: String(seq), staged: [staged.id] }, { sessionId: SID }) as { files: Array<{ id: string }> };
  fileId = attached.files[0]!.id;

  const deps: DecisionBoardApiDeps = {
    identity: null,
    canManageHost: true,
    proxyToDaemon: (_app, path, init) => fetchDaemonIpc(ipc.port, path, init, SECRET),
    bots: () => [{ larkAppId: APP, botName: '管家', steward: { enabled: true, chatId: 'oc_steward' }, online: true }],
    readJsonBody: async () => ({}),
  };
  server = createServer((req, res) => handle(req, res, deps));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ItemDetailView } from './src/dashboard/web/decision-board-page.tsx';
        const { appId, seq } = window.__board;
        createRoot(document.getElementById('root')).render(<ItemDetailView appId={appId} seq={seq} />);
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0]!.text;

  const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || systemChromium,
    args: ['--no-sandbox'],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  await ipc?.close();
  setDecisionBoardService(null);
  setIpcAuthSecret(null);
  setLarkAppId('');
  service?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  stripCsp = false;
  seen.api.length = 0;
  seen.collect.length = 0;
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`${origin}/`);
  seen.api.length = 0;
  seen.collect.length = 0;
});

afterEach(async () => {
  await context?.close();
});

describe('说明页里的脚本碰不到控制台', () => {
  it('对照组：同一份 HTML 不加防护地放在控制台同源下，脚本偷得到 cookie、localStorage 和 API', async () => {
    await page.goto(`${origin}/control/explainer.html`);
    const report = () => seen.collect.find(d => d.startsWith('{'));
    await expect.poll(report, { timeout: 10_000 }).toBeDefined();
    await expect.poll(() => seen.collect.includes('onerror'), { timeout: 10_000 }).toBe(true);
    const leaked = JSON.parse(report()!);
    expect(leaked.cookie).toContain(COOKIE);
    expect(leaked.stored).toBe(STORED);
    expect(leaked.api).toBe(API);
    expect(seen.api[0]!.cookie).toContain(COOKIE);
  });

  it('事项页里嵌的说明页：响应带 CSP sandbox，脚本和内联事件都不跑，API 没被打到，父页面收不到消息', async () => {
    const response = page.waitForResponse(r => r.url().endsWith(`/files/${fileId}`));
    const frame = await explainerFrame(`figure[data-file-id="${fileId}"] iframe`);
    expect((await response).headers()['content-security-policy']).toMatch(/(^|;)\s*sandbox\s*($|;)/);
    expect(await frame.locator('#title').textContent()).toBe('改了什么');
    await settle();
    expect(seen).toEqual({ api: [], collect: [] });
    expect(await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages)).toEqual([]);
    expectNothingLeaked(await probe(frame));
    expect(seen.api).toEqual([]);
  });

  it('全屏查看的弹窗里一样', async () => {
    await page.waitForSelector(`figure[data-file-id="${fileId}"] iframe`);
    await page.locator(`figure[data-file-id="${fileId}"] button`).click();
    const frame = await explainerFrame('dialog.dboard-explainer-dialog[open] iframe');
    expect(await frame.locator('#title').textContent()).toBe('改了什么');
    await settle();
    expect(seen).toEqual({ api: [], collect: [] });
    expect(await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages)).toEqual([]);
    expectNothingLeaked(await probe(frame));
  });

  it('新标签页直接打开（不在 iframe 里）：靠 CSP sandbox 一样是不透明源，脚本不跑', async () => {
    await page.waitForSelector(`figure[data-file-id="${fileId}"] a[target="_blank"]`);
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      page.locator(`figure[data-file-id="${fileId}"] a[target="_blank"]`).click(),
    ]);
    await tab.waitForLoadState('load');
    expect(tab.url()).toBe(`${origin}/api/decision-board/${APP}/files/${fileId}`);
    expect(await tab.locator('#title').textContent()).toBe('改了什么');
    await tab.waitForTimeout(1500);
    expect(seen).toEqual({ api: [], collect: [] });
    expectNothingLeaked(await probe(tab));
  });

  it('就算中间有代理吃掉了 CSP 响应头，事项页 iframe 自己的 sandbox 也拦得住', async () => {
    stripCsp = true;
    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    const response = page.waitForResponse(r => r.url().endsWith(`/files/${fileId}`));
    await page.goto(`${origin}/`);
    const frame = await explainerFrame(`figure[data-file-id="${fileId}"] iframe`);
    expect((await response).headers()['content-security-policy']).toBeUndefined();
    expect(await frame.locator('#title').textContent()).toBe('改了什么');
    await settle();
    expect(seen).toEqual({ api: [], collect: [] });
    expect(await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages)).toEqual([]);
    const probed = await probe(frame);
    expect(probed.origin).toBe('null');
    expect(probed.cookie).toMatch(/^blocked:/);
    expect(probed.stored).toMatch(/^blocked:/);
    expect(probed.api).not.toBe(API);
  });
});
