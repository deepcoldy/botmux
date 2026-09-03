import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright');

/** 和 verify-agent-workbench-browser.ts 用同一套解析顺序。以前这里是
 *  `PLAYWRIGHT_BROWSERS_PATH ||= <repo>/.playwright-browsers`——那个目录并不存在，
 *  等于把 Playwright 自带的 ~/.cache/ms-playwright 一起顶掉，脚本必然起不来。
 *  现在只把它当候选之一，找不到就退回 Playwright 自己管理的浏览器。 */
async function resolveBrowserExecutable() {
  const candidates = [
    process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE?.trim(),
    join(root, '.playwright-browsers', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    join(homedir(), '.cache', 'ui-check', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个；都没有就用 Playwright 自带的那份。
    }
  }
  return undefined;
}

const fixture = join(root, 'scripts', 'fixtures', 'agent-workbench-screenshot.tsx');
const output = join(root, 'docs', 'assets', 'agent-workbench-dark.png');
const css = await readFile(join(root, 'src', 'dashboard', 'web', 'style.css'));
const bundle = await build({
  entryPoints: [fixture],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  write: false,
  logLevel: 'silent',
});
const fixtureJs = bundle.outputFiles[0].contents;

// 标题跟 src/dashboard/web/index.html 一致（Botmux），截图里的标签页名才是产品真名。
const pageHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Botmux</title><link rel="stylesheet" href="/style.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
// 终端 iframe 里放的是一段合成的会话内容，只为让截图里的终端面板看起来像真的在
// 干活。刻意不印任何测试通过数——验收结果的唯一出处是同目录的
// agent-workbench-browser-results.json，截图里再抄一份数字只会各自过期。
const terminalHtml = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0;background:#070a0e;color:#cad5df;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}body{padding:15px 17px;box-sizing:border-box}.dim{color:#5f7182}.cyan{color:#67c7f5}.green{color:#6fd29b}.amber{color:#e2b35c}.cursor{display:inline-block;width:7px;height:13px;background:#67c7f5;vertical-align:-2px}</style></head><body><div class="dim">botmux@workbench  ~/work/botmux  feat/agent-workbench</div><br><div><span class="cyan">❯</span> 把会话列表的行操作收敛成三个：聊天 / 定位 / 终端</div><br><div class="dim">读取 agent-workbench-session-list.tsx</div><div class="dim">读取 agent-workbench-view.tsx</div><div><span class="green">●</span> 行操作浮层改为悬停显示，行高锁在 54px 与虚拟滚动对齐</div><div><span class="green">●</span> 组头改成可折叠按钮（▾ / ▸），折叠状态存本地</div><br><div><span class="amber">?</span> 「定位」只对话题会话可见，群聊/单聊要不要也给一个入口？</div><div><span class="cyan">❯</span> <span class="cursor"></span></div></body></html>';

const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pageHtml);
  } else if (path === '/style.css') {
    response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    response.end(css);
  } else if (path === '/fixture.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(fixtureJs);
  } else if (path.startsWith('/s/')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(terminalHtml);
  } else {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Unable to resolve capture server address');
const browserExecutable = await resolveBrowserExecutable();
const browser = await chromium.launch({
  headless: true,
  ...(browserExecutable ? { executablePath: browserExecutable } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', message => process.stderr.write('[browser console] ' + message.text() + '\n'));
  page.on('pageerror', error => process.stderr.write('[browser error] ' + error.stack + '\n'));
  await page.goto('http://127.0.0.1:' + String(address.port) + '/', { waitUntil: 'networkidle' });
  await page.locator('.agent-workbench-page').waitFor();
  const selectedRow = page.locator('.wb-session-row.is-selected');
  await selectedRow.waitFor();
  // 行操作浮层平时 opacity:0 / pointer-events:none，悬停才出现——先 hover 再点，
  // 否则点击会被铺满整行的聊天锚点（.wb-session-copy-link::after）吃掉。
  await selectedRow.hover();
  // 工作区默认是收起的（.wb-desktop-layout.is-terminal-closed 把它整块隐藏，
  // 会话列表铺满）。终端面板由行内「终端」按钮只读打开，再在面板标题栏点「接管输入」
  // 拿写权限（行内已无接管捷径）——截图要拍的就是接管之后的样子。
  await selectedRow.locator('.wb-session-row-action.is-terminal').click();
  await page.locator('.wb-terminal-pane').waitFor();
  await page.locator('.wb-terminal-pane .wb-pane-actions button', { hasText: '接管输入' }).click();
  await page.locator('.wb-mode-chip.is-controlled').waitFor();
  await page.locator('.wb-pane-frame').waitFor();
  // 面板打开后列表收窄，指针已经不在原来那行上了。重新悬停，让截图里同时留下
  // 行操作（聊天/定位/终端）这条契约。
  await selectedRow.hover();
  await page.locator('.wb-session-row.is-selected .wb-session-row-actions').waitFor();
  await page.screenshot({ path: output, fullPage: false });
  const metrics = await page.evaluate(() => ({
    title: document.title,
    sessions: document.querySelector('.wb-rail-heading > div > span:last-child')?.textContent,
    renderedRows: document.querySelectorAll('.wb-session-row').length,
    rowHeight: Math.round(document.querySelector('.wb-session-row')?.getBoundingClientRect().height ?? 0),
    groupHeaders: document.querySelectorAll('.wb-session-group-toggle').length,
    terminalMode: document.querySelector('.wb-terminal-pane .wb-mode-chip')?.textContent,
    responsiveStep: document.querySelector('.agent-workbench-page')?.getAttribute('data-responsive-step'),
  }));
  // 截图是验收证据，指标对不上就该红，不能悄悄留一张过期的图。
  assert.equal(metrics.title, 'Botmux');
  assert.equal(metrics.sessions, '320');
  assert.ok(metrics.renderedRows > 1 && metrics.renderedRows < 40, 'virtualised rows out of range');
  assert.equal(metrics.rowHeight, 54);
  assert.ok(metrics.groupHeaders >= 2, 'group headers missing');
  assert.match(metrics.terminalMode ?? '', /可输入/);
  assert.equal(metrics.responsiveStep, 'full');
  await writeFile(join(root, 'docs', 'assets', 'agent-workbench-dark.metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, output, browser: browserExecutable ? 'local executable' : 'Playwright managed Chromium', ...metrics }) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
