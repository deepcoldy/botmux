/** Synthetic Dashboard browser verification; no live bots or IM requests. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs/assets/group-idle-close');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageDialog } from './src/dashboard/web/groups-page.tsx';
import { t } from './src/dashboard/web/ui.ts';
const chat = { chatId: 'oc_demo', name: '项目讨论群', ownerId: 'app-a', chatMode: 'topic', memberBots: [
  { larkAppId: 'app-a', botName: '开发助手', inChat: true, agentCliId: 'codex' },
  { larkAppId: 'app-b', botName: '文档助手', inChat: true, agentCliId: 'claude-code' },
] };
const policies = JSON.parse(localStorage.getItem('fixturePolicies') || '{}');
window.fixtureWrites = [];
window.fetch = async (url, init) => {
  const path = String(url);
  if (path.includes('/idle-close/')) {
    const settings = JSON.parse(init.body);
    window.fixtureWrites.push({ path, settings });
    if (window.fixtureFailure) return new Response(JSON.stringify({ok:false,error:'模拟保存失败'}), {status:503});
    policies[path.split('/').at(-1)] = settings;
    localStorage.setItem('fixturePolicies', JSON.stringify(policies));
    return new Response(JSON.stringify({ok:true,settings}));
  }
  if (path.includes('/cli-options/models')) return new Response(JSON.stringify({models:['gpt-5'],source:'static'}));
  if (path.startsWith('/api/cli-options')) return new Response(JSON.stringify({options:[]}));
  return new Response(JSON.stringify({ok:true,members:[],subjects:[],raw:[],resolved:[],grants:[]}));
};
function snapshot(){return {...chat, memberBots:chat.memberBots.map(bot=>({...bot,idleClose:policies[bot.larkAppId]}))};}
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
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.BOTMUX_BROWSER_EXECUTABLE ? { executablePath: process.env.BOTMUX_BROWSER_EXECUTABLE }
      : !existsSync(chromium.executablePath()) && existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = page.locator('[data-group-idle-close]');
  await card.waitFor();
  const row = card.locator('form').first();
  const number = row.getByRole('spinbutton');
  const unit = row.getByRole('combobox');
  const toggle = row.getByRole('switch');
  const save = row.getByRole('button', { name: '保存', exact: true });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await number.isDisabled(), true);
  assert.equal(await card.evaluate(node => node.nextElementSibling.querySelector('legend').textContent), '新话题默认模型');
  await row.locator('.toggle-row').click();
  await number.fill('1.5');
  assert.equal(await number.inputValue(), '1');
  await number.fill('0');
  assert.equal(await save.isDisabled(), true);
  await number.fill('12');
  await number.press('ArrowUp');
  assert.equal(await number.inputValue(), '13');
  await number.press('ArrowDown');
  await unit.selectOption('hours');
  await save.click();
  await row.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites.at(-1)), {
    path: '/api/groups/oc_demo/idle-close/app-a', settings: { enabled: true, duration: 12, unit: 'hours' },
  });
  await page.reload();
  await card.waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await number.inputValue(), '12');
  assert.equal(await unit.inputValue(), 'hours');
  assert.equal(await card.locator('form').nth(1).getByRole('switch').isChecked(), false);
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile.png') });
  await page.evaluate(() => { window.fixtureFailure = true; });
  await number.fill('8');
  await save.click();
  await row.getByRole('status').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(await number.inputValue(), '8');
  await page.evaluate(() => { window.fixtureFailure = false; });
  await number.fill('');
  await row.locator('.toggle-row').click();
  await save.click();
  await row.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await toggle.isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('通过：卡片顺序、默认关闭、整数和步进输入、小时设置、保存与回显、保存失败、关闭开关、手机无横向溢出。');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
