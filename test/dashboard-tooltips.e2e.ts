import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// 非文本断言：把真实 dashboard CSS 交给 Chromium 渲染，断言 InfoTip（Base UI Popover）、
// OverflowText / IconTip（Base UI Tooltip）、FeedGroupPicker（Base UI Popover）的指针、键盘、
// 触屏交互，以及浮层在滚动容器和原生 modal dialog 里的落点。
describe('dashboard tips and pickers on Base UI', () => {
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
          import { FieldTitle, IconTip, InfoTip, OverflowText } from './src/dashboard/web/dashboard-components.tsx';
          import { FeedGroupPicker } from './src/dashboard/web/feed-group-picker.tsx';

          window.events = [];
          const record = (...entry) => window.events.push(entry);
          const groups = [{ groupId: 'g1', name: 'Alpha team' }, { groupId: 'g2', name: 'Beta team' }];

          function Picker(props) {
            const [state, setState] = useState({ selectedId: '', newName: '' });
            return <FeedGroupPicker groups={groups} selectedId={state.selectedId} newName={state.newName}
              disabled={props.disabled}
              onChange={(selectedId, newName) => { record(props.id, selectedId, newName); setState({ selectedId, newName }); }} />;
          }

          function Fixture() {
            return <>
              <span id="top-tip" style={{ position: 'absolute', top: 6, left: 320 }}>
                <InfoTip label="Top help">Shown below the mark</InfoTip>
              </span>
              <main style={{ padding: '170px 24px 24px', display: 'grid', gap: 14, justifyItems: 'start', width: 420 }}>
                <button id="before" type="button">before</button>
                <label id="toggle">
                  <input id="cb" type="checkbox" />
                  <FieldTitle help="Explains the toggle">Toggle</FieldTitle>
                </label>
                <a id="nav" href="#/settings">
                  Settings
                  <InfoTip className="nav-update-tip" label="Update ready" preventClick={false} focusable={false}
                    trigger={<span className="nav-update-dot" aria-hidden="true" />}>Update ready</InfoTip>
                </a>
                <button id="after-nav" type="button">after</button>
                <div id="ov-long" style={{ width: 120 }}><OverflowText text="A very long whiteboard title that cannot fit" /></div>
                <div id="ov-short" style={{ width: 300 }}><OverflowText text="Short" /></div>
                <div id="ov-quiet" style={{ width: 120 }}><OverflowText text="A very long agent name that cannot fit" showPopover={false} /></div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <IconTip label="Restart CLI">
                    <button id="icon-a" type="button" className="card-act" aria-label="Restart CLI"
                      onClick={event => { event.stopPropagation(); record('icon-a'); }}
                      dangerouslySetInnerHTML={{ __html: '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" /></svg>' }} />
                  </IconTip>
                  <IconTip label="Open console"><a id="icon-link" href="#console" aria-label="Open console">↗</a></IconTip>
                </div>
                <form id="form" style={{ width: 320 }} onSubmit={event => { event.preventDefault(); record('submit'); }}>
                  <div id="picker"><Picker id="picker" /></div>
                  <button type="submit">Create</button>
                </form>
                <div id="picker-off" style={{ width: 320 }}><Picker id="picker-off" disabled /></div>
                <button id="open-dialog" type="button" onClick={() => document.getElementById('modal').showModal()}>Open dialog</button>
              </main>
              <dialog id="modal" style={{ width: 380 }}>
                <IconTip label="Close">
                  <button id="dialog-close" type="button" aria-label="Close" onClick={() => document.getElementById('modal').close()}>×</button>
                </IconTip>
                <p id="dialog-tip">Field <InfoTip>Help inside the dialog</InfoTip></p>
                <div id="dialog-scroller" style={{ height: 70, overflow: 'auto' }}>
                  <div id="dialog-picker"><Picker id="dialog-picker" /></div>
                </div>
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

  async function load(target: Page): Promise<void> {
    await target.setContent('<div id="root"></div>');
    await target.addStyleTag({ content: readFileSync('src/dashboard/web/style.css', 'utf8') });
    await target.addScriptTag({ content: script });
    // 首帧是同款外观的占位；Base UI 实现到位后 InfoTip 才可聚焦、另外两类触发器才带 Base UI 标记。
    await target.locator('#toggle .ui-info-tip[tabindex="0"]').waitFor();
    await target.locator('#icon-a[data-base-ui-tooltip-trigger]').waitFor();
    await target.locator('#picker .feed-group-picker-trigger[tabindex="0"]').waitFor();
  }

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    await load(page);
  });

  afterEach(async () => {
    await page?.close();
  });

  const events = () => page.evaluate(() => (window as any).events as unknown[][]);
  const focused = (locator: Locator) => locator.evaluate(el => el === document.activeElement);
  const visible = (locator: Locator) => locator.isVisible();
  const box = async (locator: Locator) => {
    const rect = await locator.boundingBox();
    if (!rect) throw new Error('no layout box');
    return rect;
  };
  /** A point away from every fixture control. */
  const away = { x: 980, y: 980 };
  const hitsInside = (locator: Locator) => locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hit && el.contains(hit);
  });

  describe('InfoTip', () => {
    const mark = () => page.locator('#toggle .ui-info-tip');
    const help = () => page.locator('.ui-info-pop', { hasText: 'Explains the toggle' });

    it('opens on hover above the mark and stays open while the pointer moves onto the popup to copy it', async () => {
      await mark().hover();
      await expect.poll(() => visible(help())).toBe(true);
      const markBox = await box(mark());
      const popBox = await box(help());
      expect(popBox.y + popBox.height).toBeLessThanOrEqual(markBox.y);
      expect(await help().evaluate(el => getComputedStyle(el).userSelect)).toBe('text');

      await page.mouse.move(popBox.x + popBox.width / 2, popBox.y + popBox.height / 2, { steps: 8 });
      await page.waitForTimeout(400);
      expect(await visible(help())).toBe(true);

      await page.mouse.move(away.x, away.y);
      await expect.poll(() => visible(help())).toBe(false);
    });

    it('rides out a brief slip of the pointer off the mark instead of flickering shut', async () => {
      await mark().hover();
      await expect.poll(() => visible(help())).toBe(true);
      await mark().evaluate(el => {
        (window as any).tipClosed = false;
        new MutationObserver(() => {
          if (!el.hasAttribute('data-popup-open')) (window as any).tipClosed = true;
        }).observe(el, { attributes: true, attributeFilter: ['data-popup-open'] });
      });
      const markBox = await box(mark());
      const x = markBox.x + markBox.width / 2;
      // Downwards, away from the popup, so the safe path towards it does not apply.
      await page.mouse.move(x, markBox.y + markBox.height + 10, { steps: 3 });
      await page.mouse.move(x, markBox.y + markBox.height / 2, { steps: 3 });
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => (window as any).tipClosed)).toBe(false);
      expect(await visible(help())).toBe(true);
    });

    it('pins open on click inside a label without toggling its checkbox; an outside click closes it', async () => {
      await mark().click();
      await expect.poll(() => visible(help())).toBe(true);
      expect(await page.locator('#cb').isChecked()).toBe(false);

      await page.mouse.move(away.x, away.y);
      await page.waitForTimeout(400);
      expect(await visible(help())).toBe(true);

      await page.mouse.click(away.x, away.y);
      await expect.poll(() => visible(help())).toBe(false);
      expect(await page.locator('#cb').isChecked()).toBe(false);
    });

    it('is a tab stop that Enter opens without toggling the checkbox; Escape closes it and returns focus', async () => {
      await page.locator('#before').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await focused(mark())).toBe(true);
      // Focus alone does not open it: Base UI popovers open on hover, press or Enter / Space.
      await page.waitForTimeout(300);
      expect(await visible(help())).toBe(false);

      await page.keyboard.press('Enter');
      await expect.poll(() => visible(help())).toBe(true);
      expect(await page.locator('#cb').isChecked()).toBe(false);

      await page.keyboard.press('Escape');
      await expect.poll(() => visible(help())).toBe(false);
      expect(await focused(mark())).toBe(true);
    });

    it('closes once Tab moves on past it, whether Enter or a click opened it', async () => {
      await page.locator('#before').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect.poll(() => visible(help())).toBe(true);
      await page.keyboard.press('Tab');
      await expect.poll(() => visible(help())).toBe(false);
      expect(await focused(page.locator('#nav'))).toBe(true);

      await mark().click();
      await expect.poll(() => visible(help())).toBe(true);
      await page.mouse.move(away.x, away.y);
      await page.keyboard.press('Tab');
      await expect.poll(() => visible(help())).toBe(false);
      expect(await focused(page.locator('#nav'))).toBe(true);
    });

    it('is a button named by its label, else the field title, else plain-text help', async () => {
      await expect.poll(() => page.getByRole('button', { name: 'Top help', exact: true }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Toggle', exact: true }).evaluate(el => el.matches('#toggle .ui-info-tip'))).toBe(true);
      await page.locator('#open-dialog').click();
      expect(await page.getByRole('button', { name: 'Help inside the dialog', exact: true })
        .evaluate(el => el.matches('#dialog-tip .ui-info-tip'))).toBe(true);
    });

    it('opens on tap on a touch screen, without toggling the checkbox', async () => {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
      const touch = await context.newPage();
      try {
        await load(touch);
        const tip = touch.locator('.ui-info-pop', { hasText: 'Explains the toggle' });
        await touch.locator('#toggle .ui-info-tip').tap();
        await expect.poll(() => tip.isVisible()).toBe(true);
        expect(await touch.locator('#cb').isChecked()).toBe(false);
        await touch.touchscreen.tap(380, 830);
        await expect.poll(() => tip.isVisible()).toBe(false);
      } finally {
        await context.close();
      }
    });

    it('inside a link with focusable/preventClick off: no tab stop, the click follows the link and does not pin', async () => {
      const dot = page.locator('#nav .ui-info-tip');
      const tip = page.locator('.ui-info-pop', { hasText: 'Update ready' });
      expect(await dot.getAttribute('tabindex')).toBeNull();
      expect(await dot.getAttribute('role')).toBeNull();
      await page.locator('#nav').focus();
      await page.keyboard.press('Tab');
      expect(await focused(page.locator('#after-nav'))).toBe(true);

      await dot.hover();
      await expect.poll(() => visible(tip)).toBe(true);
      await dot.click();
      expect(await page.evaluate(() => location.hash)).toBe('#/settings');
      await page.mouse.move(away.x, away.y);
      await expect.poll(() => visible(tip)).toBe(false);
    });

    it('flips below the mark when there is no room above', async () => {
      const top = page.locator('#top-tip .ui-info-tip');
      const tip = page.locator('.ui-info-pop', { hasText: 'Shown below the mark' });
      await top.hover();
      await expect.poll(() => visible(tip)).toBe(true);
      expect(await tip.getAttribute('data-side')).toBe('bottom');
      expect((await box(tip)).y).toBeGreaterThanOrEqual((await box(top)).y + (await box(top)).height);
    });

    it('lands in the open modal dialog, above the dialog content', async () => {
      await page.locator('#open-dialog').click();
      const tip = page.locator('.ui-info-pop', { hasText: 'Help inside the dialog' });
      await page.locator('#dialog-tip .ui-info-tip').hover();
      await expect.poll(() => visible(tip)).toBe(true);
      expect(await tip.evaluate(el => el.closest('dialog')?.id)).toBe('modal');
      expect(await hitsInside(tip)).toBe(true);
    });
  });

  describe('OverflowText', () => {
    const fullText = (text: string) => page.locator('.ui-overflow-popover', { hasText: text });

    it('shows the full text only while it is cut off, and never with showPopover={false}', async () => {
      const long = page.locator('#ov-long .ui-overflow-text');
      await expect.poll(() => long.getAttribute('class')).toContain('is-overflowing');
      await long.hover();
      const tip = fullText('A very long whiteboard title that cannot fit');
      await expect.poll(() => visible(tip)).toBe(true);
      expect((await box(tip)).width).toBeGreaterThan((await box(long)).width);
      await page.mouse.move(away.x, away.y);
      await expect.poll(() => visible(tip)).toBe(false);

      const short = page.locator('#ov-short .ui-overflow-text');
      await short.hover();
      await page.waitForTimeout(400);
      expect(await short.getAttribute('class')).not.toContain('is-overflowing');
      expect(await page.locator('.ui-overflow-popover:visible').count()).toBe(0);

      const quiet = page.locator('#ov-quiet .ui-overflow-text');
      await quiet.hover();
      await page.waitForTimeout(400);
      expect(await quiet.getAttribute('class')).toContain('is-overflowing');
      expect(await page.locator('.ui-overflow-popover:visible').count()).toBe(0);
    });
  });

  describe('IconTip', () => {
    const icon = () => page.locator('#icon-a');
    const tip = (label: string) => page.locator('.icon-tip', { hasText: label });

    it('shows the label above the icon on hover; a click hides it and still runs the action', async () => {
      await icon().hover();
      await expect.poll(() => visible(tip('Restart CLI'))).toBe(true);
      const iconBox = await box(icon());
      const tipBox = await box(tip('Restart CLI'));
      expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(iconBox.y);
      const arrow = await box(tip('Restart CLI').locator('.icon-tip-arrow'));
      expect(Math.abs(arrow.x + arrow.width / 2 - (iconBox.x + iconBox.width / 2))).toBeLessThan(1.5);

      await icon().click();
      await expect.poll(() => visible(tip('Restart CLI'))).toBe(false);
      expect(await events()).toEqual([['icon-a']]);
      await page.waitForTimeout(300);
      expect(await visible(tip('Restart CLI'))).toBe(false);
    });

    it('keyboard focus shows it; focus from a mouse-opened dialog does not', async () => {
      await page.locator('#after-nav').click();
      await page.keyboard.press('Tab');
      expect(await focused(icon())).toBe(true);
      await expect.poll(() => visible(tip('Restart CLI'))).toBe(true);
      await page.keyboard.press('Tab');
      await expect.poll(() => visible(tip('Restart CLI'))).toBe(false);

      await page.locator('#open-dialog').click();
      expect(await focused(page.locator('#dialog-close'))).toBe(true);
      await page.waitForTimeout(400);
      expect(await visible(tip('Close'))).toBe(false);
      await page.keyboard.press('Escape');

      await page.locator('#open-dialog').focus();
      await page.keyboard.press('Enter');
      expect(await focused(page.locator('#dialog-close'))).toBe(true);
      await expect.poll(() => visible(tip('Close'))).toBe(true);
      expect(await tip('Close').evaluate(el => el.closest('dialog')?.id)).toBe('modal');
    });

    it('stays out of the way on a touch screen', async () => {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
      const touch = await context.newPage();
      try {
        await load(touch);
        await touch.locator('#icon-a').tap();
        await touch.waitForTimeout(400);
        expect(await touch.locator('.icon-tip:visible').count()).toBe(0);
        expect(await touch.evaluate(() => (window as any).events)).toEqual([['icon-a']]);
      } finally {
        await context.close();
      }
    });
  });

  describe('FeedGroupPicker', () => {
    const trigger = (id: string) => page.locator(`#${id} .feed-group-picker-trigger`);
    const popup = () => page.locator('.feed-group-picker-pop:visible');

    it('picks an existing label, closes, and returns focus to the trigger', async () => {
      expect(await trigger('picker').getAttribute('aria-label')).toBe('飞书标签，当前：不选择标签');
      await trigger('picker').click();
      await expect.poll(() => popup().count()).toBe(1);
      expect(Math.abs((await box(popup())).width - (await box(trigger('picker'))).width)).toBeLessThan(1);

      await popup().getByRole('button', { name: 'Beta team' }).click();
      expect(await events()).toEqual([['picker', 'g2', '']]);
      await expect.poll(() => popup().count()).toBe(0);
      expect(await trigger('picker').getAttribute('aria-label')).toBe('飞书标签，当前：Beta team');
      expect(await focused(trigger('picker'))).toBe(true);

      await trigger('picker').click();
      expect(await popup().getByRole('button', { name: 'Beta team' }).getAttribute('aria-current')).toBe('true');
    });

    it('takes a new label from the first row, and Enter there does not submit the form', async () => {
      await trigger('picker').click();
      await popup().getByRole('textbox').fill('  Gamma');
      await popup().getByRole('textbox').press('Enter');
      expect((await events()).at(-1)).toEqual(['picker', '', 'Gamma']);
      expect(await events()).not.toContainEqual(['submit']);
      expect(await popup().count()).toBe(1);
      expect(await trigger('picker').getAttribute('aria-label')).toBe('飞书标签，当前：新建标签：Gamma');
    });

    it('stays shut while disabled', async () => {
      expect(await trigger('picker-off').getAttribute('aria-disabled')).toBe('true');
      await trigger('picker-off').click({ force: true });
      await page.waitForTimeout(300);
      expect(await popup().count()).toBe(0);
    });

    it('inside a scrolling modal dialog: the popup escapes the scroller, and Escape closes only the picker', async () => {
      await page.locator('#open-dialog').click();
      await trigger('dialog-picker').click();
      await expect.poll(() => popup().count()).toBe(1);
      expect(await popup().evaluate(el => el.closest('dialog')?.id)).toBe('modal');
      const scroller = await box(page.locator('#dialog-scroller'));
      const last = popup().getByRole('button', { name: 'Beta team' });
      expect((await box(last)).y).toBeGreaterThan(scroller.y + scroller.height);
      expect(await hitsInside(last)).toBe(true);

      await popup().getByRole('textbox').focus();
      await page.keyboard.press('Escape');
      await expect.poll(() => popup().count()).toBe(0);
      expect(await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).open)).toBe(true);
      expect(await focused(trigger('dialog-picker'))).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).open)).toBe(false);
    });
  });
});
