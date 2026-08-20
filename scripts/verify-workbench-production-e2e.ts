#!/usr/bin/env tsx
/**
 * 生产 bundle 端到端验收（harnessType: production-e2e）。
 *
 * 为什么要有这一份：`verify-agent-workbench-browser.ts` 挂的是
 * `scripts/fixtures/agent-workbench-browser.tsx`——它自己 `createRoot` 渲染工作台
 * 组件，会话数组、登录态、能力集全是硬编码常量。那套用例能证明「组件按这些 props
 * 渲染成什么样」，但**证明不了生产**：真实用户拿到的是 `app.tsx` 打出来的整份 SPA，
 * 会话来自 `store.bootstrap()` 的 `/api/sessions` 快照，登录态来自 `/api/settings`
 * 的 401 作用域头，能力集来自 `/api/workbench/capabilities`。批 1/批 2 的
 * 「13/13 全绿」因此只是 component harness 的绿，不是生产链路的绿。
 *
 * 本脚本把整条链路换成真的：
 *   • 页面 = `src/dashboard/web/app.tsx` 的 esbuild 产物（与 `pnpm dashboard:bundle`
 *     同一套配置），真 `store.ts`、真 `app.tsx` 认证流程、真路由；
 *   • 身份 = 真 `DashboardSessionStore` 签发的飞书 H5 会话 Cookie，服务端用真
 *     `createDashboardH5AuthController().resolve()` 解析；
 *   • 门禁 = 真 `decideWorkbenchH5Auth`（`/api/settings`、`/api/schedules` 的 401
 *     是它判出来的，不是脚本写死的）；能力集 = 真
 *     `projectWorkbenchOperationCapabilities`；
 *   • 终端只读通道 = 真 `mintTerminalViewCapability` + `centralViewLinkPath`，
 *     `/s/<id>` 用真 `terminalViewCapabilityAuthSession` 验签并复核会话存活；
 *   • 预览 = 真 `createPreviewGuardPage` + `createSessionPreviewProxy` + 真
 *     `PreviewInteractionManager`，目标端口带真 `resolvePreviewPortOwner` 证明；
 *   • 控制类写请求 = 真 `ControlCsrfTokens` + `guardControlRequest`（同源 + 一次性
 *     票据），壳里的 `<meta name="botmux-csrf">` 由真 `injectControlCsrfMeta` 注入。
 *
 * 三条断言：
 *   ① P1-14：H5 身份下会话列表**真的**渲染出行来，且 `/api/schedules` 一跳都没发、
 *      登录蒙层没被误弹。这是「schedules 401 不再拖垮会话快照」在生产 bundle 上的证据。
 *   ② P1-17：真 `hasTouch` 移动 context（iPhone 13 profile）下，会话坞的终端链接是
 *      带 `viewToken=` 的同源只读地址；把它拿到**完全没有 Cookie**的上下文里，页面
 *      与 WebSocket 升级都能连上，而裸 `/s/<id>` 的页面与 WS 双双被拒。这正是 iOS
 *      WebView 的处境。
 *   ③ P1-16 / 交互锁：移动端「网页」页签里的 guard 蒙层默认锁定，解锁后收起，点
 *      「立即锁定」重新盖上，且服务端交互状态跟着回到 preview。
 *
 * 跑法：
 *   npx tsx scripts/verify-workbench-production-e2e.ts
 *
 * 反转验证（先红后绿）：
 *   ① 把 `src/dashboard/web/store.ts` 的排程读取改回
 *      `fetch('/api/schedules').then(r => r.json())` 并塞进 `Promise.all`——①
 *      的会话行数掉到 0。
 *   ② 把 `agent-workbench-dock-view.tsx` 的 `wantsViewToken` 改成恒 false（永远发裸
 *      `/s/<id>`）——② 的 `viewToken=` 断言立刻失败，且 cookieless 打开就是 401。
 *   ③ 把 `preview-guard-page.ts` 的 `lock` 分支改成不 `apply()`——③ 的重新锁定失败。
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardSessionStore,
  createDashboardH5AuthController,
  type DashboardAuthIdentity,
  type DashboardH5AuthConfig,
} from '../src/dashboard/h5-auth.js';
import {
  decideWorkbenchH5Auth,
  projectWorkbenchOperationCapabilities,
  type WorkbenchCapabilityActor,
} from '../src/dashboard/auth.js';
import {
  ControlCsrfTokens,
  guardControlRequest,
  injectControlCsrfMeta,
} from '../src/dashboard/control-csrf.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_INTERACTIVE_MODE_LABEL,
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
import type { SessionPreviewTarget } from '../src/core/session-preview.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = join(root, 'src', 'dashboard', 'web');
const resultPath = join(root, 'docs', 'assets', 'workbench-production-e2e-results.json');
const screenshotDir = join(root, 'docs', 'assets');

const SESSION_ID = 'prod-e2e-alpha';
const SECOND_SESSION_ID = 'prod-e2e-beta';
const H5_USER = 'ou_prod_e2e_viewer';
const CONTROL_SECRET = 'production-e2e-control-secret-not-a-real-credential';
const PREVIEW_CAPABILITY_SECRET = 'production-e2e-preview-capability-secret-not-a-real-credential';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const TERMINAL_HTML = '<!doctype html><html><body style="margin:0;background:#070a0e;color:#d8e2ed;font:13px monospace;padding:16px">'
  + '<p id="terminal-mode">LOCAL TERMINAL · COOKIE SESSION</p></body></html>';
const TERMINAL_VIEW_HTML = TERMINAL_HTML.replace('COOKIE SESSION', 'READ-ONLY VIEW CAPABILITY');
const PREVIEW_HTML = '<!doctype html><html><body style="margin:0;background:#101722;color:#d8e2ed;font:14px system-ui;padding:18px">'
  + '<h1>Agent 的 Web 应用</h1><p id="preview-ready">production e2e preview upstream</p></body></html>';

class MemoryAudit implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
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
  const candidates = [
    process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE?.trim(),
    join(homedir(), '.cache', 'ui-check', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* 回落到 Playwright 自带 Chromium */ }
  }
  return undefined;
}

