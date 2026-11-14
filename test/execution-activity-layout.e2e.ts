import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { describe, it, expect } from 'vitest';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';

// 非文本断言：生产 React 会话页和样式交给浏览器，检查可见数据及生成审阅截图。
describe('execution activity in the real table', () => {
  it('shows queue, tool and unknown phases from canonical observations', async () => {
    const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { bootstrap } from './src/dashboard/web/store.ts';
      import { renderSessionsPage } from './src/dashboard/web/sessions-page.tsx';
      window.EventSource = class { addEventListener() {} close() {} };
      renderSessionsPage(document.getElementById('root'));
      void bootstrap({ canReadSchedules: () => false });
    ` }, bundle: true, write: false, loader: { '.css': 'empty' }, platform: 'browser', format: 'esm', target: 'es2022' });
    const css = readFileSync('src/dashboard/web/design-tokens.css', 'utf8') + readFileSync('src/dashboard/web/style.css', 'utf8');
    const now = Date.now();
    const phases = [
      { title: '模型容量等待', phase: 'model_queue', source: 'capacity-banner', startedAtMs: now - 64000, lastProgressAtMs: now - 12000 },
      { title: '工具查询进行中', phase: 'tool', source: 'cli-event', startedAtMs: now - 30000, lastProgressAtMs: now - 5000 },
      { title: '阶段不可观测', phase: 'unknown', source: 'unavailable' },
    ];
    const rows = phases.map((value, index) => ({ sessionId: `fixture-${index}`, title: value.title, status: 'working',
      larkAppId: 'cli_fixture', botName: 'Support bot', cliId: 'traex', chatId: `oc_fixture_${index}`, chatType: 'group',
      chatDisplayName: '服务支持群', spawnedAt: now - 300000, lastMessageAt: now - 10000,
      executionActivity: { ...value, measuredAtMs: now } }));
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.BOTMUX_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 850 }, reducedMotion: 'reduce' });
      await context.addInitScript(() => { localStorage.setItem('botmux.dashboard.sessions.view', 'table'); localStorage.setItem('botmux.dashboard.locale', 'zh'); });
      await context.route('http://support.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div class="app-shell"><div class="chrome-body"><div class="workspace"><main id="root"></main></div></div></div><script type="module" src="/entry.js"></script></body></html>' });
        if (url.pathname === '/entry.js') return route.fulfill({ contentType: 'application/javascript', body: result.outputFiles[0].text });
        if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (url.pathname === '/api/sessions') return route.fulfill({ json: selectSessionPage(rows, url.searchParams) });
        return route.fulfill({ json: { bots: [], groups: [], failures: [], sessions: [], schedules: [] } });
      });
      const page = await context.newPage();
      await page.goto('http://support.test/#/sessions');
      await page.locator('#sessions-table tbody tr').first().waitFor();
      const statuses = await page.locator('#sessions-table .status-task-work').allTextContents();
      expect(statuses.some(text => text.includes('模型排队中'))).toBe(true);
      expect(statuses.some(text => text.includes('工具执行中'))).toBe(true);
      expect(statuses.some(text => text.includes('执行阶段未知'))).toBe(true);
      if (process.env.BOTMUX_SCREENSHOT_OUTPUT) await page.screenshot({ path: process.env.BOTMUX_SCREENSHOT_OUTPUT, fullPage: true });
      await context.close();
    } finally { await browser.close(); }
  });
});
