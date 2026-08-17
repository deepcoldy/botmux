import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DASHBOARD_H5_CLIENT_TIMEOUT_MS,
  DashboardSessionStore,
  createDashboardH5AuthController,
  parseNamedCookie,
  type DashboardAuthIdentity,
  type DashboardH5AuthConfig,
} from '../src/dashboard/h5-auth.js';
import {
  PREVIEW_INTERACTION_IDLE_MS,
  PreviewInteractionManager,
} from '../src/dashboard/preview-interaction.js';
import { createPreviewGuardPage } from '../src/dashboard/preview-guard-page.js';
import { createSessionPreviewProxy, type PreviewProxyResolution } from '../src/dashboard/preview-proxy.js';
import { TerminalControlManager, type TerminalDashboardActor } from '../src/dashboard/terminal-control.js';
import { isPreviewPort, probeSessionPreviewTarget } from '../src/core/session-preview.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'scripts', 'fixtures', 'agent-workbench-browser.tsx');
const resultPath = join(root, 'docs', 'assets', 'agent-workbench-browser-results.json');
const pageHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Workbench browser harness</title><link rel="stylesheet" href="/style.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const terminalHtml = '<!doctype html><html><body style="margin:0;background:#070a0e;color:#d8e2ed;font:13px monospace;padding:16px">LOCAL TERMINAL · READ/CONTROL CONTRACT</body></html>';
const previewHtml = '<!doctype html><html><body style="margin:0;background:#101722;color:#d8e2ed;font:14px system-ui;padding:18px"><h1>Local preview target</h1><p id="preview-ready">HTTP and WebSocket preview harness is ready.</p></body></html>';

class MemoryAudit implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unable to resolve local server port');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function executablePath(): Promise<string | undefined> {
  const explicit = process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE?.trim();
  const candidates = [
    explicit,
    join(homedir(), '.cache', 'ui-check', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell', 'linux-121.0.6167.85', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to Playwright's managed browser when no local executable exists.
    }
  }
  return undefined;
}

function requestActor(req: IncomingMessage, h5Identity: DashboardAuthIdentity | null): TerminalDashboardActor | null {
  if (h5Identity) return h5Identity;
  if (parseNamedCookie(req.headers.cookie, 'dashboard') !== 'ok') return null;
  return {
    userId: 'ou_local_browser',
    authSessionId: 'local-browser-auth-session',
    issuedAt: 0,
    expiresAt: previewNow + 60 * 60_000,
  } as DashboardAuthIdentity;
}

const audit = new MemoryAudit();
let previewNow = Date.now();
const terminalControl = new TerminalControlManager({
  secret: 'local-browser-control-secret-not-a-real-credential',
  audit,
  ttlMs: 60_000,
  now: () => previewNow,
});
const previewInteraction = new PreviewInteractionManager({ audit, now: () => previewNow });

const h5Config: DashboardH5AuthConfig = {
  enabled: true,
  brand: 'feishu',
  appId: 'cli_local_browser_fixture',
  appSecret: 'synthetic-browser-fixture-secret',
  allowedOpenIds: ['ou_browser_allowed'],
  entryPath: '/auth/feishu',
  sessionTtlMs: 60 * 60_000,
  secureCookies: false,
};
const h5Sessions = new DashboardSessionStore({ ttlMs: h5Config.sessionTtlMs });
const h5Auth = createDashboardH5AuthController({
  config: h5Config,
  sessions: h5Sessions,
  audit,
  exchanger: {
    async exchange(code) {
      if (code !== 'browser-code') throw new Error('synthetic provider denial');
      return { openId: 'ou_browser_allowed' };
    },
  },
});

const css = await readFile(join(root, 'src', 'dashboard', 'web', 'style.css'));
const bundle = await build({
  entryPoints: [fixturePath],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  write: false,
  logLevel: 'silent',
});
const fixtureJs = bundle.outputFiles[0].contents;

const upstreamSockets = new Set<WebSocket>();
const upstream = createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'preview_cookie=must_be_stripped; Path=/',
    'x-preview-upstream': 'local',
  });
  res.end(req.url?.startsWith('/ping') ? `preview-ok:${req.url}` : previewHtml);
});
const upstreamWss = new WebSocketServer({ server: upstream });
upstreamWss.on('connection', socket => {
  upstreamSockets.add(socket);
  socket.send('ready');
  socket.on('message', data => socket.send(`echo:${data.toString()}`));
  socket.on('close', () => upstreamSockets.delete(socket));
});
const upstreamPort = await listen(upstream);

