import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { describe, it, expect } from 'vitest';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';

// 非文本断言：生产 React 会话页和样式交给浏览器，检查可见数据及生成审阅截图。
describe('support session titles in the real table', () => {
  it('shows a group fallback, pinned title, attention and activity', async () => {
    const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { bootstrap } from './src/dashboard/web/store.ts';
      import { renderSessionsPage } from './src/dashboard/web/sessions-page.tsx';
      window.EventSource = class { addEventListener() {} close() {} };
      renderSessionsPage(document.getElementById('root'));
      void bootstrap({ canReadSchedules: () => false });
    ` }, bundle: true, write: false, loader: { '.css': 'empty' }, platform: 'browser', format: 'esm', target: 'es2022' });
    const css = readFileSync('src/dashboard/web/design-tokens.css', 'utf8') + readFileSync('src/dashboard/web/style.css', 'utf8');
    const now = Date.now();
    const rows = [
      { sessionId: 'fixture-initial', title: '你是本群的 oncall 协同助手。入群后先阅读群内可见的最近消息、卡片和转发内容，只做只读总结。首', titleSource: 'initial', chatDisplayName: '规则支持群', status: 'working', lastMessageAt: now - 30000 },
      { sessionId: 'fixture-pinned', title: '用户指定的排查主题', titleSource: 'user', nativeSessionTitleUserDefined: true, chatDisplayName: '产品支持群', status: 'idle', lastMessageAt: now - 60000 },
      { sessionId: 'fixture-attention', title: 'rule 123 队列拒绝', titleSource: 'cli', chatDisplayName: '数据服务群', status: 'working', agentAttention: { kind: 'help', reason: '需要补充实例 ID', at: now - 10000 }, lastMessageAt: now - 10000 },
    ].map((row, index) => ({ ...row, larkAppId: 'cli_fixture', botName: 'Support bot', cliId: 'codex', chatId: `oc_fixture_${index}`, chatType: 'group', spawnedAt: now - 300000 }));
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
      const titles = await page.locator('#sessions-table .sessions-table-text-cell').allTextContents();
      expect(titles.some(text => text.includes('规则支持群'))).toBe(true);
      expect(titles.some(text => text.includes('用户指定的排查主题'))).toBe(true);
      expect(titles.some(text => text.includes('需要补充实例 ID'))).toBe(true);
      if (process.env.BOTMUX_SCREENSHOT_OUTPUT) await page.screenshot({ path: process.env.BOTMUX_SCREENSHOT_OUTPUT, fullPage: true });
      await context.close();
    } finally { await browser.close(); }
  });
});