/** 证据要能被复现，就得说清「这份绿是哪个 commit、哪份产物、哪个浏览器跑出来的」。 */
function headCommit(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

/** 与 `pnpm dashboard:bundle` 同一套 esbuild 配置：测的就是要发出去的那份产物。 */
async function bundleProductionSpa(outDir: string): Promise<void> {
  await build({
    entryPoints: { app: join(webSrc, 'app.tsx') },
    bundle: true,
    outdir: outDir,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    minify: true,
    target: 'es2022',
    logLevel: 'silent',
  });
}

const audit = new MemoryAudit();
const csrfTokens = new ControlCsrfTokens();
const terminalControl = new TerminalControlManager({ secret: CONTROL_SECRET, audit, ttlMs: 60_000 });
const previewInteraction = new PreviewInteractionManager({ audit });

const h5Config: DashboardH5AuthConfig = {
  enabled: true,
  brand: 'feishu',
  appId: 'cli_production_e2e',
  appSecret: 'synthetic-production-e2e-secret',
  allowedOpenIds: [H5_USER],
  entryPath: '/auth/feishu',
  sessionTtlMs: 60 * 60_000,
  secureCookies: false,
  // Loopback harness, no proxy in front: x-forwarded-for is not trusted.
  trustedProxyHops: 0,
};
const h5Sessions = new DashboardSessionStore({ ttlMs: h5Config.sessionTtlMs });
const h5Auth = createDashboardH5AuthController({
  config: h5Config,
  sessions: h5Sessions,
  audit,
  exchanger: {
    async exchange() { throw new Error('production e2e seeds the H5 session directly'); },
  },
});

/** worker 每次启动的 view generation。真实 daemon 从 worker 上报的 boot token 推导，
 *  这里把同一个 helper 喂一条合成 upstream URL，token 形状与生产一致。 */
function harnessViewGeneration(): string {
  const derived = upstreamWorkerViewGeneration(
    CONTROL_SECRET,
    'http://127.0.0.1:1/?viewToken=production-e2e-boot-token',
  );
  if (!derived) throw new Error('unable to derive a worker view generation');
  return derived;
}
const viewGeneration = harnessViewGeneration();

/** H5 身份在 dashboard.ts 里被投影成的能力切面（见 request-identity.ts）：终端可接管、
 *  预览可操作，但管理面一律没有。能力集与门禁都由生产函数从这份切面算出来。 */
function capabilityActor(identity: DashboardAuthIdentity): WorkbenchCapabilityActor & TerminalDashboardActor {
  return {
    ...identity,
    kind: 'feishu-h5',
    terminalCapability: 'controlled',
    previewCapability: 'operate',
  };
}

function identityOf(req: IncomingMessage): (WorkbenchCapabilityActor & TerminalDashboardActor) | null {
  const identity = h5Auth.resolve(req);
  return identity ? capabilityActor(identity) : null;
}

const observed = {
  scheduleRequests: 0,
  settingsRequests: 0,
  viewLinkRequests: 0,
  viewTokenTerminalHits: 0,
  cookieTerminalHits: 0,
  terminalUnauthorized: 0,
  viewTokenSockets: 0,
  rejectedSockets: 0,
};

let previewTarget: SessionPreviewTarget | null = null;
function requirePreviewTarget(): SessionPreviewTarget {
  if (!previewTarget) throw new Error('preview target requested before the upstream was listening');
  return previewTarget;
}

function resolvePreview(sessionId: string): PreviewProxyResolution {
  return sessionId === SESSION_ID
    ? { ok: true, target: requirePreviewTarget() }
    : { ok: false, status: 404, error: 'preview_not_registered' };
}

const previewGuard = createPreviewGuardPage({
  authenticated: req => identityOf(req) !== null,
  resolve: resolvePreview,
  mintContentCapability: (req, sessionId) => {
    const identity = identityOf(req);
    return identity
      ? mintPreviewContentCapability(PREVIEW_CAPABILITY_SECRET, sessionId, {
        userId: identity.userId,
        authSessionId: identity.authSessionId,
        expiresAt: identity.expiresAt,
      })
      : null;
  },
  mintCsrfToken: req => {
    const identity = identityOf(req);
    return identity ? csrfTokens.mint(identity.authSessionId) : null;
  },
  // 与工作台按钮同一份投影：H5 身份 previewCapability='operate' ⇒ 解锁入口渲染。
  canInteract: req => projectWorkbenchOperationCapabilities(identityOf(req)).canInteract,
});

const previewProxy = createSessionPreviewProxy({
  authenticated: req => identityOf(req) !== null,
  resolve: resolvePreview,
  verifyContentCapability: (capability, sessionId) =>
    verifyPreviewContentCapability(PREVIEW_CAPABILITY_SECRET, capability, sessionId).ok,
});

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(value));
}

