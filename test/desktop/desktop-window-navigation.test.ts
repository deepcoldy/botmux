import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type WindowModule = typeof import('../../src/desktop/main/window.js');

let desktopShellSidebarWidth: WindowModule['desktopShellSidebarWidth'];
let desktopWindowInitialWidth: WindowModule['desktopWindowInitialWidth'];
let desktopWindowMinWidth: WindowModule['desktopWindowMinWidth'];
let desktopWindowPreferredWidth: WindowModule['desktopWindowPreferredWidth'];
let shouldBlockTopLevelNavigation: WindowModule['shouldBlockTopLevelNavigation'];
let shouldOpenGuestNavigationExternally: WindowModule['shouldOpenGuestNavigationExternally'];
let shouldOpenUrlExternally: WindowModule['shouldOpenUrlExternally'];

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) },
  shell: { openExternal: vi.fn() },
}));

beforeAll(async () => {
  // Import after the Electron mock so these pure navigation guards do not depend
  // on a downloaded Electron binary in unit-test environments.
  const mod = await import('../../src/desktop/main/window.js');
  desktopShellSidebarWidth = mod.desktopShellSidebarWidth;
  desktopWindowInitialWidth = mod.desktopWindowInitialWidth;
  desktopWindowMinWidth = mod.desktopWindowMinWidth;
  desktopWindowPreferredWidth = mod.desktopWindowPreferredWidth;
  shouldBlockTopLevelNavigation = mod.shouldBlockTopLevelNavigation;
  shouldOpenGuestNavigationExternally = mod.shouldOpenGuestNavigationExternally;
  shouldOpenUrlExternally = mod.shouldOpenUrlExternally;
});

describe('desktop window navigation guard', () => {
  const rendererUrl = new URL('file:///Applications/Botmux.app/Contents/Resources/app.asar/dist/desktop/renderer/index.html');

  it('reserves native shell width for the embedded dashboard viewport', () => {
    // The Desktop app wraps the browser dashboard with its own rail. If the
    // BrowserWindow keeps the old dashboard-only width, table-heavy pages open
    // in a cramped viewport.
    expect(desktopWindowPreferredWidth - desktopShellSidebarWidth).toBe(1320);
    expect(desktopWindowMinWidth - desktopShellSidebarWidth).toBe(980);
    expect(desktopWindowInitialWidth(2560)).toBe(desktopWindowPreferredWidth);
    expect(desktopWindowInitialWidth(1440)).toBe(1392);
    expect(desktopWindowInitialWidth(1200)).toBe(desktopWindowMinWidth);
  });

  it('keeps renderer minimum width aligned with the native window minimum', () => {
    const styleSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url)),
      'utf-8',
    );
    const sidebarWidth = Number(/--sidebar-width:\s*(\d+)px;/.exec(styleSource)?.[1] ?? NaN);
    const shellMinWidth = Number(/min-width:\s*(\d+)px;/.exec(styleSource)?.[1] ?? NaN);

    expect(sidebarWidth).toBe(desktopShellSidebarWidth);
    expect(shellMinWidth).toBe(desktopWindowMinWidth);
  });

  it('allows embedded dashboard navigation while blocking top-level escapes', () => {
    // Embedded dashboard guests need to load the local HTTP dashboard; blocking
    // non-main-frame navigation leaves the right-hand console area blank.
    expect(shouldBlockTopLevelNavigation({
      url: 'http://127.0.0.1:7891/?t=token',
      isMainFrame: false,
      rendererUrl,
    })).toBe(false);

    expect(shouldBlockTopLevelNavigation({
      url: 'https://example.com/',
      isMainFrame: true,
      rendererUrl,
    })).toBe(true);

    expect(shouldBlockTopLevelNavigation({
      url: rendererUrl.toString(),
      isMainFrame: true,
      rendererUrl,
    })).toBe(false);
  });

  it('routes dashboard popup URLs to the system browser only for http links', () => {
    expect(shouldOpenUrlExternally('http://127.0.0.1:7891/s/sess_term')).toBe(true);
    expect(shouldOpenUrlExternally('https://example.com/changelog')).toBe(true);
    expect(shouldOpenUrlExternally('about:blank')).toBe(false);
    expect(shouldOpenUrlExternally('javascript:alert(1)')).toBe(false);
    expect(shouldOpenUrlExternally('file:///tmp/token.txt')).toBe(false);
  });

  it('keeps dashboard guest navigation internal while handing external origins to the browser', () => {
    const dashboardUrl = 'http://127.0.0.1:7891/#/sessions?shell=desktop';

    // The webview starts at about:blank; the first dashboard HTTP load must not
    // be mistaken for an external link.
    expect(shouldOpenGuestNavigationExternally('http://127.0.0.1:7891/#/', 'about:blank')).toBe(false);

    expect(shouldOpenGuestNavigationExternally('http://127.0.0.1:7891/#/settings', dashboardUrl)).toBe(false);
    expect(shouldOpenGuestNavigationExternally('http://127.0.0.1:8800/s/sess_term', dashboardUrl)).toBe(true);
    expect(shouldOpenGuestNavigationExternally('https://applink.feishu.cn/client/chat/open', dashboardUrl)).toBe(true);
    expect(shouldOpenGuestNavigationExternally('javascript:alert(1)', dashboardUrl)).toBe(false);
  });
});
