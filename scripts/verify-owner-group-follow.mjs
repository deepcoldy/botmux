/** Synthetic browser verification of the opt-in setting; no live IM writes. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs/assets/owner-group-follow');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OwnerGroupFollowControls } from './src/dashboard/web/bot-defaults-page.tsx';
import { normalizeOwnerGroupFollowConfig } from './src/services/owner-group-follow-policy.ts';
window.fixtureWrites = [];
window.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  window.fixtureWrites.push({path:String(url),body});
  if (window.fixtureFailure) return new Response(JSON.stringify({ok:false,error:'save_failed'}),{status:500});
  try {
    return new Response(JSON.stringify({ok:true,ownerGroupFollow:normalizeOwnerGroupFollowConfig(body.ownerGroupFollow)??null}));
  } catch {
    return new Response(JSON.stringify({ok:false,error:'invalid_json'}),{status:400});
  }
};
function App(){
  const [bot,setBot] = useState({larkAppId:'cli_demo',botName:'协作助手'});
  return <article className="bd-card"><h3>协作助手 · 默认设置</h3><OwnerGroupFollowControls bot={bot}
    patchBot={(_id,patch)=>setBot(current=>({...current,...patch}))}/></article>;
}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false, outdir: '/tmp/botmux-owner-follow-browser-bundle' });
const css = await readFile(join(root, 'src/dashboard/web/style.css'));
const tokens = await readFile(join(root, 'src/dashboard/web/design-tokens.css'));
const html = `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;padding:24px;background:var(--bg);overflow:auto}#root{max-width:700px;margin:auto}.bd-card{padding:24px}</style></head><body><div id="root"></div><script>localStorage.setItem('botmux.dashboard.locale','zh')</script><script type="module" src="/app.js"></script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(path === '/app.js' ? bundle.outputFiles.find(file => file.path.endsWith('.js')).contents : path === '/fixture.css' ? bundle.outputFiles.find(file => file.path.endsWith('.css'))?.contents ?? '' : path === '/style.css' ? css : path === '/tokens.css' ? tokens : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.BOTMUX_BROWSER_EXECUTABLE ? { executablePath: process.env.BOTMUX_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 820, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const toggle = page.locator('[data-action="toggle-owner-group-follow"]');
  await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.evaluate(() => window.fixtureWrites.length), 0);
  await page.locator('.bd-card').screenshot({ path: join(output, 'default-off.png') });
  const exclusions = page.locator('[data-input="ownerGroupFollowExcluded"]');
  await exclusions.fill('oc_draft'); await toggle.locator('..').click();
  await page.waitForFunction(() => window.fixtureWrites.length === 1);
  assert.equal(await toggle.isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites[0]), {
    path: '/api/bots/cli_demo/owner-group-follow', body: { ownerGroupFollow: { enabled: true } },
  });
  assert.equal(await exclusions.inputValue(), 'oc_draft');
  await page.locator('[data-action="save-owner-group-follow-exclusions"]').click();
  await page.waitForFunction(() => window.fixtureWrites.length === 2);
  assert.deepEqual(await page.evaluate(() => window.fixtureWrites[1].body.ownerGroupFollow), { enabled: true, excludeChatIds: ['oc_draft'] });
  await page.locator('.bd-card').screenshot({ path: join(output, 'enabled-exclusions.png') });
  await page.evaluate(() => { window.fixtureFailure = true; }); await toggle.locator('..').click();
  await page.waitForFunction(() => window.fixtureWrites.length === 3);
  await page.waitForFunction(() => !document.querySelector('[data-action="toggle-owner-group-follow"]').disabled);
  assert.equal(await toggle.isChecked(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: default off, saved toggle, unsaved exclusions, exclusion save, failed-save rollback; screenshots generated');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