/** 与 dashboard.ts 的 deny401 分支逐字对齐：HTML 正文 + workbench 作用域头。
 *  SPA 的全局 fetch 包装正是靠这个头把「窄门禁的预期 401」与「登录过期」分开。 */
function denyWorkbench(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-botmux-auth-scope': 'workbench',
  });
  res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
}

function sessionRows(): Array<Record<string, unknown>> {
  const now = Date.now();
  return [
    {
      sessionId: SESSION_ID,
      status: 'working',
      title: '生产 E2E 主会话',
      botName: 'Prod Harness',
      cliId: 'codex',
      repoName: 'botmux',
      chatId: 'oc_prod_e2e',
      chatDisplayName: '生产 E2E 群',
      scope: 'thread',
      lastMessageAt: now,
      webPort: frontPort,
      proxyPort: frontPort,
      preview: { path: `/preview/${encodeURIComponent(SESSION_ID)}/`, registeredAt: new Date(now).toISOString() },
    },
    {
      sessionId: SECOND_SESSION_ID,
      status: 'idle',
      title: '生产 E2E 次会话',
      botName: 'Prod Harness',
      cliId: 'claude',
      chatId: 'oc_prod_e2e_2',
      scope: 'thread',
      lastMessageAt: now - 60_000,
      webPort: frontPort,
      proxyPort: frontPort,
    },
  ];
}

let frontPort = 0;
let outDir = '';
let indexHtml = '';
let styleCss = '';

