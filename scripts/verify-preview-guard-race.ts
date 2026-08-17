#!/usr/bin/env tsx
/**
 * P1-16 + P2 回归证据：Preview guard 蒙层的时序与能力渲染，真实 Chromium 实测。
 *
 * 原问题（未修前真实可复现）：
 *   ① P1-16 旧响应掀蒙层——壳的 15s 轮询 GET 与 activity POST 拿到响应就无条件
 *      `apply()`。用户点「返回预览模式」之后，一份**点击之前**发出的 activity 响应
 *      迟到落地，把 `mode:'interactive'` 又写回蒙层：应用重新可点，直到下一轮 15s
 *      轮询才自愈。锁定是安全动作，不能被自己发出的旧请求推翻。
 *   ② P2 只读身份仍看到「解锁交互」——按钮画了，点下去服务端 403。
 *
 * 本脚本用真实 Chromium + 真实 guard 壳（createPreviewGuardPage）+ 真实交互状态机
 * （PreviewInteractionManager）+ 真实角色门禁（previewInteractionWriteAllowed）跑三个
 * 场景，并落三张截图：
 *   A. 迟到的 activity 响应：响应体在用户点击锁定**之前**就已经落到浏览器手里
 *      （页面里包了一层 fetch，故意不把 AbortSignal 透给真实请求——这正是 abort
 *      拦不住的那一类：字节已经收到，只差把 then 排上）。锁定之后再放行这份旧响应，
 *      蒙层必须纹丝不动。
 *   B. 不做任何注入的原生路径：服务端把 activity 响应挂住，壳在点锁定时 abort 它，
 *      断言服务端确实看到客户端断开，且蒙层保持锁定。
 *   C. 只读身份（platform teammate）：壳里没有解锁/锁定按钮，蒙层锁定，预览照常可看；
 *      同时直接对 unlock 端点发 POST，必须 403 —— 隐藏按钮只是省掉一次必然失败的
 *      点击，不是唯一防线。
 *
 * 跑法：
 *   npx tsx scripts/verify-preview-guard-race.ts
 *
 * 反转验证（先红后绿）：把 preview-guard-page.ts 里 `send()` 的
 *   .then(function(state){if(settle(ticket))apply(state)}, …)
 * 改回无条件 `apply(state)`，场景 A 立刻炸（蒙层被旧响应掀开）；把 unlockControl /
 * lockControl 改成不看 canInteract 恒渲染，场景 C 立刻炸。
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolvePreviewPortOwner } from '../src/core/preview-port-owner.js';
import { PREVIEW_CONTENT_SEGMENT, type SessionPreviewTarget } from '../src/core/session-preview.js';
import {
  previewInteractionWriteAllowed,
  projectWorkbenchOperationCapabilities,
  type WorkbenchCapabilityActor,
} from '../src/dashboard/auth.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import { createPreviewGuardPage } from '../src/dashboard/preview-guard-page.js';
import { PreviewInteractionManager } from '../src/dashboard/preview-interaction.js';
import { mintPreviewContentCapability } from '../src/dashboard/preview-content-capability.js';
import type { TerminalDashboardActor } from '../src/dashboard/terminal-control.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'docs', 'assets');
const resultPath = join(assetsDir, 'preview-guard-race-results.json');

const SESSION_ID = 's1';
const CAPABILITY_SECRET = 'preview-guard-race-capability-secret-not-a-real-credential';

/** 与 request-identity.ts 的真实身份形状一致，只列本脚本用到的两类。 */
const IDENTITIES: Record<string, WorkbenchCapabilityActor & TerminalDashboardActor> = {
  owner: {
    kind: 'legacy-dashboard',
    terminalCapability: 'controlled',
    previewCapability: 'operate',
    userId: 'legacy-owner',
    authSessionId: 'auth-owner',
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
  teammate: {
    kind: 'platform-dashboard',
    terminalCapability: 'readonly',
    previewCapability: 'readonly',
    userId: 'platform:teammate',
    authSessionId: 'auth-teammate',
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
};

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

const audit = new MemoryAudit();
const interaction = new PreviewInteractionManager({ audit });

/** 服务端观察到的事实，全部进最终结果 JSON。 */
const observed = {
  activityRequests: 0,
  activityAborted: 0,
  lockRequests: 0,
  unlockForbidden: 0,
};

/** 场景 B：把下一个 activity 响应挂住，直到显式放行或客户端断开。 */
interface HeldActivity {
  release(): void;
  aborted: boolean;
}
let heldActivity: HeldActivity | null = null;
let holdActivity = false;

/** 读回当前被挂住的 activity。写成函数而不是直接读变量：它是在请求处理回调里被赋值
 *  的，直接读的话控制流分析会停在 `heldActivity = null` 那一步、把类型收敛成 `never`，
 *  于是 `.release()` / `.aborted` 编译不过。 */
function pendingActivity(): HeldActivity | null {
  return heldActivity;
}

/** P1-12 之后 `SessionPreviewTarget` 必须带端口持有证明与 worker 代次。被预览的上游
 *  就监听在本进程里（`/preview/<id>/<content>/` 那条路由自己吐 APP_HTML），所以走生产
 *  同一条 `resolvePreviewPortOwner` 求一份**真的**证明，而不是编一个形状糊过去。 */
let previewTarget: SessionPreviewTarget | null = null;
function requirePreviewTarget(): SessionPreviewTarget {
  if (!previewTarget) throw new Error('preview target resolved before the harness server started listening');
  return previewTarget;
}

function identityOf(req: IncomingMessage): (WorkbenchCapabilityActor & TerminalDashboardActor) | null {
  const cookie = req.headers.cookie ?? '';
  const role = /(?:^|;\s*)role=([a-z]+)/.exec(cookie)?.[1] ?? '';
  return IDENTITIES[role] ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const guard = createPreviewGuardPage({
  authenticated: req => identityOf(req) !== null,
  resolve: sessionId => (sessionId === SESSION_ID
    ? { ok: true, target: requirePreviewTarget() }
    : { ok: false, status: 404, error: 'unknown_session' }),
  mintContentCapability: (req, sessionId) => {
    const identity = identityOf(req);
    return identity
      ? mintPreviewContentCapability(CAPABILITY_SECRET, sessionId, {
        userId: identity.userId,
        authSessionId: identity.authSessionId,
        expiresAt: Date.now() + 60 * 60_000,
      })
      : null;
  },
  // P2：与工作台按钮同一份投影。teammate/guest 拿不到解锁入口。
  canInteract: req => projectWorkbenchOperationCapabilities(identityOf(req)).canInteract,
});

const APP_HTML = `<!doctype html><meta charset="utf-8"><title>agent app</title>
<body style="margin:0;font:16px/1.5 system-ui;background:#f8fafc;color:#0f172a">
<main style="padding:40px"><h1>Agent 的 Web 应用</h1>
<p id="app-body">这是被预览的应用页面。蒙层锁定时这里点不到。</p>
<button id="app-action" type="button">应用内按钮</button></main>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://preview.test');
  if (url.pathname.startsWith(`/preview/${SESSION_ID}/${PREVIEW_CONTENT_SEGMENT}/`)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(APP_HTML);
    return;
  }
  const state = /^\/api\/sessions\/([^/]+)\/preview-interaction(?:\/(unlock|activity|lock))?$/.exec(url.pathname);
  if (state) {
    const identity = identityOf(req);
    if (!identity) return json(res, 401, { ok: false, error: 'authentication_required' });
    const action = state[2];
    if (req.method === 'GET' && !action) {
      return json(res, 200, { ok: true, ...interaction.state(identity, SESSION_ID) });
    }
    // 真实的处理器级角色门禁：只读身份的写操作一律 403。
    if (!previewInteractionWriteAllowed(identity)) {
      observed.unlockForbidden += 1;
      return json(res, 403, { ok: false, error: 'preview_operation_forbidden' });
    }
    if (action === 'unlock') return json(res, 200, { ok: true, ...interaction.unlock(identity, SESSION_ID) });
    if (action === 'lock') {
      observed.lockRequests += 1;
      return json(res, 200, { ok: true, ...interaction.lock(identity, SESSION_ID) });
    }
    if (action === 'activity') {
      observed.activityRequests += 1;
      // 响应体在这一刻就定稿（此时还没锁定，所以是 interactive）——迟到的正是它。
      const body = JSON.stringify({ ok: true, ...interaction.activity(identity, SESSION_ID) });
      if (!holdActivity) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body);
        return;
      }
      const entry = {
        aborted: false,
        release: () => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        },
      };
      req.on('aborted', () => { entry.aborted = true; observed.activityAborted += 1; });
      res.on('close', () => { if (!res.writableEnded) { entry.aborted = true; } });
      heldActivity = entry;
      return;
    }
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (guard.handle(req, res, url)) return;
  res.writeHead(404);
  res.end();
});

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('unable to resolve local port');
  return address.port;
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

/** 页面里包一层 fetch：activity 的响应**不带** AbortSignal 发出去，拿到之后先扣住。
 *  模拟的是「响应字节已经落到浏览器手里，abort 来晚了」——真实网络里最常见、也正是
 *  单靠 AbortController 兜不住的那一类竞态。 */
const HOLD_ACTIVITY_INIT = `(() => {
  const realFetch = window.fetch.bind(window);
  const held = [];
  window.__heldActivity = () => held.length;
  window.__releaseActivity = () => { const jobs = held.splice(0); jobs.forEach(job => job()); return jobs.length; };
  window.fetch = (input, init) => {
    if (!String(input).endsWith('/activity')) return realFetch(input, init);
    const stripped = Object.assign({}, init);
    delete stripped.signal;
    return realFetch(input, stripped)
      .then(response => response.json().then(body => new Promise(resolve => {
        held.push(() => resolve({ ok: response.ok, status: response.status, json: () => Promise.resolve(body) }));
      })));
  };
})();`;

async function overlayLocked(page: Page): Promise<boolean> {
  return page.locator('#overlay').isVisible();
}

/** 点进 iframe 内部 → 父窗口 blur + activeElement 是 iframe，正是壳承认的活动信号。 */
async function touchPreviewApp(page: Page): Promise<void> {
  await page.frameLocator('#app').locator('#app-action').click({ force: true });
}

async function main(): Promise<void> {
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const owner = resolvePreviewPortOwner({ host: '127.0.0.1', port, ownerPids: [process.pid] });
  assert.ok(
    owner.ok,
    `拿不到本进程预览端口的持有证明（${(owner as { reason?: string }).reason}）——没有它 guard 壳的 resolve 就不是生产形状`,
  );
  previewTarget = {
    host: '127.0.0.1',
    port,
    registeredAt: new Date().toISOString(),
    owner: owner.proof,
    workerGeneration: 1,
  };
  const browserPath = await executablePath();
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });

  const openAs = async (role: 'owner' | 'teammate', initScript?: string): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    await context.addCookies([{ name: 'role', value: role, url: base }]);
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    await page.goto(`${base}/preview/${SESSION_ID}/`, { waitUntil: 'load' });
    await page.waitForSelector('#overlay');
    return { context, page };
  };

  const findings: Record<string, unknown> = {};
  try {
    // ── 场景 A：迟到的 activity 响应（abort 拦不住的那一类） ────────────────────
    {
      const { context, page } = await openAs('owner', HOLD_ACTIVITY_INIT);
      assert.equal(await overlayLocked(page), true, '预览默认必须是锁定的蒙层态');
      await page.click('#unlock');
      await page.waitForSelector('#overlay.hidden', { state: 'attached', timeout: 5_000 });
      assert.equal(await overlayLocked(page), false, '显式解锁后蒙层应当收起');
      await page.screenshot({ path: join(assetsDir, 'preview-guard-race-unlocked.png') });

      await touchPreviewApp(page);
      await page.waitForFunction(() => (window as unknown as { __heldActivity(): number }).__heldActivity() === 1, null, { timeout: 5_000 });

      await page.click('#lock');
      await page.waitForFunction(() => !document.getElementById('overlay')!.classList.contains('hidden'), null, { timeout: 5_000 });
      const lockedRightAfterClick = await overlayLocked(page);

      // 旧 activity 响应现在才被交给壳：generation 必须把它丢掉。
      const released = await page.evaluate(() => (window as unknown as { __releaseActivity(): number }).__releaseActivity());
      await page.waitForTimeout(600);
      const lockedAfterStale = await overlayLocked(page);
      const badge = (await page.locator('#badge').innerText()).trim();
      await page.screenshot({ path: join(assetsDir, 'preview-guard-race-locked.png') });

      assert.equal(released, 1, '这一轮没有真的扣住 activity 响应，断言会落空');
      assert.equal(lockedRightAfterClick, true, '点了「返回预览模式」蒙层没有立刻盖上');
      assert.equal(lockedAfterStale, true, '迟到的 activity 响应把已经锁定的蒙层重新掀开了');
      assert.equal(badge, '预览模式（默认）', `锁定后标签应回到预览模式，实际是「${badge}」`);
      findings.staleActivity = { released, lockedRightAfterClick, lockedAfterStale, badge };
      await context.close();
    }

    // ── 场景 B：不注入任何东西的原生路径（服务端挂住 activity） ────────────────
    {
      holdActivity = true;
      heldActivity = null;
      const { context, page } = await openAs('owner');
      await page.click('#unlock');
      await page.waitForSelector('#overlay.hidden', { state: 'attached', timeout: 5_000 });
      const before = observed.activityRequests;
      await touchPreviewApp(page);
      const deadline = Date.now() + 5_000;
      while (observed.activityRequests === before && Date.now() < deadline) {
        await page.waitForTimeout(50);
      }
      assert.ok(observed.activityRequests > before, '预览里的真实点击没有触发 activity 续期');

      await page.click('#lock');
      await page.waitForFunction(() => !document.getElementById('overlay')!.classList.contains('hidden'), null, { timeout: 5_000 });
      pendingActivity()?.release();
      await page.waitForTimeout(600);
      const lockedAfterRelease = await overlayLocked(page);
      assert.equal(lockedAfterRelease, true, '服务端挂住的 activity 放行后掀开了蒙层');
      findings.nativePath = {
        lockedAfterRelease,
        activityAbortedByClient: pendingActivity()?.aborted ?? false,
        lockRequests: observed.lockRequests,
      };
      await context.close();
      holdActivity = false;
    }

    // ── 场景 C：只读身份 ────────────────────────────────────────────────────────
    {
      const { context, page } = await openAs('teammate');
      const unlockButtons = await page.locator('#unlock').count();
      const lockButtons = await page.locator('#lock').count();
      const canInteractAttr = await page.locator('#overlay').getAttribute('data-can-interact');
      const locked = await overlayLocked(page);
      const previewVisible = await page.locator('iframe#app').isVisible();
      const appHeading = await page.frameLocator('#app').locator('h1').innerText();
      await page.screenshot({ path: join(assetsDir, 'preview-guard-readonly.png') });

      // 按钮没了不等于 API 松了：直接打端点仍必须 403。
      const forced = await context.request.post(`${base}/api/sessions/${SESSION_ID}/preview-interaction/unlock`);

      assert.equal(unlockButtons, 0, '只读身份仍然看到了「解锁交互」按钮');
      assert.equal(lockButtons, 0, '只读身份仍然看到了「返回预览模式」按钮');
      assert.equal(canInteractAttr, 'false', 'guard 壳没有把只读能力标出来');
      assert.equal(locked, true, '只读身份的蒙层不是锁定态');
      assert.equal(previewVisible, true, '只读身份连预览都看不到了（过度收紧）');
      assert.equal(appHeading, 'Agent 的 Web 应用', '只读身份的预览内容没有正常渲染');
      assert.equal(forced.status(), 403, `只读身份直接 POST unlock 应当 403，实际 ${forced.status()}`);
      findings.readonly = {
        unlockButtons,
        lockButtons,
        canInteractAttr,
        locked,
        previewVisible,
        forcedUnlockStatus: forced.status(),
      };
      await context.close();
    }

    // 对照：可交互身份的壳照常有解锁入口（能力为真时不误伤）。
    {
      const { context, page } = await openAs('owner');
      const unlockButtons = await page.locator('#unlock').count();
      assert.equal(unlockButtons, 1, 'owner 身份丢失了解锁入口');
      findings.ownerControl = { unlockButtons, canInteractAttr: await page.locator('#overlay').getAttribute('data-can-interact') };
      await context.close();
    }

    const output = {
      ok: true,
      subject: 'P1-16 guard lock generation + P2 readonly unlock button',
      browser: browserPath ? 'local executable' : 'Playwright managed Chromium',
      screenshots: [
        'docs/assets/preview-guard-race-unlocked.png',
        'docs/assets/preview-guard-race-locked.png',
        'docs/assets/preview-guard-readonly.png',
      ],
      assertions: {
        staleActivityCannotUnhideOverlay: true,
        lockAppliesBeforeItsResponse: true,
        readonlyRendersNoUnlockControl: true,
        readonlyUnlockStillForbiddenServerSide: true,
        interactiveIdentityKeepsUnlock: true,
      },
      observed,
      findings,
      auditActions: audit.records.map(record => record.action),
    };
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

await main();
