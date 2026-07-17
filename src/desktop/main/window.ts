import { BrowserWindow, screen, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const desktopShellSidebarWidth = 250;
export const desktopDashboardPreferredContentWidth = 1320;
export const desktopDashboardMinContentWidth = 980;
export const desktopWindowPreferredWidth = desktopDashboardPreferredContentWidth + desktopShellSidebarWidth;
export const desktopWindowMinWidth = desktopDashboardMinContentWidth + desktopShellSidebarWidth;
const desktopWindowScreenMargin = 48;

export function desktopWindowInitialWidth(
  workAreaWidth = screen.getPrimaryDisplay().workAreaSize.width,
): number {
  // The desktop shell adds a native rail around the browser dashboard; reserve
  // that rail so the embedded pages do not start in their narrow layout.
  return Math.max(
    desktopWindowMinWidth,
    Math.min(desktopWindowPreferredWidth, workAreaWidth - desktopWindowScreenMargin),
  );
}

export function createMainWindow(preloadPath: string, rendererDir: string): BrowserWindow {
  const rendererPath = join(rendererDir, 'index.html');
  const rendererUrl = pathToFileURL(rendererPath);
  const win = new BrowserWindow({
    width: desktopWindowInitialWidth(),
    height: 860,
    minWidth: desktopWindowMinWidth,
    minHeight: 680,
    title: 'Botmux',
    webPreferences: {
      // Renderer code is browser-only; privileged APIs stay behind preload IPC.
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  win.webContents.on('will-attach-webview', (event, webPreferences) => {
    // The dashboard runs in a guest WebContents; keep it isolated from Electron
    // and Node even though the shell itself owns privileged IPC through preload.
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
  });

  configureExternalOpenHandler(win.webContents);
  win.webContents.on('did-attach-webview', (_event, webContents) => {
    // target=_blank links live inside the dashboard guest, not the shell page;
    // hook the guest too so terminal/changelog/group links leave Electron safely.
    configureExternalOpenHandler(webContents);
    webContents.on('will-navigate', (event, url) => {
      if (!shouldOpenGuestNavigationExternally(url, webContents.getURL())) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
  });
  win.webContents.on('will-frame-navigate', event => {
    if (shouldBlockTopLevelNavigation({
      url: event.url,
      isMainFrame: event.isMainFrame,
      rendererUrl,
    })) {
      event.preventDefault();
    }
  });
  void win.loadFile(rendererPath).catch(error => {
    console.error('[desktop] failed to load renderer', error);
  });

  return win;
}

function configureExternalOpenHandler(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    // Let dashboard links open in the user's browser, never in a privileged
    // Electron child window.
    if (shouldOpenUrlExternally(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function shouldOpenUrlExternally(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function shouldOpenGuestNavigationExternally(url: string, currentUrl: string): boolean {
  try {
    const parsed = new URL(url);
    const current = new URL(currentUrl);
    // Let the dashboard's initial load and same-origin hash/path changes stay in
    // the webview; terminal panes and Feishu/browser links use another origin.
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return false;
    return shouldOpenUrlExternally(url) && parsed.origin !== current.origin;
  } catch {
    return false;
  }
}

export function shouldBlockTopLevelNavigation(input: {
  url: string;
  isMainFrame: boolean;
  rendererUrl: URL;
}): boolean {
  // Dashboard guest views are allowed to reach the local HTTP dashboard; the
  // guard only keeps the privileged desktop shell itself on the bundled file.
  return input.isMainFrame && !isRendererUrl(input.url, input.rendererUrl);
}

function isRendererUrl(url: string, rendererUrl: URL): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && parsed.pathname === rendererUrl.pathname;
  } catch {
    return false;
  }
}