async function handleFront(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // 真实的 H5 登录路由（/auth/feishu、/auth/feishu/session、/auth/feishu/logout）。
  if (await h5Auth.handle(req, res, url)) return;

  // 与 dashboard.ts 同序：预览壳 / 预览代理 / 终端前置代理都在门禁之前自行鉴权。
  if (previewGuard.handle(req, res, url)) return;
  if (await previewProxy.handleHttp(req, res, url)) return;
  if (path === `/s/${encodeURIComponent(SESSION_ID)}` || path.startsWith(`/s/${encodeURIComponent(SESSION_ID)}/`)) {
    return serveTerminal(req, res, url);
  }

  const identity = identityOf(req);
  // 门禁本身来自生产函数：脚本没有一张自己的路径白名单。
  const decision = identity
    ? decideWorkbenchH5Auth({ method, pathname: path })
    : ({ kind: 'deny401' } as const);
  if (path === '/api/schedules') observed.scheduleRequests += 1;
  if (path === '/api/settings') observed.settingsRequests += 1;
  if (decision.kind === 'deny401') {
    // 有身份 ⇒ 这是窄门禁的预期拒绝，带 workbench 作用域头；无身份才是真未登录。
    if (identity) return denyWorkbench(res);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<h1>Token expired</h1>');
    return;
  }
  if (!identity) throw new Error('unreachable: allowed decision without an identity');

  if (path === '/' || path === '/index.html') {
    // 每次加载现签一枚 CSRF 票据注入壳（生产同一条 injectControlCsrfMeta）。
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    return void res.end(injectControlCsrfMeta(indexHtml, csrfTokens.mint(identity.authSessionId)));
  }
  if (path === '/assets/style.css') {
    res.writeHead(200, { 'content-type': MIME['.css'] });
    return void res.end(styleCss);
  }
  if (path.startsWith('/assets/')) {
    const target = normalize(join(outDir, path.slice('/assets/'.length)));
    if (!target.startsWith(outDir)) { res.writeHead(403); return void res.end(); }
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
      return void res.end(body);
    } catch {
      res.writeHead(404);
      return void res.end();
    }
  }

  if (method === 'GET' && path === '/api/sessions') return json(res, 200, { sessions: sessionRows() });
  if (method === 'GET' && path === '/api/workbench/capabilities') {
    return json(res, 200, { ok: true, capabilities: projectWorkbenchOperationCapabilities(identity) });
  }
  if (method === 'GET' && path === '/api/workbench/h5-context') {
    return json(res, 200, {
      ok: true,
      h5: { enabled: true, appId: h5Config.appId, brand: h5Config.brand, entryPath: h5Config.entryPath },
    });
  }
  if (method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    return void res.write('retry: 5000\n\n');
  }

  // P1-5 短时只读能力（本脚本要验的 /view-link，component harness 里根本没有实现）。
  const viewLinkMatch = path.match(/^\/api\/sessions\/([^/]+)\/view-link$/);
  if (method === 'GET' && viewLinkMatch) {
    observed.viewLinkRequests += 1;
    const sessionId = decodeURIComponent(viewLinkMatch[1]);
    const minted = mintTerminalViewCapability(CONTROL_SECRET, sessionId, identity, viewGeneration);
    const link = minted ? centralViewLinkPath(sessionId, minted.token) : null;
    if (!minted || !link) return json(res, 503, { ok: false, error: 'terminal_unavailable' });
    return json(res, 200, { ok: true, url: link, expiresAt: minted.expiresAt });
  }

  const controlMatch = path.match(/^\/api\/sessions\/([^/]+)\/control(?:\/(takeover|release))?$/);
  if (controlMatch) {
    const sessionId = decodeURIComponent(controlMatch[1]);
    const action = controlMatch[2];
    if (method === 'GET' && !action) return json(res, 200, { ok: true, ...terminalControl.state(identity, sessionId) });
    const guard = guardControlRequest({ headers: req.headers, authSessionId: identity.authSessionId, tokens: csrfTokens });
    if (!guard.ok) return json(res, guard.status, { ok: false, error: guard.error });
    if (method === 'POST' && action === 'takeover') {
      const result = terminalControl.takeover(identity, sessionId);
      return json(res, result.ok ? 200 : 409, result.ok ? { ...result, owned: true } : { ok: false, error: result.error });
    }
    if (method === 'POST' && action === 'release') {
      const result = terminalControl.release(identity, sessionId);
      return json(res, result.ok ? 200 : 403, result.ok ? { ...result, owned: false } : { ok: false, error: result.error });
    }
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const interactionMatch = path.match(/^\/api\/sessions\/([^/]+)\/preview-interaction(?:\/(unlock|activity|lock))?$/);
  if (interactionMatch) {
    const sessionId = decodeURIComponent(interactionMatch[1]);
    const action = interactionMatch[2];
    if (method === 'GET' && !action) return json(res, 200, { ok: true, ...previewInteraction.state(identity, sessionId) });
    const guard = guardControlRequest({ headers: req.headers, authSessionId: identity.authSessionId, tokens: csrfTokens });
    if (!guard.ok) return json(res, guard.status, { ok: false, error: guard.error });
    if (method === 'POST' && action === 'unlock') return json(res, 200, { ok: true, ...previewInteraction.unlock(identity, sessionId) });
    if (method === 'POST' && action === 'activity') return json(res, 200, { ok: true, ...previewInteraction.activity(identity, sessionId) });
    if (method === 'POST' && action === 'lock') return json(res, 200, { ok: true, ...previewInteraction.lock(identity, sessionId) });
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  res.writeHead(404);
  res.end('not found');
}

/**
 * 终端前置代理的两条鉴权路，与生产同构：
 *   • Cookie（桌面登录态）；
 *   • `?viewToken=`（触屏 / iOS WebView：WS 升级根本不带 Cookie，凭证必须在 URL 里）。
 * viewToken 走真实验签，并且**再复核一次认证会话是否还活着**——签名有效但会话已登出
 * 的能力必须当场失效（P1-5 的中央撤销）。
 */
function viewTokenAuthSession(sessionId: string, viewToken: string | null): string | null {
  const authSessionId = terminalViewCapabilityAuthSession(CONTROL_SECRET, sessionId, viewToken);
  if (!authSessionId) return null;
  return h5Sessions.liveAuthSession(authSessionId) ? authSessionId : null;
}

function serveTerminal(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const granted = viewTokenAuthSession(SESSION_ID, url.searchParams.get('viewToken'));
  if (granted) {
    observed.viewTokenTerminalHits += 1;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(TERMINAL_VIEW_HTML);
    return;
  }
  if (identityOf(req)) {
    observed.cookieTerminalHits += 1;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(TERMINAL_HTML);
    return;
  }
  observed.terminalUnauthorized += 1;
  json(res, 401, { ok: false, error: 'authentication_required' });
}

// ── 服务端装配 ────────────────────────────────────────────────────────────────
const upstreamSockets = new Set<WebSocket>();
const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': MIME['.html'], 'x-preview-upstream': 'local' });
  res.end(req.url?.startsWith('/ping') ? `preview-ok:${req.url}` : PREVIEW_HTML);
});
const upstreamWss = new WebSocketServer({ server: upstream });
upstreamWss.on('connection', socket => {
  upstreamSockets.add(socket);
  socket.on('message', data => socket.send(`echo:${data.toString()}`));
  socket.on('close', () => upstreamSockets.delete(socket));
});
const upstreamPort = await listen(upstream);

