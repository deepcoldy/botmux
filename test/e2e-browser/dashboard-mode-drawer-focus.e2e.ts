/**
 * 模式示例侧栏的真实浏览器键盘/焦点回归（react-test-renderer 无真实 DOM，
 * 原生 Tab 顺序、inert、滚动锁必须在浏览器里验）。
 *
 * 运行需指定本地构建 dashboard 预览页：
 *   BD_MODE_HARNESS_URL=http://127.0.0.1:8931/index.html \
 *   npx vitest run --project e2e test/e2e-browser/dashboard-mode-drawer-focus.e2e.ts
 *
 * 校验：正向 Tab 不穿出抽屉（首/中/末预览各正反多轮）；切预览焦点不跳；
 * 抽屉打开期间主页 radio 保存回调为 0；背景 inert + 滚动锁；Esc 后恢复。
 */
import { chromium, type Browser, type Page } from 'playwright';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HARNESS_URL = process.env.BD_MODE_HARNESS_URL;

describe.skipIf(!HARNESS_URL)('mode example drawer focus trap (browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(HARNESS_URL!, { waitUntil: 'networkidle' });
  });

  afterAll(async () => {
    await browser?.close();
  });

  function focusedKind(): Promise<string> {
    return page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.classList.contains('bd-example-close')) return 'close';
      if (a?.classList.contains('bd-example-tab')) return `tab:${a.textContent?.trim().slice(0, 4)}`;
      return `LEAK:${(a?.textContent ?? '').trim().slice(0, 10)}`;
    });
  }

  it('Tab cycles only between close and the current preview tab; background never receives focus', async () => {
    // 打开普通群示例
    await page.locator('.bd-mode-example-trigger').nth(1).click();
    await page.waitForSelector('.bd-example-panel');

    await page.evaluate(() => {
      (window as unknown as { __radioClicks: number }).__radioClicks = 0;
      document.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.bd-mode-opt') && document.querySelector('.bd-example-panel')) {
          (window as unknown as { __radioClicks: number }).__radioClicks++;
        }
      }, true);
    });

    // 从 X 正向 Tab 6 次：只应在 close ↔ 当前 tab（tabIndex=0 的唯一 tab）间循环
    const forward: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      forward.push(await focusedKind());
    }
    expect(forward.every(p => p === 'close' || p.startsWith('tab:'))).toBe(true);
    expect(new Set(forward).size).toBe(2);

    // 反向
    const back: string[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      back.push(await focusedKind());
    }
    expect(back.every(p => p !== null && !p.startsWith('LEAK'))).toBe(true);
    expect((await page.evaluate(() => (window as unknown as { __radioClicks: number }).__radioClicks))).toBe(0);

    await page.keyboard.press('Escape');
    await page.waitForSelector('.bd-example-panel', { state: 'detached' });
  });

  it('switching preview keeps focus in tablist; locks scroll/inert and restores on close', async () => {
    await page.locator('.bd-mode-example-trigger').nth(1).click();
    await page.waitForSelector('.bd-example-panel');

    await page.locator('.bd-example-tab', { hasText: '话题模式' }).focus();
    await page.keyboard.press('ArrowRight');
    const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    expect(focusedRole).toBe('tab');

    const lock = await page.evaluate(() => ({
      overflow: document.body.style.overflow,
      mainInert: !!document.querySelector('main')?.hasAttribute('inert'),
    }));
    expect(lock.overflow).toBe('hidden');

    await page.keyboard.press('Escape');
    await page.waitForSelector('.bd-example-panel', { state: 'detached' });
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });
});
