/** Synthetic Dashboard browser verification for per-group reply mode; no live bots or IM requests. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs/assets/group-reply-mode');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageDialog } from './src/dashboard/web/groups-page.tsx';
import { t } from './src/dashboard/web/ui.ts';
const defaults = { 'app-a': 'chat', 'app-b': 'chat-topic' };
const chat = { chatId: 'oc_demo', name: '项目讨论群', ownerId: 'app-a', chatMode: 'group', memberBots: [
  { larkAppId: 'app-a', botName: '开发助手', inChat: true, agentCliId: 'codex' },
  { larkAppId: 'app-b', botName: '文档助手', inChat: true, agentCliId: 'claude-code' },
] };
const overrides = JSON.parse(localStorage.getItem('fixtureOverrides') || '{"app-b":"new-topic"}');
window.fixtureWrites = [];
window.fetch = async (url, init) => {
  const path = String(url);
  if (path.includes('/chat-mode/')) {
    window.fixtureProbes = (window.fixtureProbes || 0) + 1;
    return new Response(JSON.stringify({ok:true,chatId:'oc_demo',chatMode:localStorage.getItem('fixtureTopology') || 'group'}));
  }
  if (path.includes('/reply-mode/')) {
    const { mode } = JSON.parse(init.body);
    const appId = path.split('/').at(-1);
    window.fixtureWrites.push({ path, mode });
    if (window.fixtureFailure) return new Response(JSON.stringify({ok:false,error:'chat_mode_unconfirmed'}), {status:503});
    if (mode === 'inherit') delete overrides[appId]; else overrides[appId] = mode === 'topic' ? 'shared' : mode;
    localStorage.setItem('fixtureOverrides', JSON.stringify(overrides));
    return new Response(JSON.stringify({ok:true,override:overrides[appId] ?? null}));
  }
  if (path.includes('/cli-options/models')) return new Response(JSON.stringify({models:['gpt-5'],source:'static'}));
  if (path.startsWith('/api/cli-options')) return new Response(JSON.stringify({options:[]}));
  return new Response(JSON.stringify({ok:true,members:[],subjects:[],raw:[],resolved:[],grants:[]}));
};
function state(appId){const o=overrides[appId]??null;return {override:o,default:defaults[appId],effective:o??defaults[appId],inherited:o===null};}
function snapshot(){return {...chat, memberBots:chat.memberBots.map(bot=>({...bot,replyMode:state(bot.larkAppId)}))};}
function App(){const [current,setCurrent]=useState(snapshot); return <ManageDialog chat={current} tr={t} onClose={()=>{}}
  onReloadGroups={async()=>{const next=snapshot();setCurrent(next);return {chats:[next],bots:next.memberBots};}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false });
const css = await readFile(join(root, 'src/dashboard/web/style.css'));
const html = `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:20px;background:var(--bg);overflow:auto}#g-drawer{width:min(100%,760px);margin:auto}#root{padding:16px}@media(max-width:500px){body{padding:0}#root{padding:12px}}</style></head><body><div id="g-drawer"><div id="root"></div></div><script>localStorage.setItem('botmux.dashboard.locale','zh')</script><script type="module" src="/app.js"></script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('content-type', path === '/app.js' ? 'text/javascript' : path === '/style.css' ? 'text/css' : 'text/html');
  res.end(path === '/app.js' ? bundle.outputFiles[0].contents : path === '/style.css' ? css : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.BOTMUX_BROWSER_EXECUTABLE ? { executablePath: process.env.BOTMUX_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = page.locator('[data-group-reply-mode]');
  await card.waitFor();
  const rowA = card.locator('[data-group-reply-mode-row="app-a"]');
  const rowB = card.locator('[data-group-reply-mode-row="app-b"]');
  assert.equal(await rowA.locator('select').inputValue(), 'inherit');
  assert.match(await rowA.locator('.group-reply-mode-source').textContent(), /继承 Bot 默认/);
  assert.equal(await rowB.locator('select').inputValue(), 'new-topic');
  assert.match(await rowB.locator('.group-reply-mode-source').textContent(), /本群覆盖/);
  await rowA.locator('select').selectOption('shared');
  await rowA.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites.at(-1)), { path: '/api/groups/oc_demo/reply-mode/app-a', mode: 'shared' });
  await page.reload();
  await card.waitFor();
  assert.equal(await rowA.locator('select').inputValue(), 'shared');
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile.png') });
  await page.evaluate(() => { window.fixtureFailure = true; });
  await rowA.locator('select').selectOption('chat');
  await rowA.getByRole('status').filter({ hasText: '暂时无法确认群类型' }).waitFor();
  assert.equal(await rowA.locator('select').inputValue(), 'shared');
  await page.evaluate(() => { window.fixtureFailure = false; });
  await rowA.locator('select').selectOption('inherit');
  await rowA.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await rowA.locator('select').inputValue(), 'inherit');
  assert.equal(await page.evaluate(() => window.fixtureProbes), 1);

  // 普通群（chat_mode=group）已切成话题布局：单群查询返回 topic → 只能清除休眠覆盖。
  await page.evaluate(() => localStorage.setItem('fixtureTopology', 'topic'));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.reload();
  await card.waitFor();
  await page.locator('[data-group-reply-mode][data-topology="topic"]').waitFor();
  assert.deepEqual(await rowB.locator('option').evaluateAll(os => os.map(o => o.value)), ['inherit', 'new-topic']);
  assert.equal(await rowA.locator('select').isDisabled(), true);
  assert.match(await card.locator('p small').textContent(), /话题布局/);
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'topic-layout.png') });
  await rowB.locator('select').selectOption('inherit');
  await rowB.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await rowB.locator('select').inputValue(), 'inherit');

  // 单群查询失败：不预判拓扑、文案中性，仍提供完整选项（保存由 daemon strict 闸兜底）。
  await page.evaluate(() => localStorage.setItem('fixtureTopology', 'unknown'));
  await page.reload();
  await page.locator('[data-group-reply-mode][data-topology="unknown"]').waitFor();
  assert.match(await card.locator('p small').textContent(), /保存时会校验群类型/);
  assert.equal(await rowA.locator('option').count(), 5);
  assert.deepEqual(errors, []);
  console.log('通过：继承/覆盖来源展示、选择覆盖并回显、保存失败回滚、改回继承、手机无横向溢出、每个对话框只查一次拓扑、话题布局群仅可清除休眠覆盖、拓扑查询失败时中性降级。');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
