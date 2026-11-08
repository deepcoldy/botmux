import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// All HTTP traffic is fulfilled locally, including mutations. No live Dashboard is used.
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.PLUGIN_UI_EVIDENCE || join(tmpdir(), 'botmux-plugin-ui-evidence'));
const scratch = await mkdtemp(join(tmpdir(), 'botmux-plugin-ui-'));
await mkdir(output, { recursive: true });
const bundle = join(scratch, 'page.js');
await build({
  stdin: {
    contents: 'import {renderPluginPage} from "./src/dashboard/web/plugin-page.tsx"; renderPluginPage(document.getElementById("root"));',
    resolveDir: root, loader: 'tsx',
  },
  outfile: bundle, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
});
const hostHtml = await readFile(join(root, 'src/dashboard/web/index.html'), 'utf8');
const hostStyles = await Promise.all(['style.css', 'design-tokens.css'].map(name =>
  readFile(join(root, 'dist/dashboard-web', name), 'utf8')));
const appCss = await readFile(join(root, 'dist/dashboard-web/app.css'), 'utf8');
const script = await readFile(bundle, 'utf8');
const pageCss = await readFile(join(scratch, 'page.css'), 'utf8');
const installed = [
  {
    id: 'sample-notes', packageName: '@example/plugin-notes', version: '1.2.0',
    displayName: '会议笔记', description: '整理会议记录与待办事项。',
    source: { type: 'npm' }, stateHash: 'fixture-state', dependencies: [],
    skillsCount: 1, mcpCount: 0, dashboard: [], enabledGlobal: false,
    enabledByBot: { 'fixture-bot': true },
    contributions: { skills: [{ name: 'meeting-notes' }] },
  },
  {
    id: 'sample-browser', packageName: '@example/plugin-browser', version: '2.0.0',
    displayName: '浏览器工具', description: '为 Agent 提供浏览器操作能力。',
    audience: '需要本机浏览器', source: { type: 'npm' }, stateHash: 'fixture-state',
    skillsCount: 0, mcpCount: 1, dashboard: [], enabledGlobal: true,
    enabledByBot: { 'fixture-bot': true }, contributions: {},
  },
];
const catalog = [{
  id: 'sample-search', package: '@example/plugin-search', displayName: 'Search Tools',
  description: '搜索与检索工具。', repo: 'https://example.com/search',
  categories: ['search'], compatibility: { botmux: '>=3.56.0' },
}];
const payload = {
  plugins: installed, globalPlugins: ['sample-browser'],
  bots: [{ id: 'fixture-bot', name: 'Demo Agent', cliId: 'codex', plugins: ['sample-notes'] }],
  gatewayAdapters: [],
};
const writes = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/') return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="botmux-csrf" content="fixture"></head><body><main id="root"></main></body></html>',
    });
    if (path === '/page.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (path === '/api/plugins') return route.fulfill({ json: payload });
    if (path === '/api/plugins/market') return route.fulfill({ json: { items: catalog, stale: false, available: true } });
    if (path === '/api/plugins/market/prepare') {
      return route.fulfill({ json: { plan: {
        nonce: 'fixture-nonce', id: 'sample-search', packageName: '@example/plugin-search',
        version: '1.0.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        expiresAt: Date.now() + 60000,
      } } });
    }
    if (path === '/api/plugins/market/install') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: '测试安装已拒绝' } });
    }
    if (path === '/api/plugins/market/refresh') return route.fulfill({ json: { items: catalog, stale: false, available: true } });
    throw new Error(`Unexpected request: ${route.request().method()} ${path}`);
  });
  await page.goto('http://plugin-ui.test/#/plugins');
  await page.evaluate(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const style of parsed.querySelectorAll('style')) document.head.append(style.cloneNode(true));
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.skin = 'default';
  }, hostHtml);
  for (const content of hostStyles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: appCss });
  await page.addStyleTag({ content: pageCss });
  await page.addStyleTag({ content: 'body{display:block;height:auto;min-height:100vh}#root{max-width:1160px;margin:0 auto;padding:24px} @media(max-width:600px){#root{padding:12px}}' });
  await page.addScriptTag({ url: '/page.js', type: 'module' });
  const center = page.locator('[data-native-plugin-center]');
  await expect(center).toBeVisible();
  await expect(center.locator('[data-plugin-card]')).toHaveCount(2);
  const bounds = async () => {
    const size = await center.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(size.scroll <= size.width + 2, JSON.stringify(size));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  };
  const shot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await bounds();
    assert.ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()));
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' });
  };
  await shot('installed-dark');
  await center.getByRole('searchbox').fill('no-match');
  await expect(center.locator('[data-plugin-card]')).toHaveCount(0);
  await center.getByRole('searchbox').fill('');
  await center.locator('[data-plugin-card="sample-notes"]').getByRole('button', { name: '管理', exact: true }).click();
  const manage = page.getByRole('dialog');
  await expect(manage).toBeVisible();
  const advanced = manage.locator('details');
  await expect(advanced).not.toHaveAttribute('open', '');
  await shot('manage-dark');
  await page.keyboard.press('Escape');
  await expect(manage).not.toBeVisible();
  await center.getByRole('tab', { name: '发现', exact: true }).click();
  await expect(center.locator('[data-market-plugin]')).toHaveCount(1);
  await shot('discover-dark');
  await center.getByRole('button', { name: '查看详情' }).click();
  await page.getByRole('button', { name: '安装插件', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认安装', exact: true });
  await expect(confirmation).toBeVisible();
  await shot('install-confirm');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(writes.length, 0);
  await page.keyboard.press('Escape');
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await shot(`discover-${width}`);
    await center.getByRole('tab', { name: /^已安装/ }).click();
    await shot(`installed-${width}`);
    await center.getByRole('tab', { name: '发现', exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await center.getByRole('tab', { name: /^已安装/ }).click();
  await shot('installed-light');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output, screenshots: 9, actualMutations: writes.length }));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
