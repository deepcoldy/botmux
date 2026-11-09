import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// 飞书侧栏 350–1200px，桌面更宽；560 是汇总行折成上下两行的断点。
const VIEWPORT_WIDTHS = [350, 560, 725, 1024, 1280];
const APP = 'cli_board';
const TITLE = '发版和部署：上一版之后 master 上的 149 个提交（101 个修复、23 个功能）';
const LONG_STAGE = '定 A：今晚 20:00 后发 v3.59.0 加部署（等偶发用例修复合入、master 全绿）';
const SHORT_STAGE = '在审';
const LONG_SEQ = 207;
const SHORT_SEQ = 208;

const NOW = Date.UTC(2026, 10, 9, 6);
const item = (seq: number, stage: string) => ({
  seq, title: TITLE, state: 'active', stage, kind: 'deploy', repo: 'owner/repo', options: [], rev: 3,
  createdAt: NOW - 86_400_000, updatedAt: NOW - 1_500_000, stateAt: NOW - 1_500_000,
});
const chatLinks = [
  { kind: 'chat', ref: 'oc_review', text: '评审群', url: 'https://example.test/chat/oc_review', primary: true, chatCheck: 'verified' },
  { kind: 'chat', ref: 'oc_release', text: '发版群', url: 'https://example.test/chat/oc_release', chatCheck: 'verified' },
];
const steward = { enabled: true, ready: true, chatId: 'oc_steward' };
const counts = { decide: 0, active: 2, all: 2 };
const LIST = {
  ok: true, view: 'all', steward, counts, drafts: [], batches: [],
  items: [LONG_SEQ, SHORT_SEQ].map(seq => ({
    ...item(seq, seq === LONG_SEQ ? LONG_STAGE : SHORT_STAGE), links: chatLinks, hasDraft: false, pendingDecisions: 0, unseen: false,
  })),
};
const detail = (seq: number) => ({
  ok: true, item: { ...item(seq, seq === LONG_SEQ ? LONG_STAGE : SHORT_STAGE), noChatReason: '管家自己处理' },
  links: [], events: [], files: [], pendingDecisions: [], steward, drafts: [],
});

type Box = { left: number; right: number; top: number; width: number; height: number };
type ChipBox = Box & { text: string; title: string | null; truncated: boolean };
type RowBox = { link: Box; main: Box; meta: Box; chip: ChipBox };
type DetailBox = { section: Box; head: Box; h1: Box; chip: ChipBox };

