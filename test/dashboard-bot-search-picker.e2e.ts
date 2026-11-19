import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// 非文本断言：把真实 dashboard CSS 交给 Chromium 渲染，断言 BotSearchPicker（Base UI
// Combobox）的过滤、键盘交互（输入过滤、上下键、回车选中、Esc 关闭）与 ARIA 角色。
describe('BotSearchPicker filter and keyboard', () => {
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
          import { BotSearchPicker } from './src/dashboard/web/bot-search-picker.tsx';

          const options = [
            { larkAppId: 'cli_aa01', name: '编排一号', cliId: 'claude-code' },
            { larkAppId: 'cli_bb02', name: 'DocWriter', cliId: 'codex', hint: '最近一次调用模型失败：额度用完或被限流' },
            { larkAppId: 'cli_cc03', name: '管家', cliId: 'claude-code', disabledWhy: '管家 Bot 不能当编排 Bot' },
            { larkAppId: 'cli_dd04', name: 'Reviewer', cliId: 'claude-code' },
          ];
          window.changes = [];

          function Fixture() {
            const [value, setValue] = useState('');
            return <BotSearchPicker id="bot" label="编排 Bot" options={options} value={value}
              placeholder="选择" searchPlaceholder="搜索" emptyLabel="无匹配"
              onChange={v => { window.changes.push(v); setValue(v); }} />;
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
    const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || systemChromium,
      args: ['--no-sandbox'],
    });
  });

  afterAll(async () => { await browser?.close(); });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.setContent('<div id="root" style="padding:24px;width:420px"></div>');
    await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
    await page.addScriptTag({ content: script });
    await page.locator('#bot').waitFor();
  });

  afterEach(async () => { await page?.close(); });

  const changes = () => page.evaluate(() => (window as any).changes as string[]);
  const visibleOptions = () => page.locator('[role="option"]:visible');
  const open = async () => {
    await page.locator('#bot').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#bot-search').evaluate((el) => el === document.activeElement)).toBe(true);
  };

  it('is a combobox with a listbox of options; unusable bots are listed, disabled, with their reason', async () => {
    await open();
    expect(await page.locator('[role="listbox"]:visible').count()).toBe(1);
    expect(await visibleOptions().count()).toBe(4);
    const steward = visibleOptions().filter({ hasText: '管家' });
    expect(await steward.getAttribute('aria-disabled')).toBe('true');
    expect(await steward.textContent()).toContain('管家 Bot 不能当编排 Bot');
    expect(await visibleOptions().filter({ hasText: 'DocWriter' }).textContent()).toContain('最近一次调用模型失败');
  });

  it('typing filters by name, appId and CLI (case-insensitive); Enter picks the highlighted one', async () => {
    await open();
    await page.keyboard.type('CODEX');
    await expect.poll(() => visibleOptions().count()).toBe(1);
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual(['cli_bb02']);
    await expect.poll(() => page.locator('#bot-search').isVisible()).toBe(false);
    expect(await page.locator('#bot').textContent()).toContain('DocWriter');

    await open();
    await page.keyboard.type('cli_dd');
    await expect.poll(() => visibleOptions().count()).toBe(1);
    await page.keyboard.press('Enter');
    await open();
    await page.keyboard.type('一号');
    await expect.poll(() => visibleOptions().count()).toBe(1);
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual(['cli_bb02', 'cli_dd04', 'cli_aa01']);
  });

  it('arrow keys move the highlight (a disabled bot is reachable but Enter does not pick it); Esc closes without choosing', async () => {
    await open();
    await page.keyboard.type('claude');
    await expect.poll(() => visibleOptions().count()).toBe(3);
    const highlighted = () => page.locator('[role="option"][data-highlighted]').textContent();
    // autoHighlight: the first match is up; down reaches 管家 (disabled).
    await expect.poll(highlighted).toContain('编排一号');
    await page.keyboard.press('ArrowDown');
    await expect.poll(highlighted).toContain('管家');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual([]);
    await page.keyboard.press('ArrowDown');
    await expect.poll(highlighted).toContain('Reviewer');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#bot-search').isVisible()).toBe(false);
    expect(await changes()).toEqual([]);
    await open();
    await page.keyboard.type('review');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual(['cli_dd04']);
  });

  it('picking the current bot again (click or Enter) does not call onChange', async () => {
    await open();
    await page.keyboard.type('一号');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual(['cli_aa01']);
    await open();
    await visibleOptions().filter({ hasText: '编排一号' }).click();
    await open();
    await page.keyboard.type('一号');
    await expect.poll(() => visibleOptions().count()).toBe(1);
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual(['cli_aa01']);
    expect(await page.locator('#bot').textContent()).toContain('编排一号');
  });

  it('no match: the empty line, nothing to pick', async () => {
    await open();
    await page.keyboard.type('zzz');
    await expect.poll(() => visibleOptions().count()).toBe(0);
    expect(await page.locator('.connector-group-empty:visible').textContent()).toBe('无匹配');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual([]);
  });
});
