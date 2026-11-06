import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const LONG_CHAT_NAME = `群聊${'超长不可换行名称'.repeat(48)}`;

// 非文本断言：把真实 dashboard CSS 交给 Chromium 渲染，再断言点击与布局结果。
describe('schedule form modal interaction and sizing', () => {
  let browser: Browser;
  let page: Page;
  let script: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { createDashboardTranslator } from './src/dashboard/web/i18n.ts';
          import { ScheduleFormModal } from './src/dashboard/web/schedules-page.tsx';

          const longChatName = ${JSON.stringify(LONG_CHAT_NAME)};
          window.fetch = async input => {
            const url = String(input);
            if (url.startsWith('/api/schedules/calendars')) {
              return new Response(JSON.stringify({ calendars: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            if (url.startsWith('/api/groups')) {
              return new Response(JSON.stringify({
                bots: [{ larkAppId: 'cli_modal', botName: 'Modal bot' }],
                chats: [{
                  chatId: 'oc_modal_long',
                  name: longChatName,
                  memberBots: [{ larkAppId: 'cli_modal', inChat: true }],
                }],
              }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            throw new Error('Unexpected fetch: ' + url);
          };

          function Fixture() {
            const [open, setOpen] = useState(true);
            window.closeCount = window.closeCount ?? 0;
            window.reopenScheduleModal = () => setOpen(true);
            return <ScheduleFormModal
              open={open}
              editing={{
                id: 'schedule-modal-layout',
                name: 'Modal layout test',
                schedule: '0 9 * * *',
                prompt: 'Regression fixture',
                larkAppId: 'cli_modal',
                chatIds: ['oc_modal_long'],
                chatDisplayName: longChatName,
              }}
              error={null}
              bots={[{ larkAppId: 'cli_modal', botName: 'Modal bot' }]}
              scheduleTimeZone="Asia/Shanghai"
              tr={createDashboardTranslator('zh')}
              onClose={() => {
                window.closeCount += 1;
                setOpen(false);
              }}
              onSubmit={() => {}}
            />;
          }

          createRoot(document.getElementById('root')).render(<Fixture />);
        `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    script = result.outputFiles[0].text;

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

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 720, height: 800 } });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
    await page.addScriptTag({ content: script });
    await page.locator('.schedule-form-dialog[open]').waitFor();
    await expect.poll(() => page.locator('.schedule-chat-picker-summary').textContent())
      .toBe(LONG_CHAT_NAME);
  });

  afterEach(async () => {
    await page?.close();
  });

  it('keeps edits open for an inner padding click but closes for an outside backdrop click', async () => {
    const dialog = page.locator('.schedule-form-dialog');
    const box = await dialog.boundingBox();
    if (!box) throw new Error('schedule dialog has no layout box');

    await page.mouse.click(box.x + 10, box.y + 10);
    expect(await page.evaluate(() => (window as any).closeCount)).toBe(0);
    expect(await dialog.getAttribute('open')).not.toBeNull();

    await page.mouse.click(Math.max(2, box.x - 12), box.y + box.height / 2);
    expect(await page.evaluate(() => (window as any).closeCount)).toBeGreaterThan(0);
    expect(await dialog.getAttribute('open')).toBeNull();
  });

  it('does not give a long selected chat name horizontal scrolling room', async () => {
    const metrics = await page.locator('.schedule-form-dialog').evaluate(dialog => ({
      clientWidth: dialog.clientWidth,
      scrollWidth: dialog.scrollWidth,
      triggerClientWidth: dialog.querySelector<HTMLElement>('.schedule-chat-picker-trigger')?.clientWidth,
      triggerScrollWidth: dialog.querySelector<HTMLElement>('.schedule-chat-picker-trigger')?.scrollWidth,
    }));

    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    expect(metrics.triggerScrollWidth).toBe(metrics.triggerClientWidth);
  });
});
