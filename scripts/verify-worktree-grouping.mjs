/** Synthetic component/browser evidence; never connects to a live daemon. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchSessionList } from './src/dashboard/web/agent-workbench-session-list.tsx';
const ws = { sourceId:'host-a-demo', kind:'git', rootPath:'/workspace/feature-a', displayName:'feature-a', branch:'feat/search', state:'resolved' };
const rows = [
  { sessionId:'review', title:'确认搜索方案', status:'idle', agentAttention:{reason:'等待确认'}, workspace:ws },
  { sessionId:'implementation', title:'搜索功能开发', status:'working', workspace:ws },
  { sessionId:'tests', title:'接口回归测试', status:'idle', workspace:ws },
  { sessionId:'other-host', title:'另一台主机的任务', status:'idle', workspace:{...ws, sourceId:'host-b-demo'} },
  { sessionId:'notes', title:'整理文档', status:'idle', workspace:{...ws, kind:'directory', rootPath:'/workspace/notes', displayName:'notes', branch:undefined} },
  { sessionId:'legacy', title:'历史会话', status:'closed' },
].map((r,i)=>({...r, botName:i%2?'Builder':'Reviewer', cliId:i%2?'codex':'claude', workingDir:r.workspace?.rootPath || '/legacy', lastMessageAt:1780000000000-i*1000, scope:'thread', chatId:'demo-chat'}));
function App(){const [dimension,setDimension]=useState('worktree'); const [selected,setSelected]=useState(null);
return <WorkbenchSessionList sessions={rows} selectedSessionId={selected} onSelect={setSelected} dimension={dimension} onDimensionChange={setDimension} now={1780000001000} online onOpenSurface={()=>{}} onLocate={async()=>{}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false });
const css = await readFile(join(root, 'src/dashboard/web/style.css'));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body{margin:0;height:100%;background:#10141b}#root{height:100%;width:min(100%,580px);margin:auto}.wb-session-rail{height:100%;width:100%;box-sizing:border-box}</style></head><body><div id="root" class="agent-workbench-page"></div><script type="module" src="/app.js"></script></body></html>`;
const server = createServer((req,res)=>{
  const path = new URL(req.url,'http://localhost').pathname;
  res.setHeader('content-type', path==='/app.js'?'text/javascript':path==='/style.css'?'text/css':'text/html');
  res.end(path==='/app.js'?bundle.outputFiles[0].contents:path==='/style.css'?css:html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({ headless:true, ...(process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE ? {executablePath:process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE}: {}) });
try {
  const page = await browser.newPage({ viewport:{width:800,height:850} });
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.wb-session-row').first().waitFor();
  assert.equal(await page.locator('.wb-session-row').count(),6);
  assert.equal(await page.locator('.wb-session-group-toggle').count(),5);
  const headers=page.locator('.wb-session-group-toggle');
  assert.match(await headers.nth(1).getAttribute('title'), /host-a-d/);
  await headers.nth(1).click();
  assert.equal(await page.locator('.wb-session-row').count(),4);
  await headers.nth(1).click();
  await page.getByRole('searchbox').fill('feat/search');
  assert.equal(await page.locator('.wb-session-row').count(),4);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('combobox').selectOption('status');
  assert.equal(await page.locator('.wb-session-row').count(),6);
  await page.getByRole('combobox').selectOption('worktree');
  await page.screenshot({path:join(root,'docs/assets/worktree-grouping-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,'docs/assets/worktree-grouping-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: grouping, attention, source isolation, collapse, search, dimension switching, mobile overflow');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
