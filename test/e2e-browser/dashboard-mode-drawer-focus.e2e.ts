/**
 * 模式示例侧栏的真实浏览器键盘/焦点回归（react-test-renderer 无真实 DOM，
 * 原生 Tab 顺序、inert、滚动锁必须在浏览器里验）。
 *
 * 运行需指定本地构建 dashboard 预览页（页面需带一个 main 外的导航，
 * 以便验证顶栏/侧栏这类框架在抽屉打开时也不可达）：
 *   BD_MODE_HARNESS_URL=http://127.0.0.1:8931/index.html \
 *   npx vitest run --project e2e test/e2e-browser/dashboard-mode-drawer-focus.e2e.ts
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

    // 注入一个 main 外的品牌导航（模拟真实 dashboard 顶栏链接）
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.className = 'brand';
      a.href = '#/';
      a.textContent = 'brand-outside-main';
      a.setAttribute('data-test-brand', '1');
      document.body.insertBefore(a, document.body.firstChild);
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  function focusedKind(): Promise<string> {
    return page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.classList.contains('bd-example-close')) return 'close';
      if (a?.classList.contains('bd-example-tab')) return `tab:${a.textContent?.trim().slice(0, 6)}`;
      if (a?.classList.contains('brand')) return 'LEAK:brand';
      return `LEAK:${(a?.textContent ?? '').trim().slice(0, 10)}`;
    });
  }

  async function openRegularDrawer(): Promise<void> {
    await page.locator('.bd-mode-example-trigger').nth(1).click();
    await page.waitForSelector('.bd-example-panel');
  }

  it('background frame (incl. outside-main nav) is inert while open, restored on close', async () => {
    await openRegularDrawer();
    const inertInfo = await page.evaluate(() => {
      const brand = document.querySelector('.brand') as HTMLElement;
      return { brandInert: brand.hasAttribute('inert'), brandAriaHidden: brand.getAttribute('aria-hidden'), overflow: document.body.style.overflow };
    });
    expect(inertInfo.brandInert).toBe(true);
    expect(inertInfo.brandAriaHidden).toBe('true');
    expect(inertInfo.overflow).toBe('hidden');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.bd-example-panel', { state: 'detached' });
    const restored = await page.evaluate(() => ({
      brandInert: (document.querySelector('.brand') as HTMLElement).hasAttribute('inert'),
      overflow: document.body.style.overflow,
    }));
    expect(restored.brandInert).toBe(false);
    expect(restored.overflow).toBe('');
  });

  it('Tab never leaves the drawer, incl. after arrow keys move focus to a tabindex=-1 tab', async () => {
    await openRegularDrawer();

    // 边界复现：聚焦当前 tab（混合），按 ↑ 把焦点移到前一项（roving 组里 tabIndex=-1 的 tab）
    await page.locator('.bd-example-tab', { hasText: '混合模式' }).focus();
    await page.keyboard.press('ArrowUp');
    expect((await focusedKind()).startsWith('tab:')).toBe(true);

    // 此时按 Tab：旧实现会穿到背景品牌链接；现在应被兜底回当前可 Tab 项
    await page.keyboard.press('Tab');
    const afterUpTab = await focusedKind();
    expect(afterUpTab.startsWith('LEAK')).toBe(false);
    expect(afterUpTab === 'close' || afterUpTab.startsWith('tab:')).toBe(true);

    // 多轮正/反 Tab 全部不泄漏
    const path: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      path.push(await focusedKind());
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      path.push(await focusedKind());
    }
    expect(path.every(p => !p.startsWith('LEAK'))).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForSelector('.bd-example-panel', { state: 'detached' });
  });

  it('arrow-preview inside the drawer never triggers the real save onChange', async () => {
    await page.evaluate(() => {
      (window as unknown as { __radioClicks: number }).__radioClicks = 0;
      document.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.bd-mode-opt') && document.querySelector('.bd-example-panel')) {
          (window as unknown as { __radioClicks: number }).__radioClicks++;
        }
      }, true);
    });
    await openRegularDrawer();
    // 方向键切遍 tabs：只会改 previewValue，不碰主页 radio
    await page.locator('.bd-example-tab', { hasText: '混合模式' }).focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    const selectedMain = await page.evaluate(() => {
      // 普通群是第二组；只看该组的选中项
      const groups = [...document.querySelectorAll('[data-input]')];
      const regularGrid = groups.find(g => g.getAttribute('data-input') === 'regularGroupMode') as HTMLElement | undefined;
      return regularGrid?.querySelector('.bd-mode-opt.is-selected .bd-mode-opt-name')?.textContent?.trim().slice(0, 4);
    });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.bd-example-panel', { state: 'detached' });
    const clicks = await page.evaluate(() => (window as unknown as { __radioClicks: number }).__radioClicks);
    expect(selectedMain).toContain('混合');
    expect(clicks).toBe(0);
  });
});
