/**
 * 企业微信机器人的 Bot 配置卡在真实浏览器里的版式：企业微信专属格子和别的格子一样各占双栏瀑布流的
 * 一栏（不再整行铺满、把输入框拉到整张卡那么宽），格子之间不重叠、内容不横向溢出，哪一栏中间都没有
 * 整行格子压出来的大块空白；格子里的输入框、下拉框和保存按钮与同一张卡上共用区块的同类控件渲染得一样。
 * 窄屏时退回单栏。
 */
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'esbuild';
import {createServer, type Server} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {chromium, type Browser, type Page} from 'playwright';
import {BOT_DEFAULTS_SECTIONS, BOT_DEFAULTS_TABS, botDefaultsSectionDomId, type BotDefaultsTab} from '../src/dashboard/web/bot-defaults.js';
import {WECOM_FIXTURE_ID, wecomBotDefaultsApi} from './fixtures/wecom-bot-defaults-browser-api.js';

// 非文本断言：真实生产 CSS 作为浏览器夹具，测试只测量渲染出的几何与计算样式。
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const bundle = await build({entryPoints: ['test/fixtures/wecom-bot-defaults-browser.tsx'], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: {'.css': 'empty'}, logLevel: 'silent'});
  server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/fixture.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="botmux-csrf" content="fixture-csrf"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({headless: true, ...(!existsSync(chromium.executablePath()) && existsSync(systemChrome) ? {executablePath: systemChrome} : {})});
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(done => server ? server.close(() => done()) : done()); });

/** 企业微信专属格子在某个分类里的 DOM id：取自区块登记表（标了 provider: 'wecom'、自成一格的区块）。 */
const wecomTileIds = (tab: BotDefaultsTab) => BOT_DEFAULTS_SECTIONS
  .filter(section => section.provider === 'wecom' && !section.tile && section.tab === tab)
  .map(section => botDefaultsSectionDomId(section.id));

async function openWecomCard(width: number): Promise<{page: Page; errors: string[]}> {
  const page = await browser.newPage({viewport: {width, height: 1000}});
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.route('**/api/**', async route => {
    const {body} = wecomBotDefaultsApi(new URL(route.request().url()).pathname);
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)}).catch(() => {});
  });
  page.setDefaultTimeout(8000);
  await page.goto(`${origin}/#/bot-defaults?provider=wecom&bot=${WECOM_FIXTURE_ID}`);
  // 常用分类没有企业微信专属格子：等会话分类（此时还是隐藏面板）里的第一格挂上来。
  await page.locator(`#${wecomTileIds('sessions')[0]}`).waitFor({state: 'attached'});
  return {page, errors};
}

type Box = {id: string; wecom: boolean; x: number; y: number; w: number; h: number; overflowX: number};
/** 网格宽度、行列间距与隐式行轨道高度（双栏时瀑布流按「轨道 + 行间距」一步步排格子），以及每一格。 */
type Layout = {grid: number; rowGap: number; columnGap: number; autoRow: number; tiles: Box[]};

/** 打开一个分类，等瀑布流排定（连续两次测量一致），返回该分类网格里每一格的位置与尺寸。 */
async function measurePanel(page: Page, tab: BotDefaultsTab): Promise<Layout> {
  await page.locator(`#bd-tab-${tab}`).click();
  const measure = () => page.evaluate(({panel, ids}) => {
    const grid = document.querySelector<HTMLElement>(`#bd-panel-${panel} .bd-tab-grid`)!;
    const g = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const tiles = [...grid.children].map(el => {
      const r = el.getBoundingClientRect();
      const id = el.id || (el.hasAttribute('data-runtime-status') ? '(runtime status)' : '(no id)');
      return {id, wecom: ids.includes(el.id), x: r.left - g.left, y: r.top - g.top, w: r.width, h: r.height, overflowX: el.scrollWidth - el.clientWidth};
    });
    return {grid: g.width, rowGap: parseFloat(style.rowGap), columnGap: parseFloat(style.columnGap), autoRow: parseFloat(style.gridAutoRows), tiles};
  }, {panel: tab, ids: wecomTileIds(tab)});
  let previous = '';
  await expect.poll(async () => {
    const next = JSON.stringify(await measure());
    const settled = next === previous && !next.includes('"w":0');
    previous = next;
    return settled;
  }, {timeout: 8000, intervals: [100, 150, 200, 250]}).toBe(true);
  return JSON.parse(previous);
}

