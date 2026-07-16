import { app, session, shell, type BrowserWindow, type Tray } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoStartCliRuntimeOnLaunch } from './main/auto-start.js';
import { discoverExternalRuntimeCandidate } from './main/external-runtime.js';
import { createRuntimeStateMonitor, registerDesktopIpc } from './main/ipc.js';
import { resolveDesktopPaths } from './main/paths.js';
import { listPm2Apps } from './main/pm2-apps.js';
import { createRuntimeService } from './main/runtime-service.js';
import { createDesktopTray } from './main/tray.js';
import { createMainWindow } from './main/window.js';
import { normalizeBotmuxVersion, resolveEffectiveBotmuxVersion } from '../utils/version-info.js';

let quitting = false;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

configureDesktopCommandLine();

app.on('before-quit', () => {
  quitting = true;
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void bootstrap().catch(error => {
    console.error('[desktop] bootstrap failed', error);
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  configureDesktopSessionPermissions();

  const desktopDir = __dirname;
  const paths = resolveDesktopPaths({
    homeDir: homedir(),
    userDataDir: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    devRepoRoot: process.cwd(),
  });
  const appVersion = resolveDesktopAppVersion(app.getVersion());
  const runtime = createRuntimeService({
    paths,
    appVersion,
    execPath: process.execPath,
    env: process.env,
    fs: { existsSync, readFileSync },
    // Re-scan the user's global CLI on every status/action path so an in-place
    // `botmux upgrade` is detected without requiring the desktop app to restart.
    discoverExternalRuntime: () => discoverExternalRuntimeCandidate(paths),
    pm2Apps: async selectedRuntime => listPm2Apps(paths, selectedRuntime),
  });

  const win = createMainWindow(join(desktopDir, 'preload.cjs'), join(desktopDir, 'renderer'));
  mainWindow = win;
  const monitor = createRuntimeStateMonitor({
    runtime,
    sendState: state => {
      if (!win.isDestroyed()) win.webContents.send('desktop:state-changed', state);
    },
  });
  registerDesktopIpc({ paths, runtime, monitor });
  monitor.start();
  void autoStartCliRuntimeOnLaunch({
    runtime,
    monitor,
    warn: message => console.warn(`[desktop] ${message}`),
  });
  win.on('close', event => {
    // Closing the window should not stop the supervised daemon; explicit Quit
    // exits the shell, explicit Stop controls the runtime.
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  tray = createDesktopTray({
    window: win,
    onStart: () => {
      void runtime.start();
    },
    onStop: () => {
      void runtime.stop();
    },
    onRestart: () => {
      void runtime.restart();
    },
    onOpenLogs: () => {
      void shell.openPath(paths.logsDir);
    },
    onOpenHome: () => {
      void shell.openPath(paths.botmuxHome);
    },
  });
}

function configureDesktopCommandLine(): void {
  // Botmux Desktop embeds a local dashboard and never captures screen contents.
  // Disable Chromium's macOS capture picker features so Electron cannot fall
  // through to a system Screen Recording permission prompt on startup.
  app.commandLine.appendSwitch('disable-features', [
    'ScreenCaptureKitPickerScreen',
    'ScreenCaptureKitStreamPickerSonoma',
  ].join(','));
}

function configureDesktopSessionPermissions(): void {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler((_webContents, permission) => {
    return isAllowedDesktopPermission(permission);
  });
  desktopSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedDesktopPermission(permission));
  });
  desktopSession.setDevicePermissionHandler(() => false);
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  }, { useSystemPicker: false });
}

function isAllowedDesktopPermission(permission: string): boolean {
  // Keep same-origin clipboard writes for the shell's "copy logs" affordance.
  // Everything else is denied locally instead of escalating to macOS privacy
  // prompts such as camera, microphone, screen capture, Bluetooth, or devices.
  return permission === 'clipboard-sanitized-write';
}

function resolveDesktopAppVersion(rawVersion: string): string {
  const normalized = normalizeBotmuxVersion(rawVersion);
  if (normalized && normalized !== '0.0.0') return normalized;

  const plistVersion = readBundleShortVersion();
  if (plistVersion && plistVersion !== '0.0.0') return plistVersion;

  // Dev runs and source-built apps can have package.json stamped as 0.0.0.
  // Falling back to git describe keeps the shell version aligned with CLI UI.
  return resolveEffectiveBotmuxVersion({
    rawVersion,
    rootDir: app.isPackaged ? process.resourcesPath : process.cwd(),
  });
}

function readBundleShortVersion(): string | null {
  if (!app.isPackaged) return null;
  try {
    const plist = readFileSync(join(process.resourcesPath, '..', 'Info.plist'), 'utf-8');
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return normalizeBotmuxVersion(match?.[1]);
  } catch {
    return null;
  }
}
