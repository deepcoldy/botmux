import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type CardBox = {
  id: string;
  width: number;
  menuHit: boolean;
  menuInside: boolean;
  unpinReachable: boolean | null;
  menuTop: number;
  menuRightGap: number;
  checkBottom: number;
  clipped: string[];
  avatar: boolean;
  rowStartIndents: number[];
  rowGaps: number[];
};

const HOST_WIDTHS = [900, 1100, 1300, 1500, 1700, 1900];

// 非文本断言：真实 SessionsKanbanView + 真实 dashboard CSS 交给 Chromium 排版，再看「⋯」点不点得到。
describe('kanban card header menu', () => {
  let browser: Browser;
  let page: Page;
  let script: string;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { SessionsKanbanView } from './src/dashboard/web/sessions-kanban.tsx';

          const pin = { model: 'gpt-5.5', effort: 'high', source: 'bot' };
          const drift = { session: 'oncall', current: 'off' };
          const states = [
            {},
            { sandboxDrift: drift },
            { adopt: true, modelPin: pin },
            { adopt: true, locked: true },
            { adopt: true, locked: true, sandboxDrift: drift },
            { locked: true, sandboxDrift: drift, modelPin: pin },
          ];
          const rows = [];
          states.forEach((state, i) => {
            for (const cliId of ['claude-code', 'codex', 'pi']) {
              rows.push({
                sessionId: 's-' + i + '-' + cliId, chatId: 'oc_' + i + '_' + cliId, chatDisplayName: 'chat ' + i,
                title: 'Session ' + i, larkAppId: 'cli_menu', botName: 'Menu bot', cliId, status: 'idle',
                lastMessageAt: 1000 - i, ...state,
              });
            }
          });
          const noop = () => {};
          const icons = { close: '', details: '', feishu: '', history: '', key: '', lock: '', restart: '', terminal: '', unlock: '' };
          createRoot(document.getElementById('host')).render(<SessionsKanbanView
            rows={rows} host={null} canRestartSession={() => true} icons={icons}
            lockActionLabel={() => 'lock'} sessionStatusText={() => 'idle'} selectedSessionIds={new Set()}
            onDetails={noop} onHistory={noop} onMoveRows={noop} onRename={noop} onRestart={noop}
            onToggleLock={noop} onToggleSelect={noop}
          />);

          window.measureCards = () => Array.from(document.querySelectorAll('article.kanban-card')).map(card => {
            card.scrollIntoView({ block: 'center', inline: 'center' });
            const c = card.getBoundingClientRect();
            const more = card.querySelector('.kanban-card-more');
            const check = card.querySelector('.kanban-card-check').getBoundingClientRect();
            const m = more.getBoundingClientRect();
            const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
            const unpin = card.querySelector('.model-pin-chip button');
            const u = unpin?.getBoundingClientRect();
            const unpinHit = u && document.elementFromPoint(u.left + u.width / 2, u.top + u.height / 2);
            const headEl = card.querySelector('.kanban-card-head');
            const headRect = headEl.getBoundingClientRect();
            const kids = Array.from(headEl.children)
              .map(el => ({ el, rect: el.getBoundingClientRect() }))
              .filter(k => k.rect.width > 0 && k.rect.height > 0);
            // flex-wrap 后按垂直区间重叠归并视觉行：align-items:center 时同行元素高度不同、
            // top 并不相等（16px checkbox 与 22px badge 中心对齐后 top 差 3px），不能用 top 归并；
            // 同行元素的 [top,bottom] 必重叠，跨行间有 row-gap 间隔、区间不相交。DOM 顺序即行主序。
            const visualRows: Array<{ top: number; bottom: number; items: typeof kids }> = [];
            for (const k of kids) {
              const last = visualRows[visualRows.length - 1];
              if (last && k.rect.top < last.bottom && k.rect.bottom > last.top) {
                last.items.push(k);
                last.top = Math.min(last.top, k.rect.top);
                last.bottom = Math.max(last.bottom, k.rect.bottom);
              } else {
                visualRows.push({ top: k.rect.top, bottom: k.rect.bottom, items: [k] });
              }
            }
            // 行首缩进只看内容行：「⋯」独占一行时靠 margin-left:auto 贴右缘是设计行为，
            // 它作为行首的那一行没有左对齐内容，不纳入缩进判定。
            const rowStartIndents = visualRows
              .filter(r => !r.items[0].el.classList.contains('kanban-card-more'))
              .map(r => r.items[0].rect.left - headRect.left);
            const rowGaps: number[] = [];
            for (const r of visualRows) {
              for (let i = 1; i < r.items.length; i++) {
                const prev = r.items[i - 1].rect;
                const cur = r.items[i];
                // 「⋯」靠 margin-left:auto 贴右，它前面的空隙是 auto 撑开的，不属于 badge 间距。
                if (cur.el.classList.contains('kanban-card-more')) continue;
                rowGaps.push(cur.rect.left - prev.right);
              }
            }
            return {
              id: card.getAttribute('data-id'), width: Math.round(c.width),
              menuHit: !!hit && hit.closest('.kanban-card-more') === more,
              menuInside: m.width > 0 && m.right <= c.right,
              unpinReachable: u ? !!unpinHit && unpinHit.closest('button') === unpin && u.width > 0 && u.right <= c.right : null,
              menuTop: m.top - c.top, menuRightGap: headRect.right - m.right,
              checkBottom: check.bottom - c.top,
              clipped: Array.from(headEl.children)
                .filter(el => el.getBoundingClientRect().right > c.right)
                .map(el => el.className),
              avatar: !!card.querySelector('.kanban-card-avatar'),
              rowStartIndents,
              rowGaps,
            };
          });
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

  afterEach(async () => {
    await page?.close();
  });

  async function renderAt(hostWidth: number): Promise<CardBox[]> {
    page = await browser.newPage({ viewport: { width: hostWidth + 40, height: 900 } });
    const html = `<!doctype html><html lang="zh" data-theme="light"><head><style>${readFileSync('src/dashboard/web/style.css', 'utf8')}</style></head>`
      + `<body><div id="host" class="sessions-kanban" style="width:${hostWidth}px;height:860px"></div></body></html>`;
    // localStorage 需要真实 origin，about:blank 读它会抛 SecurityError。
    await page.route('http://kanban.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://kanban.test/');
    await page.addScriptTag({ content: script });
    await page.locator('article.kanban-card .kanban-card-more').first().waitFor();
    return page.evaluate(() => (window as any).measureCards());
  }

  it('keeps every header item, the ⋯ menu and the unpin button inside the card, however crowded the tags are', async () => {
    const widths = new Set<number>();
    const unreachable: string[] = [];
    const unpinUnreachable: string[] = [];
    const clipped: string[] = [];
    const menuNotRight: string[] = [];
    for (const hostWidth of HOST_WIDTHS) {
      const cards = await renderAt(hostWidth);
      expect(cards).toHaveLength(18);
      expect(cards.every(card => card.avatar)).toBe(true);
      for (const card of cards) {
        widths.add(card.width);
        if (!card.menuHit || !card.menuInside) unreachable.push(`${hostWidth}:${card.id}`);
        if (card.unpinReachable === false) unpinUnreachable.push(`${hostWidth}:${card.id}`);
        for (const item of card.clipped) clipped.push(`${hostWidth}:${card.id}:${item}`);
        if (Math.abs(card.menuRightGap) > 1) menuNotRight.push(`${hostWidth}:${card.id}`);
      }
      await page.close();
    }
    expect(Math.min(...widths)).toBeLessThan(200);
    expect(Math.max(...widths)).toBeGreaterThan(340);
    expect(unreachable).toEqual([]);
    expect(unpinUnreachable).toEqual([]);
    expect(clipped).toEqual([]);
    expect(menuNotRight).toEqual([]);
  });

  it('opens the menu with a real click on the most crowded card', async () => {
    await renderAt(1300);
    const card = page.locator('article[data-id="s-4-claude-code"]');
    await card.locator('.kanban-card-more').click();
    await expect.poll(() => page.locator('.card-menu-pop').count()).toBe(1);
  });

  it('keeps a header that fits on one row, and wraps only when the tags do not fit', async () => {
    const cards = await renderAt(1300);
    const plain = cards.find(card => card.id === 's-0-pi')!;
    expect(plain.menuTop).toBeLessThan(plain.checkBottom);
    const crowded = cards.find(card => card.id === 's-4-claude-code')!;
    expect(crowded.menuTop).toBeGreaterThanOrEqual(crowded.checkBottom);
  });

  it('left-aligns every wrapped row and keeps one uniform 6px gap instead of badge margin doubling', async () => {
    const indentViolations: string[] = [];
    const gapViolations: string[] = [];
    for (const hostWidth of HOST_WIDTHS) {
      const cards = await renderAt(hostWidth);
      for (const card of cards) {
        for (const indent of card.rowStartIndents) {
          if (Math.abs(indent) > 0.5) indentViolations.push(`${hostWidth}:${card.id}:${Math.round(indent * 100) / 100}`);
        }
        // 卡片头列 gap 为 6px。实测无修复时相邻 badge 间距只有两个值：6（正常）与 12
        //（lock/drift badge 自带 margin-left:6 叠成 gap6+margin6）。用单向区间而非「恰好 6」：
        // 下界 5.5 防间距被异常压缩，上界 8 拒绝 12px 双倍（6 与 12 之间实测无任何取值）。
        for (const gap of card.rowGaps) {
          if (gap < 5.5 || gap > 8) gapViolations.push(`${hostWidth}:${card.id}:${Math.round(gap * 100) / 100}`);
        }
      }
      await page.close();
    }
    expect(indentViolations).toEqual([]);
    expect(gapViolations).toEqual([]);
  });
});
