import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { fetchCliAvailability } from '../src/dashboard/web/cli-availability.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const cliState = {
  options: [
    { id: 'traex', label: 'TraeX', available: false, command: 'traex', availabilityStatus: 'unknown' as const },
    { id: 'gemini', label: 'Gemini', available: false, command: 'gemini', availabilityStatus: 'unknown' as const },
  ],
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: [],
};
const renderers: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function renderAgent(bot = { larkAppId: 'cli_test', cliId: 'traex' }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(BotAgentSection, {
      bot, cliState, sessionFallback: 'traex', patchBot: vi.fn(),
    }));
  });
  renderers.push(renderer);
  return renderer;
}

describe('selected Dashboard CLI availability', () => {
  it('does not label a PATH-only miss as uninstalled while the complete probe is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const renderer = renderAgent();
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
  });

  it.each(['available', 'unavailable', 'unknown'] as const)('renders the complete %s result', async status => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status } : { models: [], source: 'static' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = renderAgent(); });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(status === 'unavailable' ? 1 : 0);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/cli-options/availability?key=traex&bot=cli_test', { signal: expect.any(AbortSignal) },
    );
  });

  it('ignores an old unavailable response after selecting another CLI', async () => {
    let resolveOld!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/availability?key=traex')) return await new Promise(resolve => { resolveOld = resolve; });
      return { ok: true, json: async () => url.includes('/availability?') ? { status: 'available' } : { models: [] } };
    }));
    const renderer = renderAgent();
    await act(async () => {
      renderer.root.findByProps({ dataInput: 'agentCliId' }).props.onChange('gemini');
    });
    await act(async () => { resolveOld({ ok: true, json: async () => ({ status: 'unavailable' }) }); });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
    expect(renderer.root.findByProps({ dataInput: 'agentCliId' }).props.value).toBe('gemini');
  });

  it('discards the old Bot readiness when its persisted configuration changes', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status: 'unavailable' } : { models: [] },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const renderer = renderAgent();
    await act(async () => {});
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(1);
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    act(() => {
      renderer.update(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_test', cliId: 'traex', cliPathOverride: '/new/traex' },
        cliState, sessionFallback: 'traex', patchBot: vi.fn(),
      }));
    });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
  });

  it('does not turn network/HTTP/invalid-body failures into a missing executable', async () => {
    for (const response of [
      { ok: false, json: async () => ({ status: 'unavailable' }) },
      { ok: true, json: async () => ({ status: 'malformed' }) },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      expect(await fetchCliAvailability('traex')).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchCliAvailability('traex')).toBeNull();
  });
});

describe('Bot readiness configuration identity', () => {
  it('preserves definitive absence without another probe when only the roster object changes', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status: 'unavailable' } : { models: [] },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const renderer = renderAgent();
    await act(async () => {});
    const before = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/availability?')).length;
    await act(async () => {
      renderer.update(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_test', cliId: 'traex' }, cliState, sessionFallback: 'traex', patchBot: vi.fn(),
      }));
    });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/availability?'))).toHaveLength(before);
  });

  it('re-probes after the server environment fingerprint changes', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status: 'unavailable' } : { models: [] },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const renderer = renderAgent();
    await act(async () => {});
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    act(() => renderer.update(React.createElement(BotAgentSection, {
      bot: { larkAppId: 'cli_test', cliId: 'traex', envRevision: 'changed-env' },
      cliState, sessionFallback: 'traex', patchBot: vi.fn(),
    })));
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/availability?'))).toHaveLength(2);
  });
});

