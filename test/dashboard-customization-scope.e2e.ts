/**
 * 「自定义」页在真实浏览器里的平台切换（飞书 / 企业微信）：真实页面 + 真实 style.css，所有 /api/** 由
 * Playwright 路由交给真实的 handleCustomizationApi（数据目录是 e2e 围栏给的临时目录），所以页面发出的
 * 请求、服务端按作用域落盘的结果都是真的。调用方按本机管理员处理（企业微信作用域只对它开放）；企业微信
 * 作用域的写请求像 dashboard.ts 那样过控制 CSRF 检查（票据是页面 <meta name="botmux-csrf"> 里的那枚）。
 *
 * - 部署里没有企业微信连接时，页面上没有平台切换栏，发出的请求一个都不带作用域。
 * - 有企业微信连接时出现「飞书 / 企业微信」切换，默认飞书；切到企业微信后只列企业微信会话里真的会渲染的
 *   片段、没有内置 Skill 页签，并说明角色与业务提示词在各连接的 Bot 配置里设置；企业微信页的每一种写操作
 *   （片段、总开关、导入、恢复出厂、回滚）都带 scope=wecom 和 CSRF 票据，只落进企业微信那份存储。
 * - 在一个平台下打开、输入、弹出的东西（编辑框和草稿、导入框、确认框）在有效平台变化时（点切换，或名册
 *   里的企业微信连接数变化）一律丢弃；慢到的旧读取不覆盖期间的保存；一个平台的加载失败不显示在另一个平台。
 *
 * CZ_CAPTURE_DIR=<dir> 时额外把各状态的 DOM 与截图写进该目录（改动前后对照用）。
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {build} from 'esbuild';
import {createServer, type Server, type IncomingMessage, type ServerResponse} from 'node:http';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium, type Browser, type Page} from 'playwright';
import {handleCustomizationApi} from '../src/dashboard/customization-api.js';
import {invalidateCustomizationCache} from '../src/services/customization-store.js';

// 非文本断言：真实生产 CSS 作为浏览器夹具，测试只看渲染结果与发出的请求。
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
const CAPTURE_DIR = process.env.CZ_CAPTURE_DIR;
const CSRF = 'fixture-csrf';
let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  const bundle = await build({entryPoints: ['test/fixtures/customization-browser.tsx'], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: {'.css': 'empty'}, logLevel: 'silent'});
  server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/fixture.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="botmux-csrf" content="${CSRF}"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({headless: true, ...(!existsSync(chromium.executablePath()) && existsSync(systemChrome) ? {executablePath: systemChrome} : {})});
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(done => server ? server.close(() => done()) : done()); });

const dataDir = () => process.env.SESSION_DATA_DIR!;
const stateOf = (dir: 'customizations' | 'customizations-wecom') => {
  const file = join(dataDir(), dir, 'state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

interface ApiCall { method: string; path: string; body?: string; csrf?: string }
type ApiResult = {status: number; headers: Record<string, string>; body: string};

/** Hand one browser request to the real customization API, in process, as the host admin. */
async function realApi(method: string, url: URL, body: string | undefined, csrf?: string): Promise<ApiResult> {
  const out: ApiResult = {status: 0, headers: {}, body: ''};
  const res = {
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {}; return res; },
    end(chunk?: string) { out.body = chunk ?? ''; },
  } as unknown as ServerResponse;
  const req = {method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body, 'utf8'); }} as unknown as IncomingMessage;
  const access = {
    wecomHostAdmin: true,
    // dashboard.ts enforceControlCsrf: on a bad token it answers 403 itself.
    wecomCsrfValid: () => {
      if (csrf === CSRF) return true;
      res.writeHead(403, {'content-type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'control_csrf_invalid'}));
      return false;
    },
  };
  if (!await handleCustomizationApi(req, res, url, access)) return {status: 404, headers: {}, body: '{}'};
  return out;
}

interface Hooks {
  /** Delay delivering the answer (it is computed when the request arrives). */
  delay?: (method: string, url: URL) => number;
  fail?: (method: string, url: URL) => boolean;
}

async function openPage(width: number, roster: {lark?: number; wecom?: number}, hooks: Hooks = {}): Promise<{page: Page; calls: ApiCall[]; errors: string[]}> {
  const page = await browser.newPage({viewport: {width, height: 1000}});
  const calls: ApiCall[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.addInitScript(value => { (window as unknown as {__CZ_ROSTER__: unknown}).__CZ_ROSTER__ = value; }, roster);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ?? undefined;
    const csrf = request.headers()['x-botmux-csrf'];
    calls.push({method: request.method(), path: url.pathname + url.search, ...(body ? {body} : {}), ...(csrf ? {csrf} : {})});
    const result = hooks.fail?.(request.method(), url)
      ? {status: 500, headers: {'content-type': 'application/json'}, body: JSON.stringify({ok: false, error: 'injected_failure'})}
      : await realApi(request.method(), url, body, csrf);
    const wait = hooks.delay?.(request.method(), url) ?? 0;
    if (wait) await new Promise(done => setTimeout(done, wait));
    await route.fulfill({status: result.status, headers: result.headers, body: result.body}).catch(() => {});
  });
  page.setDefaultTimeout(8000);
  await page.goto(`${origin}/#/customization`);
  await page.locator('.cz-stage-tab').first().waitFor();
  await page.mouse.move(0, 0);
  return {page, calls, errors};
}

