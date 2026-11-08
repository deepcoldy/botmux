/**
 * 真实 worker 进程 + 真实 Chromium：浏览器访问不了任何外部地址时，Web 终端仍能加载 xterm
 * 组件并渲染 CLI 输出。
 *
 * 复现的是线上现象：浏览器那一侧连不上公共 CDN，`xterm.js` 加载失败，`new Terminal` 抛
 * ReferenceError，终端整页空白。这里把非回环地址的请求全部拦掉，并分别用只读链接
 * （`?viewToken=`）和操作链接（`?token=`）打开——组件请求带不上页面地址里的 capability，
 * worker 必须在鉴权之前认领它们。
 *
 * 需要本机装有 Playwright 的 Chromium（`bun x playwright install chromium`）；CI 不跑 e2e 项目，
 * 手动执行：`bun x vitest run --project e2e test/web-terminal-offline-assets.e2e.ts`。
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

type Ready = Extract<WorkerToDaemon, { type: 'ready' }>;

function waitForReady(child: ChildProcess, logs: string[]): Promise<Ready> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`worker ready timeout\n${logs.join('')}`)), 15_000);
    child.on('message', (raw) => {
      const message = raw as WorkerToDaemon;
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolvePromise(message);
      } else if (message.type === 'error') {
        clearTimeout(timer);
        rejectPromise(new Error(`worker error: ${message.message}\n${logs.join('')}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`worker exited before ready (${code ?? signal})\n${logs.join('')}`));
    });
  });
}

describe('Web 终端不依赖外部 CDN', () => {
  let root = '';
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let ready: Ready;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-offline-assets-'));
    const dataDir = join(root, 'session');
    const configDir = join(root, '.botmux');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.dashboard-secret'), 'offline-assets-secret', { mode: 0o600 });

    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
process.stdout.write('offline marker line\\r\\nPROMPT> ');
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const logs: string[] = [];
    const sessionId = `offline-assets-${Date.now()}`;
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: join(root, 'control.ndjson'),
        LARK_APP_ID: 'app_offline_assets',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr?.on('data', (chunk) => logs.push(chunk.toString()));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_offline_assets',
      rootMessageId: 'om_offline_assets',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_offline_assets',
      larkAppSecret: 'secret',
    };
    child.send(init);
    ready = await waitForReady(child, logs);
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['只读链接', () => `/?viewToken=${encodeURIComponent(ready.viewToken ?? '')}`],
    ['操作链接', () => `/?token=${encodeURIComponent(ready.token)}`],
  ])('%s：外网全断时 xterm 组件从 worker 加载并渲染出 CLI 输出', async (_name, query) => {
    const page = await browser!.newPage();
    const external: string[] = [];
    const vendor: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') {
        external.push(url.href);
        return route.abort();
      }
      if (url.pathname.includes('/__botmux/vendor/')) vendor.push(url.pathname);
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${ready.port}${query()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const term = (window as unknown as { term?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).term;
      if (!term) return false;
      for (let i = 0; i < term.buffer.active.length; i++) {
        if (term.buffer.active.getLine(i)?.translateToString(true).includes('offline marker line')) return true;
      }
      return false;
    }, undefined, { timeout: 15_000 });
    const bootError = await page.evaluate(() => document.getElementById('boot-error')?.classList.contains('show'));
    await page.close();

    expect(external).toEqual([]);
    expect(vendor).toHaveLength(7);
    expect(bootError).toBe(false);
  }, 30_000);
});
