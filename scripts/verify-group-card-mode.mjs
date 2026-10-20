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
const output = join(root, 'docs/assets/group-card-mode');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageDialog } from './src/dashboard/web/groups-page.tsx';
import { t } from './src/dashboard/web/ui.ts';
// app-c has the bot-level run-process card off (e.g. final-only replies).
const chat = { chatId: 'oc_demo', name: '项目讨论群', ownerId: 'app-a', chatMode: 'topic', memberBots: [
  { larkAppId: 'app-a', botName: '开发助手', inChat: true, agentCliId: 'codex' },
  { larkAppId: 'app-b', botName: '文档助手', inChat: true, agentCliId: 'claude-code' },
  { larkAppId: 'app-c', botName: '巡检助手', inChat: true, agentCliId: 'codex' },
] };
const master = { 'app-a': true, 'app-b': true, 'app-c': false };
const noCard = JSON.parse(localStorage.getItem('fixtureNoCard') || '{"app-b":true}');
window.fixtureWrites = [];
window.fetch = async (url, init) => {
  const path = String(url);
  if (path.includes('/card-mode/')) {
    const body = JSON.parse(init.body);
    window.fixtureWrites.push({ path, body });
    if (window.fixtureFailure) return new Response(JSON.stringify({ok:false,error:'模拟保存失败'}), {status:503});
    const appId = path.split('/').at(-1);
    const changed = noCard[appId] === body.enabled;
    noCard[appId] = !body.enabled;
    localStorage.setItem('fixtureNoCard', JSON.stringify(noCard));
    return new Response(JSON.stringify({ok:true,enabled:body.enabled,changed}));
  }
  if (path.includes('/cli-options/models')) return new Response(JSON.stringify({models:['gpt-5'],source:'static'}));
  if (path.startsWith('/api/cli-options')) return new Response(JSON.stringify({options:[]}));
  return new Response(JSON.stringify({ok:true,members:[],subjects:[],raw:[],resolved:[],grants:[]}));
};
function snapshot(){return {...chat, memberBots:chat.memberBots.map(bot=>({...bot,
  streamingCardMasterEnabled: master[bot.larkAppId],
  streamingCardChatEnabled: !noCard[bot.larkAppId],
  streamingCardEffectiveEnabled: master[bot.larkAppId] && !noCard[bot.larkAppId],
}))};}
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
  const section = page.locator('[data-group-card-mode]');
  await section.waitFor();
  assert.equal(await section.locator('legend').textContent(), '运行过程卡片');
  assert.equal(await section.evaluate(node => node.nextElementSibling.querySelector('legend').textContent), '实时卡片置顶');
  const row = id => section.locator(`[data-bot="${id}"]`);
  const state = id => row(id).locator('[data-card-mode-state]').getAttribute('data-card-mode-state');
  assert.equal(await state('app-a'), 'inherit-on');
  assert.equal(await state('app-b'), 'chat-off');
  assert.equal(await state('app-c'), 'inherit-off');

  // Turn off app-a in this chat (== /card off), silently.
  await row('app-a').locator('.toggle-row').click();
  await row('app-a').getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites.at(-1)), {
    path: '/api/groups/oc_demo/card-mode/app-a', body: { enabled: false },
  });
  assert.equal(await state('app-a'), 'chat-off');
  // Re-enable app-b (== /card on → inherit the bot).
  await row('app-b').locator('.toggle-row').click();
  await row('app-b').getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await state('app-b'), 'inherit-on');

  await page.reload();
  await section.waitFor();
  assert.equal(await row('app-a').getByRole('switch').isChecked(), false);
  assert.equal(await row('app-b').getByRole('switch').isChecked(), true);
  assert.equal(await row('app-c').getByRole('switch').isChecked(), true);
  await section.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await section.evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'mobile.png') });

  // Save failure rolls the switch back and reports the error.
  await page.evaluate(() => { window.fixtureFailure = true; });
  await row('app-a').locator('.toggle-row').click();
  await row('app-a').getByRole('status').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(await row('app-a').getByRole('switch').isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('通过：区块位置、继承开/本群关/Bot 级关三态展示、关闭与恢复写入、刷新回显、保存失败回滚、手机无横向溢出。');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