/**
 * 双栏网格里每一栏从上到下的空白：相邻两格之间（整行格子同时算在两栏里）、以及栏顶到第一格。瀑布流按
 * 「行轨道 + 行间距」整步排格子，紧挨着排的一栏里相邻两格最多隔一个行间距再加一步；超过它的空白就是
 * 整行格子压在了一高一矮两栏下面。
 */
function emptyRuns(layout: Layout): string[] {
  const bound = layout.rowGap + (layout.autoRow + layout.rowGap);
  const width = (layout.grid - layout.columnGap) / 2;
  const found: string[] = [];
  for (const column of [0, 1]) {
    const left = column * (width + layout.columnGap);
    const right = left + width;
    const stack = layout.tiles.filter(tile => tile.x < right - 1 && tile.x + tile.w > left + 1).sort((a, b) => a.y - b.y);
    let bottom = 0;
    let above = '(top)';
    for (const tile of stack) {
      const run = tile.y - bottom;
      if (run > bound + 1) found.push(`column ${column + 1}: ${Math.round(run)}px empty between ${above} and ${tile.id} (bound ${bound}px)`);
      bottom = Math.max(bottom, tile.y + tile.h);
      above = tile.id;
    }
  }
  return found;
}

function overlaps(tiles: Box[]): string[] {
  const found: string[] = [];
  for (const [i, a] of tiles.entries()) {
    for (const b of tiles.slice(i + 1)) {
      const apart = a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;
      if (!apart) found.push(`${a.id || '(no id)'} × ${b.id || '(no id)'}`);
    }
  }
  return found;
}