const reservation = createServer();
const unreachablePort = await listen(reservation);
await closeServer(reservation);
const registeredAt = new Date(previewNow).toISOString();

function resolvePreview(sessionId: string): PreviewProxyResolution {
  if (sessionId === 'browser-success') {
    return { ok: true, target: { host: '127.0.0.1', port: upstreamPort, registeredAt } };
  }
  if (sessionId === 'invalid-port') {
    return { ok: true, target: { host: '127.0.0.1', port: 70_000, registeredAt } };
  }
  if (sessionId === 'unreachable') {
    return { ok: true, target: { host: '127.0.0.1', port: unreachablePort, registeredAt } };
  }
  if (sessionId === 'browser-failure') return { ok: false, status: 503, error: 'daemon_offline' };
  return { ok: false, status: 404, error: 'preview_not_registered' };
}

function actor(req: IncomingMessage): TerminalDashboardActor | null {
  return requestActor(req, h5Auth.resolve(req));
}

const previewProxy = createSessionPreviewProxy({
  authenticated: req => actor(req) !== null,
  resolve: resolvePreview,
});
const previewGuard = createPreviewGuardPage({
  authenticated: req => actor(req) !== null,
  resolve: resolvePreview,
});
const controlWss = new WebSocketServer({ noServer: true });

async function handleFront(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (await h5Auth.handle(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/style.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end(css);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/fixture.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(fixtureJs);
    return;
  }

  const requestIdentity = actor(req);
  if (req.method === 'GET' && url.pathname === '/api/workbench/h5-context') {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    return json(res, 200, {
      ok: true,
      h5: { enabled: true, appId: h5Config.appId, brand: h5Config.brand, entryPath: h5Config.entryPath },
    });
  }

  const controlMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/control(?:\/(takeover|release))?$/);
  if (controlMatch) {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    const sessionId = decodeURIComponent(controlMatch[1]);
    if (sessionId === 'browser-failure') return json(res, 503, { ok: false, error: 'daemon_offline' });
    const action = controlMatch[2];
    if (req.method === 'GET' && !action) return json(res, 200, { ok: true, ...terminalControl.state(requestIdentity, sessionId) });
    if (req.method === 'POST' && action === 'takeover') {
      const result = terminalControl.takeover(requestIdentity, sessionId);
      return json(res, result.ok ? 200 : 409, result.ok ? { ...result, owned: true } : { ok: false, error: result.error });
    }
    if (req.method === 'POST' && action === 'release') {
      const result = terminalControl.release(requestIdentity, sessionId);
      return json(res, result.ok ? 200 : 403, result.ok ? { ...result, owned: false } : { ok: false, error: result.error });
    }
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const interactionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview-interaction(?:\/(unlock|activity|lock))?$/);
  if (interactionMatch) {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    const sessionId = decodeURIComponent(interactionMatch[1]);
    if (sessionId === 'browser-failure') return json(res, 502, { ok: false, error: 'preview_unreachable' });
    const action = interactionMatch[2];
    if (req.method === 'GET' && !action) return json(res, 200, { ok: true, ...previewInteraction.state(requestIdentity, sessionId) });
    if (req.method === 'POST' && action === 'unlock') return json(res, 200, { ok: true, ...previewInteraction.unlock(requestIdentity, sessionId) });
    if (req.method === 'POST' && action === 'activity') return json(res, 200, { ok: true, ...previewInteraction.activity(requestIdentity, sessionId) });
    if (req.method === 'POST' && action === 'lock') return json(res, 200, { ok: true, ...previewInteraction.lock(requestIdentity, sessionId) });
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  if (req.method === 'POST' && url.pathname === '/harness/advance-preview') {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    previewNow += PREVIEW_INTERACTION_IDLE_MS;
    return json(res, 200, { ok: true, expired: previewInteraction.expireDue() });
  }

  if (req.method === 'GET' && url.pathname === '/harness/register') {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    const port = Number(url.searchParams.get('port'));
    if (!isPreviewPort(port)) return json(res, 400, { ok: false, error: 'invalid_port' });
    const target = await probeSessionPreviewTarget({ port, timeoutMs: 100, now: () => new Date(previewNow) });
    return target
      ? json(res, 200, { ok: true, preview: { path: '/preview/browser-success/', registeredAt: target.registeredAt } })
      : json(res, 422, { ok: false, error: 'preview_unreachable' });
  }

  if (previewGuard.handle(req, res, url)) return;
  if (await previewProxy.handleHttp(req, res, url)) return;

  if (url.pathname.startsWith('/s/')) {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(terminalHtml);
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

const front = createServer((req, res) => {
  void handleFront(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'harness_error' });
    else res.end();
  });
});
front.on('upgrade', (req, socket, head) => {
  if (previewProxy.handleUpgrade(req, socket as Duplex, head)) return;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/control-socket') return socket.destroy();
  const requestIdentity = actor(req);
  const sessionId = url.searchParams.get('session') ?? '';
  if (!requestIdentity) return socket.destroy();
  controlWss.handleUpgrade(req, socket, head, ws => {
    const socketRef = {
      get destroyed() { return ws.readyState === WebSocket.CLOSED; },
      destroy() { ws.terminate(); },
    };
    const registered = terminalControl.registerWritableSocket(requestIdentity, sessionId, socketRef);
    if (!registered.registered) {
      ws.close(1008, 'readonly');
      return;
    }
    ws.send('controlled');
    ws.once('close', () => terminalControl.disconnect(requestIdentity, sessionId, registered.leaseMarker));
  });
});
const frontPort = await listen(front);
const base = `http://127.0.0.1:${frontPort}`;

