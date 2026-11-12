import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// 非文本断言：真实的成员权限组件 + 真实 dashboard CSS 放进群管理抽屉（#g-drawer）交给 Chromium，
// 用鼠标点击验证勾选行为。抽屉样式把 .checkbox-row 里的原生复选框隐藏且 pointer-events:none，
// 只有 <label> 行能把对胶囊的点击转给复选框，这一点只能在真实浏览器里看到。
const MEMBERS = [
  { openId: 'ou_person_a', name: 'Person A', memberType: 'unknown' },
  { openId: 'ou_person_b', name: 'Person B', memberType: 'unknown' },
  { openId: 'ou_viewpoint_bot', name: 'Viewpoint Bot', memberType: 'bot', self: true },
  { openId: 'ou_peer_bot', name: 'Peer Bot', memberType: 'bot' },
];

describe('member access rows in the group drawer are selectable with a mouse', () => {
  let browser: Browser;
  let page: Page;
  let script: string;
  let css: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MemberAccessSection } from './src/dashboard/web/member-access-section.tsx';

          const members = ${JSON.stringify(MEMBERS)};
          window.__calls = [];
          const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
          window.fetch = async (input, init = {}) => {
            const path = new URL(String(input), location.href).pathname;
            const body = init.body ? JSON.parse(String(init.body)) : null;
            window.__calls.push({ path, method: init.method ?? 'GET', body });
            if (path.endsWith('/members-display')) return json({ members });
            if (path.endsWith('/blocked-users')) {
              const entries = body?.entries ?? [];
              return json({ ok: true, raw: entries, resolved: entries });
            }
            if (path.endsWith('/grants/chat')) {
              return json({ ok: true, subjects: body.subjectOpenIds.map(id => ({ subjectOpenId: id, chatGrantActive: false, changed: false, grantsTalk: false, grantsOperate: false })) });
            }
            return json({ ok: false, error: 'not_found' }, 404);
          };
          const tr = key => key;
          const chat = { chatId: 'oc_drawer', memberBots: [{ larkAppId: 'cli_viewpoint', botName: 'Viewpoint Bot', inChat: true }] };
          createRoot(document.getElementById('root')).render(<MemberAccessSection chat={chat} members={chat.memberBots} tr={tr} />);
        `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    script = result.outputFiles[0].text;
    css = readFileSync('src/dashboard/web/style.css', 'utf8');

    const systemChromium = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ].find(existsSync);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || systemChromium,
      args: ['--no-sandbox'],
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  afterEach(async () => {
    await page?.close();
  });

  async function openDrawer(): Promise<Page> {
    page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const html = `<!doctype html><html lang="zh" data-theme="light"><head><style>${css}</style></head>`
      + '<body><dialog id="g-drawer" class="groups-manage-drawer" open><article class="g-manage-dialog">'
      + '<div class="g-manage-body"><section role="tabpanel"><div id="root"></div></section></div>'
      + '</article></dialog></body></html>';
    await page.route('http://drawer.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://drawer.test/');
    await page.addScriptTag({ content: script });
    await page.locator('[data-member-row="ou_person_a"]').waitFor();
    return page;
  }

  const row = (openId: string) => page.locator(`[data-member-row="${openId}"]`);
  const box = (openId: string) => row(openId).locator('input[type=checkbox]');

  it('clicking a member pill selects it and enables the grant button; clicking again unselects', async () => {
    await openDrawer();
    const grant = page.locator('[data-action="grant-selected"]');
    await expect(grant.isDisabled()).resolves.toBe(true);

    await row('ou_person_a').locator('strong').click();
    await expect(box('ou_person_a').isChecked()).resolves.toBe(true);
    await expect(grant.isEnabled()).resolves.toBe(true);

    await row('ou_peer_bot').click({ position: { x: 6, y: 10 } });
    await expect(box('ou_peer_bot').isChecked()).resolves.toBe(true);

    await row('ou_person_a').locator('strong').click();
    await expect(box('ou_person_a').isChecked()).resolves.toBe(false);
  });

  it('the block button inside a pill blocks without toggling the selection', async () => {
    await openDrawer();
    await row('ou_person_b').locator('[data-action="row-block"]').click();
    await row('ou_person_b').locator('[data-action="row-unblock"]').waitFor();

    await expect(box('ou_person_b').isChecked()).resolves.toBe(false);
    const puts = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.method === 'PUT'));
    expect(puts.map((c: any) => c.body)).toEqual([{ entries: ['ou_person_b'] }]);
  });

  it('the viewpoint bot\'s own pill cannot be selected', async () => {
    await openDrawer();
    // force：Playwright 会把对 <label> 的点击重定向到已禁用的复选框并拒绝执行；真实鼠标点击没有这层检查。
    await row('ou_viewpoint_bot').locator('strong').click({ force: true });
    await expect(box('ou_viewpoint_bot').isChecked()).resolves.toBe(false);
    await expect(page.locator('[data-action="grant-selected"]').isDisabled()).resolves.toBe(true);
  });
});
