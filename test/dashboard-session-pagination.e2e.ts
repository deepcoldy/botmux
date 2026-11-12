/** Browser regression coverage for bounded snapshots, explicit history paging and archived deep links. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';

// 非文本断言：生产会话页与 CSS 交给 Chromium，验证分页按钮实际请求下一页及历史深链接。
describe('dashboard history pagination in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let script: string;
  const requests: string[] = [];
  const rows = Array.from({ length: 2098 }, (_, index) => ({
    sessionId: `s-${String(index).padStart(4, '0')}`,
    larkAppId: 'cli_fixture', botName: 'Fixture bot', cliId: 'codex',
    chatId: `oc_${index}`, chatDisplayName: `Fixture chat ${index}`,
    title: `Fixture session ${index}`, status: index < 69 ? 'idle' : 'closed',
    lastMessageAt: 1700000000000 + index * 1000, spawnedAt: 1700000000000,
  }));

  beforeAll(async () => {
    const result = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import { bootstrap, store } from './src/dashboard/web/store.ts';
        import { renderSessionsPage } from './src/dashboard/web/sessions-page.tsx';
        class Stream { addEventListener() {} close() {} }
        window.EventSource = Stream;
        renderSessionsPage(document.getElementById('root'));
        void bootstrap({ canReadSchedules: () => false });
        window.fixtureStore = store;
      ` },
      bundle: true, write: false, loader: { '.css': 'empty' }, platform: 'browser', format: 'esm', target: 'es2022',
    });
    script = result.outputFiles[0].text;
    const executablePath = process.env.BOTMUX_TEST_BROWSER_EXECUTABLE
      ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(path => existsSync(path));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('http://pagination.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<html lang="zh"><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>' });
      }
      if (url.pathname === '/entry.js') return route.fulfill({ contentType: 'application/javascript', body: script });
      if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: readFileSync('src/dashboard/web/design-tokens.css', 'utf8') + readFileSync('src/dashboard/web/style.css', 'utf8') });
      if (url.pathname === '/api/sessions') {
        requests.push(url.search);
        return route.fulfill({ json: selectSessionPage(rows, url.searchParams) });
      }
      return route.fulfill({ json: { bots: [], groups: [], failures: [], sessions: [], schedules: [] } });
    });
  });

  afterAll(async () => { await browser?.close(); });

  it('starts with 69 active and 50 closed rows, loads one history page per click, and resolves old deep links', async () => {
    await page.goto('http://pagination.test/#/sessions');
    const more = page.getByRole('button', { name: '加载更早的已关闭会话' });
    await more.waitFor();
    expect(requests).toEqual(['?view=board']);
    // The banner reads like the dormant-session hint next to it: muted 12px text with a link-style button.
    const look = await page.evaluate(() => {
      const banner = document.querySelector('.sessions-history-pagination')!;
      const button = banner.querySelector('button')!;
      const [b, btn] = [getComputedStyle(banner), getComputedStyle(button)];
      return { fontSize: b.fontSize, border: btn.borderTopWidth, background: btn.backgroundColor, cursor: btn.cursor };
    });
    expect(look).toEqual({ fontSize: '12px', border: '0px', background: 'rgba(0, 0, 0, 0)', cursor: 'pointer' });
    expect(await page.evaluate(() => (window as unknown as { fixtureStore: { sessions: Map<string, unknown> } }).fixtureStore.sessions.size)).toBe(119);
    if (process.env.BOTMUX_PAGINATION_SCREENSHOT) {
      mkdirSync(dirname(process.env.BOTMUX_PAGINATION_SCREENSHOT), { recursive: true });
      await page.screenshot({ path: process.env.BOTMUX_PAGINATION_SCREENSHOT, fullPage: false });
    }
    await more.click();
    await page.waitForFunction(() => (window as unknown as { fixtureStore: { sessions: Map<string, unknown> } }).fixtureStore.sessions.size === 169);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('view=closed&cursor=');
    await page.goto('http://pagination.test/#/sessions?session=s-0069');
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { fixtureStore?: { sessions: Map<string, unknown> } }).fixtureStore?.sessions.has('s-0069'));
    expect(requests).toContain('?view=single&sessionId=s-0069');
    await page.getByText('Fixture session 69', { exact: true }).first().waitFor();
  });
});
