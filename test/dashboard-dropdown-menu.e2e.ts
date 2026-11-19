import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// 非文本断言：把真实 dashboard CSS 交给 Chromium 渲染，断言 DropdownMenu（Base UI
// Select / Combobox）的键盘交互、弹窗与滚动容器里的浮层、以及页面 CSS 钩子的实际效果。
describe('DropdownMenu on Base UI', () => {
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
          import { DropdownMenu, dropdownLabel } from './src/dashboard/web/dashboard-components.tsx';

          window.changes = [];
          const record = (...entry) => window.changes.push(entry);
          const letters = [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta', hint: 'Second letter' },
            { value: 'x', label: 'Locked', disabled: true },
            { value: 'g', label: 'Gamma' },
          ];
          const zones = Array.from({ length: 14 }, (_, i) => ({ value: 'tz' + i, label: 'Zone ' + i }));
          const clis = [
            { value: 'claude-code', label: 'Claude', disabled: true },
            { value: 'codex', label: 'Codex' },
            { value: 'gemini', label: 'Gemini' },
          ];

          function Menu(props) {
            const [value, setValue] = useState(props.initial);
            return <DropdownMenu {...props} value={value} label={dropdownLabel(props.options, value)}
              onChange={next => { record(props.id, next); setValue(next); }} />;
          }

          function Fixture() {
            return <>
              <form id="form" onSubmit={event => { event.preventDefault(); record('submit'); }}
                style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
                <Menu id="long" ariaLabel="Long" options={zones} initial="tz0" />
                <Menu id="plain" ariaLabel="Letters" options={letters} initial="a" />
                <Menu id="notify" ariaLabel="Notify" options={letters} initial="a" notifyOnReselect />
                <Menu id="search" ariaLabel="CLI" options={clis} initial="gemini" searchable
                  searchPlaceholder="Filter" searchEmptyLabel="No match" />
                <Menu id="off" ariaLabel="Off" options={letters} initial="a" disabled />
                <Menu id="empty" ariaLabel="Zone" initial=""
                  options={[{ value: '', label: 'Follow host' }, { value: 'tz1', label: 'Zone 1' }]} />
                <Menu id="wide" ariaLabel="Wide" options={letters} initial="a" style={{ width: 300 }} />
                <Menu id="field" className="bd-field-menu" ariaLabel="Field" options={zones} initial="tz0"
                  style={{ width: 260 }} />
                <Menu id="start" className="dw-mode" ariaLabel="Start aligned" options={letters} initial="a" />
              </form>
              <div id="scroller" style={{ height: 140, overflow: 'auto', marginTop: 12, border: '1px solid' }}>
                <div style={{ height: 90 }} />
                <Menu id="scrolled" ariaLabel="Scrolled" options={zones} initial="tz0" />
                <div style={{ height: 200 }} />
              </div>
              <dialog id="modal" style={{ width: 360 }}>
                <Menu id="in-dialog" ariaLabel="In dialog" options={letters} initial="a" />
                <Menu id="in-dialog-search" ariaLabel="Search in dialog" options={clis} initial="codex" searchable
                  searchPlaceholder="Filter" searchEmptyLabel="No match" />
              </dialog>
            </>;
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
    page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.setContent('<div id="root" style="padding:24px"></div>');
    await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
    await page.addScriptTag({ content: script });
    // 首帧是同款外观的占位触发器；Base UI 实现到位后触发器才可聚焦。
    await page.locator('#plain > .sect-sort-trigger[tabindex="0"]').waitFor();
  });

  afterEach(async () => {
    await page?.close();
  });

  const changes = () => page.evaluate(() => (window as any).changes as unknown[][]);
  const trigger = (id: string) => page.locator(`#${id} > .sect-sort-trigger`);
  // 关闭后 Base UI 可能保留浮层节点、只设 hidden，所以按可见性判断开合。
  const options = () => page.locator('[role="option"]:visible');
  const option = (label: string) => page.locator('[role="option"]:visible', { hasText: label });
  const popup = () => page.locator('.sect-sort-pop:visible');
  const focused = (locator: ReturnType<Page['locator']>) => locator.evaluate(el => el === document.activeElement);
  const box = async (locator: ReturnType<Page['locator']>) => {
    const rect = await locator.boundingBox();
    if (!rect) throw new Error('no layout box');
    return rect;
  };
  const hitTest = (rect: { x: number; y: number; width: number; height: number }) => page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent ?? null,
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
  );

  it('picks with arrow keys and Enter, then returns focus to the trigger', async () => {
    await trigger('plain').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => options().count()).toBe(4);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    expect(await changes()).toEqual([['plain', 'b']]);
    await expect.poll(() => options().count()).toBe(0);
    await expect.poll(() => focused(trigger('plain'))).toBe(true);
    expect(await trigger('plain').textContent()).toBe('Beta');
    expect(await changes()).not.toContainEqual(['submit']);
  });

  it('ignores letters typed on the closed trigger', async () => {
    // 先开关一次：选项已注册进 Base UI 关闭态触发器的 typeahead 索引。
    await trigger('plain').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => options().count()).toBe(4);
    await page.keyboard.press('Escape');
    await expect.poll(() => focused(trigger('plain'))).toBe(true);

    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await page.waitForTimeout(150);
    expect(await changes()).toEqual([]);
    expect(await trigger('plain').getAttribute('aria-expanded')).toBe('false');

    // Space 仍然能打开。
    await page.keyboard.press(' ');
    await expect.poll(() => options().count()).toBe(4);
  });

  it('skips onChange when re-picking the current value unless notifyOnReselect is set', async () => {
    await trigger('plain').click();
    await option('Alpha').click();
    await expect.poll(() => options().count()).toBe(0);
    expect(await changes()).toEqual([]);

    await trigger('notify').click();
    await option('Alpha').click();
    expect(await changes()).toEqual([['notify', 'a']]);
  });

  it('shows hints only in the popup, marks the selection, and ignores disabled options', async () => {
    await trigger('plain').click();
    expect(await trigger('plain').textContent()).toBe('Alpha');
    expect(await option('Beta').textContent()).toBe('BetaSecond letter');
    expect(await option('Alpha').getAttribute('aria-selected')).toBe('true');
    expect(await option('Locked').getAttribute('aria-disabled')).toBe('true');

    await option('Locked').click({ force: true });
    await page.waitForTimeout(150);
    expect(await changes()).toEqual([]);
  });

  it('treats an empty-string value as a real, selected option', async () => {
    expect(await trigger('empty').textContent()).toBe('Follow host');
    await trigger('empty').click();
    expect(await option('Follow host').getAttribute('aria-selected')).toBe('true');
    await option('Zone 1').click();
    await trigger('empty').click();
    await option('Follow host').click();
    expect(await changes()).toEqual([['empty', 'tz1'], ['empty', '']]);
  });

  it('cannot be opened or focused while disabled', async () => {
    expect(await trigger('off').getAttribute('aria-disabled')).toBe('true');
    await trigger('off').click({ force: true });
    await page.waitForTimeout(150);
    expect(await options().count()).toBe(0);
    await trigger('notify').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await focused(trigger('off'))).toBe(false);
  });

  it('searchable: Enter takes the first enabled match and never submits the form', async () => {
    await trigger('search').click();
    const input = page.locator('.sect-sort-search:visible');
    await expect.poll(() => focused(input)).toBe(true);

    // 空查询：高亮停在当前值上，Enter 只是确认，不改值。
    await expect.poll(() => option('Gemini').getAttribute('data-highlighted')).toBe('');
    await page.keyboard.press('Enter');
    await expect.poll(() => options().count()).toBe(0);
    expect(await changes()).toEqual([]);

    // 第一项匹配（Claude）是禁用的：Enter 落在 Codex，焦点回到触发器。
    await trigger('search').click();
    await expect.poll(() => focused(input)).toBe(true);
    await page.keyboard.type('c');
    await expect.poll(() => options().count()).toBe(2);
    await page.keyboard.press('Enter');
    await expect.poll(() => options().count()).toBe(0);
    expect(await changes()).toEqual([['search', 'codex']]);
    await expect.poll(() => focused(trigger('search'))).toBe(true);

    // 方向键从当前值往下走。
    await trigger('search').click();
    await expect.poll(() => focused(input)).toBe(true);
    await expect.poll(() => option('Codex').getAttribute('data-highlighted')).toBe('');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await changes()).at(-1)).toEqual(['search', 'gemini']);

    // 没有匹配：显示空态，Enter 什么也不做。
    await trigger('search').click();
    await expect.poll(() => focused(input)).toBe(true);
    await page.keyboard.type('zzz');
    await expect.poll(() => page.locator('.sect-sort-empty:visible').textContent()).toBe('No match');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    expect(await popup().count()).toBe(1);
    expect(await changes()).toEqual([['search', 'codex'], ['search', 'gemini']]);
  });

  it('Escape inside a modal dialog closes only the popup, which renders inside the dialog', async () => {
    await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
    await trigger('in-dialog').click();
    const gamma = option('Gamma');
    await gamma.waitFor();
    expect(await gamma.evaluate(el => Boolean(el.closest('dialog[open]')))).toBe(true);
    expect(await hitTest(await box(gamma))).toBe('Gamma');

    await page.keyboard.press('Escape');
    await expect.poll(() => options().count()).toBe(0);
    expect(await page.locator('#modal').evaluate(el => (el as HTMLDialogElement).open)).toBe(true);

    await trigger('in-dialog').click();
    await option('Gamma').click();
    expect(await changes()).toEqual([['in-dialog', 'g']]);

    await trigger('in-dialog-search').click();
    const input = page.locator('.sect-sort-search:visible');
    await expect.poll(() => focused(input)).toBe(true);
    expect(await input.evaluate(el => Boolean(el.closest('dialog[open]')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => options().count()).toBe(0);
    expect(await page.locator('#modal').evaluate(el => (el as HTMLDialogElement).open)).toBe(true);

    await trigger('in-dialog-search').click();
    await expect.poll(() => focused(input)).toBe(true);
    await page.keyboard.type('gem');
    await page.keyboard.press('Enter');
    expect((await changes()).at(-1)).toEqual(['in-dialog-search', 'gemini']);
    await expect.poll(() => options().count()).toBe(0);
    await expect.poll(() => focused(trigger('in-dialog-search'))).toBe(true);

    // 菜单已关，再按 Esc 才轮到弹窗自己。
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#modal').evaluate(el => (el as HTMLDialogElement).open)).toBe(false);
  });

  it('keeps every option reachable from a menu at the bottom of a scroll container', async () => {
    await trigger('scrolled').click();
    await expect.poll(() => options().count()).toBe(14);
    const pop = await box(popup());
    expect(pop.y + pop.height).toBeLessThanOrEqual(900);
    for (let i = 0; i < 14; i++) {
      const item = option(`Zone ${i}`).first();
      await item.scrollIntoViewIfNeeded();
      expect(await hitTest(await box(item)), `Zone ${i}`).toBe(`Zone ${i}`);
    }
    await option('Zone 13').click();
    expect(await changes()).toEqual([['scrolled', 'tz13']]);
  });

  it('stays inside a short viewport with the last option still clickable', async () => {
    // 触发器在视口中部：上下两侧都不到 52vh，光靠样式里的 vh 上限会出界。
    await page.setViewportSize({ width: 900, height: 400 });
    await page.evaluate(() => { document.getElementById('root')!.style.paddingTop = '170px'; });
    await trigger('long').click();
    await expect.poll(() => options().count()).toBe(14);
    const pop = await box(popup());
    expect(pop.y).toBeGreaterThanOrEqual(0);
    expect(pop.y + pop.height).toBeLessThanOrEqual(400);
    const last = option('Zone 13');
    await last.scrollIntoViewIfNeeded();
    expect(await hitTest(await box(last))).toBe('Zone 13');
    await last.click();
    expect(await changes()).toEqual([['long', 'tz13']]);
  });

  it('is non-modal: the page keeps scrolling and another menu opens in one click', async () => {
    // modal 模式会给 html/body 加滚动锁。
    const scrollLock = () => page.evaluate(() => [document.documentElement, document.body]
      .map(el => `${el.getAttribute('style') ?? ''}|${getComputedStyle(el).overflow}`).join(' / '));
    const before = await scrollLock();
    await trigger('notify').click();
    await expect.poll(() => options().count()).toBe(4);
    expect(await scrollLock()).toBe(before);
    // 弹层开在触发器下方，所以点上方那个菜单。
    await trigger('plain').click();
    await expect.poll(() => trigger('plain').getAttribute('aria-expanded')).toBe('true');
    expect(await trigger('notify').getAttribute('aria-expanded')).toBe('false');
    expect(await options().count()).toBe(4);
  });

  it('sizes and aligns the popup against its trigger, including page hooks', async () => {
    // 默认：开在触发器下方（不盖住触发器），不窄于触发器，水平居中。
    await trigger('wide').click();
    await expect.poll(() => options().count()).toBe(4);
    const wide = await box(trigger('wide'));
    let pop = await box(popup());
    expect(pop.y).toBeGreaterThanOrEqual(wide.y + wide.height);
    expect(pop.width).toBeGreaterThanOrEqual(wide.width - 0.5);
    expect(Math.abs(pop.x + pop.width / 2 - (wide.x + wide.width / 2))).toBeLessThan(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => options().count()).toBe(0);

    // bd-field-menu：与触发器同宽，限高 280px。
    await trigger('field').click();
    const field = await box(trigger('field'));
    pop = await box(popup());
    expect(Math.abs(pop.width - field.width)).toBeLessThan(1);
    expect(pop.height).toBeLessThanOrEqual(280);
    await page.keyboard.press('Escape');
    await expect.poll(() => options().count()).toBe(0);

    // dw-mode：--dropdown-align: start 贴触发器左缘，宽度至少 220px。
    await trigger('start').click();
    const start = await box(trigger('start'));
    pop = await box(popup());
    expect(Math.abs(pop.x - start.x)).toBeLessThan(1);
    expect(pop.width).toBeGreaterThanOrEqual(220);
  });
});
