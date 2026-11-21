import { app, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DesktopPaths } from '../shared/types.js';
import { detectLegacyAutostart } from './login-item.js';
import {
  listTargets,
  locateDashboard,
  runRuntimeAction,
  selectDesktopDashboardUrl,
  tailLogTarget,
  type RuntimeStateMonitor,
} from './runtime-actions.js';
import type { createRuntimeService } from './runtime-service.js';

export { createRuntimeStateMonitor, type RuntimeStateMonitor } from './runtime-actions.js';

type RuntimeService = ReturnType<typeof createRuntimeService>;

export function registerDesktopIpc(args: {
  paths: DesktopPaths;
  runtime: RuntimeService;
  monitor?: Pick<RuntimeStateMonitor, 'refresh'>;
}): void {
  // Keep the renderer's surface area narrow: every filesystem/process action
  // must go through an explicit handler here.
  ipcMain.handle('desktop:get-state', () => args.runtime.getState());
  ipcMain.handle('desktop:get-device-status', () => args.runtime.getDeviceStatus());
  ipcMain.handle('desktop:start', () => runRuntimeAction(args.runtime.start, args.monitor));
  ipcMain.handle('desktop:stop', () => runRuntimeAction(args.runtime.stop, args.monitor));
  ipcMain.handle('desktop:restart', () => runRuntimeAction(args.runtime.restart, args.monitor));
  ipcMain.handle('desktop:takeover', () => runRuntimeAction(args.runtime.takeover.bind(args.runtime), args.monitor));
  ipcMain.handle('desktop:locate-dashboard', () => locateDashboard(args.runtime));
  ipcMain.handle('desktop:get-dashboard-url', async () => {
    const result = await args.runtime.dashboard();
    return result.code === 0 ? selectDesktopDashboardUrl(result.stdout) : null;
  });
  ipcMain.handle('desktop:list-log-targets', () => listTargets(args.paths));
  ipcMain.handle('desktop:tail-logs', (_event, targetId: unknown) => tailLogTarget(args.paths, targetId));
  ipcMain.handle('desktop:open-logs-dir', () => shell.openPath(args.paths.logsDir));
  ipcMain.handle('desktop:open-botmux-home', () => shell.openPath(args.paths.botmuxHome));
  ipcMain.handle('desktop:get-login-item', () => getLoginItemState());
  ipcMain.handle('desktop:set-login-item', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('desktop:set-login-item expects a boolean');
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return getLoginItemState();
  });
}

function getLoginItemState() {
  return {
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    ...detectLegacyAutostart({ homeDir: homedir(), existsSync }),
  };
}