const browserPath = await executablePath();
const browser = await chromium.launch({
  headless: true,
  ...(browserPath ? { executablePath: browserPath } : {}),
});

type ScenarioResult = { ok: true; durationMs: number };
const scenarioResults: Record<string, ScenarioResult> = {};

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await run();
  scenarioResults[name] = { ok: true, durationMs: Date.now() - started };
}

async function localContext(viewport = { width: 1280, height: 800 }): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  // tsx/esbuild preserves function names with this helper. Playwright serializes
  // evaluate callbacks without the module prelude, so provide the harmless
  // helper explicitly inside the isolated synthetic browser context.
  await context.addInitScript({ content: 'globalThis.__name = (target) => target;' });
  return context;
}

async function authenticatedContext(viewport = { width: 1440, height: 900 }): Promise<BrowserContext> {
  const context = await localContext(viewport);
  await context.addCookies([{ name: 'dashboard', value: 'ok', url: base, httpOnly: true, sameSite: 'Lax' }]);
  return context;
}

async function waitForText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor();
}

/** 行操作浮层平时是 opacity:0 / pointer-events:none，悬停或聚焦才出现。不先 hover
 *  就点，点击会被铺满整行的聊天锚点（.wb-session-copy-link::after）吃掉。 */
async function rowAction(page: Page, title: string | RegExp, action: 'terminal' | 'terminal-control'): Promise<void> {
  const row = page.getByRole('option', { name: title });
  await row.waitFor();
  await row.hover();
  await row.locator(`.wb-session-row-action.is-${action}`).click();
}

