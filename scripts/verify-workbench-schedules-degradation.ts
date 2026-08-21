#!/usr/bin/env tsx
/**
 * P1-14 回归证据：Workbench-only 身份的生产 SPA 启动后必须有会话列表。
 *
 * 原问题（未修前生产真实可复现）：
 *   store bootstrap 把 `/api/sessions` 与 `/api/schedules` 一起塞进 `Promise.all`
 *   → 飞书 H5 / 平台 teammate 身份走窄门禁，`/api/schedules` 明确 401 + HTML 登录页
 *   → 那份 HTML 让 `.json()` 抛 SyntaxError
 *   → 整个 `Promise.all` 连同**已经成功**的会话快照一起废掉
 *   → `replaceSnapshot` 从不执行，工作台一进去就是空列表。
 *
 * 本脚本用 **生产入口 `src/dashboard/web/app.tsx` 的真实 esbuild 产物**（与
 * `pnpm dashboard:bundle` 同一套配置）+ 真实 Chromium 跑完整启动：服务端按
 * Workbench-only 身份如实回 401（含 `x-botmux-auth-scope: workbench`），断言
 * 会话列表真的渲染出行来，且 `/api/schedules` 一次都没被请求（按能力不发）。
 * 对照组用 legacy owner 身份跑一遍，断言排程照常加载、概览排程区块仍在。
 *
 * 跑法：
 *   npx tsx scripts/verify-workbench-schedules-degradation.ts
 *
 * 反转验证（先红后绿）：把 src/dashboard/web/store.ts 的 reconcile 改回
 *   fetch('/api/schedules').then(r => r.json())  并直接进 Promise.all，
 * 再跑本脚本——workbench 组的会话行数会掉到 0。
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = join(root, 'src', 'dashboard', 'web');
const resultPath = join(root, 'docs', 'assets', 'workbench-schedules-degradation-results.json');
const screenshotDir = join(root, 'docs', 'assets');

type Identity = 'workbench-only' | 'legacy-owner';

const SESSIONS = [
  {
    sessionId: 'sess-alpha',
    status: 'working',
    botName: '小明',
    chatTitle: '客户 ACME 对接群',
    repoName: 'botmux',
    gitBranch: 'feat/alpha',
    lastActivityAt: Date.now(),
  },
  {
    sessionId: 'sess-beta',
    status: 'idle',
    botName: '小红',
    chatTitle: '内部工具群',
    repoName: 'botmux',
    gitBranch: 'main',
    lastActivityAt: Date.now() - 60_000,
  },
];

const SCHEDULES = [
  { id: 'sch-1', name: '每日对账', enabled: true, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() },
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
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

interface RunResult {
  /** 浏览器控制台里 `bootstrap failed` 那一行（未修前正是它把会话快照吃掉的）。 */
  bootstrapError: string | null;
  sessionRows: number;
  sessionTitles: string[];
  scheduleRequests: number;
  overviewScheduleRows: number;
  overviewSchedulePanelPresent: boolean;
  authOverlayVisible: boolean;
}