/** Root DOM with the page's own <style> block dropped (it is static text). */
const rootHtml = (page: Page) => page.evaluate(() => document.getElementById('root')!.innerHTML);

async function capture(page: Page, name: string): Promise<void> {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, {recursive: true});
  await page.waitForTimeout(350);
  writeFileSync(join(CAPTURE_DIR, `${name}.html`), await rootHtml(page));
  await page.screenshot({path: join(CAPTURE_DIR, `${name}.png`), fullPage: true});
}

const scopeTab = (page: Page, label: '飞书' | '企业微信') => page.locator('.cz-scope-tabs [role=tab]', {hasText: label});
const row = (page: Page, key: string) => page.locator('.cz-frag', {has: page.locator('.cz-frag-key', {hasText: key})});
const DEFENSE = 'ai.routing.hidden_context_defense'; // listed by both scopes
const publishRoster = (page: Page, count: number) => page.evaluate(n => (window as unknown as {__publishRoster: (p: string, c: number) => void}).__publishRoster('wecom', n), count);
async function toWecom(page: Page): Promise<void> {
  await scopeTab(page, '企业微信').click();
  await page.locator('.cz-scope-note').waitFor();
}
async function toFeishu(page: Page): Promise<void> {
  await scopeTab(page, '飞书').click();
  await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).waitFor();
}

