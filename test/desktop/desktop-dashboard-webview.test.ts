import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isWebTerminalDashboardHash } from '../../src/dashboard/web/client-shell.js';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, (...args: any[]) => unknown>>(),
  invoke: vi.fn(),
  handled: new Map<string, (...args: any[]) => unknown>(),
  openExternal: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeBrowserWindow {
    webContents = Object.assign(new Emitter(), { setWindowOpenHandler: vi.fn() });
    constructor(readonly options: Record<string, any>) {}
    loadFile = vi.fn(() => Promise.resolve());
  }
  return {
    app: { getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })), setLoginItemSettings: vi.fn() },
    BrowserWindow: FakeBrowserWindow,
    contextBridge: { exposeInMainWorld: vi.fn((key: string, api: any) => electron.exposed.set(key, api)) },
    ipcMain: { handle: vi.fn((channel: string, fn: any) => electron.handled.set(channel, fn)) },
    ipcRenderer: { invoke: electron.invoke, on: vi.fn(), off: vi.fn() },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openExternal: electron.openExternal, openPath: vi.fn() },
  };
});

function guestWebContents(url: string) {
  return Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), getURL: () => url });
}

describe('desktop dashboard embed', () => {
  beforeEach(() => {
    electron.openExternal.mockClear();
    electron.invoke.mockClear();
  });

  // 源码结构护栏(K4)：桌面壳侧边栏（静态 index.html）必须镜像浏览器 Dashboard 的 NAV_ITEMS
  // （app.tsx 内未导出的入口模块常量）；两边都是不可 import 的入口脚本，只能读文本对齐。
  // 守的是「Dashboard 新增页面后桌面端漏加入口」。
  it('mirrors the browser dashboard navigation routes', () => {
    const dashboardSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );
    const desktopHtml = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const nav = /<nav class="sidebar-nav"[\s\S]*?<\/nav>/.exec(desktopHtml)?.[0] ?? '';
    const sidebarRoutes = [...nav.matchAll(/\bdata-route="([^"]+)"/g)].map(match => match[1]);
    const navItems = /const NAV_ITEMS: NavItem\[] = \[([\s\S]*?)\];/.exec(dashboardSource)?.[1] ?? '';
    const dashboardRoutes = [...navItems.matchAll(/\bid: '([^']+)'/g)].map(match => match[1]);

    expect(dashboardRoutes.length).toBeGreaterThan(0);
    // Web-terminal surfaces (the host Terminal page) belong to the native client:
    // the embedded dashboard redirects them to #/sessions, so the desktop sidebar
    // deliberately leaves them out.
    expect(sidebarRoutes).toEqual(dashboardRoutes.filter(id => !isWebTerminalDashboardHash(`#/${id}`)));
  });

  it('isolates the embedded dashboard guest from Electron, Node, and the shell preload', async () => {
    const { createMainWindow } = await import('../../src/desktop/main/window.js');
    const win = createMainWindow('/app/preload.js', '/app/renderer') as any;
    expect(win.options.webPreferences).toMatchObject({
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: '/app/preload.js',
    });

    const guestPreferences: Record<string, unknown> = {
      preload: '/app/preload.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    win.webContents.emit('will-attach-webview', {}, guestPreferences);
    expect(guestPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  });

  it('hands guest popups and cross-origin navigations to the system browser', async () => {
    const { createMainWindow } = await import('../../src/desktop/main/window.js');
    const win = createMainWindow('/app/preload.js', '/app/renderer') as any;
    const guest = guestWebContents('http://127.0.0.1:7891/#/sessions?shell=desktop');
    win.webContents.emit('did-attach-webview', {}, guest);

    // target=_blank terminal links: never an Electron child window, http(s) only.
    const openHandler = guest.setWindowOpenHandler.mock.calls.at(-1)?.[0];
    expect(openHandler?.({ url: 'http://127.0.0.1:8800/s/sess_term' })).toEqual({ action: 'deny' });
    expect(electron.openExternal).toHaveBeenCalledWith('http://127.0.0.1:8800/s/sess_term');
    electron.openExternal.mockClear();
    expect(openHandler?.({ url: 'file:///tmp/token.txt' })).toEqual({ action: 'deny' });
    expect(electron.openExternal).not.toHaveBeenCalled();

    const crossOrigin = { preventDefault: vi.fn() };
    guest.emit('will-navigate', crossOrigin, 'https://applink.feishu.cn/client/chat/open');
    expect(crossOrigin.preventDefault).toHaveBeenCalled();
    expect(electron.openExternal).toHaveBeenCalledWith('https://applink.feishu.cn/client/chat/open');

    const sameOrigin = { preventDefault: vi.fn() };
    guest.emit('will-navigate', sameOrigin, 'http://127.0.0.1:7891/#/settings');
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
  });

  it('routes every preload bridge call to a channel the main process handles', async () => {
    await import('../../src/desktop/preload.js');
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    registerDesktopIpc({
      paths: { botmuxHome: '/tmp/botmux', dataDir: '/tmp/botmux/data', logsDir: '/tmp/botmux/logs' } as any,
      runtime: {} as any,
    });
    const api = electron.exposed.get('botmuxDesktop') ?? {};
    // Legacy renderers still call takeover; structured locate replaced URL lookup
    // but both stay reachable.
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['takeover', 'locateDashboard', 'getDashboardUrl']));

    for (const [name, call] of Object.entries(api)) {
      if (name === 'onStateChanged') continue;
      electron.invoke.mockClear();
      call('arg');
      const channel = electron.invoke.mock.calls[0]?.[0];
      expect(electron.handled.has(channel), `${name} -> ${channel}`).toBe(true);
    }
  });
});