// P1-12：预览目标必须带真的端口持有证明。上游就监听在本进程里，走生产同一条
// resolvePreviewPortOwner 求证。
const upstreamOwner = resolvePreviewPortOwner({ host: '127.0.0.1', port: upstreamPort, ownerPids: [process.pid] });
assert.ok(
  upstreamOwner.ok,
  `拿不到预览上游端口的持有证明（${(upstreamOwner as { reason?: string }).reason}）`,
);
previewTarget = {
  host: '127.0.0.1',
  port: upstreamPort,
  registeredAt: new Date().toISOString(),
  owner: upstreamOwner.proof,
  workerGeneration: 1,
};

const terminalWss = new WebSocketServer({ noServer: true });
const front = createServer((req, res) => {
  void handleFront(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'harness_error' });
    else res.end();
  });
});
front.on('upgrade', (req, socket, head) => {
  if (previewProxy.handleUpgrade(req, socket as Duplex, head)) return;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (!url.pathname.startsWith(`/s/${encodeURIComponent(SESSION_ID)}`)) return socket.destroy();
  // iOS WebView 的关键处境：升级请求里没有 Cookie，只有 URL 上的 viewToken。
  if (!viewTokenAuthSession(SESSION_ID, url.searchParams.get('viewToken')) && !identityOf(req)) {
    observed.rejectedSockets += 1;
    socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    return socket.destroy();
  }
  terminalWss.handleUpgrade(req, socket, head, ws => {
    observed.viewTokenSockets += 1;
    ws.send('terminal-stream-ready');
  });
});
frontPort = await listen(front);
const base = `http://127.0.0.1:${frontPort}`;

// ── 浏览器侧 ──────────────────────────────────────────────────────────────────
interface BootstrapEvidence {
  sessionRows: number;
  rowText: string[];
  scheduleRequests: number;
  settingsRequests: number;
  authOverlayVisible: boolean;
  bootstrapError: string | null;
}

