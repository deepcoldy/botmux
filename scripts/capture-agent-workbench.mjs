import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, '.playwright-browsers');
const { chromium } = await import('playwright');
const browserExecutable = process.env.BOTMUX_WORKBENCH_BROWSER_EXECUTABLE?.trim();
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

const pageHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Workbench capture</title><link rel="stylesheet" href="/style.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const terminalHtml = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0;background:#070a0e;color:#cad5df;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}body{padding:15px 17px;box-sizing:border-box}.dim{color:#5f7182}.cyan{color:#67c7f5}.green{color:#6fd29b}.amber{color:#e2b35c}.cursor{display:inline-block;width:7px;height:13px;background:#67c7f5;vertical-align:-2px}</style></head><body><div class="dim">orca@workbench  ~/work/botmux  feat/agent-workbench</div><br><div><span class="cyan">❯</span> pnpm build</div><div class="green">✓</div><div class="dim">public-domain audit · TypeScript · dashboard chunks · dist audit</div><div><span class="green">✓</span> build complete</div><br><div><span class="cyan">❯</span> pnpm exec tsx scripts/verify-agent-workbench.ts</div><div>{"ok":true,"sessions":320,"virtualItemsRendered":22}</div><br><div><span class="cyan">❯</span> git diff --stat</div><div class="dim">Agent Workbench routes, model, panes, Dock, tests, docs</div><br><div><span class="amber">review</span> Preview lease relocks fail-closed after inactivity.</div><div><span class="cyan">❯</span> <span class="cursor"></span></div></body></html>';
const previewHtml = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0;background:#0d1219;color:#d8e2ed;font:13px/1.45 system-ui,sans-serif}body{padding:16px;box-sizing:border-box}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #273344;padding-bottom:12px}.brand{letter-spacing:.1em;font-weight:700}.live{color:#6fd29b;font:11px ui-monospace,monospace}.grid{display:grid;grid-template-columns:1.25fr .75fr;gap:10px;margin-top:12px}.panel{border:1px solid #273344;background:#111822;padding:12px}.panel h2{font-size:12px;margin:0 0 10px;color:#8b9aad;letter-spacing:.08em}.metric{font:24px ui-monospace,monospace;color:#67c7f5}.row{display:flex;justify-content:space-between;border-top:1px solid #273344;padding:7px 0}.ok{color:#6fd29b}.warn{color:#e2b35c}.bar{height:5px;background:#273344;margin-top:7px}.fill{width:78%;height:100%;background:#67c7f5}</style></head><body><div class="top"><div class="brand">RELEASE CONTROL</div><div class="live">● LIVE PREVIEW</div></div><div class="grid"><section class="panel"><h2>WORKBENCH READINESS</h2><div class="metric">92%</div><div class="bar"><div class="fill"></div></div><div class="row"><span>Routing and lazy chunks</span><span class="ok">PASS</span></div><div class="row"><span>Terminal / Web pane contract</span><span class="ok">PASS</span></div><div class="row"><span>Preview inactivity relock</span><span class="warn">REVIEW</span></div></section><section class="panel"><h2>ACTIVE LEASE</h2><div class="row"><span>Mode</span><span class="ok">INTERACTIVE</span></div><div class="row"><span>Scope</span><span>This session</span></div><div class="row"><span>Relock</span><span>12 min</span></div></section></div></body></html>';

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
  } else if (path.startsWith('/preview/')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(previewHtml);
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
  await page.locator('.wb-mode-chip.is-controlled').waitFor();
  await page.locator('.wb-mode-chip.is-interactive').waitFor();
  await page.screenshot({ path: output, fullPage: false });
  const metrics = await page.evaluate(() => ({
    title: document.title,
    sessions: document.querySelector('.wb-rail-heading > div > span:last-child')?.textContent,
    renderedRows: document.querySelectorAll('.wb-session-row').length,
    paneMode: document.querySelector('.wb-pane-region')?.getAttribute('data-pane-mode'),
    responsiveStep: document.querySelector('.agent-workbench-page')?.getAttribute('data-responsive-step'),
  }));
  await writeFile(join(root, 'docs', 'assets', 'agent-workbench-dark.metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, output, ...metrics }) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
