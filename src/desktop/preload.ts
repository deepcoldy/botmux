import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Expose a typed, whitelisted bridge instead of leaking ipcRenderer or Node
// primitives into the browser context.
contextBridge.exposeInMainWorld('botmuxDesktop', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  start: () => ipcRenderer.invoke('desktop:start'),
  stop: () => ipcRenderer.invoke('desktop:stop'),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  takeover: () => ipcRenderer.invoke('desktop:takeover'),
  locateDashboard: () => ipcRenderer.invoke('desktop:locate-dashboard'),
  getDashboardUrl: () => ipcRenderer.invoke('desktop:get-dashboard-url'),
  listLogTargets: () => ipcRenderer.invoke('desktop:list-log-targets'),
  tailLogs: (targetId: string) => ipcRenderer.invoke('desktop:tail-logs', targetId),
  openLogsDir: () => ipcRenderer.invoke('desktop:open-logs-dir'),
  openBotmuxHome: () => ipcRenderer.invoke('desktop:open-botmux-home'),
  getLoginItem: () => ipcRenderer.invoke('desktop:get-login-item'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('desktop:set-login-item', enabled),
  onStateChanged: (fn: (state: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown) => fn(state);
    ipcRenderer.on('desktop:state-changed', listener);
    return () => ipcRenderer.off('desktop:state-changed', listener);
  },
});
