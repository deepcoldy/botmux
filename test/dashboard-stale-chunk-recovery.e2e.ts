import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serveMissingDashboardChunk } from '../src/dashboard/stale-chunk-http.js';

type Scenario = 'missing' | 'legacy' | 'missing-persistent' | 'legacy-persistent' | 'render-error';

// A real HTTP server and Chromium exercise the production route lifecycle,
// reload guard and missing-chunk handler. The fixture changes the served entry
// after a tab has opened, just as deploying a different build would.
describe('dashboard recovers from stale route chunks', () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let origin: string;
  let oldEntry: string;
  let newEntry: string;
  let scenario: Scenario;
  let published: boolean;
  let documents: number;
  let chunkResponses: Array<{ pathname: string; status: number }>;

  async function entry(chunk: string): Promise<string> {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          import { beginDashboardRoute, createDashboardRouteState, loadAndRenderDashboardRoute }
            from './src/dashboard/web/route-lifecycle.ts';
          import { maybeReloadBrowserForStaleRouteChunk }
            from './src/dashboard/web/stale-chunk-reload.ts';
          const state = createDashboardRouteState();
          const root = document.getElementById('root');
          async function route() {
            const seq = beginDashboardRoute(state);
            root.dataset.state = 'loading';
            try {
              await loadAndRenderDashboardRoute(state, seq, root,
                async () => (await import(${JSON.stringify(chunk)})).render);
            } catch (err) {
              if (seq !== state.seq) return;
              if (maybeReloadBrowserForStaleRouteChunk(err, {
                href: location.href, hash: location.hash,
                getSessionStorage: () => window.sessionStorage,
                reload: () => location.reload(),
              })) return;
              root.dataset.state = 'failed';
              root.replaceChildren();
              const error = document.createElement('p');
              error.dataset.error = '';
              error.textContent = String(err);
              const retry = document.createElement('button');
              retry.textContent = 'Retry route';
              retry.onclick = route;
              root.append(error, retry);
            }
          }
          window.addEventListener('hashchange', route);
          if (location.hash && location.hash !== '#/') void route();
        `,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      minify: true,
      target: 'es2022',
      external: ['/assets/chunks/*'],
    });
    return result.outputFiles[0].text;
  }

  beforeAll(async () => {
    oldEntry = await entry('/assets/chunks/old-page.js');
    newEntry = await entry('/assets/chunks/current-page.js');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      res.setHeader('cache-control', 'no-store');
      if (pathname === '/') {
        documents++;
        res.setHeader('content-type', 'text/html');
        res.end(`<div id="root" data-state="menu"><a href="#/monitor-room">Open route</a></div>
          <script type="module" src="/assets/app.js"></script>`);
        return;
      }
      if (pathname === '/assets/app.js') {
        res.setHeader('content-type', 'application/javascript');
        const fresh = published && (scenario === 'missing' || scenario === 'legacy');
        res.end(fresh ? newEntry : oldEntry);
        return;
      }
      if (pathname === '/assets/chunks/current-page.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(`export function render(root) {
          root.dataset.state = 'ready';
          root.textContent = 'Current build loaded';
        }`);
        return;
      }
      if (pathname === '/assets/chunks/old-page.js' && scenario === 'render-error') {
        res.setHeader('content-type', 'application/javascript');
        res.end(`export function render() { throw new Error('route render failed'); }`);
        return;
      }
      if (pathname === '/assets/chunks/old-page.js' && scenario.startsWith('legacy')) {
        // A stale route response still requires a minified shared-chunk export.
        res.setHeader('content-type', 'application/javascript');
        res.end(`import { e } from './chunk-KXPFRRWM.js'; export const render = e;`);
        return;
      }
      if (pathname === '/assets/chunks/chunk-KXPFRRWM.js' && scenario.startsWith('legacy')) {
        // Legacy wire response: the refresh code cannot run if linking fails.
        chunkResponses.push({ pathname, status: 200 });
        res.setHeader('content-type', 'application/javascript');
        res.end(`sessionStorage.setItem('legacy-shim-executed', '1');
          location.reload();
          export function renderMonitorRoomPage() { location.reload(); }`);
        return;
      }
      if (serveMissingDashboardChunk(req, res, pathname.replace(/^\/assets/, ''))) {
        chunkResponses.push({ pathname, status: 404 });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    origin = `http://127.0.0.1:${address.port}`;
    const executablePath = process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  });

  beforeEach(async () => {
    published = false;
    documents = 0;
    chunkResponses = [];
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  async function openOldTabAndDeploy(nextScenario: Scenario): Promise<void> {
    scenario = nextScenario;
    await page.goto(origin);
    await page.getByRole('link', { name: 'Open route' }).waitFor();
    published = true;
    await page.getByRole('link', { name: 'Open route' }).click();
  }

  it.each(['missing', 'legacy'] as const)('recovers from %s chunks by loading the new build once', async (mode) => {
    await openOldTabAndDeploy(mode);
    await page.locator('#root[data-state="ready"]').waitFor();
    expect(documents).toBe(2);
    expect(chunkResponses).toEqual([{
      pathname: mode === 'missing' ? '/assets/chunks/old-page.js' : '/assets/chunks/chunk-KXPFRRWM.js',
      status: mode === 'missing' ? 404 : 200,
    }]);
    expect(await page.evaluate(() => sessionStorage.getItem('legacy-shim-executed'))).toBeNull();
    expect(await page.locator('[data-error]').count()).toBe(0);
  });

  it.each(['missing-persistent', 'legacy-persistent'] as const)('stops after one reload when %s remains broken', async (mode) => {
    await openOldTabAndDeploy(mode);
    await page.locator('#root[data-state="failed"]').waitFor();
    expect(documents).toBe(2);
    expect(chunkResponses).toHaveLength(2);
    if (mode === 'legacy-persistent') {
      expect(await page.locator('[data-error]').textContent()).toMatch(/does not provide an export named 'e'/);
    }
    await page.getByRole('button', { name: 'Retry route' }).click();
    await page.locator('#root[data-state="failed"]').waitFor();
    expect(documents).toBe(2);
    // Chromium may retry a failed fetch; this must not trigger another reload.
    expect(chunkResponses.every(response => response.status === (mode === 'missing-persistent' ? 404 : 200))).toBe(true);
  });

  it('shows a render failure without reloading or disguising it as a stale chunk', async () => {
    await openOldTabAndDeploy('render-error');
    await page.locator('#root[data-state="failed"]').waitFor();
    expect(documents).toBe(1);
    expect(chunkResponses).toEqual([]);
  });
});