describe('WeCom bot card layout in the real browser', () => {
  it('puts every WeCom-only tile in one column of the two-column grid, with no overlap and nothing clipped', async () => {
    const {page, errors} = await openWecomCard(1440);
    try {
      for (const tab of BOT_DEFAULTS_TABS) {
        const {grid, tiles} = await measurePanel(page, tab);
        const wecom = tiles.filter(tile => tile.wecom);
        const ordinary = tiles.filter(tile => !tile.wecom);
        expect(wecom.map(tile => tile.id).sort(), tab).toEqual([...wecomTileIds(tab)].sort());
        // 前提：这个宽度下网格确实是双栏（普通格子里最窄的那一格只占一栏）。
        const column = Math.min(...ordinary.map(tile => tile.w));
        expect(column, `${tab}: grid is not in two-column mode`).toBeLessThan(grid * 0.6);
        // 企业微信专属格子和普通格子一样只占一栏，不横跨整行。
        for (const tile of wecom) expect(tile.w, `${tab}: ${tile.id} spans more than one column`).toBeLessThanOrEqual(column + 1);
        expect(overlaps(tiles), `${tab}: overlapping tiles`).toEqual([]);
        for (const tile of wecom) expect(tile.overflowX, `${tab}: ${tile.id} overflows horizontally`).toBeLessThanOrEqual(1);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('leaves no tall empty run in either column of any tab: full-width tiles never sit below columns of unequal height', async () => {
    const {page, errors} = await openWecomCard(1440);
    try {
      const runs: Record<string, string[]> = {};
      for (const tab of BOT_DEFAULTS_TABS) {
        const layout = await measurePanel(page, tab);
        // 前提：双栏（行轨道是瀑布流用的细轨道，第二栏里有格子）。
        expect(Number.isFinite(layout.autoRow) && layout.tiles.some(tile => tile.x > layout.grid / 4), `${tab}: grid is not in two-column mode`).toBe(true);
        const found = emptyRuns(layout);
        if (found.length) runs[tab] = found;
      }
      expect(runs).toEqual({});
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('renders the WeCom-only inputs, dropdowns and save buttons like the shared tiles on the same card', async () => {
    const {page, errors} = await openWecomCard(1440);
    try {
      type Look = Record<'height' | 'fontSize' | 'fontWeight' | 'fontFamily' | 'color' | 'borderColor' | 'background', string>;
      /** 一个分类里企业微信专属格子与共用格子中的同类控件，各自的计算样式。 */
      const looks = (tab: BotDefaultsTab) => page.evaluate(({panel, ids}) => {
        const look = (el: Element) => {
          const s = getComputedStyle(el);
          return {height: String(Math.round(el.getBoundingClientRect().height)), fontSize: s.fontSize, fontWeight: s.fontWeight, fontFamily: s.fontFamily, color: s.color, borderColor: s.borderTopColor, background: s.backgroundColor};
        };
        const tiles = [...document.querySelector(`#bd-panel-${panel} .bd-tab-grid`)!.children];
        const inside = (wecom: boolean, selector: string) => tiles
          .filter(tile => ids.includes(tile.id) === wecom)
          .flatMap(tile => [...tile.querySelectorAll(selector)])
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(look);
        return {
          // 专属格子里的每个单行输入框都算（漏写 type 的也算），只排除下拉框自带的隐藏表单 input。
          wecomInputs: inside(true, 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([aria-hidden="true"])'),
          sharedInputs: inside(false, 'input[type=text], input[type=number]'),
          wecomMenus: inside(true, '[role=combobox]'),
          sharedMenus: inside(false, '[role=combobox]'),
          wecomSaves: inside(true, 'button[data-action^="save-wecom-"]'),
          sharedSaves: inside(false, 'button.primary[data-action^="save-"]'),
        };
      }, {panel: tab, ids: wecomTileIds(tab)});
      const differences = (look: Look, reference: Look, keys: Array<keyof Look>) =>
        keys.filter(key => look[key] !== reference[key]).map(key => `${key}: ${look[key]} ≠ ${reference[key]}`);

      // 参照：常用分类里共用区块（Agent / 工作目录）的单行输入框、下拉框和保存按钮。
      await measurePanel(page, 'common');
      const common = await looks('common');
      const [input, menu, save] = [common.sharedInputs[0], common.sharedMenus[0], common.sharedSaves[0]];
      expect(input && menu && save, 'shared reference controls on the common tab').toBeTruthy();
      const counts = {inputs: 0, menus: 0, saves: 0};
      for (const tab of BOT_DEFAULTS_TABS) {
        await measurePanel(page, tab);
        const found = await looks(tab);
        counts.inputs += found.wecomInputs.length;
        counts.menus += found.wecomMenus.length;
        counts.saves += found.wecomSaves.length;
        for (const look of found.wecomInputs) {
          expect(differences(look, input!, ['height', 'fontSize', 'fontWeight', 'fontFamily', 'borderColor', 'background']), `${tab}: input`).toEqual([]);
        }
        for (const look of found.wecomMenus) expect(differences(look, menu!, ['height', 'fontSize', 'fontWeight']), `${tab}: dropdown`).toEqual([]);
        for (const look of found.wecomSaves) {
          expect(differences(look, save!, ['height', 'fontSize', 'fontWeight', 'color', 'borderColor', 'background']), `${tab}: save button`).toEqual([]);
        }
        // 每个专属格子都有自己的保存按钮（常用分类没有本地业务设置那一格）。
        expect(found.wecomSaves.length, `${tab}: save buttons`).toBeGreaterThanOrEqual(wecomTileIds(tab).length);
      }
      // 夹具确实铺出了这些控件（不是因为一个都没找到才通过）。
      expect(counts.inputs).toBeGreaterThan(10);
      expect(counts.menus).toBeGreaterThan(10);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('falls back to a single column on a narrow screen without overlap or horizontal overflow', async () => {
    const {page, errors} = await openWecomCard(820);
    try {
      for (const tab of BOT_DEFAULTS_TABS) {
        const {grid, tiles} = await measurePanel(page, tab);
        for (const tile of tiles) expect(Math.abs(tile.w - grid), `${tab}: ${tile.id} is not full width in one column`).toBeLessThanOrEqual(1);
        expect(overlaps(tiles), `${tab}: overlapping tiles`).toEqual([]);
        for (const tile of tiles.filter(item => item.wecom)) expect(tile.overflowX, `${tab}: ${tile.id} overflows horizontally`).toBeLessThanOrEqual(1);
      }
      expect(await page.evaluate(() => {
        const detail = document.querySelector<HTMLElement>('.bot-defaults-page .bd-detail')!;
        return detail.scrollWidth - detail.clientWidth;
      })).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
