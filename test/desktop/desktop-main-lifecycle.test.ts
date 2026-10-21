import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockSession = ReturnType<typeof makeMockSession>;
function makeMockSession() {
  return {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  };
}

const electron = vi.hoisted(() => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/botmux-desktop-test'),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false,
  },
  sessions: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  app: electron.app,
  session: {
    get defaultSession() { return electron.sessions.get('default'); },
    fromPartition: (partition: string) => electron.sessions.get(partition),
  },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
// Abort bootstrap right after the session permission setup so the test never
// builds the runtime service, window, or tray.
vi.mock('../../src/desktop/main/paths.js', () => ({
  resolveDesktopPaths: () => { throw new Error('stop bootstrap'); },
}));

// The dashboard <webview> partition lives in the renderer HTML; the permission
// handlers must land on that same session or the guest falls back to defaults.
const dashboardPartition = /partition="([^"]+)"/.exec(
  readFileSync('src/desktop/renderer/index.html', 'utf-8'),
)?.[1] ?? '';

async function loadDesktopMain(singleInstanceLock: boolean) {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const sessions = { default: makeMockSession(), dashboard: makeMockSession() };
  electron.sessions.clear();
  electron.sessions.set('default', sessions.default);
  electron.sessions.set(dashboardPartition, sessions.dashboard);
  electron.app.requestSingleInstanceLock.mockReturnValue(singleInstanceLock);
  await import('../../src/desktop/main.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  return sessions;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 非文本断言：从 renderer HTML 读出 webview 实际使用的 partition 名作为测试输入，
// 断言的是权限处理器真的挂到了那个 session 上，而不是 HTML 的写法。
describe('desktop main lifecycle', () => {
  it('quits a duplicate app instance without bootstrapping', async () => {
    await loadDesktopMain(false);

    expect(electron.app.quit).toHaveBeenCalled();
    expect(electron.app.whenReady).not.toHaveBeenCalled();
    expect(electron.app.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function));
  });

  it('disables the capture pickers before taking the single-instance lock and bootstrapping', async () => {
    await loadDesktopMain(true);

    expect(electron.app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      expect.stringMatching(/ScreenCaptureKitPickerScreen.*ScreenCaptureKitStreamPickerSonoma/),
    );
    expect(electron.app.on).toHaveBeenCalledWith('second-instance', expect.any(Function));
    const appendOrder = electron.app.commandLine.appendSwitch.mock.invocationCallOrder[0];
    const lockOrder = electron.app.requestSingleInstanceLock.mock.invocationCallOrder[0];
    const readyOrder = electron.app.whenReady.mock.invocationCallOrder[0];
    expect(appendOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(readyOrder);
  });

  it('denies every permission except sanitized clipboard writes on the default and dashboard sessions', async () => {
    expect(dashboardPartition).not.toBe('');
    const sessions = await loadDesktopMain(true);

    for (const desktopSession of [sessions.default, sessions.dashboard] as MockSession[]) {
      const check = desktopSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      expect(check?.(null, 'clipboard-sanitized-write')).toBe(true);
      for (const permission of ['media', 'notifications', 'display-capture', 'clipboard-read']) {
        expect(check?.(null, permission)).toBe(false);
      }

      const request = desktopSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const decisions: boolean[] = [];
      request?.(null, 'media', (granted: boolean) => decisions.push(granted));
      request?.(null, 'clipboard-sanitized-write', (granted: boolean) => decisions.push(granted));
      expect(decisions).toEqual([false, true]);

      expect(desktopSession.setDevicePermissionHandler.mock.calls[0]?.[0]?.()).toBe(false);

      const [displayMedia, options] = desktopSession.setDisplayMediaRequestHandler.mock.calls[0] ?? [];
      const granted = vi.fn();
      displayMedia?.({}, granted);
      expect(granted).toHaveBeenCalledWith({});
      expect(options).toEqual({ useSystemPicker: false });
    }
  });
});