// 非文本断言：style.css 只作为真实浏览器样式夹具，断言的是交互与 HTTP 结果。
it.skipIf(process.env.BOTMUX_AVAILABILITY_BROWSER !== '1')('uses real browser controls with shell readiness and stable roster refresh', async () => {
  const { chromium } = await import('playwright');
  const { build } = await import('esbuild');
  const { createServer } = await import('node:http');
  const { readFileSync, mkdirSync } = await import('node:fs');
  const { cliAvailabilityResponse, createCliAvailabilityCache } = await import('../src/dashboard/cli-availability-request.js');
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'availability-browser-'));
  const tool = join(root, 'traex'); const shell = join(root, 'shell');
  writeFileSync(tool, '#!/bin/sh\nexit 0\n'); chmodSync(tool, 0o755);
  writeFileSync(shell, `#!/bin/sh\n[ "$4" = traex ] && echo '${tool}'\n`); chmodSync(shell, 0o755);
  const initial = { larkAppId: 'browser_app', botName: 'CLI readiness example', cliId: 'traex', envRevision: 'same-env' };
  const config = { ...initial, larkAppSecret: 'fixture', cliId: 'traex' as const, env: { HOME: root, ZDOTDIR: root, SHELL: shell, PATH: '/usr/bin:/bin' } };
  const bundle = await build({
    stdin: { contents: `
      import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { BotAgentSection } from './src/dashboard/web/bot-defaults-page.tsx';
      const initial = ${JSON.stringify(initial)};
      function App() { const [bot,setBot]=useState(initial); return <main style={{maxWidth:900,margin:'30px auto'}}>
        <button data-refresh onClick={()=>setBot({...bot})}>Refresh same roster</button>
        <BotAgentSection bot={bot} sessionFallback="traex"
          cliState={{options:[{id:'traex',label:'TraeX',availabilityStatus:'unknown'},{id:'reasonix',label:'Reasonix',availabilityStatus:'unknown'}],ttadkModelDefault:'',ttadkModelSuggestions:[]}}
          patchBot={(_,patch)=>setBot({...bot,...patch})} /></main>; }
      createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', minify: true,
  });
  let probes = 0;
  const cache = createCliAvailabilityCache();
  const server = createServer((req,res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/app.js') { res.setHeader('Content-Type','text/javascript'); res.end(bundle.outputFiles[0]!.contents); }
    else if (url.pathname === '/style.css') { res.setHeader('Content-Type','text/css'); res.end(readFileSync('src/dashboard/web/style.css')); }
    else if (url.pathname === '/api/cli-options/availability') {
      probes++;
      const response = await cliAvailabilityResponse(url.searchParams.get('key')!, config, config.env, undefined, cache);
      res.writeHead(response.statusCode,{'content-type':'application/json'}); res.end(JSON.stringify(response.body));
    } else if (url.pathname.startsWith('/api/')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ models: [], profiles: [], source: 'static' })); }
    else res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>');
  })().catch(error => { res.statusCode=500;res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport:{width:1120,height:900} });
    const readyResponse = page.waitForResponse(response => response.url().includes('/availability?key=traex'));
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
    expect((await (await readyResponse).json()).status).toBe('available');
    await page.locator('[data-input="agentCliId"]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('.hint-warn'));
    await page.waitForTimeout(250);
    const before = probes;
    await page.locator('[data-refresh]').click();
    await page.waitForTimeout(250);
    expect(probes).toBe(before);
    expect(await page.locator('.hint-warn').count()).toBe(0);
    mkdirSync('docs/assets/cli-availability',{recursive:true});
    await page.screenshot({path:'docs/assets/cli-availability/roster-stable.png',fullPage:true});
    // The real dropdown uses a button plus listbox options.
    await page.locator('#bd-menu-agentCliId summary').click();
    await page.locator('#bd-menu-agentCliId button').filter({hasText:'Reasonix'}).click();
    await page.locator('.hint-warn').waitFor();
    await page.screenshot({path:'docs/assets/cli-availability/confirmed-missing.png',fullPage:true});
    expect(await page.locator('.hint-warn').count()).toBe(1);
  } finally {
    await browser?.close(); await new Promise<void>(resolve => server.close(()=>resolve())); rmSync(root,{recursive:true,force:true});
  }
}, 60_000);