async function main(): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), 'botmux-workbench-spa-'));
  await bundleProductionSpa(outDir);
  const indexHtml = await readFile(join(webSrc, 'index.html'), 'utf8');
  const styleCss = await readFile(join(webSrc, 'style.css'), 'utf8');

  let identity: Identity = 'workbench-only';
  let scheduleRequests = 0;

  const denyWorkbench = (res: ServerResponse): void => {
    // 与 dashboard.ts 的 deny401 分支逐字对齐：HTML 正文 + workbench 作用域头。
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-botmux-auth-scope': 'workbench',
    });
    res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
  };
  const json = (res: ServerResponse, value: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(indexHtml);
      }
      if (path === '/assets/style.css') {
        res.writeHead(200, { 'content-type': MIME['.css'] });
        return res.end(styleCss);
      }
      if (path.startsWith('/assets/')) {
        // 只服务打包产物目录内的文件（normalize 后必须仍以 outDir 开头）。
        const target = normalize(join(outDir, path.slice('/assets/'.length)));
        if (!target.startsWith(outDir)) { res.writeHead(403); return res.end(); }
        try {
          const body = await readFile(target);
          res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
          return res.end(body);
        } catch {
          res.writeHead(404); return res.end();
        }
      }

      if (path === '/api/sessions') return json(res, { sessions: SESSIONS });
      if (path === '/api/schedules') {
        scheduleRequests += 1;
        if (identity === 'legacy-owner') return json(res, { schedules: SCHEDULES, timezone: 'Asia/Shanghai' });
        return denyWorkbench(res);
      }
      if (path === '/api/settings') {
        if (identity === 'legacy-owner') {
          return json(res, { settings: { publicReadOnly: false }, lang: 'zh', authed: true, bound: false });
        }
        return denyWorkbench(res);
      }
      if (path === '/api/workbench/capabilities') {
        return json(res, {
          ok: true,
          capabilities: identity === 'legacy-owner'
            ? { canLocate: true, canControl: true, canInteract: true }
            : { canLocate: true, canControl: false, canInteract: false },
        });
      }
      if (path === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        return res.write('retry: 5000\n\n');
      }
      if (path === '/api/groups') return json(res, { groups: [], bots: [] });
      if (path === '/api/plugins/dashboard') return json(res, { plugins: [] });

      // 其它管理面 API 对 Workbench-only 身份就是 401；owner 身份给个空壳，
      // 免得脚本被无关端点带偏。
      if (identity === 'legacy-owner') return json(res, { ok: true });
      return denyWorkbench(res);
    })().catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const browserPath = await executablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
  });

  const run = async (as: Identity, screenshot: string): Promise<RunResult> => {
    identity = as;
    scheduleRequests = 0;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

    await page.goto(`${base}/#/agent-workbench`, { waitUntil: 'load' });
    await page.waitForSelector('.wb-session-rail', { timeout: 15_000 }).catch(() => null);
    // 会话行是异步落库的，给 store 一点时间；空列表也会在超时后继续断言。
    await page.waitForSelector('.wb-session-row', { timeout: 8_000 }).catch(() => null);

    const sessionRows = await page.locator('.wb-session-row').count();
    const sessionTitles = await page.locator('.wb-session-row').allInnerTexts();
    const authOverlayVisible = await page.locator('#auth-expired-overlay').isVisible().catch(() => false);
    await page.screenshot({ path: join(screenshotDir, screenshot), fullPage: false });

    // 概览页：排程区块在没有能力时必须整块隐藏，而不是画一个永远为空的面板。
    // 用一次全新的页面加载（而不是改 hash），既贴近用户直接进概览的路径，也顺带
    // 再验一遍「无能力身份第二次启动依然不发 /api/schedules」。
    const overviewPage = await context.newPage();
    await overviewPage.goto(`${base}/#/`, { waitUntil: 'load' });
    await overviewPage.waitForSelector('.overview-root', { timeout: 15_000 });
    await overviewPage.waitForSelector('#recent-sessions li', { timeout: 15_000 }).catch(() => null);
    const overviewSchedulePanelPresent = (await overviewPage.locator('.schedules-panel').count()) > 0;
    const overviewScheduleRows = await overviewPage.locator('#next-schedules li:not(.empty)').count();
    await overviewPage.screenshot({ path: join(screenshotDir, screenshot.replace('.png', '-overview.png')) });
    await overviewPage.close();

    await context.close();
    return {
      bootstrapError: consoleErrors.find(text => text.includes('bootstrap failed')) ?? null,
      sessionRows,
      sessionTitles,
      scheduleRequests,
      overviewScheduleRows,
      overviewSchedulePanelPresent,
      authOverlayVisible,
    };
  };

  try {
    const workbench = await run('workbench-only', 'workbench-schedules-401-h5.png');
    const owner = await run('legacy-owner', 'workbench-schedules-401-owner.png');

    // ── ① Workbench-only：排程 401 不许拖垮会话快照 ───────────────────────────
    assert.equal(
      workbench.sessionRows,
      SESSIONS.length,
      `Workbench-only 身份的会话列表应有 ${SESSIONS.length} 行，实际 ${workbench.sessionRows}`
      + `（bootstrap 错误：${workbench.bootstrapError ?? '无'}）`,
    );
    assert.equal(workbench.bootstrapError, null, `bootstrap 在浏览器里抛了：${workbench.bootstrapError}`);
    const workbenchRowText = workbench.sessionTitles.join('\n');
    for (const marker of ['sess-alpha', 'sess-beta', '小明', '小红']) {
      assert.ok(
        workbenchRowText.includes(marker),
        `会话行没有渲染出真实数据（缺 ${marker}）：${JSON.stringify(workbench.sessionTitles)}`,
      );
    }
    // ② 按能力决定是否请求：没有 schedules 能力就一跳都不发。
    assert.equal(workbench.scheduleRequests, 0, '无能力身份仍然请求了 /api/schedules');
    // ③ 排程区块整块隐藏，不画空面板。
    assert.equal(workbench.overviewSchedulePanelPresent, false, '排程不可用时概览仍渲染了排程面板');
    // ④ 窄门禁 401 不是登录过期，不能盖登录蒙层。
    assert.equal(workbench.authOverlayVisible, false, 'Workbench-only 身份被误判成登录过期');

    // ── ⑤ 对照组：管理身份行为不变 ───────────────────────────────────────────
    assert.equal(owner.sessionRows, SESSIONS.length, 'owner 身份的会话列表退化了');
    assert.equal(owner.bootstrapError, null, `owner 身份 bootstrap 抛了：${owner.bootstrapError}`);
    assert.equal(owner.scheduleRequests > 0, true, 'owner 身份没有请求 /api/schedules');
    assert.equal(owner.overviewSchedulePanelPresent, true, 'owner 身份丢失了概览排程面板');
    assert.equal(owner.overviewScheduleRows, SCHEDULES.length, 'owner 身份的排程行没有渲染');

    const output = {
      ok: true,
      subject: 'P1-14 workbench bootstrap tolerates a schedules 401',
      bundle: 'production entry src/dashboard/web/app.tsx (same esbuild config as pnpm dashboard:bundle)',
      browser: browserPath ? 'local executable' : 'Playwright managed Chromium',
      screenshots: [
        'docs/assets/workbench-schedules-401-h5.png',
        'docs/assets/workbench-schedules-401-h5-overview.png',
        'docs/assets/workbench-schedules-401-owner.png',
        'docs/assets/workbench-schedules-401-owner-overview.png',
      ],
      workbenchOnly: workbench,
      legacyOwner: owner,
    };
    await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await browser.close();
    await closeServer(server);
  }
}

await main();