// 非文本断言：真实的看板汇总页 / 详情页组件 + 真实 dashboard CSS 交给 Chromium 排版，再量标题和状态标签的尺寸。
describe('decision board: a long free-text stage never squeezes the title', () => {
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
          import { BoardSummaryView, ItemDetailView } from './src/dashboard/web/decision-board-page.tsx';

          const list = ${JSON.stringify(LIST)};
          const details = ${JSON.stringify({ [LONG_SEQ]: detail(LONG_SEQ), [SHORT_SEQ]: detail(SHORT_SEQ) })};
          const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
          window.fetch = async (input, init = {}) => {
            const path = new URL(String(input), location.href).pathname;
            const base = '/api/decision-board/${APP}';
            if (path === '/api/decision-board/boards') {
              return json({ ok: true, boards: [{ larkAppId: '${APP}', botName: 'Steward', online: true, steward: list.steward, counts: list.counts }] });
            }
            if (path === base + '/items') return json(list);
            const rest = path.startsWith(base + '/items/') ? path.slice(base.length + '/items/'.length).split('/') : [];
            if (rest.length === 1 && details[rest[0]]) return json(details[rest[0]]);
            if (rest.length > 1 && (init.method ?? 'GET') !== 'GET') return json({ ok: true });
            return json({ ok: false, error: 'not_found' }, 404);
          };

          const seq = Number(new URLSearchParams(location.search).get('seq'));
          createRoot(document.getElementById('root')).render(seq
            ? <ItemDetailView appId="${APP}" seq={seq} />
            : <BoardSummaryView route={{ appId: '${APP}', view: 'all' }} />);
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

  async function open(width: number, query: string, ready: string): Promise<void> {
    page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const css = ['style.css', 'design-tokens.css'].map(name => readFileSync(`src/dashboard/web/${name}`, 'utf8')).join('\n');
    const html = `<!doctype html><html lang="zh" data-theme="dark"><head><meta charset="utf-8"><style>${css}</style>`
      + '<style>body{margin:0;padding:16px}</style></head><body><div id="root"></div></body></html>';
    // 详情页会读写 sessionStorage，about:blank 上会抛 SecurityError，所以挂在一个真实 origin 下。
    await page.route('http://board.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`http://board.test/${query}`);
    await page.addScriptTag({ content: script });
    await page.locator(ready).waitFor();
  }

  async function measureRows(width: number): Promise<Record<number, RowBox>> {
    await open(width, '', `a.dboard-row[data-seq="${SHORT_SEQ}"]`);
    return page.evaluate(() => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
      };
      const out: Record<number, RowBox> = {};
      for (const link of Array.from(document.querySelectorAll<HTMLElement>('a.dboard-row'))) {
        const chip = link.querySelector<HTMLElement>('.dboard-state')!;
        out[Number(link.dataset.seq)] = {
          link: box(link),
          main: box(link.querySelector('.dboard-row-main')!),
          meta: box(link.querySelector('.dboard-row-meta')!),
          chip: { ...box(chip), text: chip.textContent ?? '', title: chip.getAttribute('title'), truncated: chip.scrollWidth > chip.clientWidth },
        };
      }
      return out;
    });
  }

  async function measureDetail(width: number, seq: number): Promise<DetailBox> {
    await open(width, `?seq=${seq}`, '.dboard-detail-head .dboard-state');
    return page.evaluate(() => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
      };
      const head = document.querySelector('.dboard-detail-head')!;
      const chip = head.querySelector<HTMLElement>('.dboard-state')!;
      return {
        section: box(document.querySelector('.dboard-detail')!),
        head: box(head),
        h1: box(head.querySelector('h1')!),
        chip: { ...box(chip), text: chip.textContent ?? '', title: chip.getAttribute('title'), truncated: chip.scrollWidth > chip.clientWidth },
      };
    });
  }

  it('summary row: the title column is never narrower than the state column, and a long stage does not make the row taller', async () => {
    const failures: string[] = [];
    for (const width of VIEWPORT_WIDTHS) {
      const rows = await measureRows(width);
      const long = rows[LONG_SEQ];
      const short = rows[SHORT_SEQ];
      // 旧布局：725px 时标题列 0px、整行 900px 高；1280px 时标题列只有右侧列的一半。
      if (long.main.width + 0.5 < long.meta.width) failures.push(`${width}: title column ${long.main.width} < state column ${long.meta.width}`);
      // 同标题、同关联的两行只差阶段文字；长阶段最多让右侧元信息多折一行。
      if (long.link.height > short.link.height + short.chip.height + 4) failures.push(`${width}: row ${long.link.height}px vs ${short.link.height}px with a short stage`);
      // 缩不下的标签会在 flex-end 下向左溢出、压到标题上，或向右被列表裁掉。
      if (long.chip.left < long.meta.left - 0.5 || long.chip.right > long.meta.right + 0.5) failures.push(`${width}: state chip [${long.chip.left}, ${long.chip.right}] outside its column [${long.meta.left}, ${long.meta.right}]`);
      if (long.chip.truncated && long.chip.title !== long.chip.text) failures.push(`${width}: truncated chip has no full-text title (${long.chip.title})`);
      if (short.chip.truncated) failures.push(`${width}: short stage chip is truncated`);
      await page.close();
    }
    expect(failures).toEqual([]);
  });

  it('summary row: the full state text, stage included, is in the chip title', async () => {
    const rows = await measureRows(725);
    expect(rows[LONG_SEQ].chip.truncated).toBe(true);
    expect(rows[LONG_SEQ].chip.text.endsWith(LONG_STAGE)).toBe(true);
    expect(rows[LONG_SEQ].chip.title).toBe(rows[LONG_SEQ].chip.text);
  });

  it('detail header: the stage stays inside the page, is shown in full, and leaves the title most of the line', async () => {
    const failures: string[] = [];
    for (const width of VIEWPORT_WIDTHS) {
      const d = await measureDetail(width, LONG_SEQ);
      if (d.head.right > d.section.right + 0.5) failures.push(`${width}: header ${d.head.right} wider than the page ${d.section.right}`);
      if (d.chip.right > d.section.right + 0.5) failures.push(`${width}: state chip ${d.chip.right} past the page ${d.section.right}`);
      if (d.chip.truncated) failures.push(`${width}: stage cut off on the detail page`);
      if (d.h1.width + 0.5 < d.head.width * 0.6) failures.push(`${width}: title ${d.h1.width}px of a ${d.head.width}px header`);
      await page.close();
      const s = await measureDetail(width, SHORT_SEQ);
      // 短阶段仍是一行的胶囊。
      if (s.chip.truncated || s.chip.height > 24) failures.push(`${width}: short stage chip ${s.chip.width}x${s.chip.height}`);
      await page.close();
    }
    expect(failures).toEqual([]);
  });
});
