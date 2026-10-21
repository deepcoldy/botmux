import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('session table local horizontal overlay (C)', () => {
  let browser: Browser;
  let page: Page;
  let script: string;
  let measuredScript: string;
  let realScript: string;
  const screenshotDir = mkdtempSync(join(tmpdir(), 'botmux-session-scrollbar-'));
  const css = readFileSync('src/dashboard/web/style.css', 'utf8');
  beforeAll(async () => {
    const result = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, {useRef, useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {SessionHorizontalScrollbar} from './src/dashboard/web/session-horizontal-scrollbar.tsx';
        import {initFloatingScrollbars} from './src/dashboard/web/floating-scrollbars.ts';
        import {applyCyberFx} from './src/dashboard/web/cyber-fx.ts';
        function Fixture(){const ref=useRef(null);const [table,setTable]=useState(true);window.setTableView=setTable;return <>
          <div className="sessions-table-scroll-host" style={{position:'absolute',left:80,top:80,width:400,height:240}}>
          <div ref={ref} id="scroller" className="sessions-view-stage" data-view={table?'table':'topics'} data-local-horizontal-scrollbar={table?'':undefined}
            style={{width:'100%',height:'calc(100% - 6px)',overflow:'auto'}}>
            <table id="sessions-table" style={{minWidth:1600,height:960}}><tbody><tr><td>Session control table</td></tr></tbody></table>
          </div>
          {table?<SessionHorizontalScrollbar scrollRef={ref}/>:null}
          </div>
          <div id="other" style={{position:'absolute',left:550,top:80,width:300,height:240,overflow:'auto'}}>
            <div style={{width:1200,height:960}}>Unchanged display-only area</div>
          </div>
        </>}
        const root=createRoot(document.getElementById('app-root'));root.render(<Fixture/>);
        window.fixtureRoot=root; window.applyCyberFx=applyCyberFx;
        initFloatingScrollbars(document.getElementById('app-root'));
      ` },
      bundle: true, write: false, format: 'iife', platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    script = result.outputFiles[0].text;
    const real = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import {renderSessionsPage} from './src/dashboard/web/sessions-page.tsx';
        import {store} from './src/dashboard/web/store.ts'; import {ui} from './src/dashboard/web/ui.ts';
        import {initFloatingScrollbars} from './src/dashboard/web/floating-scrollbars.ts';
        window.reviewStore=store;window.reviewUi=ui;ui.authed=false;ui.workbenchAuthed=false;ui.init();
        window.disposer=renderSessionsPage(document.getElementById('page-host'));
        initFloatingScrollbars(document.getElementById('app-root'));
        window.rows=Array.from({length:40},(_,i)=>({sessionId:'session-'+i,status:'idle',cliId:'pi',chatId:'oc_test',botName:'TestBot',larkAppId:'cli_test',title:'Long session title '+i+' abcdefghijklmnopqrstuv',workingDir:'/tmp/project-long-directory-'+i,spawnedAt:Date.now()-10000,lastMessageAt:Date.now()-5000,tokenUsage:{in:12456,out:32145}}));
        store.replaceSnapshot(window.rows,[]);
      ` }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
    });
    realScript = real.outputFiles[0].text;
    const localSource = readFileSync('src/dashboard/web/session-horizontal-scrollbar.tsx', 'utf8')
      .replace('const update = () => {', `const update = () => {
        const metrics = (window as any).localMetrics; const begin = performance.now();
        try { updateMeasured(); } finally { metrics.samples.push(performance.now()-begin); }
      };
      const updateMeasured = () => {`);
    const measured = await build({
      stdin: { resolveDir: process.cwd(), contents: localSource + `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        (window as any).localMetrics={samples:[]};
        createRoot(document.getElementById('bar-host')!).render(<SessionHorizontalScrollbar scrollRef={{current:document.getElementById('scroller') as HTMLDivElement}}/>);
      `, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    measuredScript = measured.outputFiles[0].text;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    rmSync(screenshotDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => { throw error; });
    await page.setContent('<div id="app-root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => document.querySelector('.session-horizontal-scrollbar') && !(document.querySelector('.session-horizontal-scrollbar') as HTMLElement).hidden);
    await page.mouse.move(200, 150);
    await page.waitForTimeout(180);
  });
  afterEach(async () => { await page?.close(); });
  const track = () => page.locator('.session-horizontal-scrollbar');
  const left = () => page.locator('#scroller').evaluate(el => el.scrollLeft);
  async function begin() {
    const thumb = await track().locator('.floating-scrollbar-thumb').boundingBox();
    if (!thumb) throw new Error('missing thumb');
    const p = { x: thumb.x + thumb.width * .7, y: thumb.y + 3 };
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    return p;
  }
  const maxLeft = () => page.locator('#scroller').evaluate(el => el.scrollWidth - el.clientWidth);

  it('is mounted only in the table view, and excludes only that target x axis from global bars', async () => {
    const source = readFileSync('src/dashboard/web/sessions-page.tsx', 'utf8');
    expect(source).toContain("bootstrapped && viewMode === 'table' ? <SessionHorizontalScrollbar");
    expect(await page.locator('body > .floating-scrollbar-layer .floating-scrollbar-x').count()).toBe(1);
    expect(await page.locator('body > .floating-scrollbar-layer .floating-scrollbar-y').count()).toBe(2);
    expect(await track().evaluate(el => el.parentElement?.className)).toBe('sessions-table-scroll-host');
    expect(await track().evaluate(el => document.getElementById('scroller')!.contains(el))).toBe(false);
    expect(await track().evaluate(el => getComputedStyle(el).height)).toBe('6px');
    expect(await page.locator('body > .floating-scrollbar-layer .floating-scrollbar').evaluateAll(els => els.every(el => getComputedStyle(el).pointerEvents === 'none'))).toBe(true);
    expect(readFileSync('src/dashboard/web/floating-scrollbars.ts', 'utf8')).not.toMatch(/popupCandidates|motionBlocked|pointerdown|setPointerCapture/);
  });

  it('cleans up on view switches and reinstates original global horizontal display on non-table views', async () => {
    await begin();
    await page.evaluate(() => (window as any).setTableView(false));
    await expect.poll(() => track().count()).toBe(0);
    await page.mouse.up();
    await expect.poll(() => page.locator('.floating-scrollbar-x').count()).toBe(2);
    await page.evaluate(() => (window as any).setTableView(true));
    await expect.poll(() => track().count()).toBe(1);
    await expect.poll(() => page.locator('.floating-scrollbar-x').count()).toBe(1);
    await page.mouse.move(200, 150);
    const p = await begin(); await page.mouse.move(p.x + 30, p.y); await page.mouse.up();
    expect(await left()).toBeGreaterThan(0);
  });

  it('preserves grab offset, maps proportionally, clamps both ends and releases outside', async () => {
    const p = await begin(); expect(await left()).toBe(0);
    await page.mouse.move(p.x + 50, p.y);
    const expected = await track().evaluate(el => {
      const target = document.getElementById('scroller')!;
      return 50 * (target.scrollWidth - target.clientWidth) / ((el as HTMLElement).offsetWidth - (el.firstElementChild as HTMLElement).offsetWidth);
    });
    expect(await left()).toBeCloseTo(expected, 0);
    await page.mouse.move(980, 600); expect(await left()).toBe(await maxLeft());
    await page.mouse.move(0, 0); expect(await left()).toBe(0);
    await page.mouse.move(980, 600); await page.mouse.up();
    expect(await track().getAttribute('class')).not.toContain('is-dragging');
    await page.mouse.move(0, 0); expect(await left()).toBe(await maxLeft());
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  });

  it('clicks track outside the thumb', async () => {
    const box = await track().boundingBox(); if (!box) throw Error('missing track');
    await page.mouse.click(box.x + box.width * .8, box.y + 3);
    expect(await left()).toBeGreaterThan(0);
  });

  it('keeps hover/drag visible, fades after activity and leaves hidden track noninteractive', async () => {
    await page.waitForTimeout(1100);
    expect(await track().evaluate(el => getComputedStyle(el).pointerEvents)).toBe('auto');
    await begin(); await page.mouse.move(900, 500);
    await page.waitForTimeout(1100);
    expect(await track().evaluate(el => getComputedStyle(el).opacity)).toBe('0.78');
    await page.mouse.up(); await page.waitForTimeout(1100);
    expect(await track().evaluate(el => getComputedStyle(el).opacity)).toBe('0');
    expect(await track().evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  });

  it('ignores right mouse dragging', async () => {
    const thumb = await track().locator('.floating-scrollbar-thumb').boundingBox(); if (!thumb) throw Error('missing thumb');
    await page.mouse.move(thumb.x + 20, thumb.y + 3);
    await page.mouse.down({ button: 'right' }); await page.mouse.move(600, 400); await page.mouse.up({ button: 'right' });
    expect(await left()).toBe(0);
  });

  for (const zoom of ['transform', 'zoom'] as const) {
    it(`maps pointer units correctly under CSS ${zoom}`, async () => {
      await page.locator('#scroller').evaluate((el, kind) => {
        const host = el.parentElement!;
        if (kind === 'transform') { host.style.transform = 'scale(.75)'; host.style.transformOrigin = 'top left'; }
        else host.style.zoom = '.75';
      }, zoom);
      await page.mouse.move(140, 140); const p = await begin();
      await page.mouse.move(p.x + 30, p.y);
      const expected = await track().evaluate(el => {
        const t = el as HTMLElement; const target = document.getElementById('scroller')!;
        return 30 / (t.getBoundingClientRect().width / t.offsetWidth) * (target.scrollWidth - target.clientWidth)
          / (t.offsetWidth - (t.firstElementChild as HTMLElement).offsetWidth);
      });
      expect(await left()).toBeCloseTo(expected, 0); await page.mouse.up();
    });
  }

  it('follows vertical and horizontal scroll without changing client dimensions', async () => {
    const size = await page.locator('#scroller').evaluate(el => [el.clientWidth, el.clientHeight]);
    await page.locator('#scroller').evaluate(el => el.scrollTo({ left: 300, top: 250, behavior: 'instant' }));
    await page.waitForTimeout(100);
    const box = await track().boundingBox(); if (!box) throw Error('missing track');
    expect(box.x).toBe(83); expect(box.y).toBe(314);
    expect(await page.locator('#scroller').evaluate(el => [el.clientWidth, el.clientHeight])).toEqual(size);
    expect(await page.locator('#scroller').evaluate(el => el.scrollHeight)).toBe(960);
    const p = await begin(); await page.mouse.move(p.x + 30, p.y); await page.mouse.up();
    expect(await left()).toBeGreaterThan(300);
    expect(await page.locator('#scroller').evaluate(el => el.scrollTop)).toBe(250);
  });

  it('preserves native content/track continuous two-axis wheel scrolling', async () => {
    await page.mouse.wheel(100, 120); await page.waitForTimeout(200);
    expect(await left()).toBe(100);
    const box = await track().boundingBox(); if (!box) throw Error('missing track');
    await page.mouse.move(box.x + 200, box.y + 3);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(10, 12); await page.waitForTimeout(20); }
    await page.waitForTimeout(100);
    expect(await left()).toBe(200);
    expect(await page.locator('#scroller').evaluate(el => el.scrollTop)).toBe(240);
  });

  it('keeps wheel over scrolling content on the native scroll chain (no preventDefault)', async () => {
    // The host listener must only forward wheel events that land on the bar or
    // the reserved gutter; events over the table content keep browser-native
    // scrolling (platform line deltas, pinch zoom, scroll chaining).
    await page.evaluate(() => {
      (window as any).__contentDefaultPrevented = null;
      window.addEventListener('wheel', event => {
        if ((event.target as HTMLElement).closest?.('#scroller')) {
          (window as any).__contentDefaultPrevented = event.defaultPrevented;
        }
      }, { once: true });
    });
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(120);
    expect(await page.evaluate(() => (window as any).__contentDefaultPrevented)).toBe(false);
  });

  it('forwards vertical wheel from the reserved gutter while the bar is hidden without horizontal overflow', async () => {
    // Columns fit the viewport: the interactive bar hides, but the reserved
    // 6px gutter (the bar's parent area) must still scroll the table vertically.
    await page.locator('#sessions-table').evaluate(el => { el.style.minWidth = '100px'; });
    await page.waitForTimeout(100);
    expect(await track().evaluate(el => (el as HTMLElement).hidden)).toBe(true);
    const point = await page.locator('#scroller').evaluate(el => {
      const host = el.parentElement!;
      const h = host.getBoundingClientRect(), s = el.getBoundingClientRect();
      return { x: h.left + h.width / 2, y: (s.bottom + h.bottom) / 2 };
    });
    await page.locator('#scroller').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    expect(await page.locator('#scroller').evaluate(el => el.scrollTop)).toBe(120);
  });

  it('does not request a global rescan for local hover/thumb style writes', async () => {
    await page.evaluate(() => {
      (window as any).treeScans = 0;
      const root = document.getElementById('app-root')!;
      const query = root.querySelectorAll.bind(root);
      root.querySelectorAll = (selector: string) => { if (selector === '*') (window as any).treeScans++; return query(selector); };
    });
    await page.mouse.move(900, 500); await page.mouse.move(200, 150);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => (window as any).treeScans)).toBe(0);
  });

  it('inherits native wheel containment rather than forwarding into another container', async () => {
    await page.locator('#scroller').evaluate(el => { el.style.overscrollBehavior = 'contain'; el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(100);
    const box = await track().boundingBox(); if (!box) throw Error('missing track');
    await page.mouse.move(box.x + 200, box.y + 3); await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    expect(await page.locator('#other').evaluate(el => el.scrollTop)).toBe(0);
  });

  it('resizes/updates table content and hides only if overflow disappears', async () => {
    await page.locator('#scroller').evaluate(el => { el.style.width = '250px'; });
    await expect.poll(() => track().evaluate(el => el.getBoundingClientRect().width)).toBe(244);
    await page.locator('#sessions-table').evaluate(el => { el.style.minWidth = '800px'; });
    await expect.poll(() => track().locator('.floating-scrollbar-thumb').evaluate(el => (el as HTMLElement).offsetWidth)).toBe(76);
    await page.locator('#sessions-table').evaluate(el => { el.style.minWidth = '100px'; });
    await expect.poll(() => track().evaluate(el => (el as HTMLElement).hidden)).toBe(true);
    await page.locator('#sessions-table').evaluate(el => { el.style.minWidth = '1600px'; });
    await expect.poll(() => track().evaluate(el => (el as HTMLElement).hidden)).toBe(false);
  });

  for (const width of [375, 700]) {
    it(`handles a ${width}px viewport without offscreen/local hit leakage`, async () => {
      await page.setViewportSize({ width, height: 600 });
      await page.locator('#scroller').evaluate(el => { el.parentElement!.style.left = '10px'; el.parentElement!.style.width = 'calc(100% - 20px)'; });
      await expect.poll(() => track().evaluate(el => el.getBoundingClientRect().width)).toBe(width - 26);
      await page.mouse.move(50, 150); await begin(); await page.mouse.move(width - 5, 315); await page.mouse.up();
      expect(await left()).toBeGreaterThan(0);
    });
  }

  it('stays hidden when the actual narrow-page responsive CSS makes the table area non-scrollable', async () => {
    await page.setViewportSize({ width: 375, height: 600 });
    await page.locator('#scroller').evaluate(el => {
      const main = document.createElement('main'); const section = document.createElement('div');
      section.className = 'page sessions-page'; main.appendChild(section); const host=el.parentElement!; host.before(main); section.appendChild(host);
      el.style.overflow = ''; el.style.width = '300px';
    });
    await page.mouse.move(150, 150);
    await page.waitForTimeout(150);
    expect(await page.locator('#scroller').evaluate(el => getComputedStyle(el).overflowX)).toBe('visible');
    expect(await track().evaluate(el => (el as HTMLElement).hidden)).toBe(true);
  });

  for (const scope of ['body', 'inside', 'modal'] as const) {
    it(`allows a ${scope} popup to receive trusted clicks under a stationary thumb`, async () => {
      const p = await begin(); await page.mouse.up();
      await page.evaluate(({ p, scope }) => {
        const popup = document.createElement(scope === 'modal' ? 'dialog' : 'button');
        popup.id = 'popup'; popup.textContent = 'Popup choice';
        popup.style.cssText = `position:fixed;left:${p.x - 20}px;top:${p.y - 20}px;margin:0;width:100px;height:40px;z-index:1400;background:white`;
        popup.onclick = e => { popup.dataset.clicked = String(e.isTrusted); };
        (scope === 'inside' ? document.getElementById('scroller')! : document.body).appendChild(popup);
        if (scope === 'modal') (popup as HTMLDialogElement).showModal();
      }, { p, scope });
      // No pointermove and no JS geometry-discovery timeout.
      await page.mouse.down(); await page.mouse.up();
      expect(await page.locator('#popup').getAttribute('data-clicked')).toBe('true');
      expect(await left()).toBe(0);
      await page.locator('#popup').evaluate(el => el.remove());
      await page.mouse.move(200, 150); const again = await begin();
      await page.mouse.move(again.x + 30, again.y); await page.mouse.up();
      expect(await left()).toBeGreaterThan(0);
    });
  }

  it('respects CSS sibling/:has popup positioning and animation without scanning candidates', async () => {
    const p = await begin(); await page.mouse.up();
    await page.addStyleTag({ content: '#local-pop {position:static;width:100px;height:40px} #marker.open ~ #local-pop, #host:has(.open) #local-pop {position:fixed;left:80px;top:300px;z-index:1400;background:white}' });
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'host';
      host.innerHTML = '<span id="marker"></span><button id="local-pop">Action</button>';
      host.querySelector<HTMLElement>('#local-pop')!.onclick = e => { host.dataset.clicked = String(e.isTrusted); };
      document.body.appendChild(host); document.getElementById('marker')!.className = 'open';
    });
    await page.mouse.down(); await page.mouse.up(); expect(await page.locator('#host').getAttribute('data-clicked')).toBe('true');
    await page.locator('#local-pop').evaluate(el => { el.style.transition = 'transform 700ms linear'; el.style.transform = 'translateY(-100px)'; });
    await page.waitForTimeout(850);
    await page.mouse.down(); expect(await track().getAttribute('class')).toContain('is-dragging');
    await page.mouse.move(p.x + 30, p.y); await page.mouse.up(); expect(await left()).toBeGreaterThan(0);
  });

  it('does not scroll through a popup opened while a thumb drag has capture', async () => {
    const p = await begin();
    await page.evaluate(p => {
      const popup = document.createElement('button'); popup.id = 'during-drag';
      popup.style.cssText = `position:fixed;left:${p.x + 30}px;top:${p.y - 10}px;width:100px;height:40px;z-index:1400;background:white`;
      document.body.appendChild(popup);
    }, p);
    await page.mouse.move(p.x + 50, p.y);
    expect(await track().getAttribute('class')).not.toContain('is-dragging');
    expect(await left()).toBe(0); await page.mouse.up();
  });

  it('releases immediately on real pointer capture loss', async () => {
    const p = await begin();
    await track().evaluate(el => (el as HTMLElement).releasePointerCapture(1));
    await page.mouse.move(p.x + 50, p.y); await page.mouse.up();
    expect(await left()).toBe(0);
    expect(await track().getAttribute('class')).not.toContain('is-dragging');
  });

  it('does not let genuine or decorative animations disable the table or other pages', async () => {
    await page.evaluate(() => { document.documentElement.dataset.skin = 'cyber'; (window as any).applyCyberFx(true, false); });
    await page.waitForTimeout(250); await page.mouse.move(200, 150);
    const p = await begin(); await page.mouse.move(p.x + 30, p.y); await page.mouse.up(); expect(await left()).toBeGreaterThan(0);
    expect(await page.locator('#cyber-fx').evaluate(el => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
    await page.screenshot({ path: join(screenshotDir, 'local-c-cyber.png') });
  });

  for (const cancel of ['inert', 'blur', 'pointercancel', 'unmount', 'overflow'] as const) {
    it(`releases safely on ${cancel}`, async () => {
      const p = await begin();
      await page.evaluate(cancel => {
        const bar = document.querySelector('.session-horizontal-scrollbar')!;
        if (cancel === 'inert') document.getElementById('scroller')!.inert = true;
        if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
        if (cancel === 'pointercancel') bar.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
        if (cancel === 'unmount') (window as any).fixtureRoot.unmount();
        if (cancel === 'overflow') (document.getElementById('sessions-table') as HTMLElement).style.minWidth = '100px';
      }, cancel);
      await page.waitForTimeout(100); await page.mouse.move(p.x + 50, p.y); await page.mouse.up();
      expect(await page.locator('.session-horizontal-scrollbar.is-dragging').count()).toBe(0);
      if (cancel === 'inert') expect(await track().evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
      if (cancel !== 'unmount') expect(await left()).toBe(0);
    });
  }

  it('does not lose new-drag availability to a 15k DOM / 50ms class ticker', async () => {
    await page.evaluate(() => {
      const rows = document.createElement('div'); rows.id = 'rows';
      rows.innerHTML = Array.from({ length: 5000 }, (_, i) => `<div><span>${i}</span><button>Row</button></div>`).join('');
      document.getElementById('other')!.appendChild(rows);
      (window as any).bodyScans = 0; const query = document.body.querySelectorAll.bind(document.body);
      document.body.querySelectorAll = (selector: string) => { if (selector === '*') (window as any).bodyScans++; return query(selector); };
      (window as any).ticker = setInterval(() => rows.classList.toggle('tick'), 50);
    });
    const p = await begin(); await page.mouse.up();
    const hits = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(25); await page.mouse.down();
      hits.push((await track().getAttribute('class'))!.includes('is-dragging')); await page.mouse.up();
    }
    expect(hits.every(Boolean)).toBe(true);
    console.info(`C 15k ticker: captures=${hits.filter(Boolean).length}/${hits.length}; body scans=${await page.evaluate(() => (window as any).bodyScans)}`);
    expect(await page.evaluate(() => (window as any).bodyScans)).toBe(0);
    await page.evaluate(() => clearInterval((window as any).ticker));
    await page.mouse.move(p.x + 30, p.y);
    await page.screenshot({ path: join(screenshotDir, 'local-c-default.png') });
  });

  it('keeps local geometry work bounded with 15k nodes and the real table page layout', async () => {
    await page.close(); page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent('<div id="app-root"><main style="height:600px"><div class="page sessions-page"><div>Header</div><div>Stats</div><div>Filters</div><div class="sessions-table-scroll-host"><div id="scroller" class="sessions-view-stage" data-view="table" data-local-horizontal-scrollbar=""><table id="sessions-table" style="min-width:1600px"><tbody></tbody></table></div><div id="bar-host"></div></div></div></main></div>');
    await page.addStyleTag({ content: css });
    await page.locator('#sessions-table tbody').evaluate(el => { el.innerHTML = Array.from({ length: 5000 }, (_, i) => `<tr><td>session-${i}</td><td>running</td></tr>`).join(''); });
    await page.addScriptTag({ content: measuredScript });
    await page.waitForTimeout(200); await page.mouse.move(200, 300);
    const thumb = await track().locator('.floating-scrollbar-thumb').boundingBox(); if (!thumb) throw Error('missing thumb');
    await page.evaluate(() => { (window as any).localMetrics.samples = []; });
    await page.mouse.move(thumb.x + 10, thumb.y + 3); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(thumb.x + 10 + i * 5, thumb.y + 3);
    await page.mouse.up();
    const timings = await page.evaluate(() => {
      const samples = (window as any).localMetrics.samples as number[];
      return { calls: samples.length, total: samples.reduce((sum, ms) => sum + ms, 0), max: Math.max(...samples) };
    });
    expect(await left()).toBeGreaterThan(0);
    expect(timings.calls).toBeLessThan(60);
    expect(timings.total).toBeLessThan(150);
    console.info(`C actual table / 15k elements local update: ${JSON.stringify(timings)}`);
  });

  for (const shrink of ['width', 'height', 'both'] as const) {
    it(`clamps nonzero scroll offsets naturally on ${shrink} content shrink without overlay overflow`, async () => {
      await page.locator('#scroller').evaluate(el => el.scrollTo({ left: el.scrollWidth, top: el.scrollHeight, behavior: 'instant' }));
      await page.waitForTimeout(50);
      const before = await page.locator('#scroller').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
      expect(before.left).toBeGreaterThan(0); expect(before.top).toBeGreaterThan(0);
      await page.locator('#sessions-table').evaluate((el, shrink) => {
        if (shrink !== 'height') { el.style.minWidth = '100px'; el.style.width = '100px'; }
        if (shrink !== 'width') el.style.height = '100px';
      }, shrink);
      await page.waitForTimeout(100);
      const after = await page.locator('#scroller').evaluate(el => ({ sw:el.scrollWidth,sh:el.scrollHeight,cw:el.clientWidth,ch:el.clientHeight,left:el.scrollLeft,top:el.scrollTop }));
      if (shrink !== 'height') { expect(after.sw).toBe(after.cw); expect(after.left).toBe(0); }
      else expect(after.left).toBe(before.left);
      if (shrink !== 'width') { expect(after.sh).toBe(after.ch); expect(after.top).toBe(0); }
      else expect(after.top).toBe(before.top);
      const withOverlay = [after.sw, after.sh, after.left, after.top];
      const excluded = await track().evaluate(el => {
        (el as HTMLElement).style.display='none'; const t=document.getElementById('scroller')!;
        const values=[t.scrollWidth,t.scrollHeight,t.scrollLeft,t.scrollTop]; (el as HTMLElement).style.display=''; return values;
      });
      expect(excluded).toEqual(withOverlay);
    });
  }

  for (const action of ['search', 'sse', 'columns'] as const) {
    it(`handles real renderSessionsPage ${action} at nonzero dual-axis offsets without feedback storms`, async () => {
      await page.close(); page = await browser.newPage({ viewport:{width:1000,height:700} });
      const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=> {
        const url=new URL(route.request().url());
        return route.fulfill({contentType:url.pathname==='/'?'text/html':'application/json',body:url.pathname==='/'
          ? '<div id="app-root"><main id="page-host" style="width:calc(100% - 100px);height:600px;margin:30px 50px;padding:0"></main></div>'
          : JSON.stringify({ok:true,bots:[],chats:[{chatId:'oc_test',name:'Test chat'}],groups:[]})});
      });
      await page.goto('http://local-regression.invalid/');
      await page.evaluate(()=>localStorage.setItem('botmux.dashboard.sessions.view','table'));
      await page.addStyleTag({content:css});await page.addScriptTag({content:realScript});
      await page.waitForFunction(()=>document.querySelectorAll('#sessions-table tbody tr').length===40);
      const stage=page.locator('.sessions-view-stage');
      await stage.evaluate(el=>el.scrollTo({left:el.scrollWidth,top:el.scrollHeight,behavior:'instant'}));
      await page.waitForTimeout(80);
      const before=await stage.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop}));
      expect(before.left).toBeGreaterThan(0);expect(before.top).toBeGreaterThan(0);
      await page.evaluate(()=>{
        (window as any).shrinkEvents={scroll:0,scans:0};
        document.querySelector('.sessions-view-stage')!.addEventListener('scroll',()=>{(window as any).shrinkEvents.scroll++;});
        const root=document.getElementById('app-root')!;const query=root.querySelectorAll.bind(root);
        root.querySelectorAll=(selector:string)=>{if(selector==='*')(window as any).shrinkEvents.scans++;return query(selector);};
      });
      if(action==='search') await page.locator('input[name="q"]').fill('definitely-no-match');
      if(action==='sse') await page.evaluate(()=>{
        (window as any).rows.forEach((r:any)=>(window as any).reviewStore.applySse('session.exited',{sessionId:r.sessionId}));
      });
      if(action==='columns') {
        // Keep the nonzero Y position; product column state changes reduce width.
        await page.evaluate(()=>{
          const inputs=document.querySelectorAll<HTMLInputElement>('.session-table-columns-item input');
          inputs.forEach(input=>input.click());
        });
      }
      await page.waitForTimeout(200);
      const metrics=await stage.evaluate(el=>{
        const table=el.querySelector('table')!;
        return {sw:el.scrollWidth,sh:el.scrollHeight,cw:el.clientWidth,ch:el.clientHeight,left:el.scrollLeft,top:el.scrollTop,tw:table.offsetWidth,th:table.offsetHeight};
      });
      expect(metrics.sw).toBe(Math.max(metrics.cw,metrics.tw));
      expect(metrics.sh).toBe(Math.max(metrics.ch,metrics.th));
      expect(metrics.left).toBeLessThanOrEqual(metrics.sw-metrics.cw);
      expect(metrics.top).toBeLessThanOrEqual(metrics.sh-metrics.ch);
      if(action!=='columns')expect(metrics.top).toBe(0);
      const counts=await page.evaluate(()=>(window as any).shrinkEvents);
      expect(counts.scroll).toBeLessThan(10);expect(counts.scans).toBeLessThan(10);
      await page.waitForTimeout(250);
      expect(await page.evaluate(()=>(window as any).shrinkEvents)).toEqual(counts);
      expect(errors).toEqual([]);
      console.info(`C01 real-page ${action}: ${JSON.stringify({before,metrics,counts})}`);
    });
  }

  for (const from of ['board', 'topics'] as const) {
    for (const reduced of [false, true]) {
      it(`keeps real column checkboxes above the sibling bar after ${from}→table (${reduced ? 'reduced' : 'normal'} motion)`, async () => {
        await page.close(); page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
        const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
          const entry = new URL(route.request().url()).pathname === '/';
          return route.fulfill({ contentType: entry ? 'text/html' : 'application/json', body: entry
            ? '<div id="app-root"><main id="page-host" style="width:900px;height:500px;margin:30px 50px;padding:0"></main></div>'
            : JSON.stringify({ ok: true, bots: [], groups: [], chats: [{ chatId: 'oc_test', name: 'Test chat' }] }) });
        });
        await page.goto('http://column-regression.invalid/');
        await page.evaluate(() => localStorage.setItem('botmux.dashboard.sessions.view', 'table'));
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: realScript });
        await page.waitForFunction(() => document.querySelectorAll('#sessions-table tbody tr').length === 40);
        // Exercise actual view controls/effect. No manually injected stage class
        // or z-index override, and no removing the animation as a test fix.
        await page.locator(`.sessions-view-toggle button[data-view="${from}"]`).click();
        await page.locator('.sessions-view-toggle button[data-view="table"]').click();
        await page.waitForTimeout(500);
        const stage = page.locator('.sessions-view-stage');
        expect(await stage.evaluate(el => getComputedStyle(el).transform)).toBe('none');
        expect(await stage.getAttribute('class')).not.toContain('sessions-view-stage-enter');
        expect(await page.locator('.sessions-table-scroll-host').getAttribute('class')).toContain('sessions-view-stage-enter');
        await stage.evaluate(el => el.scrollTo({ left: el.scrollWidth, top: 0, behavior: 'instant' }));
        await page.waitForTimeout(100);
        await page.locator('.session-table-columns-menu summary').click();
        const geometry = await page.evaluate(() => {
          const b = document.querySelector('.session-horizontal-scrollbar')!.getBoundingClientRect();
          const d = document.querySelector('.session-table-columns-dropdown')!.getBoundingClientRect();
          // Find an actual visible checkbox instead of assuming the old bar
          // center still intersects an INPUT after reserving its bottom strip.
          const inputs = [...document.querySelectorAll<HTMLInputElement>('.session-table-columns-item input')];
          const stageBottom = document.querySelector('.sessions-view-stage')!.getBoundingClientRect().bottom;
          const visible = inputs.map(input => input.getBoundingClientRect())
            .filter(r => r.top >= d.top && r.bottom <= Math.min(d.bottom, stageBottom));
          const r = visible.at(-1);
          if (!r) throw Error('missing visible column checkbox');
          return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2,
            menuTop: d.top, menuBottom: d.bottom, barLeft: b.left, barRight: b.right };
        });
        expect(geometry.y).toBeGreaterThan(geometry.menuTop);
        expect(geometry.y).toBeLessThan(geometry.menuBottom);
        expect(geometry.x).toBeGreaterThan(geometry.barLeft);
        expect(geometry.x).toBeLessThan(geometry.barRight);
        const checkbox = await page.evaluateHandle(p => document.elementFromPoint(p.x, p.y), geometry);
        expect(await checkbox.evaluate(el => el?.tagName)).toBe('INPUT');
        expect(await checkbox.evaluate(el => !!el?.closest('.session-table-columns-dropdown'))).toBe(true);
        const initial = await checkbox.evaluate(el => (el as HTMLInputElement).checked);
        await checkbox.evaluate(el => el!.addEventListener('click', e => { (window as any).columnTrusted = e.isTrusted; }));
        const columnsBefore = await page.locator('#sessions-table thead th').count();
        const beforeLeft = await stage.evaluate(el => el.scrollLeft);
        await page.mouse.click(geometry.x, geometry.y);
        expect(await page.evaluate(() => (window as any).columnTrusted)).toBe(true);
        expect(await checkbox.evaluate(el => (el as HTMLInputElement).checked)).toBe(!initial);
        await expect.poll(() => page.locator('#sessions-table thead th').count()).toBe(columnsBefore + (initial ? -1 : 1));
        expect(await stage.evaluate(el => el.scrollLeft)).toBeLessThanOrEqual(beforeLeft);
        expect(await page.locator('.session-horizontal-scrollbar.is-dragging').count()).toBe(0);
        await page.screenshot({ path: join(screenshotDir, `c02-${from}-${reduced ? 'reduced' : 'motion'}.png`) });
        await page.locator('.session-table-columns-menu summary').click();
        await stage.evaluate(el => el.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
        await page.mouse.move(200, 300); const p = await begin();
        await page.mouse.move(p.x + 30, p.y); await page.mouse.up();
        expect(await stage.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        expect(errors).toEqual([]);
        console.info(`C02 real ${from} reduced=${reduced}: INPUT at ${JSON.stringify(geometry)}, trusted=true, toggled=${!initial}`);
        await checkbox.dispose();
      });
    }
  }

  it('keeps real row checkboxes clickable at every bottom-edge scroll position, including clipped remnants', async () => {
    await page.close(); page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('**/*', route => {
      const entry = new URL(route.request().url()).pathname === '/';
      return route.fulfill({ contentType: entry ? 'text/html' : 'application/json', body: entry
        ? '<div id="app-root"><main id="page-host" style="width:900px;height:600px;margin:30px 50px;padding:0"></main></div>'
        : JSON.stringify({ ok: true, bots: [], groups: [], chats: [{ chatId: 'oc_test', name: 'Test chat' }] }) });
    });
    await page.goto('http://row-control-regression.invalid/');
    await page.evaluate(() => localStorage.setItem('botmux.dashboard.sessions.view', 'table'));
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: realScript });
    await page.waitForFunction(() => document.querySelectorAll('#sessions-table tbody tr').length === 40);
    await page.mouse.move(200, 300);
    const stage = page.locator('.sessions-view-stage');
    const input = page.locator('#sessions-table tbody input[type="checkbox"]').nth(10);
    // Sweep the former 6px hit strip and a half-clipped checkbox. Real mouse
    // clicks, not input.click() or forcing the table back to the origin.
    for (const distance of [12, 8, 6, 4, 2, 0, -2, -4]) {
      await input.evaluate((el, distance) => {
        const scroller = el.closest('.sessions-view-stage')!;
        const bottom = scroller.getBoundingClientRect().bottom;
        const r = el.getBoundingClientRect();
        scroller.scrollBy({ top: (r.top + r.bottom) / 2 - (bottom - distance), behavior: 'instant' });
      }, distance);
      await page.waitForTimeout(40);
      const point = await input.evaluate(el => {
        const s = el.closest('.sessions-view-stage')!; const bounds = s.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const top = Math.max(r.top, bounds.top); const bottom = Math.min(r.bottom, bounds.bottom);
        return { x: (r.left + r.right) / 2, y: (top + bottom) / 2, visible: bottom - top };
      });
      expect(point.visible).toBeGreaterThan(0);
      expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.tagName, point)).toBe('INPUT');
      const initial = await input.isChecked(); const beforeLeft = await stage.evaluate(el => el.scrollLeft);
      await input.evaluate(el => el.addEventListener('click', event => { (window as any).rowTrusted = event.isTrusted; }, { once: true }));
      await page.mouse.click(point.x, point.y);
      await expect.poll(() => input.isChecked()).toBe(!initial);
      expect(await page.evaluate(() => (window as any).rowTrusted)).toBe(true);
      expect(await stage.evaluate(el => el.scrollLeft)).toBe(beforeLeft);
      expect(await page.locator('.session-horizontal-scrollbar.is-dragging').count()).toBe(0);
      const covered = await stage.evaluate(el => {
        const s = el.getBoundingClientRect(); let count = 0;
        for (const input of el.querySelectorAll('tbody input[type="checkbox"]')) {
          const r = input.getBoundingClientRect();
          for (let y = Math.max(r.top + .5, s.top + .5); y < Math.min(r.bottom, s.bottom); y += 2) {
            if (document.elementFromPoint((r.left + r.right) / 2, y)?.closest('.session-horizontal-scrollbar')) count++;
          }
        }
        return count;
      });
      expect(covered).toBe(0);
    }
    const geometry = await stage.evaluate(el => ({ bottom: el.getBoundingClientRect().bottom,
      hostBottom: el.parentElement!.getBoundingClientRect().bottom }));
    const bar = await track().boundingBox(); if (!bar) throw Error('missing track');
    expect(bar.y).toBeCloseTo(geometry.bottom, 4);
    expect(bar.y + bar.height).toBeCloseTo(geometry.hostBottom, 4);
    await page.screenshot({ path: join(screenshotDir, 'row-checkbox-bottom-edge.png') });
  });

  it('stops a captured drag when a native modal opens and recovers after it closes', async () => {
    const p = await begin();
    await page.evaluate(() => {
      const dialog = document.createElement('dialog'); dialog.id = 'during-modal';
      dialog.innerHTML = '<button>Modal action</button>'; document.body.appendChild(dialog); dialog.showModal();
    });
    await page.mouse.move(p.x + 50, p.y); await page.mouse.up();
    expect(await left()).toBe(0);
    expect(await track().getAttribute('class')).not.toContain('is-dragging');
    const button = page.locator('#during-modal button');
    await button.evaluate(el => el.addEventListener('click', e => { (window as any).modalTrusted = e.isTrusted; }));
    await button.click(); expect(await page.evaluate(() => (window as any).modalTrusted)).toBe(true);
    await page.locator('#during-modal').evaluate(el => { (el as HTMLDialogElement).close(); el.remove(); });
    await page.mouse.move(200, 150); const again = await begin();
    await page.mouse.move(again.x + 30, again.y); await page.mouse.up();
    expect(await left()).toBeGreaterThan(0);
  });
});
