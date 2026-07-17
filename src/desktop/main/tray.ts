import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';

export function createDesktopTray(args: {
  window: BrowserWindow;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onOpenLogs: () => void;
  onOpenHome: () => void;
}): Tray {
  // Keep the menu-bar lifecycle functional even before a branded tray icon
  // asset exists.
  const tray = new Tray(nativeImage.createEmpty());
  const showWindow = () => {
    args.window.show();
    args.window.focus();
  };
  const menu = Menu.buildFromTemplate([
    { label: 'Show Console', click: showWindow },
    { type: 'separator' },
    { label: 'Start Botmux', click: args.onStart },
    { label: 'Stop Botmux', click: args.onStop },
    { label: 'Restart Botmux', click: args.onRestart },
    { type: 'separator' },
    { label: 'Open Logs', click: args.onOpenLogs },
    { label: 'Open Botmux Home', click: args.onOpenHome },
    { type: 'separator' },
    { label: 'Quit App', role: 'quit' },
  ]);

  tray.setToolTip('Botmux');
  tray.setContextMenu(menu);
  tray.on('click', showWindow);

  return tray;
}