describe('customization page without any WeCom connection', () => {
  for (const [label, roster] of [['wecom-0', {lark: 1, wecom: 0}], ['wecom-unknown', {lark: 1}]] as const) {
    for (const width of [1440, 375]) {
      it(`${label} @${width}: no platform switch, and no request carries a scope or a CSRF token`, async () => {
        const {page, calls, errors} = await openPage(width, roster);
        try {
          await capture(page, `nowecom-${label}-${width}-initial`);
          expect(await page.locator('.cz-scope-tabs').count()).toBe(0);
          for (const tab of ['每条新消息', '发送之后', '内置 Skill']) {
            await page.locator('.cz-stage-tab', {hasText: tab}).click();
            await capture(page, `nowecom-${label}-${width}-tab-${tab}`);
          }
          await page.locator('.cz-stage-tab', {hasText: '会话开始'}).click();
          await page.locator('button', {hasText: '历史 / 回滚'}).click();
          await capture(page, `nowecom-${label}-${width}-history`);
          await page.locator('.cz-search').fill('routing');
          await capture(page, `nowecom-${label}-${width}-search`);
          expect(calls.length).toBeGreaterThan(0);
          expect(calls.filter(call => call.path.includes('scope') || call.csrf)).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
    }
  }
});

describe('customization page with a WeCom connection', () => {
  const wecomKeys = async () => (await import('../src/im/wecom/contract/prompt-fragments.js')).wecomCustomizationFragments().map(f => f.key);
  beforeEach(() => {
    for (const dir of ['customizations', 'customizations-wecom']) rmSync(join(dataDir(), dir), {recursive: true, force: true});
    invalidateCustomizationCache();
  });

  /** Every fragment key the open scope lists, across its stage tabs. */
  async function listedKeys(page: Page): Promise<string[]> {
    const keys = new Set<string>();
    const stages = await page.locator('.cz-stage-tab').allTextContents();
    for (const label of stages) {
      if (label.includes('内置 Skill')) continue;
      await page.locator('.cz-stage-tab', {hasText: label.replace(/\d+$/, '')}).first().click();
      for (const key of await page.locator('.cz-frag-key').allTextContents()) keys.add(key);
    }
    return [...keys];
  }

  it('switches between the Feishu and the WeCom set; the WeCom tab lists only WeCom fragments and no skills', async () => {
    const {page, calls, errors} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      const tabs = page.locator('.cz-scope-tabs [role=tab]');
      expect(await tabs.allTextContents()).toEqual(['飞书', '企业微信']);
      expect(await page.locator('.cz-scope-tab-on').textContent()).toBe('飞书');
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/customization']);
      expect(await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).count()).toBe(1);

      await toWecom(page);
      expect(calls.at(-1)).toEqual({method: 'GET', path: '/api/customization?scope=wecom'});
      expect(await page.locator('.cz-scope-note').textContent()).toContain('Bot 配置');
      expect(await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).count()).toBe(0);
      expect((await listedKeys(page)).sort()).toEqual((await wecomKeys()).sort());

      await toFeishu(page);
      expect(calls.at(-1)).toEqual({method: 'GET', path: '/api/customization'});
      expect(await page.locator('.cz-scope-note').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  for (const width of [1440, 375]) {
    it(`renders both platform tabs without overflow @${width}`, async () => {
      const {page, errors} = await openPage(width, {lark: 1, wecom: 1});
      try {
        await capture(page, `wecom-${width}-feishu-tab`);
        await toWecom(page);
        await capture(page, `wecom-${width}-wecom-tab`);
        await page.locator('.cz-stage-tab', {hasText: '每条新消息'}).click();
        await capture(page, `wecom-${width}-wecom-tab-followup`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }

  it('saves a WeCom-tab edit with the WeCom scope and the CSRF token into the WeCom store only, in the line\'s fixed locale', async () => {
    const {page, calls, errors} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      // Even with the EN locale open, a Chinese-only gateway line edits its zh text.
      await page.locator('.cz-tab', {hasText: 'EN'}).click();
      const line = row(page, 'wecom.task.channel_private');
      expect(await line.locator('.cz-chip', {hasText: '仅 ZH'}).count()).toBe(1);
      await line.locator('.cz-frag-text').click();
      await line.locator('textarea').fill('E2E_WECOM_CHANNEL_LINE');
      await line.locator('button', {hasText: '保存'}).click();
      await line.locator('.cz-chip-mod').waitFor();
      const put = calls.find(call => call.method === 'PUT');
      expect(put).toMatchObject({path: '/api/customization/prompt?scope=wecom', csrf: CSRF});
      expect(JSON.parse(put!.body!)).toEqual({locale: 'zh', key: 'wecom.task.channel_private', value: 'E2E_WECOM_CHANNEL_LINE'});
      expect(stateOf('customizations-wecom').promptOverrides).toEqual({zh: {'wecom.task.channel_private': 'E2E_WECOM_CHANNEL_LINE'}});
      expect(stateOf('customizations')).toBeNull();
      await capture(page, 'wecom-tab-after-save-1440');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('sends every other WeCom-tab write — master switch, import, reset, rollback — and the export link to the WeCom store', async () => {
    const {page, calls, errors} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      expect(await page.locator('a', {hasText: '导出 bundle'}).getAttribute('href')).toBe('/api/customization/export?scope=wecom');
      const writes = () => calls.filter(call => call.method !== 'GET');

      await page.locator('.cz-master-switch').click();
      await page.locator('.cz-dim-off').waitFor();
      expect(stateOf('customizations-wecom').enabled).toBe(false);
      await page.locator('.cz-master-switch').click();
      await page.locator('.cz-dim-off').waitFor({state: 'detached'});

      await page.locator('button', {hasText: '导入 bundle'}).click();
      await page.locator('.cz-modal textarea').fill(JSON.stringify({schemaVersion: 1, kind: 'botmux-customization-bundle', scope: 'wecom', promptOverrides: {zh: {'wecom.task.channel_group': 'E2E_IMPORTED_CHANNEL'}}}));
      await page.locator('.cz-modal button', {hasText: '预览差异'}).click();
      await page.locator('.cz-modal button', {hasText: '确认导入'}).click();
      await page.locator('.cz-modal').waitFor({state: 'detached'});
      expect(stateOf('customizations-wecom').promptOverrides).toEqual({zh: {'wecom.task.channel_group': 'E2E_IMPORTED_CHANNEL'}});

      await page.locator('button', {hasText: '全部恢复出厂'}).click();
      await page.locator('.confirm-modal-dialog button', {hasText: '恢复出厂'}).click();
      await expect.poll(() => stateOf('customizations-wecom').promptOverrides).toBeUndefined();

      await page.locator('button', {hasText: '历史 / 回滚'}).click();
      await page.locator('.cz-hist-row', {hasText: 'reset all to factory'}).locator('button', {hasText: '回滚到此'}).click();
      await page.locator('.confirm-modal-dialog button', {hasText: '回滚'}).click();
      await expect.poll(() => stateOf('customizations-wecom').promptOverrides).toEqual({zh: {'wecom.task.channel_group': 'E2E_IMPORTED_CHANNEL'}});

      expect(writes().map(call => `${call.method} ${call.path} ${call.csrf}`)).toEqual([
        `PUT /api/customization/enabled?scope=wecom ${CSRF}`,
        `PUT /api/customization/enabled?scope=wecom ${CSRF}`,
        `POST /api/customization/import?scope=wecom ${CSRF}`,
        `POST /api/customization/import?scope=wecom ${CSRF}`,
        `POST /api/customization/reset-all?scope=wecom ${CSRF}`,
        `POST /api/customization/rollback?scope=wecom ${CSRF}`,
      ]);
      expect(stateOf('customizations')).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('discards an editor opened under one platform when switching to the other, in both directions', async () => {
    const {page, calls} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      await row(page, DEFENSE).locator('.cz-frag-text').click();
      await row(page, DEFENSE).locator('textarea').fill('TYPED_ON_WECOM_TAB');
      await toFeishu(page);
      expect(await row(page, DEFENSE).locator('textarea').count()).toBe(0);
      await row(page, DEFENSE).locator('.cz-frag-text').click();
      await row(page, DEFENSE).locator('textarea').fill('TYPED_ON_FEISHU_TAB');
      await toWecom(page);
      expect(await row(page, DEFENSE).locator('textarea').count()).toBe(0);
      expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('discards a WeCom editor, the import dialog and an open confirm when the WeCom connection count drops to 0', async () => {
    const {page, calls} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      await row(page, DEFENSE).locator('.cz-frag-text').click();
      await row(page, DEFENSE).locator('textarea').fill('TYPED_BEFORE_ROSTER_FLIP');
      await publishRoster(page, 0);
      await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).waitFor();
      expect(await page.locator('.cz-scope-tabs').count()).toBe(0);
      expect(await row(page, DEFENSE).locator('textarea').count()).toBe(0);

      await publishRoster(page, 1);
      await page.locator('.cz-scope-note').waitFor();
      await page.locator('button', {hasText: '导入 bundle'}).click();
      await page.locator('.cz-modal').waitFor();
      await publishRoster(page, 0);
      await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).waitFor();
      expect(await page.locator('.cz-modal').count()).toBe(0);

      await publishRoster(page, 1);
      await page.locator('.cz-scope-note').waitFor();
      await page.locator('button', {hasText: '全部恢复出厂'}).click();
      const dialog = page.locator('.confirm-modal-dialog[open]');
      await dialog.waitFor();
      await publishRoster(page, 0);
      await dialog.waitFor({state: 'detached'}).catch(() => {});
      expect(await page.locator('.confirm-modal-dialog[open]').count()).toBe(0);
      expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('closes the import dialog when the platform changes under it, so a WeCom preview can never be applied to Feishu', async () => {
    await realApi('PUT', new URL('http://x/api/customization/prompt'), JSON.stringify({locale: 'zh', key: 'ai.routing.intro', value: 'FEISHU_KEEP_ME'}));
    const {page, calls} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      await page.locator('button', {hasText: '导入 bundle'}).click();
      await page.locator('.cz-modal textarea').fill(JSON.stringify({schemaVersion: 1, kind: 'botmux-customization-bundle', scope: 'wecom', promptOverrides: {zh: {'wecom.task.channel_group': 'WECOM_BUNDLE_CHANNEL'}}}));
      await page.locator('.cz-modal button', {hasText: '预览差异'}).click();
      await page.locator('.cz-diff').waitFor();
      // The platform switch sits under the dialog's mask; a keyboard user can still reach it.
      await scopeTab(page, '飞书').focus();
      await page.keyboard.press('Enter');
      await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).waitFor();
      expect(await page.locator('.cz-modal').count()).toBe(0);
      expect(calls.filter(call => call.path.startsWith('/api/customization/import')).map(call => call.path)).toEqual(['/api/customization/import?scope=wecom']);
      expect(stateOf('customizations').promptOverrides).toEqual({zh: {'ai.routing.intro': 'FEISHU_KEEP_ME'}});
    } finally {
      await page.close();
    }
  });

  it('keeps a save made while an older reload of the same platform is still on its way', async () => {
    let slowWecomReads = false;
    const {page} = await openPage(1440, {lark: 1, wecom: 1}, {
      delay: (method, url) => (slowWecomReads && method === 'GET' && url.searchParams.get('scope') === 'wecom' ? 1500 : 0),
    });
    try {
      await toWecom(page);
      await toFeishu(page);
      slowWecomReads = true;
      await toWecom(page); // the cached WeCom set shows at once; its reload is in flight
      const line = row(page, 'wecom.task.channel_private');
      await line.locator('.cz-frag-text').click();
      await line.locator('textarea').fill('SAVED_DURING_RELOAD');
      await line.locator('button', {hasText: '保存'}).click();
      await line.locator('.cz-chip-mod').waitFor();
      await page.waitForTimeout(2000); // the older reload lands
      expect(await line.locator('.cz-chip-mod').count()).toBe(1);
      expect((await line.locator('.cz-frag-text').textContent())?.replace('✎', '')).toBe('SAVED_DURING_RELOAD');
    } finally {
      await page.close();
    }
  });

  it('shows a failed WeCom load on the WeCom tab only', async () => {
    const {page} = await openPage(1440, {lark: 1, wecom: 1}, {
      delay: (method, url) => (method === 'GET' && url.searchParams.get('scope') === 'wecom' ? 800 : 0),
      fail: (method, url) => method === 'GET' && url.searchParams.get('scope') === 'wecom',
    });
    try {
      await scopeTab(page, '企业微信').click();
      await scopeTab(page, '飞书').click();
      await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).waitFor();
      await page.waitForTimeout(1200);
      expect(await page.locator('.cz-error').count()).toBe(0);
      await scopeTab(page, '企业微信').click();
      await page.locator('.cz-error').waitFor();
    } finally {
      await page.close();
    }
  });

  it('never shows the built-in Skill section under the WeCom tab, even after the roster flips back', async () => {
    const {page} = await openPage(1440, {lark: 1, wecom: 1});
    try {
      await toWecom(page);
      await publishRoster(page, 0);
      await page.locator('.cz-stage-tab', {hasText: '内置 Skill'}).click();
      await page.locator('h2', {hasText: '内置 Skill 覆盖'}).waitFor();
      await publishRoster(page, 1);
      await page.locator('.cz-scope-note').waitFor();
      expect(await page.locator('h2', {hasText: '内置 Skill 覆盖'}).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('lands a WeCom save that finishes after switching to Feishu in the WeCom view only', async () => {
    const {page} = await openPage(1440, {lark: 1, wecom: 1}, {
      delay: (method, url) => (method === 'PUT' && url.searchParams.get('scope') === 'wecom' ? 1000 : 0),
    });
    try {
      await toWecom(page);
      const line = row(page, 'wecom.task.channel_private');
      await line.locator('.cz-frag-text').click();
      await line.locator('textarea').fill('IN_FLIGHT_SAVE');
      await line.locator('button', {hasText: '保存'}).click();
      await toFeishu(page);
      await page.waitForTimeout(1500);
      expect(await page.locator('.cz-frag-key', {hasText: 'wecom.task'}).count()).toBe(0);
      expect(await page.locator('.cz-chip-mod').count()).toBe(0);
      await toWecom(page);
      await expect.poll(() => row(page, 'wecom.task.channel_private').locator('.cz-chip-mod').count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
