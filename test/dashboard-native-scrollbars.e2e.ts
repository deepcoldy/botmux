import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'http://native-scrollbars.test';
const css = ['style.css', 'design-tokens.css']
  .map(file => readFileSync(`src/dashboard/web/${file}`, 'utf8'))
  .join('\n');

// Runs in the page before the bundle: the app shell captures window.fetch at module load.
function installFakeServer(): void {
  const bots = [{ larkAppId: 'cli_a', botName: 'Bot A' }, { larkAppId: 'cli_b', botName: 'Bot B' }];
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    sessionId: `session-${i}`, status: 'idle', cliId: 'pi', chatId: 'oc_test', botName: 'Bot A', larkAppId: 'cli_a',
    title: `Long session title ${i} abcdefghijklmnopqrstuvwxyz`, workingDir: `/tmp/project-long-directory-name-${i}`,
    spawnedAt: Date.now() - 10_000, lastMessageAt: Date.now() - 5_000,
  }));
  const bodies: Record<string, unknown> = {
    '/api/settings': { ok: true, authed: true, settings: {} },
    '/api/sessions': { ok: true, sessions },
    '/api/groups': {
      bots,
      chats: [{ chatId: 'oc_test', name: 'Test chat', memberBots: bots.map(bot => ({ ...bot, inChat: true })) }],
    },
  };
  window.fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    const body = bodies[new URL(url, location.href).pathname];
    return new Response(JSON.stringify(body ?? { ok: false }), {
      status: body ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  class FakeEventSource extends EventTarget {
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor() {
      super();
      setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); });
    }
    close(): void { this.readyState = 2; }
  }
  window.EventSource = FakeEventSource as unknown as typeof EventSource;
  localStorage.setItem('botmux.dashboard.sessions.view', 'table');
}

// macOS Chromium draws overlay scrollbars that take no layout space and only show while scrolling.
describe.skipIf(process.platform === 'darwin')('dashboard native scrollbars', () => {
  let browser: Browser;
  let page: Page;
  let script: string;
  let errors: string[] = [];

  beforeAll(async () => {
    const result = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: "import './src/dashboard/web/app.tsx';" },
      bundle: true, write: false, format: 'iife', platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    script = result.outputFiles[0].text;
    // Headless Chromium hides scrollbars unless this default flag is dropped.
    browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  });
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });

  async function open(hash: string): Promise<void> {
    // Page/drawer enter animations translate the targets; measured bar coordinates must not move.
    page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<style>${css}</style><div id="app-root"></div><script src="/app.js"></script>` });
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.addInitScript(installFakeServer);
    await page.goto(`${ORIGIN}/${hash}`);
  }

  async function overflowing(selector: string, axis: 'x' | 'y'): Promise<void> {
    await page.waitForFunction(([sel, ax]) => {
      const el = document.querySelector(sel);
      return !!el && (ax === 'y' ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth);
    }, [selector, axis] as const);
  }

  async function dragScrollbar(selector: string, axis: 'x' | 'y'): Promise<number> {
    await overflowing(selector, axis);
    const target = page.locator(selector);
    const bar = await target.evaluate((el: HTMLElement, ax) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const [bt, br, bb, bl] = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(parseFloat);
      const width = el.offsetWidth - el.clientWidth - bl - br;
      const height = el.offsetHeight - el.clientHeight - bt - bb;
      return ax === 'y'
        ? { size: width, x: r.right - br - width / 2, y: r.top + bt + 15 }
        : { size: height, x: r.left + bl + 15, y: r.bottom - bb - height / 2 };
    }, axis);
    expect(bar.size).toBeGreaterThan(0);
    await page.mouse.move(bar.x, bar.y);
    await page.mouse.down();
    await page.mouse.move(bar.x + (axis === 'x' ? 120 : 0), bar.y + (axis === 'y' ? 120 : 0), { steps: 8 });
    await page.mouse.up();
    return target.evaluate((el, ax) => (ax === 'y' ? el.scrollTop : el.scrollLeft), axis);
  }

  it('drags the main page scrollbar', async () => {
    await open('#/settings');
    expect(await dragScrollbar('main#root', 'y')).toBeGreaterThan(0);
  });

  it('drags the session table horizontal scrollbar and still scrolls by wheel', async () => {
    await open('#/sessions');
    expect(await dragScrollbar('.sessions-view-stage', 'x')).toBeGreaterThan(0);
    const stage = page.locator('.sessions-view-stage');
    await stage.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => stage.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  });

  it('keeps the last row checkbox clickable right above the horizontal scrollbar', async () => {
    await open('#/sessions');
    await overflowing('.sessions-view-stage', 'y');
    await page.locator('.sessions-view-stage').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const checkbox = page.locator('#sessions-table tbody tr:last-child input[type=checkbox]');
    const box = (await checkbox.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await checkbox.isChecked()).toBe(true);
  });

  it('drags the scrollbar inside a modal', async () => {
    await open('#/sessions');
    await page.locator('.create-session-btn').click();
    expect(await dragScrollbar('article.cs-card', 'y')).toBeGreaterThan(0);
  });

  it('drags the scrollbar inside a drawer', async () => {
    await open('#/groups');
    await page.locator('.manage-chat').first().click();
    await page.locator('.g-manage-tabs button').nth(1).click();
    expect(await dragScrollbar('.g-manage-body', 'y')).toBeGreaterThan(0);
  });

  it('follows the theme colours', async () => {
    await open('#/sessions');
    const colour = () => page.locator('.sessions-view-stage').evaluate(el => getComputedStyle(el).scrollbarColor);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const light = await colour();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    expect(await colour()).not.toBe(light);
  });
});