async function h5Cookie(): Promise<{ name: string; value: string; url: string; sameSite: 'Lax' }> {
  const created = h5Sessions.create(H5_USER);
  return { name: DASHBOARD_SESSION_COOKIE, value: created.token, url: base, sameSite: 'Lax' };
}

/** tsx/esbuild 用 `__name` 保留函数名。Playwright 把 evaluate 回调序列化过去时不带
 *  模块前言，所以在隔离上下文里补一个无副作用的同名 helper。 */
async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript({ content: 'globalThis.__name = (target) => target;' });
  return context;
}

async function newH5Context(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await newContext(browser, options);
  await context.addCookies([await h5Cookie()]);
  return context;
}

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function main(): Promise<void> {
  outDir = await mkdtemp(join(tmpdir(), 'botmux-workbench-prod-e2e-'));
  await bundleProductionSpa(outDir);
  indexHtml = await readFile(join(webSrc, 'index.html'), 'utf8');
  styleCss = await readFile(join(webSrc, 'style.css'), 'utf8');

  const browserPath = await executablePath();
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  const findings: Record<string, unknown> = {};

  try {
    // ── ① P1-14：H5 身份进生产工作台，会话列表必须真的有行 ───────────────────
    const bootstrap: BootstrapEvidence = await (async () => {
      observed.scheduleRequests = 0;
      observed.settingsRequests = 0;
      const context = await newH5Context(browser, { viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = consoleErrors(page);
      await page.goto(`${base}/#/agent-workbench`, { waitUntil: 'load' });
      await page.waitForSelector('.wb-session-row', { timeout: 15_000 }).catch(() => null);
      const evidence: BootstrapEvidence = {
        sessionRows: await page.locator('.wb-session-row').count(),
        rowText: await page.locator('.wb-session-row').allInnerTexts(),
        scheduleRequests: observed.scheduleRequests,
        settingsRequests: observed.settingsRequests,
        authOverlayVisible: await page.locator('#auth-expired-overlay').isVisible().catch(() => false),
        bootstrapError: errors.find(text => text.includes('bootstrap failed')) ?? null,
      };
      await page.screenshot({ path: join(screenshotDir, 'workbench-production-e2e-h5-sessions.png') });
      await context.close();
      return evidence;
    })();

    assert.equal(
      bootstrap.sessionRows,
      2,
      `H5 身份的生产工作台应有 2 行会话，实际 ${bootstrap.sessionRows}（bootstrap 错误：${bootstrap.bootstrapError ?? '无'}）`,
    );
    assert.equal(bootstrap.bootstrapError, null, `bootstrap 在浏览器里抛了：${bootstrap.bootstrapError}`);
    const rowText = bootstrap.rowText.join('\n');
    for (const marker of ['生产 E2E 主会话', '生产 E2E 次会话']) {
      assert.ok(rowText.includes(marker), `会话行没有渲染出真实数据（缺 ${marker}）：${JSON.stringify(bootstrap.rowText)}`);
    }
    assert.ok(bootstrap.settingsRequests > 0, 'SPA 没有探测 /api/settings，本次跑的不是真实认证流程');
    assert.equal(bootstrap.scheduleRequests, 0, 'Workbench-only 身份仍然请求了 /api/schedules');
    assert.equal(bootstrap.authOverlayVisible, false, '窄门禁 401 被误判成登录过期，盖了登录蒙层');
    findings.h5Bootstrap = bootstrap;

    // ── ② P1-17：真触屏 context 下，会话坞终端链接必须是 viewToken 只读通道 ────
    const touch = await (async () => {
      const context = await newH5Context(browser, { ...devices['iPhone 13'] });
      const page = await context.newPage();
      await page.goto(`${base}/#/agent-workbench-dock/${encodeURIComponent(SESSION_ID)}`, { waitUntil: 'load' });
      await page.waitForSelector('.agent-workbench-dock', { timeout: 15_000 });
      const environment = await page.evaluate(() => ({
        hoverNone: matchMedia('(hover: none)').matches,
        touchPoints: navigator.maxTouchPoints,
      }));
      assert.ok(
        environment.hoverNone && environment.touchPoints > 0,
        `iPhone profile 必须真的是触屏环境：${JSON.stringify(environment)}`,
      );

      const terminal = page.getByRole('link', { name: '终端链接' });
      await terminal.waitFor({ timeout: 15_000 });
      const href = await terminal.getAttribute('href') ?? '';
      const box = await terminal.boundingBox();
      await page.screenshot({ path: join(screenshotDir, 'workbench-production-e2e-dock-touch.png') });
      await context.close();
      return { environment, href, box };
    })();

    assert.ok(touch.href.includes('viewToken='), `触屏下的终端链接必须带 viewToken：${touch.href}`);
    assert.equal(new URL(touch.href, base).origin, new URL(base).origin, '终端链接被指到了非同源地址');
    assert.ok(touch.box && touch.box.height >= 44, `坞里的终端目标低于 44px：${JSON.stringify(touch.box)}`);
    assert.ok(observed.viewLinkRequests > 0, '生产 Dock 没有请求 /view-link');

    // 决定性的一步：把这条链接拿到**完全没有 Cookie**的上下文里打开——iOS WebView
    // 发 WS 升级时正是这个处境。页面与 WS 都要通，裸 /s/<id> 则页面与 WS 双双被拒。
    const cookieless = await (async () => {
      const context = await newContext(browser, { ...devices['iPhone 13'] });
      const page = await context.newPage();
      const opened = await page.goto(new URL(touch.href, base).toString());
      const openedStatus = opened?.status() ?? 0;
      await page.getByText('READ-ONLY VIEW CAPABILITY').waitFor({ timeout: 10_000 });
      const socket = await page.evaluate(async viewHref => {
        const wsUrl = new URL(viewHref, location.origin);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const dial = (url: string) => new Promise<string>(resolve => {
          const ws = new WebSocket(url);
          const timer = setTimeout(() => { ws.close(); resolve('timeout'); }, 5_000);
          ws.addEventListener('message', event => {
            clearTimeout(timer);
            ws.close();
            resolve(`message:${String(event.data)}`);
          });
          ws.addEventListener('error', () => { clearTimeout(timer); resolve('error'); });
          ws.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); });
        });
        const bare = new URL(wsUrl.toString());
        bare.search = '';
        return { withToken: await dial(wsUrl.toString()), bare: await dial(bare.toString()) };
      }, touch.href);
      await page.screenshot({ path: join(screenshotDir, 'workbench-production-e2e-cookieless-terminal.png') });
      const bare = await page.goto(`${base}/s/${encodeURIComponent(SESSION_ID)}`);
      const bareStatus = bare?.status() ?? 0;
      await context.close();
      return { openedStatus, socket, bareStatus };
    })();

    assert.equal(cookieless.openedStatus, 200, '带 viewToken 的终端页在无 Cookie 上下文里打不开');
    assert.equal(
      cookieless.socket.withToken,
      'message:terminal-stream-ready',
      `viewToken WebSocket 没连上：${cookieless.socket.withToken}`,
    );
    assert.notEqual(cookieless.socket.bare, 'message:terminal-stream-ready', '裸 /s/<id> 的 WebSocket 不该被放行');
    assert.equal(cookieless.bareStatus, 401, `裸 /s/<id> 应当 401，实际 ${cookieless.bareStatus}`);
    assert.ok(observed.rejectedSockets > 0, '服务端没有拒绝任何无凭证的 WS 升级，断言会落空');
    findings.touchViewToken = {
      environment: touch.environment,
      hrefHasViewToken: true,
      actionHeight: touch.box?.height ?? 0,
      cookielessPageStatus: cookieless.openedStatus,
      cookielessSocket: cookieless.socket,
      bareTerminalStatus: cookieless.bareStatus,
      viewLinkRequests: observed.viewLinkRequests,
    };

    // ── ③ guard 蒙层：默认锁定 → 解锁 → 立即锁定 ──────────────────────────────
    const guard = await (async () => {
      const context = await newH5Context(browser, { ...devices['iPhone 13'] });
      const page = await context.newPage();
      await page.goto(`${base}/#/agent-workbench/${encodeURIComponent(SESSION_ID)}`, { waitUntil: 'load' });
      await page.waitForSelector('.agent-workbench-page[data-responsive-step="mobile-stack"]', { timeout: 15_000 });
      await page.getByRole('option', { name: /生产 E2E 主会话/ }).click();
      await page.locator('.wb-mobile-detail').waitFor({ timeout: 10_000 });
      await page.locator('.wb-mobile-detail-seg').getByRole('button', { name: '网页' }).click();
      await page.locator('.wb-web-pane').waitFor({ timeout: 10_000 });
      const shell = page.frameLocator('.wb-web-pane iframe.wb-pane-frame');
      await shell.locator('#overlay:not(.hidden)').waitFor({ timeout: 10_000 });
      const lockedByDefault = true;
      await page.screenshot({ path: join(screenshotDir, 'workbench-production-e2e-guard-locked.png') });

      await page.locator('.wb-web-pane').getByRole('button', { name: '开启交互' }).click();
      await page.locator('.wb-mode-chip.is-interactive').waitFor({ timeout: 10_000 });
      await shell.locator('#overlay').waitFor({ state: 'hidden', timeout: 10_000 });
      const unlockedBadge = (await shell.locator('#badge').innerText()).trim();
      await page.screenshot({ path: join(screenshotDir, 'workbench-production-e2e-guard-unlocked.png') });

      await page.locator('.wb-web-pane').getByRole('button', { name: '立即锁定' }).click();
      await page.locator('.wb-mode-chip.is-preview').waitFor({ timeout: 10_000 });
      await shell.locator('#overlay:not(.hidden)').waitFor({ timeout: 10_000 });
      const relockedBadge = (await shell.locator('#badge').innerText()).trim();
      await context.close();
      return { lockedByDefault, unlockedBadge, relockedBadge };
    })();

    assert.equal(guard.lockedByDefault, true, '预览默认必须是锁定的蒙层态');
    // 标签对的是生产常量本身，不是抄一份字面量——文案改了这里跟着改，不会假绿。
    assert.equal(guard.unlockedBadge, PREVIEW_INTERACTIVE_MODE_LABEL, `解锁后标签不对：「${guard.unlockedBadge}」`);
    assert.equal(guard.relockedBadge, PREVIEW_DEFAULT_MODE_LABEL, `重新锁定后标签不对：「${guard.relockedBadge}」`);
    const guardActions = audit.records.map(record => record.action);
    assert.ok(guardActions.includes('preview.unlock'), '服务端没有记录到解锁');
    assert.ok(guardActions.includes('preview.lock'), '服务端没有记录到显式锁定');
    findings.guardOverlay = { ...guard, auditActions: guardActions };

    const head = headCommit();
    const output = {
      ok: true,
      harnessType: 'production-e2e',
      subject: 'H5 身份 + 真实触屏下的生产 Workbench 端到端验收（P1-14 / P1-17 / guard lock）',
      bundle: {
        entry: 'src/dashboard/web/app.tsx',
        config: 'same esbuild options as pnpm dashboard:bundle (bundle+splitting+minify, target es2022)',
      },
      identity: 'feishu-h5 session cookie minted by the real DashboardSessionStore',
      productionModules: [
        'src/dashboard/web/app.tsx + store.ts (real SPA bootstrap)',
        'src/dashboard/h5-auth.ts (session store + controller.resolve)',
        'src/dashboard/auth.ts (decideWorkbenchH5Auth + projectWorkbenchOperationCapabilities)',
        'src/dashboard/terminal-view-capability.ts (mint + centralViewLinkPath + verify)',
        'src/dashboard/control-csrf.ts (ControlCsrfTokens + guardControlRequest + injectControlCsrfMeta)',
        'src/dashboard/preview-guard-page.ts + preview-proxy.ts + preview-interaction.ts',
        'src/core/preview-port-owner.ts (real listening-port ownership proof)',
      ],
      head: head.commit,
      worktreeDirty: head.dirty,
      headNote: 'head 是跑这一轮时的 HEAD；worktreeDirty=true 表示工作区还有未提交改动（证据先于提交产生时的常态）',
      browser: browserPath ? `local executable (${browserPath})` : 'Playwright managed Chromium',
      browserVersion: browser.version(),
      viewports: ['1440x900 (desktop, H5 cookie)', '390x844 iPhone 13 profile (hasTouch)'],
      screenshots: [
        'docs/assets/workbench-production-e2e-h5-sessions.png',
        'docs/assets/workbench-production-e2e-dock-touch.png',
        'docs/assets/workbench-production-e2e-cookieless-terminal.png',
        'docs/assets/workbench-production-e2e-guard-locked.png',
        'docs/assets/workbench-production-e2e-guard-unlocked.png',
      ],
      observed,
      findings,
    };
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await browser.close();
    for (const socket of upstreamSockets) socket.terminate();
    await new Promise<void>(resolve => upstreamWss.close(() => resolve()));
    await new Promise<void>(resolve => terminalWss.close(() => resolve()));
    await closeServer(front);
    await closeServer(upstream);
  }
}

await main();
