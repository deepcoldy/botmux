/** Browser regression coverage for the full-height sessions page: optional bars keep their own height. */
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';

type Extra = 'none' | 'bulkBar' | 'docFailures';

interface LayoutBox {
  name: string;
  top: number;
  bottom: number;
  clientHeight: number;
  scrollHeight: number;
}

interface Layout {
  children: LayoutBox[];
  pageBottom: number;
  pageClientHeight: number;
  pageScrollHeight: number;
  stageHeight: number;
  /** null 表示这次没有分页提示（没有更早的已关闭会话）。 */
  hintButtonHitsHint: boolean | null;
}

type Row = Record<string, unknown> & { sessionId: string };

// 非文本断言：生产会话页与 style.css 交给 Chromium，挂进生产外壳同一条容器链
// （.app-shell > .chrome-body > .workspace > main），量整页布局本身，不读样式文本。
describe('sessions page full-height layout in Chromium', () => {
  let browser: Browser;
  let script: string;
  let css: string;
  // 69 个未关闭 + 2029 个已关闭：首屏只带 50 个已关闭会话和游标，分页提示必然出现。
  const rows: Row[] = Array.from({ length: 2098 }, (_, index) => ({
    sessionId: `s-${String(index).padStart(4, '0')}`,
    larkAppId: 'cli_fixture', botName: 'Fixture bot', cliId: 'codex',
    chatId: `oc_${index}`, chatDisplayName: `Fixture chat ${index}`,
    title: `Fixture session ${index}`, status: index < 69 ? 'idle' : 'closed',
    lastMessageAt: 1700000000000 + index * 1000, spawnedAt: 1700000000000,
  }));

  beforeAll(async () => {
    const result = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import { bootstrap } from './src/dashboard/web/store.ts';
        import { renderSessionsPage } from './src/dashboard/web/sessions-page.tsx';
        class Stream { addEventListener() {} close() {} }
        window.EventSource = Stream;
        renderSessionsPage(document.getElementById('root'));
        void bootstrap({ canReadSchedules: () => false });
      ` },
      bundle: true, write: false, loader: { '.css': 'empty' }, platform: 'browser', format: 'esm', target: 'es2022',
    });
    script = result.outputFiles[0].text;
    css = readFileSync('src/dashboard/web/design-tokens.css', 'utf8') + readFileSync('src/dashboard/web/style.css', 'utf8');
    const executablePath = process.env.BOTMUX_TEST_BROWSER_EXECUTABLE
      ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(path => existsSync(path));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  });

  afterAll(async () => { await browser?.close(); });

  async function measure(view: 'kanban' | 'table', extra: Extra, sessions: Row[] = rows): Promise<Layout> {
    // 入场动画带位移，关掉后量到的是静止布局。
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    try {
      await context.addInitScript(mode => { localStorage.setItem('botmux.dashboard.sessions.view', mode); }, view);
      await context.route('http://layout.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') {
          return route.fulfill({
            contentType: 'text/html',
            body: '<html lang="zh"><head><link rel="stylesheet" href="/style.css"></head><body>'
              + '<div class="app-shell"><div class="chrome-body"><div class="workspace"><main id="root"></main></div></div></div>'
              + '<script type="module" src="/entry.js"></script></body></html>',
          });
        }
        if (url.pathname === '/entry.js') return route.fulfill({ contentType: 'application/javascript', body: script });
        if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (url.pathname === '/api/sessions') return route.fulfill({ json: selectSessionPage(sessions, url.searchParams) });
        // 读不到文档评论投递结果时，会话页顶部多出一块「不可用」提示（又一个可选子元素）。
        if (url.pathname === '/api/bots' && extra === 'docFailures') return route.fulfill({ status: 500, json: { error: 'fixture_unavailable' } });
        return route.fulfill({ json: { bots: [], groups: [], failures: [], sessions: [], schedules: [] } });
      });
      const page = await context.newPage();
      await page.goto('http://layout.test/#/sessions');
      await page.locator(view === 'kanban' ? '.kanban-column header' : '.sessions-view-stage table thead').first().waitFor();
      if (sessions.some(row => row.status === 'closed')) await page.locator('.sessions-history-pagination button').waitFor();
      if (extra === 'docFailures') await page.locator('.sessions-page > .doc-comment-failures').waitFor();
      if (extra === 'bulkBar') {
        const box = view === 'kanban' ? '.kanban-card input[type=checkbox]' : '.sessions-view-stage tbody input[type=checkbox]';
        await page.locator(box).first().check({ force: true });
        await page.locator('#bulk-bar:not([hidden])').waitFor();
      }
      return await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.sessions-page')!;
        const stage = root.querySelector<HTMLElement>('.sessions-view-stage')!;
        const hint = root.querySelector<HTMLElement>('.sessions-history-pagination');
        const inFlow = [...root.children].filter((el): el is HTMLElement => {
          const style = getComputedStyle(el);
          return el instanceof HTMLElement && style.display !== 'none' && style.position !== 'fixed' && style.position !== 'absolute';
        });
        const button = hint?.querySelector('button')?.getBoundingClientRect();
        const hit = button ? document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2) : null;
        const pageBox = root.getBoundingClientRect();
        return {
          children: inFlow.map(el => {
            const box = el.getBoundingClientRect();
            return { name: el.id || el.className.split(' ')[0], top: box.top, bottom: box.bottom, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
          }),
          pageBottom: pageBox.bottom,
          pageClientHeight: root.clientHeight,
          pageScrollHeight: root.scrollHeight,
          stageHeight: stage.getBoundingClientRect().height,
          hintButtonHitsHint: hint ? !!hit && hint.contains(hit) : null,
        };
      });
    } finally {
      await context.close();
    }
  }

  for (const view of ['kanban', 'table'] as const) {
    for (const extra of ['none', 'bulkBar', 'docFailures'] as const) {
      it(`${view} view with the history banner${extra === 'none' ? '' : ` and ${extra}`} stacks every bar at its own height`, async () => {
        const layout = await measure(view, extra);
        const names = layout.children.map(child => child.name);
        expect(names).toContain('sessions-history-pagination');
        if (extra === 'bulkBar') expect(names).toContain('bulk-bar');
        if (extra === 'docFailures') expect(names).toContain('doc-comment-failures');

        // 用户能点到「加载更早的已关闭会话」：按钮中心点上最上层的是它自己，不是看板列头 / 表头。
        expect(layout.hintButtonHitsHint).toBe(true);
        for (const child of layout.children) {
          if (child.name === 'sessions-view-stage') continue;
          // 没被压扁：盒子装得下自己的内容（塌成 0 高时内容会溢出到下一块上）。
          expect(child.scrollHeight, `${child.name} is squeezed`).toBeLessThanOrEqual(child.clientHeight + 1);
        }
        for (let index = 1; index < layout.children.length; index += 1) {
          const [prev, next] = [layout.children[index - 1], layout.children[index]];
          expect(next.top, `${next.name} overlaps ${prev.name}`).toBeGreaterThanOrEqual(prev.bottom - 0.5);
        }
        // 视图舞台仍占满剩余高度：整页不溢出，最后一块贴着页面底边。
        expect(layout.stageHeight).toBeGreaterThan(200);
        expect(layout.pageScrollHeight).toBeLessThanOrEqual(layout.pageClientHeight + 1);
        expect(Math.abs(layout.pageBottom - layout.children[layout.children.length - 1].bottom)).toBeLessThanOrEqual(1);
      });
    }

    it(`${view} view with a short list keeps the bars above it at their content height`, async () => {
      // 只有 3 个会话时舞台内容远矮于视口：剩余高度要整块给舞台，不能平摊到标题 / 统计 / 筛选栏上把它们拉高。
      const [short, full] = [await measure(view, 'none', rows.slice(0, 3)), await measure(view, 'none')];
      const heightOf = (layout: Layout, name: string) => {
        const child = layout.children.find(entry => entry.name === name);
        expect(child, name).toBeDefined();
        return child!.bottom - child!.top;
      };
      for (const name of ['page-heading', 'session-runtime-stats', 'filters']) {
        expect(heightOf(short, name), name).toBeCloseTo(heightOf(full, name), 0);
      }
      expect(Math.abs(short.pageBottom - short.children[short.children.length - 1].bottom)).toBeLessThanOrEqual(1);
    });
  }
});
