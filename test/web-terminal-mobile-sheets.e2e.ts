import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

// 手机 Web 终端的复制面板、快捷指令面板和键盘开关：真 worker + 真浏览器。
// 假 CLI 把收到的每一段输入回显成 [IN "..."]，测试从终端缓冲区里读回来核对。

const LONG_LINE = `${'wrapped-'.repeat(12)}END`;

function waitForReady(
  child: ChildProcess,
  logs: string[],
): Promise<Extract<WorkerToDaemon, { type: 'ready' }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`worker ready timeout\n${logs.join('')}`));
    }, 15_000);
    child.on('message', raw => {
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

describe('手机 Web 终端：复制面板、快捷指令与键盘开关', () => {
  let root = '';
  let dataDir = '';
  let url = '';
  let viewUrl = '';
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;

  async function openPage(): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const w = window as unknown as { term?: { rows: number }; wsHasWrite?: boolean | null };
      return Boolean(document.querySelector('.xterm-screen') && w.term && w.term.rows > 0 && w.wsHasWrite === true);
    });
    for (let i = 0; i < 100 && !(await terminalText()).includes('PROMPT>'); i++) await page.waitForTimeout(100);
  }

  function terminalText(): Promise<string> {
    return page.evaluate(() => {
      const term = (window as unknown as { term: { buffer: { active: {
        length: number;
        getLine(y: number): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined;
      } } } }).term;
      const buffer = term.buffer.active;
      const out: string[] = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true);
        else out.push(line.translateToString(true));
      }
      return out.join('\n');
    });
  }

  async function expectInput(data: string): Promise<void> {
    await expect.poll(() => terminalText(), { timeout: 5_000 }).toContain(`[IN ${JSON.stringify(data)}]`);
  }
  async function inputCount(data: string): Promise<number> {
    return (await terminalText()).split(`[IN ${JSON.stringify(data)}]`).length - 1;
  }

  const activeId = () => page.evaluate(() => document.activeElement?.id ?? '');
  const sheetOpen = () => page.evaluate(() => Boolean(document.querySelector('#wb-sheet.in')));

  const settingsPath = () => join(dataDir, 'web-terminal-settings.json');
  function savedLabels(): string[] {
    if (!existsSync(settingsPath())) return [];
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      quickCommands?: Record<string, { default?: Array<{ label: string }> }>;
    };
    return (saved.quickCommands?.app_mobile_sheets?.default ?? []).map(cmd => cmd.label);
  }
  function writeQuickCommands(commands: Array<{ label: string; send: string }>): void {
    writeFileSync(settingsPath(), JSON.stringify({ quickCommands: { app_mobile_sheets: { default: commands } } }));
  }
  async function watchToasts(target: Page): Promise<() => Promise<string[]>> {
    await target.evaluate(() => {
      const w = window as unknown as { toastLog: string[] };
      w.toastLog = [];
      new MutationObserver(() => {
        const toast = document.getElementById('wb-toast');
        const text = toast?.classList.contains('show') ? toast.textContent ?? '' : '';
        if (text && w.toastLog[w.toastLog.length - 1] !== text) w.toastLog.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    return () => target.evaluate(() => (window as unknown as { toastLog: string[] }).toastLog);
  }

  // 用可视区变矮来模拟软键盘，键盘的高度由页面自己的逻辑算出来。
  async function setSoftKeyboard(height: number): Promise<void> {
    await page.evaluate((k) => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - k });
      vv.dispatchEvent(new Event('resize'));
    }, height);
    await page.waitForTimeout(400);
  }

  async function closeSheet(): Promise<void> {
    await page.tap('#wb-sheet-close');
    await expect.poll(sheetOpen).toBe(false);
    await page.waitForTimeout(350);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-mobile-sheets-'));
    dataDir = join(root, 'session');
    const configDir = join(root, '.botmux');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.dashboard-secret'), 'mobile-sheets-secret', { mode: 0o600 });

    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
for (let i = 1; i <= 60; i++) process.stdout.write('terminal line ' + i + '\\r\\n');
process.stdout.write(${JSON.stringify(LONG_LINE)} + '\\r\\n');
process.stdout.write('PROMPT> ');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', d => process.stdout.write('\\r\\n[IN ' + JSON.stringify(String(d)) + ']\\r\\nPROMPT> '));
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const logs: string[] = [];
    const sessionId = `mobile-sheets-${Date.now()}`;
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: join(root, 'control.ndjson'),
        LARK_APP_ID: 'app_mobile_sheets',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_mobile_sheets',
      rootMessageId: 'om_mobile_sheets',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_mobile_sheets',
      larkAppSecret: 'secret',
    };
    child.send(init);
    const ready = await waitForReady(child, logs);
    url = `http://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`;
    viewUrl = `http://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(ready.viewToken ?? '')}`;

    const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
      .find(existsSync);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BOTMUX_TEST_BROWSER_EXECUTABLE || systemChromium,
      args: ['--no-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    page = await context.newPage();
    await openPage();
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('点终端不弹键盘；键盘按钮开关键盘，按键行不改变键盘状态', async () => {
    // xterm 自己的隐藏输入框在触屏上不唤起软键盘。
    expect(await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.getAttribute('inputmode'))).toBe('none');

    await page.tap('#terminal', { position: { x: 180, y: 200 } });
    expect(await activeId()).not.toBe('mobile-input');

    await page.tap('#mobile-kbd');
    expect(await activeId()).toBe('mobile-input');
    expect(await page.getAttribute('#mobile-kbd', 'aria-pressed')).toBe('true');

    await page.tap('[data-sk="esc"]');
    await expectInput('\x1b');
    expect(await activeId()).toBe('mobile-input');

    await page.tap('#terminal', { position: { x: 180, y: 200 } });
    expect(await activeId()).not.toBe('mobile-input');
    expect(await page.getAttribute('#mobile-kbd', 'aria-pressed')).toBe('false');

    await page.tap('[data-sk="esc"]');
    expect(await activeId()).not.toBe('mobile-input');
  });

  it('复制键打开复制面板：折行拼回一行，复制全部后写进剪贴板并关闭', async () => {
    await page.tap('[data-sk="copy"]');
    await expect.poll(sheetOpen).toBe(true);
    const text = await page.textContent('#wb-copy-text');
    expect(text).toContain('terminal line 1\n');
    expect(text).toContain(LONG_LINE);
    expect(text).toContain('PROMPT>');

    await page.tap('#wb-sheet-foot .wb-btn.primary');
    await expect.poll(sheetOpen).toBe(false);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('terminal line 60');
    expect(clip).toContain(LONG_LINE);
    await page.waitForTimeout(350);
  });

  it('复制面板里选中一段文字后只复制选中的部分', async () => {
    await page.tap('[data-sk="copy"]');
    await expect.poll(sheetOpen).toBe(true);
    const copySelected = page.locator('#wb-sheet-foot .wb-btn:not(.primary)');
    expect(await copySelected.isDisabled()).toBe(true);

    await page.evaluate(() => {
      const pre = document.getElementById('wb-copy-text')!;
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf('terminal line 42');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 'terminal line 42'.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    });
    await expect.poll(() => copySelected.isDisabled()).toBe(false);
    await copySelected.tap();
    await expect.poll(sheetOpen).toBe(false);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('terminal line 42');
    await page.waitForTimeout(350);
  });

  it('长按终端打开复制面板，并定位到按住的那一行', async () => {
    const point = await page.evaluate(() => {
      const rect = document.querySelector('.xterm-screen')!.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const expectedRow = await page.evaluate(y => {
      const term = (window as unknown as { term: { rows: number; buffer: { active: {
        viewportY: number;
        getLine(row: number): { translateToString(trim: boolean): string } | undefined;
      } } } }).term;
      const rect = document.querySelector('.xterm-screen')!.getBoundingClientRect();
      const row = Math.floor((y - rect.top) / (rect.height / term.rows));
      return term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? '';
    }, point.y);

    const cdp = await context!.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(sheetOpen).toBe(true);
    const anchor = await page.textContent('#wb-copy-text span.anchor');
    expect(expectedRow).not.toBe('');
    expect(anchor).toContain(expectedRow);
    await closeSheet();
  });

  it('快捷指令面板垫在底栏上方：滑入时也不盖住「指令」按钮，再点一次就收起', async () => {
    const cmds = await page.evaluate(() => {
      const r = document.getElementById('mobile-cmds')!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    // 逐帧看按钮中心那个点落在谁身上：只能是遮罩，不能是面板里的指令卡片。
    const hits = await page.evaluate(async ({ x, y }) => {
      document.getElementById('mobile-cmds')!.click();
      const seen: string[] = [];
      const start = performance.now();
      while (performance.now() - start < 450) {
        await new Promise(requestAnimationFrame);
        const el = document.elementFromPoint(x, y);
        seen.push(el?.closest('#wb-sheet') ? 'sheet' : el?.id ?? '');
      }
      return seen;
    }, cmds);
    expect(hits.length).toBeGreaterThan(5);
    expect(hits).not.toContain('sheet');
    expect(hits[hits.length - 1]).toBe('wb-sheet-scrim');
    const geometry = await page.evaluate(() => ({
      sheetBottom: document.getElementById('wb-sheet')!.getBoundingClientRect().bottom,
      barTop: document.getElementById('mobile-input-bar')!.getBoundingClientRect().top,
    }));
    expect(geometry.sheetBottom).toBeLessThanOrEqual(geometry.barTop + 0.5);

    const before = await terminalText();
    await page.touchscreen.tap(cmds.x, cmds.y);
    await expect.poll(sheetOpen).toBe(false);
    await page.waitForTimeout(350);
    expect(await terminalText()).toBe(before);
  });

  it('指令按钮打开快捷指令：默认带常用命令，点一下发送并回车', async () => {
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    const labels = await page.locator('.wb-qc .wb-qc-label').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['/rewind', '/compact', '/status', '/effort']));
    expect(await page.locator('.wb-qc .wb-qc-send').count()).toBe(0);

    await page.locator('.wb-qc', { hasText: '/status' }).tap();
    await expect.poll(sheetOpen).toBe(false);
    await expectInput('/status');
    await expectInput('\r');
    await page.waitForTimeout(350);
  });

  it('CLI 输入行里还有没提交的字时，点自动回车的指令先提醒，确认了才发', async () => {
    const lineLen = () => page.evaluate(() => (window as unknown as { _wbLineLen: number })._wbLineLen);
    expect(await lineLen()).toBe(0);
    await page.fill('#mobile-input', 'half typed');
    await page.tap('#mobile-send');
    await expectInput('half typed');
    expect(await lineLen()).toBeGreaterThan(0);

    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.locator('.wb-qc', { hasText: '/compact' }).tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('仍然发送');
    await page.waitForTimeout(300);
    expect(await sheetOpen()).toBe(true);
    expect(await terminalText()).not.toContain('[IN "/compact"]');

    await page.tap('#wb-toast button');
    await expect.poll(sheetOpen).toBe(false);
    await expectInput('/compact');
    await expect.poll(lineLen).toBe(0);
    await page.waitForTimeout(350);
    await page.tap('#terminal', { position: { x: 180, y: 200 } });
  });

  it('提醒还在时关掉面板就是不发了：确认条跟着收起，之后点到它原来的位置也不会发出去', async () => {
    const toastShown = () => page.evaluate(() => document.getElementById('wb-toast')?.classList.contains('show') ?? false);
    await page.fill('#mobile-input', 'draft');
    await page.tap('#mobile-send');
    await expectInput('draft');
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.locator('.wb-qc', { hasText: '/status' }).tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('仍然发送');
    const sentBefore = await inputCount('/status');

    await page.tap('#wb-sheet-scrim', { position: { x: 195, y: 150 } });
    await expect.poll(sheetOpen).toBe(false);
    await expect.poll(toastShown).toBe(false);
    const button = (await page.locator('#wb-toast button').boundingBox())!;
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
    await page.waitForTimeout(500);
    expect(await inputCount('/status')).toBe(sentBefore);

    // 面板还开着时确认照常有效，发完输入行归零。
    await page.waitForTimeout(350);
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.locator('.wb-qc', { hasText: '/status' }).tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('仍然发送');
    await page.tap('#wb-toast button');
    await expect.poll(() => inputCount('/status')).toBe(sentBefore + 1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { _wbLineLen: number })._wbLineLen)).toBe(0);
    await page.waitForTimeout(350);
  });

  it('终端替 CLI 自动回的颜色查询应答不算没提交的字：输入行空着时点指令直接发', async () => {
    const lineLen = () => page.evaluate(() => (window as unknown as { _wbLineLen: number })._wbLineLen);
    expect(await lineLen()).toBe(0);
    // tmux 接入时会这样查询前景、背景色，终端的回答经输入通道发给 CLI。
    await page.evaluate(() => {
      (window as unknown as { term: { write(data: string): void } }).term.write('\x1b]11;?\x1b\\\x1b]10;?\x07');
    });
    await expect.poll(() => terminalText(), { timeout: 5_000 }).toMatch(/\[IN "\\u001b\]10;rgb:/);
    expect(await lineLen()).toBe(0);
    const sentBefore = await inputCount('/status');
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.locator('.wb-qc', { hasText: '/status' }).tap();
    await expect.poll(sheetOpen).toBe(false);
    await expect.poll(() => inputCount('/status')).toBe(sentBefore + 1);
    await page.waitForTimeout(350);
  });

  it('自定义指令保存在服务端，刷新页面后仍在；恢复默认后消失', async () => {
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const inputs = page.locator('.wb-qc-form input[type="text"]');
    await inputs.nth(0).fill('git status<Enter>');
    await inputs.nth(1).fill('仓库状态');
    // 没有软键盘就不进打字模式：面板不挂位置，底部的「完成」「恢复默认」一直在。
    expect(await page.evaluate(() => document.body.classList.contains('wb-sheet-typing'))).toBe(false);
    expect(await page.locator('#wb-sheet-foot').isVisible()).toBe(true);
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(() => page.locator('.wb-qc-row-main', { hasText: '仓库状态' }).count()).toBe(1);
    await expect.poll(() => page.textContent('#wb-toast')).toContain('已添加');
    expect(savedLabels()).toContain('仓库状态');

    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    // 名字和发送内容不同时，按钮上直接显示发送内容。
    expect(await page.locator('.wb-qc', { hasText: '仓库状态' }).locator('.wb-qc-send').textContent()).toBe('git status<Enter>');
    await page.locator('.wb-qc', { hasText: '仓库状态' }).tap();
    await expectInput('git status\r');
    await page.waitForTimeout(350);

    await page.tap('#mobile-cmds');
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const reset = page.locator('#wb-sheet-foot .wb-btn.danger');
    await reset.tap();
    await reset.tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('已恢复默认');
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { quickCommands?: unknown };
    expect(saved.quickCommands).toBeUndefined();
    await page.tap('#wb-sheet-foot .wb-btn.primary');
    expect(await page.locator('.wb-qc', { hasText: '仓库状态' }).count()).toBe(0);
    await closeSheet();
  });

  it('两个页面同时改快捷指令：后保存的一方收到冲突并换成最新列表，不会冲掉对方刚存的', async () => {
    const other = await context!.newPage();
    try {
      await other.goto(url, { waitUntil: 'domcontentloaded' });
      await other.waitForFunction(() => (window as unknown as { wsHasWrite?: boolean | null }).wsHasWrite === true);
      // 另一个页面先打开编辑界面，它看到的还是默认列表。
      await other.tap('#mobile-cmds');
      await expect.poll(() => other.evaluate(() => Boolean(document.querySelector('#wb-sheet.in')))).toBe(true);
      await other.tap('#wb-sheet-actions .wb-sheet-text-btn');

      await page.tap('#mobile-cmds');
      await expect.poll(sheetOpen).toBe(true);
      await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
      await page.locator('.wb-qc-form input[type="text"]').nth(0).fill('from-page-a');
      await page.locator('.wb-qc-form button[type="submit"]').tap();
      await expect.poll(savedLabels).toContain('from-page-a');

      // 记下那边弹过的每一条提示：没保存成功就不该出现「已添加」。
      await other.evaluate(() => {
        const w = window as unknown as { toastLog: string[] };
        w.toastLog = [];
        new MutationObserver(() => {
          const toast = document.getElementById('wb-toast');
          const text = toast?.classList.contains('show') ? toast.textContent ?? '' : '';
          if (text && w.toastLog[w.toastLog.length - 1] !== text) w.toastLog.push(text);
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      const toastLog = () => other.evaluate(() => (window as unknown as { toastLog: string[] }).toastLog);
      const otherForm = other.locator('.wb-qc-form input[type="text"]').nth(0);
      await otherForm.fill('from-page-b');
      await other.locator('.wb-qc-form button[type="submit"]').tap();
      await expect.poll(() => other.textContent('#wb-toast')).toContain('别的页面改过');
      expect((await toastLog()).some(text => text.includes('已添加'))).toBe(false);
      await expect.poll(() => other.locator('.wb-qc-row-main', { hasText: 'from-page-a' }).count()).toBe(1);
      expect(savedLabels()).toContain('from-page-a');
      expect(savedLabels()).not.toContain('from-page-b');

      // 在最新列表上重做就能存上，两条都在。
      await otherForm.fill('from-page-b');
      await other.locator('.wb-qc-form button[type="submit"]').tap();
      await expect.poll(savedLabels).toEqual(expect.arrayContaining(['from-page-a', 'from-page-b']));
      await expect.poll(() => other.textContent('#wb-toast')).toContain('已添加');
    } finally {
      await other.close();
    }
    // 这边重新打开面板时会去服务端读最新列表，看得到那边刚存的。
    await closeSheet();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await expect.poll(() => page.locator('.wb-qc', { hasText: 'from-page-b' }).count()).toBe(1);
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('保存途中连接断了：马上提示没等到结果，表单内容留着，重连后再点一次就能存上', async () => {
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    // 让这次保存请求发不到服务端，再断开连接。
    await page.evaluate(() => {
      const ws = (window as unknown as { ws_: WebSocket }).ws_;
      const send = ws.send.bind(ws);
      ws.send = (data: string) => { if (!String(data).includes('quick_commands')) send(data); };
    });
    const form = page.locator('.wb-qc-form input[type="text"]').nth(0);
    await form.fill('lost-on-disconnect');
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await page.evaluate(() => (window as unknown as { ws_: WebSocket }).ws_.close());
    await expect.poll(() => page.textContent('#wb-toast'), { timeout: 3_000 }).toContain('没等到保存结果');
    expect(await form.inputValue()).toBe('lost-on-disconnect');
    expect(savedLabels()).not.toContain('lost-on-disconnect');

    await page.waitForFunction(() => {
      const w = window as unknown as { ws_?: WebSocket; wsHasWrite?: boolean | null };
      return w.wsHasWrite === true && w.ws_?.readyState === 1;
    });
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(savedLabels).toContain('lost-on-disconnect');
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('面板读取列表还没回来就关掉重开：迟到的最新列表照样刷新到正在显示的面板上', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    writeQuickCommands([{ label: 'from-elsewhere', send: '/elsewhere' }]);
    // 让打开面板时发出的读取晚 3 秒才到服务端。
    await page.evaluate(() => {
      const ws = (window as unknown as { ws_: WebSocket }).ws_;
      const send = ws.send.bind(ws);
      ws.send = (data: string) => {
        if (String(data).includes('"op":"get"')) setTimeout(() => send(data), 3_000);
        else send(data);
      };
    });
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await closeSheet();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    expect(await page.locator('.wb-qc', { hasText: 'from-elsewhere' }).count()).toBe(0);
    await expect.poll(() => page.locator('.wb-qc', { hasText: 'from-elsewhere' }).count(), { timeout: 6_000 }).toBe(1);
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('面板显示的列表过期时，从它算出的修改存不进去，哪怕页面内存里已经是新列表', async () => {
    writeQuickCommands([{ label: 'keep-a', send: '/keep-a' }, { label: 'keep-b', send: '/keep-b' }]);
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await expect.poll(() => page.locator('.wb-qc', { hasText: 'keep-b' }).count()).toBe(1);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    // 别的页面刚加了一条；本页内存里的列表跟上了，面板却没重画。
    const latest = [{ label: 'keep-a', send: '/keep-a' }, { label: 'keep-b', send: '/keep-b' }, { label: 'added-elsewhere', send: '/added' }];
    writeQuickCommands(latest);
    await page.evaluate((list) => {
      (window as unknown as { _wbQuickServer: unknown })._wbQuickServer = list;
    }, latest);
    await page.tap('[aria-label="删除 keep-a"]');
    await expect.poll(() => page.textContent('#wb-toast')).toContain('别的页面改过');
    expect(savedLabels()).toEqual(['keep-a', 'keep-b', 'added-elsewhere']);
    await expect.poll(() => page.locator('.wb-qc-row-main', { hasText: 'added-elsewhere' }).count()).toBe(1);
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('保存其实写进去了、只是应答丢了：重连后重试不报冲突，按已保存处理', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const toastLog = await watchToasts(page);
    // 服务端照常写入，但这次的应答在页面上被丢掉，然后连接断开。
    await page.evaluate(() => {
      const ws = (window as unknown as { ws_: WebSocket }).ws_;
      const onmessage = ws.onmessage!;
      ws.onmessage = function (e: MessageEvent) {
        if (typeof e.data === 'string' && e.data.includes(']1989;quick_commands;')) return;
        onmessage.call(ws, e);
      };
    });
    const form = page.locator('.wb-qc-form input[type="text"]').nth(0);
    await form.fill('ack-lost');
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(savedLabels).toContain('ack-lost');
    await page.evaluate(() => (window as unknown as { ws_: WebSocket }).ws_.close());
    await expect.poll(() => page.textContent('#wb-toast'), { timeout: 3_000 }).toContain('没等到保存结果');

    await page.waitForFunction(() => {
      const w = window as unknown as { ws_?: WebSocket; wsHasWrite?: boolean | null };
      return w.wsHasWrite === true && w.ws_?.readyState === 1;
    });
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('已添加');
    expect((await toastLog()).some(text => text.includes('别的页面改过'))).toBe(false);
    expect(savedLabels().filter(label => label === 'ack-lost')).toHaveLength(1);
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('小屏和横屏上在快捷指令表单里打字：键盘弹出后输入框和保存按钮仍看得见、点得到', async () => {
    const original = page.viewportSize()!;
    try {
      for (const [width, height, keyboard] of [[375, 548, 300], [844, 340, 170]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(400);
        await page.tap('#mobile-cmds');
        await expect.poll(sheetOpen).toBe(true);
        await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
        await page.locator('.wb-qc-form input[type="text"]').nth(0).focus();
        await setSoftKeyboard(keyboard);
        const seen = await page.evaluate(() => {
          const body = document.getElementById('wb-sheet-body')!;
          const visible = (el: Element) => {
            el.scrollIntoView({ block: 'nearest' });
            const box = el.getBoundingClientRect();
            const view = body.getBoundingClientRect();
            const top = Math.max(box.top, view.top);
            const px = Math.min(box.bottom, view.bottom, window.visualViewport!.height) - top;
            const hit = document.elementFromPoint(box.left + box.width / 2, top + Math.max(1, Math.min(4, px / 2)));
            return { px: Math.round(px), hit: !!hit && (hit === el || el.contains(hit)) };
          };
          return {
            field: visible(document.activeElement!),
            save: visible(document.querySelector('.wb-qc-form button[type="submit"]')!),
          };
        });
        expect({ width, ...seen.field }).toEqual({ width, px: expect.any(Number), hit: true });
        expect(seen.field.px).toBeGreaterThanOrEqual(30);
        expect({ width, ...seen.save }).toEqual({ width, px: expect.any(Number), hit: true });
        expect(seen.save.px).toBeGreaterThanOrEqual(30);
        // 键盘弹着直接点保存：点击要落在按钮上（发送内容是空的，会被拦下并提示），焦点留在输入框里。
        expect(await page.evaluate(() => document.body.classList.contains('wb-sheet-typing'))).toBe(true);
        await page.locator('.wb-qc-form button[type="submit"]').tap();
        await expect.poll(() => page.textContent('#wb-toast')).toContain('发送内容不能为空');
        expect(await page.evaluate(() => document.activeElement === document.querySelector('.wb-qc-form input[type="text"]'))).toBe(true);
        await setSoftKeyboard(0);
        await closeSheet();
      }
    } finally {
      await page.setViewportSize(original);
      await page.waitForTimeout(400);
    }
  });

  it('面板打开时收起键盘，关闭后按打开前的状态还原', async () => {
    await page.tap('#mobile-kbd');
    expect(await activeId()).toBe('mobile-input');
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    expect(await activeId()).not.toBe('mobile-input');
    await closeSheet();
    expect(await activeId()).toBe('mobile-input');

    await page.tap('#terminal', { position: { x: 180, y: 200 } });
    await page.tap('[data-sk="copy"]');
    await expect.poll(sheetOpen).toBe(true);
    await closeSheet();
    expect(await activeId()).not.toBe('mobile-input');
  });

  it('只读页面没有底栏，用右下角按钮打开复制面板；只读连接读不到也改不了快捷指令', async () => {
    const privateList = [{ label: '私有指令', send: 'private-cmd-7f3', enter: true, hint: '' }];
    writeFileSync(settingsPath(), JSON.stringify({
      quickCommands: {
        app_mobile_sheets: { default: privateList },
        app_other_owner: { default: [{ label: '/status', send: 'other-bot-cmd-9c1', enter: true }] },
      },
    }));
    // 可写页面只拿到自己这个 Bot 的列表。
    const writableHtml = await (await fetch(url)).text();
    expect(writableHtml).toContain('private-cmd-7f3');
    expect(writableHtml).not.toContain('other-bot-cmd-9c1');
    const viewer = await context!.newPage();
    try {
      await viewer.goto(viewUrl, { waitUntil: 'domcontentloaded' });
      await viewer.waitForFunction(() => {
        const w = window as unknown as { wsHasWrite?: boolean | null };
        return w.wsHasWrite === false && Boolean(document.querySelector('.xterm-screen'));
      });
      expect(await viewer.isVisible('#mobile-input-bar')).toBe(false);
      // 复制按钮放在终端底部让出来的那一条里，不盖住最后几行。
      const fab = await viewer.evaluate(() => ({
        fabTop: document.getElementById('copy-fab')!.getBoundingClientRect().top,
        screenBottom: document.querySelector('.xterm-screen')!.getBoundingClientRect().bottom,
      }));
      expect(fab.fabTop).toBeGreaterThanOrEqual(fab.screenBottom - 0.5);
      // 用户的自定义列表不随只读页面下发。
      expect(await viewer.evaluate(() => (window as unknown as { _wbQuickSaved: unknown })._wbQuickSaved)).toBeNull();
      expect(await viewer.content()).not.toContain('private-cmd-7f3');

      await viewer.tap('#copy-fab');
      await expect.poll(() => viewer.evaluate(() => Boolean(document.querySelector('#wb-sheet.in')))).toBe(true);
      await expect.poll(() => viewer.textContent('#wb-copy-text')).toContain('terminal line 1');

      // 绕过页面直接发请求：读取不回应答（否则就把列表泄给了只读链接），保存不生效。
      const replies = await viewer.evaluate(async base => {
        const ws = (window as unknown as { ws_: WebSocket }).ws_;
        const got: string[] = [];
        const onMessage = (e: MessageEvent) => {
          if (typeof e.data === 'string' && e.data.includes('quick_commands')) got.push(e.data);
        };
        ws.addEventListener('message', onMessage);
        const nonce = '0123456789abcdef0123456789abcdef';
        ws.send(JSON.stringify({ type: 'quick_commands', op: 'get', nonce }));
        ws.send(JSON.stringify({ type: 'quick_commands', op: 'save', nonce, base, commands: [{ send: 'rm -rf ~' }] }));
        await new Promise(resolveWait => setTimeout(resolveWait, 400));
        ws.removeEventListener('message', onMessage);
        return got;
      }, privateList);
      expect(replies).toEqual([]);
      expect(readFileSync(settingsPath(), 'utf8')).not.toContain('rm -rf');
    } finally {
      await viewer.close();
      rmSync(settingsPath(), { force: true });
    }
  });

  it('底栏仍然完整地放在终端内容下方', async () => {
    const geometry = await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
      const bar = document.getElementById('mobile-input-bar')!.getBoundingClientRect();
      const pinned = document.getElementById('mobile-bar-pinned')!.getBoundingClientRect();
      return { overlap: screen.bottom - bar.top, pinnedRight: pinned.right, width: innerWidth };
    });
    expect(geometry.overlap).toBeLessThanOrEqual(0.5);
    expect(geometry.pinnedRight).toBeLessThanOrEqual(geometry.width);
  });

  it('读取请求先超时、应答后到：迟到应答仍被认领，最新列表照样刷到面板上', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    writeQuickCommands([{ label: 'late-after-timeout', send: '/late' }]);
    // 把打开面板时的读取压到 11 秒后：页面 10 秒先超时，应答到达时请求已经不在途。
    await page.evaluate(() => {
      const ws = (window as unknown as { ws_: WebSocket }).ws_;
      const send = ws.send.bind(ws);
      ws.send = (data: string) => {
        if (String(data).includes('"op":"get"')) setTimeout(() => send(data), 11_000);
        else send(data);
      };
    });
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    // 应答到达前只有内置默认，外部写入的指令看不到。
    expect(await page.locator('.wb-qc', { hasText: 'late-after-timeout' }).count()).toBe(0);
    expect(await page.locator('.wb-qc', { hasText: '/rewind' }).count()).toBeGreaterThan(0);
    // 迟到应答靠超时前记下的 nonce 仍被认领：外部列表出现，默认列表被替换。
    await expect.poll(
      () => page.locator('.wb-qc', { hasText: 'late-after-timeout' }).count(),
      { timeout: 18_000 },
    ).toBe(1);
    expect(await page.locator('.wb-qc', { hasText: '/rewind' }).count()).toBe(0);
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('读取应答晚到触发重画时，新增表单里还没保存的内容先存草稿并回填', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    // 外部列表在打开面板之前就写好：页面内嵌列表在 openPage 时已定，仍先显示默认，
    // 晚到的读取应答带着外部列表回来，照样触发一次过期重画。写文件不依赖填表耗时，
    // 用例不会因为机器忙、填表超过读取延迟而偶发失败。
    writeQuickCommands([{ label: 'from-elsewhere', send: '/elsewhere' }]);
    await page.evaluate(() => {
      const ws = (window as unknown as { ws_: WebSocket }).ws_;
      const send = ws.send.bind(ws);
      ws.send = (data: string) => {
        if (String(data).includes('"op":"get"')) setTimeout(() => send(data), 4_000);
        else send(data);
      };
    });
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const sendInput = page.locator('.wb-qc-form input[type="text"]').nth(0);
    const labelInput = page.locator('.wb-qc-form input[type="text"]').nth(1);
    await sendInput.fill('/typed-not-saved');
    await labelInput.fill('未保存的名称');
    // 4 秒后晚到的应答带着外部列表触发过期重画。
    await expect.poll(
      () => page.locator('.wb-qc-row-main', { hasText: 'from-elsewhere' }).count(),
      { timeout: 9_000 },
    ).toBe(1);
    // 重画没清掉表单：草稿回填，用户敲了一半的内容还在。
    expect(await sendInput.inputValue()).toBe('/typed-not-saved');
    expect(await labelInput.inputValue()).toBe('未保存的名称');
    // 回填的草稿可以直接提交，和外部刚写入的条目并存。
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(savedLabels).toEqual(expect.arrayContaining(['from-elsewhere', '未保存的名称']));
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('编辑已有条目提交时撞冲突：退出编辑态，新增表单为空且不预填刚编辑的内容', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    // 等打开面板时的读取完成：此时没有保存过，页面的比对基准是内置默认（null）。
    await page.waitForFunction(() => (window as unknown as { _wbQuickReq: unknown })._wbQuickReq === null);
    // 对一条默认指令进入编辑态并改内容，提交前让服务端文件被别的页面换掉，保存必然撞冲突。
    await page.locator('.wb-qc-row-main', { hasText: '/rewind' }).tap();
    const sendInput = page.locator('.wb-qc-form input[type="text"]').nth(0);
    await expect.poll(() => sendInput.inputValue()).toBe('/rewind');
    await sendInput.fill('/edited-send');
    writeQuickCommands([{ label: 'from-elsewhere', send: '/elsewhere' }]);
    await page.locator('.wb-qc-form button[type="submit"]').tap();
    await expect.poll(() => page.textContent('#wb-toast')).toContain('别的页面改过');
    // 冲突重画发生在编辑态（editIndex>=0、草稿是刚编辑的内容）：清空草稿、退回新增态，
    // 表单为空——被编辑的那一行可能已被别的页面移位或删除，不能预填成一条待添加的重复项。
    expect(await sendInput.inputValue()).toBe('');
    expect(await page.locator('.wb-qc-form-title').textContent()).toContain('添加');
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('下移保存成功后的普通重画，保留新增表单里没提交的内容', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const sendInput = page.locator('.wb-qc-form input[type="text"]').nth(0);
    await sendInput.fill('/typed-before-move');
    // 以 DOM 行序变化确认「客户端」已完成重画（不能只轮询服务端文件，文件先于应答写入，
    // 那时页面还没重画），重画不能清掉正在新增的内容。
    await page.locator('.wb-qc-row').nth(0).locator('button[aria-label^="下移"]').tap();
    await expect.poll(() => page.locator('.wb-qc-row-main').nth(0).textContent()).toContain('/compact');
    expect(await sendInput.inputValue()).toBe('/typed-before-move');
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('删除保存成功后的普通重画，保留新增表单里没提交的内容', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const sendInput = page.locator('.wb-qc-form input[type="text"]').nth(0);
    await sendInput.fill('/typed-before-delete');
    // 独立用例：此前没有任何保存，草稿仍是空的，只有删除回调自己的保留逻辑能救下输入。
    // 以 DOM 行数减少确认客户端重画已发生。
    await page.locator('.wb-qc-row').nth(0).locator('button[aria-label^="删除"]').tap();
    await expect.poll(() => page.locator('.wb-qc-row').count()).toBe(6);
    expect(await sendInput.inputValue()).toBe('/typed-before-delete');
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });

  it('用户清空新增表单后再排序或删除，旧草稿不会被回填回来', async () => {
    rmSync(settingsPath(), { force: true });
    await openPage();
    await page.tap('#mobile-cmds');
    await expect.poll(sheetOpen).toBe(true);
    await page.tap('#wb-sheet-actions .wb-sheet-text-btn');
    const sendInput = page.locator('.wb-qc-form input[type="text"]').nth(0);
    // 先填内容并下移一次：草稿被存下、重画后回填（默认列表首行 /rewind 下移后变成 /compact）。
    await sendInput.fill('/x-draft');
    await page.locator('.wb-qc-row').nth(0).locator('button[aria-label^="下移"]').tap();
    await expect.poll(() => page.locator('.wb-qc-row-main').nth(0).textContent()).toContain('/compact');
    expect(await sendInput.inputValue()).toBe('/x-draft');
    // 用户主动清空输入框，再删除当前首行：行数 7→6，确认又一次重画已发生。
    await sendInput.fill('');
    await page.locator('.wb-qc-row').nth(0).locator('button[aria-label^="删除"]').tap();
    await expect.poll(() => page.locator('.wb-qc-row').count()).toBe(6);
    // 清空就是清空：旧草稿不能在这次重画里被填回来。
    expect(await sendInput.inputValue()).toBe('');
    await closeSheet();
    rmSync(settingsPath(), { force: true });
  });
});