try {
  await scenario('h5_success', async () => {
    const context = await localContext({ width: 1280, height: 800 });
    await context.route('https://lf-scm-cn.feishucdn.com/**', route => route.fulfill({
      contentType: 'text/javascript',
      body: "window.h5sdk={ready:function(cb){cb()}};window.tt={requestAccess:function(o){o.success({code:'browser-code'})}};",
    }));
    const page = await context.newPage();
    await page.goto(`${base}/auth/feishu?returnTo=${encodeURIComponent('/#/agent-workbench/browser-success')}`);
    await page.waitForURL(/#\/agent-workbench\/browser-success$/);
    await page.locator('.agent-workbench-page').waitFor();
    const sessionStatus = await page.evaluate(async () => (await fetch('/auth/feishu/session')).status);
    assert.equal(sessionStatus, 200);
    await context.close();
  });

  await scenario('h5_failure', async () => {
    const context = await localContext();
    await context.route('https://lf-scm-cn.feishucdn.com/**', route => route.fulfill({
      contentType: 'text/javascript',
      body: 'window.h5sdk={ready:function(cb){cb()}};window.tt={requestAccess:function(o){o.fail({errno:500})}};',
    }));
    const page = await context.newPage();
    await page.goto(`${base}/auth/feishu`);
    await waitForText(page, '未能完成免登');
    await page.locator('#retry:not([hidden])').waitFor();
    await context.close();
  });

  await scenario('h5_timeout', async () => {
    const context = await localContext();
    await context.route('https://lf-scm-cn.feishucdn.com/**', route => route.fulfill({
      contentType: 'text/javascript',
      body: 'window.h5sdk={ready:function(){}};window.tt={requestAccess:function(){}};',
    }));
    const page = await context.newPage();
    await page.clock.install({ time: Date.now() });
    await page.goto(`${base}/auth/feishu`);
    await page.waitForFunction(() => Boolean(window.h5sdk));
    await page.clock.fastForward(DASHBOARD_H5_CLIENT_TIMEOUT_MS + 1);
    await waitForText(page, '未能完成免登');
    await context.close();
  });

  await scenario('h5_without_sdk', async () => {
    const context = await localContext();
    await context.route('https://lf-scm-cn.feishucdn.com/**', route => route.fulfill({
      contentType: 'text/javascript',
      body: '/* SDK unavailable in this synthetic browser */',
    }));
    const page = await context.newPage();
    await page.goto(`${base}/auth/feishu`);
    await waitForText(page, '未能完成免登');
    assert.equal(await page.evaluate(() => typeof window.tt), 'undefined');
    await context.close();
  });

  // 原名 workbench_success_and_chat。页内聊天挂件（Native chat 按钮 + h5sdk
  // toggleChat）已被有意移除——聊天现在是行内那个真锚点，交给飞书客户端自己开，
  // 所以那几条断言删掉，换成「锚点形态正确 + 完全没走 JS SDK」的守卫。
  await scenario('workbench_route_switch_and_terminal_control', async () => {
    const context = await authenticatedContext();
    const page = await context.newPage();
    // 仍然给页面挂一个「能用」的 h5sdk（sdk=toggle-success）——正因为它可用，
    // 下面那条 sdkCalls 为空的断言才有意义：不是没得调，是这条路已经不走了。
    await page.goto(`${base}/?scenario=success&sdk=toggle-success`);
    await page.locator('.agent-workbench-page').waitFor();
    // 工作区默认收起（.wb-desktop-layout.is-terminal-closed 把它整块隐藏，列表铺满），
    // 只有行内「终端 / 接管」才会把它开出来——所以路由切换也从行操作走。
    assert.equal(await page.locator('.wb-desktop-layout.is-terminal-closed').count(), 1);
    await rowAction(page, /Secondary session for route switching/, 'terminal');
    await page.locator('.wb-workspace-title strong').filter({ hasText: 'Secondary session for route switching' }).waitFor();
    await page.locator('.wb-terminal-pane .wb-mode-chip.is-readonly').waitFor();
    await rowAction(page, /Integrated Workbench browser scenario/, 'terminal-control');
    await page.locator('.wb-workspace-title strong').filter({ hasText: 'Integrated Workbench browser scenario' }).waitFor();
    // 「接管」= 开面板并自动请求写权限，不需要再点一次面板里的按钮。
    await page.locator('.wb-mode-chip.is-controlled').waitFor();
    await waitForText(page, '已接管，可键盘输入。');
    // 聊天必须是 target=_blank rel=noopener 的真锚点：脚本化打开（window.open /
    // 合成 click / enterChat）会被飞书客户端降级到窄容器，这正是当初那个 bug。
    const chatAnchor = page.getByRole('option', { name: /Integrated Workbench browser scenario/ })
      .locator('a.wb-session-row-action.is-chat');
    assert.equal(await chatAnchor.getAttribute('target'), '_blank');
    assert.equal(await chatAnchor.getAttribute('rel'), 'noopener');
    assert.match(await chatAnchor.getAttribute('href') ?? '', /^https:\/\/applink\.feishu\.cn\/client\/chat\/open\?/);
    assert.deepEqual(await page.evaluate(() => window.__workbenchHarness?.sdkCalls), []);
    await page.locator('.wb-terminal-pane').getByRole('button', { name: '释放输入' }).click();
    await page.locator('.wb-mode-chip.is-readonly').waitFor();
    // 关掉面板，工作区收回，列表重新铺满。
    await page.locator('.wb-workspace-controls').getByRole('button', { name: '关闭终端' }).click();
    await page.locator('.wb-desktop-layout.is-terminal-closed').waitFor();
    assert.equal(await page.locator('.wb-terminal-pane').count(), 0);
    await context.close();
  });

  await scenario('workbench_failure', async () => {
    const context = await authenticatedContext();
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=failure`);
    await rowAction(page, /Workbench failure boundary/, 'terminal-control');
    // 控制权接口 503 daemon_offline → 面板报错并停在只读，不会假装接管成功。
    await waitForText(page, '所属 daemon 已离线');
    await page.locator('.wb-terminal-pane .wb-mode-chip.is-readonly').waitFor();
    await context.close();
  });

  await scenario('unauthorized', async () => {
    const context = await localContext({ width: 1280, height: 800 });
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success&authenticated=false`);
    await rowAction(page, /Integrated Workbench browser scenario/, 'terminal');
    // 未登录只给只读，接管按钮根本不渲染——不是渲染出来再报错。
    await waitForText(page, '只读查看。登录 Dashboard 后可接管。');
    assert.equal(await page.locator('.wb-terminal-pane').getByRole('button', { name: '接管输入' }).count(), 0);
    const statuses = await page.evaluate(async () => ({
      preview: (await fetch('/preview/browser-success/ping')).status,
      h5Context: (await fetch('/api/workbench/h5-context')).status,
    }));
    assert.deepEqual(statuses, { preview: 401, h5Context: 401 });
    await context.close();
  });

  await scenario('mobile_and_sidebar_layout', async () => {
    const mobile = await authenticatedContext({ width: 390, height: 844 });
    const page = await mobile.newPage();
    await page.goto(`${base}/?scenario=success`);
    await page.locator('.agent-workbench-page[data-responsive-step="mobile-stack"]').waitFor();
    // 窄屏是「列表 → 详情」的下钻，不是页内 tab 栏：飞书自己的底部 tab 已经占了
    // 一层导航，页内再来一条会吃掉终端高度。分屏也已移除。
    assert.equal(await page.locator('.wb-mobile-stack').count(), 1);
    assert.equal(await page.locator('.wb-mobile-nav').count(), 0);
    assert.equal(await page.locator('.wb-pane-split').count(), 0);
    await page.locator('.wb-session-list').waitFor();
    // 点一行钻进工作区，再用「‹ 会话列表」退回来。
    await page.getByRole('option', { name: /Integrated Workbench browser scenario/ }).click();
    await page.locator('.wb-mobile-detail').waitFor();
    await page.locator('.wb-mobile-back').click();
    await page.locator('.wb-session-list').waitFor();
    await mobile.close();

    const sidebar = await authenticatedContext({ width: 375, height: 800 });
    const dock = await sidebar.newPage();
    await dock.goto(`${base}/?surface=dock&scenario=success`);
    await dock.locator('.agent-workbench-dock').waitFor();
    assert.equal(await dock.locator('.agent-workbench-dock').evaluate(element => getComputedStyle(element).minWidth), '350px');
    assert.equal(await dock.locator('.wb-pane').count(), 0);
    await sidebar.close();
  });

  // 网页预览面板如今只在窄屏的「网页」页签下存在——桌面工作区只承载终端。
  // 交互解锁/回锁这条契约因此整体搬到移动视口来验。
  await scenario('mobile_preview_interaction', async () => {
    const context = await authenticatedContext({ width: 390, height: 844 });
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success`);
    await page.locator('.agent-workbench-page[data-responsive-step="mobile-stack"]').waitFor();
    await page.getByRole('option', { name: /Integrated Workbench browser scenario/ }).click();
    await page.locator('.wb-mobile-detail').waitFor();
    await page.locator('.wb-mobile-detail-seg').getByRole('button', { name: '网页' }).click();
    await page.locator('.wb-web-pane').waitFor();
    const previewGuard = page.frameLocator('.wb-web-pane iframe.wb-pane-frame');
    await previewGuard.locator('#overlay:not(.hidden)').waitFor();
    await page.locator('.wb-web-pane').getByRole('button', { name: '开启交互' }).click();
    await page.locator('.wb-mode-chip.is-interactive').waitFor();
    await previewGuard.locator('#overlay').waitFor({ state: 'hidden' });
    await waitForText(page, '不是应用级强只读安全边界');
    await page.locator('.wb-web-pane').getByRole('button', { name: '立即锁定' }).click();
    await page.locator('.wb-mode-chip.is-preview').waitFor();
    await previewGuard.locator('#overlay:not(.hidden)').waitFor();
    await context.close();
  });

  await scenario('preview_registration_and_proxy_boundaries', async () => {
    const context = await authenticatedContext();
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success`);
    const evidence = await page.evaluate(async ({ validPort }) => {
      const read = async (path: string) => {
        const response = await fetch(path);
        return { status: response.status, body: await response.text(), referrer: response.headers.get('referrer-policy') };
      };
      return {
        invalidRegistration: await read('/harness/register?port=0'),
        validRegistration: await read(`/harness/register?port=${validPort}`),
        unregistered: await read('/preview/unregistered/ping'),
        invalidTarget: await read('/preview/invalid-port/ping'),
        unreachable: await read('/preview/unreachable/ping'),
        valid: await read('/preview/browser-success/ping?source=browser'),
      };
    }, { validPort: upstreamPort });
    assert.equal(evidence.invalidRegistration.status, 400);
    assert.match(evidence.invalidRegistration.body, /invalid_port/);
    assert.equal(evidence.validRegistration.status, 200);
    assert.equal(evidence.unregistered.status, 404);
    assert.match(evidence.unregistered.body, /preview_not_registered/);
    assert.equal(evidence.invalidTarget.status, 409);
    assert.match(evidence.invalidTarget.body, /invalid_preview_target/);
    assert.equal(evidence.unreachable.status, 502);
    assert.match(evidence.unreachable.body, /preview_unreachable/);
    assert.doesNotMatch(evidence.unreachable.body, /127\.0\.0\.1/);
    assert.ok(!evidence.unreachable.body.includes(String(unreachablePort)));
    assert.equal(evidence.valid.status, 200);
    assert.match(evidence.valid.body, /preview-ok:\/ping\?source=browser/);
    assert.equal(evidence.valid.referrer, 'no-referrer');
    await context.close();
  });

  await scenario('preview_websocket', async () => {
    const context = await authenticatedContext();
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success`);
    const reply = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/preview/browser-success/socket?room=browser`);
      const timer = setTimeout(() => reject(new Error('browser WebSocket timeout')), 3_000);
      ws.addEventListener('open', () => ws.send('browser'));
      ws.addEventListener('message', event => {
        if (event.data !== 'echo:browser') return;
        clearTimeout(timer);
        ws.close();
        resolve(event.data);
      });
      ws.addEventListener('error', () => reject(new Error('browser WebSocket error')));
    }));
    assert.equal(reply, 'echo:browser');
    await context.close();
  });

  await scenario('terminal_disconnect_returns_readonly', async () => {
    const context = await authenticatedContext();
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success`);
    const result = await page.evaluate(async () => {
      const takeover = await fetch('/api/sessions/browser-success/control/takeover', { method: 'POST' }).then(response => response.json());
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/control-socket?session=browser-success`);
        const timer = setTimeout(() => reject(new Error('control socket timeout')), 3_000);
        ws.addEventListener('message', event => {
          if (event.data !== 'controlled') return;
          ws.close();
        });
        ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
        ws.addEventListener('error', () => reject(new Error('control socket error')));
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      const state = await fetch('/api/sessions/browser-success/control').then(response => response.json());
      return { takeover, state };
    });
    assert.equal(result.takeover.mode, 'controlled');
    assert.equal(result.takeover.owned, true);
    assert.deepEqual(result.state, { ok: true, mode: 'readonly', owned: false });
    await context.close();
  });

  await scenario('preview_idle_timeout_relocks', async () => {
    const context = await authenticatedContext({ width: 1000, height: 760 });
    const page = await context.newPage();
    await page.clock.install({ time: previewNow });
    await page.goto(`${base}/preview/browser-success/`);
    await page.locator('#overlay').waitFor();
    await page.locator('#unlock').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    const advanced = await page.evaluate(async () => fetch('/harness/advance-preview', { method: 'POST' }).then(response => response.json()));
    assert.equal(advanced.expired, 1);
    await page.clock.fastForward(PREVIEW_INTERACTION_IDLE_MS + 100);
    await page.locator('#overlay:not(.hidden)').waitFor();
    await waitForText(page, '预览模式（默认）');
    assert.ok(audit.records.some(record => record.action === 'preview.idle_relock'));
    await context.close();
  });

  const output = {
    ok: true,
    browser: browserPath ? 'local executable' : 'Playwright managed Chromium',
    viewportCoverage: ['1440x900', '1280x800', '390x844', '375x800'],
    scenarios: scenarioResults,
  };
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  previewInteraction.relockAuthSession('local-browser-auth-session');
  terminalControl.releaseByAuthSession('local-browser-auth-session');
  for (const socket of upstreamSockets) socket.terminate();
  await browser.close();
  await new Promise<void>(resolve => upstreamWss.close(() => resolve()));
  await new Promise<void>(resolve => controlWss.close(() => resolve()));
  await closeServer(front);
  await closeServer(upstream);
}
