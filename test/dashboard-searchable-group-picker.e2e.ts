import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// 非文本断言：把真实 dashboard CSS 交给 Chromium 渲染，断言 SearchableGroupPicker
// （Base UI Combobox）的键盘交互、弹窗内浮层与触发器内 chip 的点击结果。
describe('SearchableGroupPicker keyboard and layering', () => {
  let browser: Browser;
  let page: Page;
  let script: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React, { useEffect, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SearchableGroupPicker } from './src/dashboard/web/searchable-group-picker.tsx';
          import { BotPickerChips } from './src/dashboard/web/bot-picker-chips.tsx';

          const groups = [
            { chatId: 'oc_alpha', name: 'Alpha 群' },
            { chatId: 'oc_beta', name: 'Beta 群' },
            { chatId: 'oc_gamma', name: 'Gamma 群' },
          ];
          window.changes = [];

          function Fixture() {
            const [single, setSingle] = useState('');
            const [multi, setMulti] = useState([]);
            const [chips, setChips] = useState(['oc_alpha']);
            const dialogRef = useRef(null);
            useEffect(() => { dialogRef.current?.showModal(); }, []);
            const record = (name, value) => window.changes.push([name, value]);
            return <>
              <SearchableGroupPicker id="single" label="单选" groups={groups} value={single}
                placeholder="选择群" searchPlaceholder="搜索群" emptyLabel="无匹配"
                selectedCountLabel={n => 'n=' + n}
                onChange={v => { record('single', v); setSingle(v); }} />
              <SearchableGroupPicker id="multi" label="多选" groups={groups} value={multi} multiple
                allLabel="全部群" placeholder="不限" searchPlaceholder="搜索群" emptyLabel="无匹配"
                selectedCountLabel={n => '已选 ' + n}
                onChange={v => { record('multi', v); setMulti(v); }} />
              <dialog ref={dialogRef} id="modal" style={{ width: 420 }}>
                <SearchableGroupPicker id="in-dialog" label="弹窗内" groups={groups} value={chips} multiple
                  placeholder="选择" searchPlaceholder="搜索群" emptyLabel="无匹配"
                  selectedCountLabel={n => '已选 ' + n}
                  selectedContent={chips.length ? <BotPickerChips
                    bots={chips.map(id => ({ larkAppId: id, botName: groups.find(g => g.chatId === id)?.name }))}
                    onRemove={id => { record('chip-remove', id); setChips(cur => cur.filter(x => x !== id)); }} /> : undefined}
                  onChange={v => { record('chips', v); setChips(v); }} />
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
    page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.setContent('<div id="root" style="padding:24px;display:grid;gap:12px;width:360px"></div>');
    await page.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
    await page.addScriptTag({ content: script });
    await page.locator('#modal[open]').waitFor();
    // 先关掉弹窗：模态 dialog 会让页面其余部分 inert，单测页面级选择器时不能开着它。
    await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).close());
  });

  afterEach(async () => {
    await page?.close();
  });

  const changes = () => page.evaluate(() => (window as any).changes as Array<[string, unknown]>);
  // 关闭后 Base UI 保留浮层节点、只设 hidden，所以按可见性而不是节点数判断开合。
  const visibleOptions = () => page.locator('[role="option"]:visible');
  // 打开后 Base UI 要过一帧才把焦点放进搜索框（在此之前焦点还在上一次关闭的归还途中）；
  // 在这之前就输入，文字会落到别的元素上。真实用户不会在一帧内开打，测试也等焦点到位。
  const openPicker = async (id: string) => {
    await page.locator(`#${id}`).click();
    await expect.poll(() => page.locator(`#${id}-search`).evaluate(el => el === document.activeElement)).toBe(true);
  };

  it('picks a single group with arrow keys and Enter, then returns focus to the trigger', async () => {
    await page.locator('#single').focus();
    await page.keyboard.press('Enter');
    const search = page.locator('#single-search');
    await expect.poll(() => search.evaluate(el => el === document.activeElement)).toBe(true);

    // 键盘打开时没有预高亮：第一次 ArrowDown 落到第一项，第二次到第二项。
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    expect(await changes()).toEqual([['single', 'oc_beta']]);
    await expect.poll(() => page.locator('#single-search').isVisible()).toBe(false);
    await expect.poll(() => page.locator('#single').evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.locator('#single').textContent()).toContain('Beta 群');
  });

  it('does not select while typing on the closed trigger, and Enter still opens for a keyboard pick', async () => {
    // 先打开一次再 Esc：选项此时已注册进 Base UI 关闭态触发器的 typeahead 索引。
    await page.locator('#single').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#single-search').evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#single').evaluate(el => el === document.activeElement)).toBe(true);

    // 关着时敲字母：旧缺陷是直接提交匹配项（onChange 触发）且浮层始终不出现。
    await page.keyboard.press('g');
    await page.waitForTimeout(150);
    expect(await changes()).toEqual([]);
    expect(await page.locator('#single').getAttribute('aria-expanded')).toBe('false');

    // 随后 Enter 仍能打开浮层，方向键 + Enter 完成键盘选择。
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#single-search').evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual([['single', 'oc_alpha']]);
  });

  it('filters by name or chatId and Enter picks the first match', async () => {
    await openPicker('single');
    await page.locator('#single-search').fill('gamma');
    await expect.poll(() => visibleOptions().count()).toBe(1);
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual([['single', 'oc_gamma']]);

    await openPicker('single');
    await page.locator('#single-search').fill('nothing-here');
    await expect.poll(() => page.locator('.connector-group-empty').textContent()).toBe('无匹配');
  });

  it('keeps the multi-select open while toggling, and the「全部」row clears the selection', async () => {
    await page.locator('#multi').click();
    const options = visibleOptions();
    await expect.poll(() => options.count()).toBe(4);

    // 打开时高亮当前选中项（空选择 = 「全部」），ArrowDown 依次到 Alpha、Beta。
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await changes()).toEqual([['multi', ['oc_alpha']], ['multi', ['oc_alpha', 'oc_beta']]]);
    expect(await options.count()).toBe(4);

    await options.first().click();
    expect((await changes()).at(-1)).toEqual(['multi', []]);
    expect(await options.first().getAttribute('aria-selected')).toBe('true');

    await page.keyboard.press('Escape');
    await expect.poll(() => options.count()).toBe(0);
    expect(await page.locator('#multi').textContent()).toContain('全部群');
  });

  it('keeps every option reachable inside the viewport when the viewport is short', async () => {
    await page.setViewportSize({ width: 900, height: 230 });
    await page.locator('#single').click();
    const popover = page.locator('.connector-group-picker-popover');
    await popover.waitFor();
    const popBox = await popover.boundingBox();
    if (!popBox) throw new Error('popover has no layout box');
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(230);

    // 最后一项要能滚进浮层可视区并点中，而不是落在外框之外、点不到。
    const last = page.locator('[role="option"]', { hasText: 'Gamma 群' });
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    if (!box) throw new Error('option has no layout box');
    expect(box.y + box.height).toBeLessThanOrEqual(popBox.y + popBox.height);
    await last.click();
    expect(await changes()).toEqual([['single', 'oc_gamma']]);
  });

  it('renders the popup above an open modal dialog and keeps it clickable', async () => {
    await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
    await page.locator('#in-dialog').click({ position: { x: 300, y: 10 } });
    const option = page.locator('[role="option"]', { hasText: 'Gamma 群' });
    await option.waitFor();
    // 浮层必须挂进 top layer 里的 dialog，否则会被模态弹窗盖住、点不到。
    expect(await option.evaluate(el => Boolean(el.closest('dialog[open]')))).toBe(true);
    const box = await option.boundingBox();
    if (!box) throw new Error('option has no layout box');
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent,
      [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toContain('Gamma 群');

    await option.click();
    expect((await changes()).at(-1)).toEqual(['chips', ['oc_alpha', 'oc_gamma']]);
  });

  // chip 用的是连接器「额外 Bot」的生产组件 BotPickerChips，不是测试里复制的一份。
  it('removing a chip inside the trigger does not open the popup', async () => {
    await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
    await page.getByLabel('取消选择 Alpha 群').click();
    await expect.poll(() => page.locator('.connector-bot-picker-chip').count()).toBe(0);
    expect((await changes()).at(-1)).toEqual(['chip-remove', 'oc_alpha']);
    expect(await page.locator('#in-dialog').getAttribute('aria-expanded')).toBe('false');
    // 给浮层一个打开的机会再断言它没开。
    await page.waitForTimeout(150);
    expect(await visibleOptions().count()).toBe(0);
  });
});
