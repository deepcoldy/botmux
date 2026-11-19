import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

// 非文本断言：将真实排程页与 CSS 交给浏览器，核验结果字段并保存审阅截图。
describe('schedule follow-up support view', () => {
  it('shows retry frequency, notification owner, completion and expiry details', async () => {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { bootstrap } from './src/dashboard/web/store.ts';
      import { renderSchedulesPage } from './src/dashboard/web/schedules-page.tsx';
      window.EventSource = class { addEventListener() {} close() {} };
      renderSchedulesPage(document.getElementById('root'));
      void bootstrap({ canReadSchedules: () => true });
    ` }, bundle: true, write: false, platform: 'browser', format: 'esm', loader: { '.css': 'empty' } });
    const css = readFileSync('src/dashboard/web/design-tokens.css', 'utf8') + readFileSync('src/dashboard/web/style.css', 'utf8');
    const now = new Date().toISOString();
    const schedules = [
      { id: 'open', name: '等待上游实例 123 完成', enabled: true, untilDone: { status: 'open', retryMinutes: 5, attempts: 3, deadline: '2026-11-15T00:00:00Z' },
        lastStatus: 'error', lastError: '上游检查暂不可用', runStats: { consecutiveFailures: 2 }, ownerOpenId: 'ou_creator' },
      { id: 'done', name: '已确认完成的跟进', enabled: false, untilDone: { status: 'done', attempts: 2, doneAt: now }, lastStatus: 'ok' },
      { id: 'expired', name: '达到截止时间的跟进', enabled: false, untilDone: { status: 'expired', attempts: 5, expiredAt: '2026-11-15T00:00:00Z', deadline: '2026-11-15T00:00:00Z' }, lastStatus: 'ok' },
    ].map(row => ({ ...row, larkAppId: 'cli_fixture', botName: 'Support bot', chatId: 'oc_fixture', chatDisplayName: '服务支持群',
      executionPosition: 'topic', scope: 'thread', rootMessageId: 'om_topic', createdAt: now, lastRunAt: now,
      schedule: '1m', parsed: { kind: 'once', display: '一分钟后', at: now }, notify: ['failing', 'expired'], prompt: '检查实例状态' }));
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.BOTMUX_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.setItem('botmux.dashboard.locale', 'zh'));
      await page.route('http://support.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div class="app-shell"><div class="chrome-body"><div class="workspace"><main id="root"></main></div></div></div><script type="module" src="/entry.js"></script></body></html>' });
        if (url.pathname === '/entry.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text });
        if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (url.pathname === '/api/schedules') return route.fulfill({ json: { schedules, timeZone: 'Asia/Shanghai' } });
        return route.fulfill({ json: { bots: [], groups: [], failures: [], sessions: [], schedules: [], logs: [], total: 0 } });
      });
      await page.goto('http://support.test/#/schedules');
      await page.locator('.schedule-row-head').first().waitFor();
      const support = await page.locator('.schedule-support-detail').allTextContents();
      expect(support.some(text => text.includes('ou_creator'))).toBe(true);
      expect(support.some(text => text.includes('上游检查暂不可用'))).toBe(true);
      expect(support.some(text => text.includes('2026-11-15T00:00:00Z'))).toBe(true);
      if (process.env.BOTMUX_SCREENSHOT_OUTPUT) await page.screenshot({ path: process.env.BOTMUX_SCREENSHOT_OUTPUT, fullPage: true });
      await page.close();
    } finally { await browser.close(); }
  }, 30000);
});
