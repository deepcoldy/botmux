import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, devices, type BrowserContext, type Page } from 'playwright';
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
import {
  mintPreviewContentCapability,
  verifyPreviewContentCapability,
} from '../src/dashboard/preview-content-capability.js';
import { TerminalControlManager, type TerminalDashboardActor } from '../src/dashboard/terminal-control.js';
import {
  centralViewLinkPath,
  mintTerminalViewCapability,
  terminalViewCapabilityAuthSession,
  upstreamWorkerViewGeneration,
} from '../src/dashboard/terminal-view-capability.js';
import { resolvePreviewPortOwner } from '../src/core/preview-port-owner.js';
import { isPreviewPort, probeSessionPreviewTarget } from '../src/core/session-preview.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'scripts', 'fixtures', 'agent-workbench-browser.tsx');
const resultPath = join(root, 'docs', 'assets', 'agent-workbench-browser-results.json');
/** 自验收截图落在仓库外：它们是每次跑出来的证据，不是需要版本化的资产。
 *  用 BOTMUX_WORKBENCH_SHOT_DIR 可以指到别处。 */
const shotDir = process.env.BOTMUX_WORKBENCH_SHOT_DIR?.trim() || join(tmpdir(), 'botmux-workbench-shots');
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

/** 证据要能被复现，就得说清「这份绿是哪个 commit、哪份夹具产物、哪个浏览器跑出来的」。 */
function headCommit(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
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
const controlSecret = 'local-browser-control-secret-not-a-real-credential';
/** Worker boot generation for the minted view capabilities. The real daemon
 *  derives it from the worker's per-boot card token; the harness feeds the same
 *  helper a synthetic upstream URL so the token shape is identical. */
function harnessViewGeneration(): string {
  const derived = upstreamWorkerViewGeneration(
    controlSecret,
    'http://127.0.0.1:1/?viewToken=local-browser-boot-token',
  );
  if (!derived) throw new Error('unable to derive a worker view generation for the harness');
  return derived;
}
const viewGeneration = harnessViewGeneration();
const terminalControl = new TerminalControlManager({
  secret: controlSecret,
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
  // Loopback fixture, no proxy in front: x-forwarded-for is not trusted.
  trustedProxyHops: 0,
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

// P1-12 之后 SessionPreviewTarget 必须带端口持有证明，缺证明的目标会被
// safeSessionPreviewTarget 归零、代理一律回 409。真实上游就监听在本进程里，所以
// 这里走生产同一条 resolvePreviewPortOwner 求一份**真的**证明。
// invalid-port / unreachable 两条用例考的是「端口非法」与「拨不通」，代理侧只做形状
// 校验（归属复核在 dashboard.ts 的 resolver 里、不在代理里），因此复用同一份形状
// 合法的证明，用例语义保持不变。
const upstreamOwner = resolvePreviewPortOwner({
  host: '127.0.0.1',
  port: upstreamPort,
  ownerPids: [process.pid],
});
assert.ok(
  upstreamOwner.ok,
  `could not prove ownership of the in-process preview upstream port (${(upstreamOwner as { reason?: string }).reason})`,
);
const owner = upstreamOwner.proof;
const workerGeneration = 1;

function resolvePreview(sessionId: string): PreviewProxyResolution {
  if (sessionId === 'browser-success') {
    return { ok: true, target: { host: '127.0.0.1', port: upstreamPort, registeredAt, owner, workerGeneration } };
  }
  if (sessionId === 'invalid-port') {
    return { ok: true, target: { host: '127.0.0.1', port: 70_000, registeredAt, owner, workerGeneration } };
  }
  if (sessionId === 'unreachable') {
    return { ok: true, target: { host: '127.0.0.1', port: unreachablePort, registeredAt, owner, workerGeneration } };
  }
  if (sessionId === 'browser-failure') return { ok: false, status: 503, error: 'daemon_offline' };
  return { ok: false, status: 404, error: 'preview_not_registered' };
}

function actor(req: IncomingMessage): TerminalDashboardActor | null {
  return requestActor(req, h5Auth.resolve(req));
}

const previewCapabilitySecret = 'local-browser-preview-capability-secret-not-a-real-credential';
const previewProxy = createSessionPreviewProxy({
  authenticated: req => actor(req) !== null,
  resolve: resolvePreview,
  verifyContentCapability: (capability, sessionId) =>
    verifyPreviewContentCapability(previewCapabilitySecret, capability, sessionId, previewNow).ok,
});
const previewGuard = createPreviewGuardPage({
  authenticated: req => actor(req) !== null,
  resolve: resolvePreview,
  mintContentCapability: (req, sessionId) => {
    const identity = actor(req);
    return identity
      ? mintPreviewContentCapability(previewCapabilitySecret, sessionId, {
        userId: identity.userId,
        authSessionId: identity.authSessionId,
        expiresAt: identity.expiresAt,
      }, previewNow)
      : null;
  },
  // 这套 harness 的身份都是可交互的本机 owner / H5 会话，解锁入口照常渲染；
  // 只读身份不渲染解锁按钮那条路由由 preview-guard-page.test.ts 与
  // verify-preview-guard-race.ts 覆盖。
  canInteract: req => actor(req) !== null,
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

  // 短时 viewToken 只读能力（P1-5）。终端面板和会话坞的触屏路径都靠它：iOS WebView
  // 发 WebSocket 升级时不带 Cookie，凭证必须能放进 URL 查询参数里。
  const viewLinkMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/view-link$/);
  if (req.method === 'GET' && viewLinkMatch) {
    if (!requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    const sessionId = decodeURIComponent(viewLinkMatch[1]);
    const minted = mintTerminalViewCapability(controlSecret, sessionId, requestIdentity, viewGeneration, previewNow);
    const link = minted ? centralViewLinkPath(sessionId, minted.token) : null;
    if (!minted || !link) return json(res, 503, { ok: false, error: 'terminal_unavailable' });
    return json(res, 200, { ok: true, url: link, expiresAt: minted.expiresAt });
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
    // P1-12：注册现在是「可达 + 归属」两件事，返回结构化结果而不是 target|undefined。
    // 血缘根用本进程 pid——被注册的上游就监听在这个进程里。
    const probe = await probeSessionPreviewTarget({
      port,
      timeoutMs: 100,
      now: () => new Date(previewNow),
      ownerPids: [process.pid],
      workerGeneration,
    });
    return probe.ok
      ? json(res, 200, { ok: true, preview: { path: '/preview/browser-success/', registeredAt: probe.target.registeredAt } })
      : json(res, 422, { ok: false, error: probe.error });
  }

  if (previewGuard.handle(req, res, url)) return;
  if (await previewProxy.handleHttp(req, res, url)) return;

  if (url.pathname.startsWith('/s/')) {
    // 两条鉴权路，和真实前置代理同构：Cookie（桌面）或 ?viewToken=（触屏 / 无 Cookie
    // 的 WebView）。后者是 P1-17 的关键——请求里连 Cookie 都没有也必须放行，否则手机
    // 上点开终端就是一片 403 空白。
    const sessionId = decodeURIComponent(url.pathname.slice('/s/'.length).replace(/\/+$/, ''));
    const grantedAuthSession = terminalViewCapabilityAuthSession(
      controlSecret,
      sessionId,
      url.searchParams.get('viewToken'),
      previewNow,
    );
    if (!grantedAuthSession && !requestIdentity) return json(res, 401, { ok: false, error: 'authentication_required' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(grantedAuthSession ? terminalHtml.replace('READ/CONTROL CONTRACT', 'READ-ONLY VIEW CAPABILITY') : terminalHtml);
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

await mkdir(shotDir, { recursive: true });

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
    // 行内「终端 / 接管」这两条**跨会话**与**降级**路径（#963 复审 P1-1、P1-2）：
    // 面板标题栏那对按钮证明不了它们，回归时用户看到的正是「点另一行的终端，面板
    // 直接没了」。
    // ① A 的终端正接管着 → 点 B 行「终端」必须打开 B 的只读终端，不是关面板。
    await rowAction(page, /Secondary session for route switching/, 'terminal');
    await page.locator('.wb-workspace-title strong').filter({ hasText: 'Secondary session for route switching' }).waitFor();
    assert.equal(await page.locator('.wb-terminal-pane').count(), 1);
    // ② 回到 A 重新接管，接管态点行内「终端」= 降为只读且面板还在（再点一次才关）。
    await rowAction(page, /Integrated Workbench browser scenario/, 'terminal-control');
    await page.locator('.wb-mode-chip.is-controlled').waitFor();
    await rowAction(page, /Integrated Workbench browser scenario/, 'terminal');
    await page.locator('.wb-terminal-pane .wb-mode-chip.is-readonly').waitFor();
    assert.equal(await page.locator('.wb-terminal-pane').count(), 1);
    // 接回写权限，下面那段既有断言从接管态开始。
    await page.locator('.wb-terminal-pane').getByRole('button', { name: '接管输入' }).click();
    await page.locator('.wb-mode-chip.is-controlled').waitFor();
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

  // P1-17：会话坞的终端链接在真触屏环境下必须是 viewToken 只读通道。
  // 以前这里永远发裸的同源 /s/<id>，iOS WebView 的 WS 升级不带 Cookie，点开就是空白。
  // 这条用真机 profile（hasTouch + isMobile）跑，不是只把 viewport 改窄。
  await scenario('dock_touch_view_token', async () => {
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    await context.addInitScript({ content: 'globalThis.__name = (target) => target;' });
    await context.addCookies([{ name: 'dashboard', value: 'ok', url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.goto(`${base}/?surface=dock&scenario=success`);
    await page.locator('.agent-workbench-dock').waitFor();
    const environment = await page.evaluate(() => ({
      hoverNone: matchMedia('(hover: none)').matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    assert.ok(
      environment.hoverNone || environment.touchPoints > 0,
      `iPhone profile must read as a touch environment: ${JSON.stringify(environment)}`,
    );

    const terminal = page.getByRole('link', { name: '终端链接' });
    await terminal.waitFor();
    const href = await terminal.getAttribute('href') ?? '';
    assert.ok(href.includes('viewToken='), `dock terminal link must carry a viewToken: ${href}`);
    assert.equal(new URL(href, base).origin, new URL(base).origin);
    // 指尖目标（P1-17）：坞里的动作格子在触屏下至少 44px。
    const box = await terminal.boundingBox();
    assert.ok(box && box.height >= 44, `dock action target below 44px: ${JSON.stringify(box)}`);
    await page.screenshot({ path: join(shotDir, 'dock-touch-iphone13.png') });

    // 决定性的一步：把这条链接拿到一个**完全没有 Cookie**的上下文里打开——iOS WebView
    // 发 WS 时正是这个处境。带 viewToken 的开得出来，裸 /s/<id> 只会 401。
    const cookieless = await localContext({ width: 390, height: 844 });
    const opened = await cookieless.newPage();
    const granted = await opened.goto(new URL(href, base).toString());
    assert.equal(granted?.status(), 200);
    await opened.getByText('READ-ONLY VIEW CAPABILITY').waitFor();
    await opened.screenshot({ path: join(shotDir, 'dock-touch-terminal-cookieless.png') });
    const bare = await opened.goto(`${base}/s/browser-success`);
    assert.equal(bare?.status(), 401);
    await cookieless.close();
    await context.close();
  });

  // 宽屏触屏（iPad 横屏）以前两头落空：44px 只写在 max-width: 620px 里。
  await scenario('wide_touch_targets', async () => {
    const context = await browser.newContext({
      viewport: { width: 1194, height: 834 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript({ content: 'globalThis.__name = (target) => target;' });
    await context.addCookies([{ name: 'dashboard', value: 'ok', url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.goto(`${base}/?scenario=success`);
    await page.locator('.wb-session-list').waitFor();
    const metrics = await page.evaluate(() => {
      const action = document.querySelector('.wb-session-row-action');
      const style = action ? getComputedStyle(action) : null;
      return {
        hoverNone: matchMedia('(hover: none)').matches,
        width: style ? Number.parseFloat(style.width) : 0,
        height: style ? Number.parseFloat(style.height) : 0,
      };
    });
    assert.ok(metrics.hoverNone, 'wide touch context must report (hover: none)');
    assert.ok(metrics.width >= 44 && metrics.height >= 44, `row action below 44px: ${JSON.stringify(metrics)}`);
    // 触屏下行内「接管」整体不渲染：那条通道只读（P1-17）。
    assert.equal(await page.locator('.wb-session-row-action.is-terminal-control').count(), 0);
    assert.ok(await page.locator('.wb-session-row-action.is-terminal').count() > 0);
    await page.screenshot({ path: join(shotDir, 'wide-touch-ipad.png') });
    await context.close();
  });

  // P1-18：带着「宽屏收起过列表」的持久化偏好，在三档视口都要能把列表叫回来并选到会话。
  await scenario('rail_collapsed_recovery', async () => {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 800 }, { width: 390, height: 844 }]) {
      const context = await authenticatedContext(viewport);
      await context.addInitScript({
        content: `try { localStorage.setItem('botmux.agent-workbench.rail.v1', JSON.stringify({ railWidth: 280, railCollapsed: true })); } catch {}`,
      });
      const page = await context.newPage();
      await page.goto(`${base}/?scenario=success`);
      await page.locator('.agent-workbench-page').waitFor();
      if (viewport.width >= 620) {
        // 收起态下列表整个不在 DOM 里——这正是死路的形状：一条点不动的窄条。
        assert.equal(await page.getByRole('option').count(), 0, `${viewport.width}px: list must start collapsed`);
        const expand = page.getByRole('button', { name: '展开会话列表' });
        await expand.waitFor();
        await page.screenshot({ path: join(shotDir, `rail-collapsed-${viewport.width}.png`) });
        await expand.click();
        await page.locator('.wb-session-list').waitFor();
        await rowAction(page, /Integrated Workbench browser scenario/, 'terminal');
        await page.locator('.wb-workspace-title strong')
          .filter({ hasText: 'Integrated Workbench browser scenario' }).waitFor();
      } else {
        // 手机档是单列下钻，收起偏好本来就不该生效。
        assert.equal(await page.locator('.wb-rail-expand').count(), 0);
        await page.getByRole('option', { name: /Integrated Workbench browser scenario/ }).click();
        await page.locator('.wb-mobile-detail').waitFor();
      }
      await page.screenshot({ path: join(shotDir, `rail-recovered-${viewport.width}.png`) });
      await context.close();
    }
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

  const head = headCommit();
  const output = {
    ok: true,
    /**
     * 这份结果的**性质**，必须写清楚：它是 component harness。
     *
     * 页面挂的是 `scripts/fixtures/agent-workbench-browser.tsx`——夹具自己
     * `createRoot` 渲染工作台组件，会话数组、登录态、能力集都是硬编码常量，
     * 生产入口 `app.tsx`、`store.ts` 的 bootstrap、真实认证流程一概没跑。
     * 所以这里的全绿只证明「组件在给定 props 下的行为 + 服务端那几个真模块的
     * 契约」，**不能当作生产 H5 / Store / 终端代理跑通的证据**。
     * 生产链路的证据在 `docs/assets/workbench-production-e2e-results.json`
     * （scripts/verify-workbench-production-e2e.ts，harnessType: production-e2e）。
     */
    harnessType: 'component',
    harness: {
      page: 'scripts/fixtures/agent-workbench-browser.tsx (hardcoded sessions / auth / capabilities)',
      productionEntryExercised: false,
      productionStoreExercised: false,
      note: '生产 bundle 的端到端证据见 docs/assets/workbench-production-e2e-results.json',
    },
    head: head.commit,
    worktreeDirty: head.dirty,
    headNote: 'head 是跑这一轮时的 HEAD；worktreeDirty=true 表示工作区还有未提交改动（证据先于提交产生时的常态）',
    fixtureBuild: {
      bundler: 'esbuild (in-process, esm/chrome120)',
      bytes: fixtureJs.byteLength,
      sha256: createHash('sha256').update(fixtureJs).digest('hex'),
    },
    browser: browserPath ? `local executable (${browserPath})` : 'Playwright managed Chromium',
    browserVersion: browser.version(),
    viewportCoverage: ['1440x900', '1280x800', '1194x834 (touch)', '900x800', '390x844 (iPhone 13 profile)', '375x800'],
    screenshots: shotDir,
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
