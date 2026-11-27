import { app, session, shell, type BrowserWindow, type Session, type Tray } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoStartCliRuntimeOnLaunch, shouldTakeOverExternalRuntime } from './main/auto-start.js';
import { createRuntimeStateMonitor, registerDesktopIpc } from './main/ipc.js';
import { resolveDesktopPaths } from './main/paths.js';
import { resolveBundledRuntimeCandidate } from './main/bundled-runtime.js';
import { probeShellPathEnv } from './main/external-runtime.js';
import { listFleetApps } from './main/fleet-apps.js';
import { runRuntimeAction, type RuntimeStateMonitor } from './main/runtime-actions.js';
import { createRuntimeService } from './main/runtime-service.js';
import { createDesktopTray } from './main/tray.js';
import { createMainWindow } from './main/window.js';
import {
  createDesktopHostLeaseRegistry,
  type DesktopHostLeaseRegistry,
} from '../core/desktop-host-leases.js';
import {
  createZeroBotLifecycle,
  isSupervisorOwnedByBundledRuntime,
  readLiveSupervisorSnapshot,
} from './main/zero-bot-lifecycle.js';
import { normalizeBotmuxVersion, resolveEffectiveBotmuxVersion } from '../utils/version-info.js';

const dashboardWebviewPartition = 'persist:botmux-dashboard';
let quitting = false;
let quitCleanupState: 'idle' | 'cleaning' | 'ready' = 'idle';
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let activeMonitor: RuntimeStateMonitor | null = null;
let activeHostLease: DesktopHostLeaseRegistry | null = null;
let activeZeroBotLifecycle: ReturnType<typeof createZeroBotLifecycle> | null = null;

configureDesktopCommandLine();

app.on('before-quit', event => {
  quitting = true;
  activeHostLease?.unregister();
  activeZeroBotLifecycle?.markClosing();
  if (quitCleanupState === 'ready') return;
  if (quitCleanupState === 'cleaning') {
    event.preventDefault();
    return;
  }
  if (!activeZeroBotLifecycle?.needsQuitCleanup()) {
    activeMonitor?.stop();
    quitCleanupState = 'ready';
    return;
  }
  event.preventDefault();
  quitCleanupState = 'cleaning';
  activeMonitor?.stop();
  void activeZeroBotLifecycle.cleanupOnQuit({ totalTimeoutMs: 5_000 })
    .catch(error => console.warn('[desktop] 0-bot quit cleanup failed', error))
    .finally(() => {
      quitCleanupState = 'ready';
      app.quit();
    });
});

app.on('will-quit', () => {
  activeHostLease?.unregister();
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
  const bundledRuntime = resolveBundledRuntimeCandidate({
    resourcesPath: process.resourcesPath,
    repoRoot: process.cwd(),
    isPackaged: app.isPackaged,
    arch: process.arch,
    appVersion,
    env: process.env,
  });
  const rawRuntime = createRuntimeService({
    paths,
    appVersion,
    execPath: process.execPath,
    env: process.env,
    fs: { existsSync, readFileSync },
    bundledRuntime,
    // Finder-launched apps inherit launchd's minimal PATH; the daemon needs the
    // user's real shell PATH (zsh/bash, profile+rc) to find per-bot CLIs.
    shellPathEnv: () => probeShellPathEnv(),
    fleetApps: () => listFleetApps(paths),
  });
  const hostLease = createDesktopHostLeaseRegistry(paths.botmuxHome);
  activeHostLease = hostLease;
  const initialLeaseRegistered = await hostLease.ensureRegistered();
  if (quitting) return;

  const zeroBotLifecycle = createZeroBotLifecycle({
    runtime: rawRuntime,
    readLiveSupervisor: () => readLiveSupervisorSnapshot(paths.botmuxHome),
    isOwnedByApp: live => isSupervisorOwnedByBundledRuntime(live, bundledRuntime),
    hasOtherActiveHost: () => hostLease.hasOtherActiveHost(),
    hostPid: process.pid,
    warn: message => console.warn(`[desktop] ${message}`),
  });
  // If a prior Electron session crashed abnormally while leaving an app-owned
  // 0-bot onboarding supervisor alive, adopt it only after holding a fenced lease.
  if (initialLeaseRegistered) zeroBotLifecycle.adoptRunningZeroBot();
  activeZeroBotLifecycle = zeroBotLifecycle;
  const runtime = zeroBotLifecycle.runtime;

  const win = createMainWindow(join(desktopDir, 'preload.cjs'), join(desktopDir, 'renderer'));
  mainWindow = win;
  let ownershipRepair: Promise<void> | null = null;
  const monitor = createRuntimeStateMonitor({
    runtime,
    watchDir: paths.botmuxHome,
    sendState: state => {
      if (quitting) return;
      void hostLease.ensureRegistered();
      zeroBotLifecycle.observeState(state);
      if (!win.isDestroyed()) win.webContents.send('desktop:state-changed', state);
      // A user may invoke an older/global `botmux restart` after Desktop has
      // launched. Reclaim the fleet instead of allowing the external runtime
      // to remain connected to the same bots.
      if (shouldTakeOverExternalRuntime(state) && !ownershipRepair) {
        ownershipRepair = runtime.takeover()
          .then(() => monitor.refresh())
          .catch(error => console.warn('[desktop] bundled runtime ownership repair failed', error))
          .finally(() => { ownershipRepair = null; });
      }
    },
  });
  activeMonitor = monitor;
  registerDesktopIpc({ paths, runtime, monitor });
  void autoStartCliRuntimeOnLaunch({
    runtime,
    monitor,
    warn: message => console.warn(`[desktop] ${message}`),
  })
    .then(async outcome => {
      if (quitting) return;
      const leaseRegistered = await hostLease.ensureRegistered();
      if (!quitting && outcome === 'skipped' && leaseRegistered) {
        zeroBotLifecycle.adoptRunningZeroBot();
      }
    })
    .finally(() => {
      if (!quitting) monitor.start();
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
    iconPath: join(desktopDir, 'assets', 'trayTemplate.png'),
    window: win,
    onStart: () => {
      void runRuntimeAction(() => runtime.start(), monitor);
    },
    onStop: () => {
      void runRuntimeAction(() => runtime.stop(), monitor);
    },
    onRestart: () => {
      void runRuntimeAction(() => runtime.restart(), monitor);
    },
    onOpenLogs: () => {
      void shell.openPath(paths.logsDir);
    },
    onOpenHome: () => {
      void shell.openPath(paths.botmuxHome);
    },
  });
  // 有意保留：模块级变量仅为持有 Tray 引用，防止其被 GC 后托盘图标消失（只写不读）。
  void tray;
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
  const desktopSessions = [
    session.defaultSession,
    session.fromPartition(dashboardWebviewPartition),
  ];
  for (const desktopSession of desktopSessions) {
    configureDesktopSessionPermissionHandlers(desktopSession);
  }
}

function configureDesktopSessionPermissionHandlers(desktopSession: Session): void {
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
