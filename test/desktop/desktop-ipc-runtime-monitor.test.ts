import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();
const electronMock = vi.hoisted(() => {
  const loginItemState = { openAtLogin: false };
  return {
    loginItemState,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: loginItemState.openAtLogin })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin?: boolean }) => {
      loginItemState.openAtLogin = Boolean(settings.openAtLogin);
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: electronMock.getLoginItemSettings,
    setLoginItemSettings: electronMock.setLoginItemSettings,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  shell: {
    openPath: vi.fn(),
  },
}));

const desktopPaths = {
  botmuxHome: '/tmp/botmux',
  dataDir: '/tmp/botmux/data',
  logsDir: '/tmp/botmux/logs',
  pm2Home: '/tmp/botmux/pm2',
};

describe('desktop IPC runtime monitor', () => {
  beforeEach(() => {
    handlers.clear();
    electronMock.loginItemState.openAtLogin = false;
    electronMock.getLoginItemSettings.mockClear();
    electronMock.setLoginItemSettings.mockClear();
    vi.useRealTimers();
  });

  it('pushes desktop:state-changed on start and every monitor tick', async () => {
    vi.useFakeTimers();
    const { createRuntimeStateMonitor } = await import('../../src/desktop/main/ipc.js');
    const states = [
      { status: 'stopped', appVersion: '1.0.0' },
      { status: 'running', appVersion: '1.0.0' },
    ];
    const runtime = {
      getState: vi.fn()
        .mockResolvedValueOnce(states[0])
        .mockResolvedValueOnce(states[1]),
    };
    const send = vi.fn();

    const monitor = createRuntimeStateMonitor({
      runtime: runtime as any,
      sendState: send,
      intervalMs: 5000,
    });
    monitor.start();
    await vi.runAllTicks();

    expect(send).toHaveBeenCalledWith(states[0]);

    await vi.advanceTimersByTimeAsync(5000);

    expect(send).toHaveBeenCalledWith(states[1]);
    expect(runtime.getState).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  it('refreshes state after runtime actions complete', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    const monitor = { refresh: vi.fn().mockResolvedValue(undefined) };
    const start = vi.fn().mockResolvedValue({ code: 0, stdout: 'started', stderr: '' });

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: {
        getState: vi.fn(),
        start,
        stop: vi.fn(),
        restart: vi.fn(),
        takeover: vi.fn(),
        dashboard: vi.fn(),
      } as any,
      monitor: monitor as any,
    });

    const result = await handlers.get('desktop:start')?.({} as any);

    expect(result).toMatchObject({ code: 0 });
    expect(monitor.refresh).toHaveBeenCalledTimes(1);
  });

  it('sets the real Electron login item when launch-at-login changes', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    registerDesktopIpc({
      paths: desktopPaths,
      runtime: {
        getState: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        takeover: vi.fn(),
        dashboard: vi.fn(),
      } as any,
    });

    expect(handlers.get('desktop:set-login-item')?.({} as any, true)).toMatchObject({
      openAtLogin: true,
    });
    expect(electronMock.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
    });
  });
});

describe('desktop dashboard locate IPC', () => {
  beforeEach(() => {
    handlers.clear();
    vi.unstubAllGlobals();
  });

  it('returns the current dashboard URL without rotating while keeping the legacy fallback', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        product: 'botmux',
        runtimeVersion: '2.95.0',
        dashboardProtocolVersion: 1,
        desktopShell: { supported: true },
        features: ['desktop-shell'],
        routes: ['#/'],
      }),
    }));
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn().mockResolvedValue({ code: 0, stdout: 'http://127.0.0.1:7891/?t=current\n', stderr: '' }),
      dashboard: vi.fn().mockResolvedValue({ code: 0, stdout: 'http://127.0.0.1:7891/?t=x\n', stderr: '' }),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: true,
      url: 'http://127.0.0.1:7891/?t=current',
      source: 'current',
    });
    expect(runtime.dashboard).not.toHaveBeenCalled();
    await expect(handlers.get('desktop:get-dashboard-url')?.({} as any)).resolves.toBe('http://127.0.0.1:7891/?t=x');
  });

  it('prefers the local direct dashboard URL from multi-line CLI output', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        product: 'botmux',
        runtimeVersion: '2.95.0',
        dashboardProtocolVersion: 1,
        desktopShell: { supported: true },
        features: ['desktop-shell'],
        routes: ['#/'],
      }),
    });
    vi.stubGlobal('fetch', fetch);
    const output = [
      'https://m-test.botmux.bytedance.net/?t=platform-token',
      '本地直连(平台异常时可用): http://10.92.89.226:7891/?t=local-token',
    ].join('\n');
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn().mockResolvedValue({ code: 0, stdout: `${output}\n`, stderr: '' }),
      dashboard: vi.fn().mockResolvedValue({ code: 0, stdout: `${output}\n`, stderr: '' }),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: true,
      url: 'http://10.92.89.226:7891/?t=local-token',
      source: 'current',
    });
    expect(fetch).toHaveBeenCalledWith('http://10.92.89.226:7891/__desktop/compat?t=local-token', expect.any(Object));
    await expect(handlers.get('desktop:get-dashboard-url')?.({} as any)).resolves.toBe('http://10.92.89.226:7891/?t=local-token');
  });

  it('rotates a dashboard URL only when no active dashboard token exists', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        product: 'botmux',
        runtimeVersion: '2.95.0',
        dashboardProtocolVersion: 1,
        desktopShell: { supported: true },
        features: ['desktop-shell'],
        routes: ['#/'],
      }),
    }));
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'no-active-token' }),
      dashboard: vi.fn().mockResolvedValue({ code: 0, stdout: 'http://127.0.0.1:7891/?t=x\n', stderr: '' }),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: true,
      url: 'http://127.0.0.1:7891/?t=x',
      source: 'rotated',
    });
    expect(runtime.dashboard).toHaveBeenCalledTimes(1);
  });

  it('returns incompatible when the dashboard compat manifest is missing', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn(),
    }));
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn().mockResolvedValue({ code: 0, stdout: 'http://127.0.0.1:7891/?t=x\n', stderr: '' }),
      dashboard: vi.fn().mockResolvedValue({ code: 0, stdout: 'http://127.0.0.1:7891/?t=x\n', stderr: '' }),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toMatchObject({
      ok: false,
      reason: 'incompatible',
      message: expect.stringContaining('/__desktop/compat'),
    });
  });

  it('returns incompatible when degraded state already reports a CLI/App protocol mismatch', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    const runtime = {
      getState: vi.fn().mockResolvedValue({
        status: 'degraded',
        message: '请升级或切换全局 botmux CLI，当前 CLI 与 Desktop 兼容协议不匹配。',
      }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn(),
      dashboard: vi.fn(),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: false,
      reason: 'incompatible',
      message: '请升级或切换全局 botmux CLI，当前 CLI 与 Desktop 兼容协议不匹配。',
    });
    expect(runtime.dashboard).not.toHaveBeenCalled();
  });

  it.each([
    ['no_secret', 'no-secret: missing .dashboard-secret'],
    ['wrong_service', 'wrong-service: port belongs to another service'],
    ['unreachable', 'ECONNREFUSED while opening dashboard'],
    ['unknown', 'unexpected dashboard lookup failure'],
  ] as const)('maps dashboard lookup failures to %s', async (reason, stderr) => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr }),
      dashboard: vi.fn(),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: false,
      reason,
      message: stderr,
    });
    expect(runtime.dashboard).not.toHaveBeenCalled();
  });

  it('returns structured failure when the runtime is not running', async () => {
    const { registerDesktopIpc } = await import('../../src/desktop/main/ipc.js');
    const runtime = {
      getState: vi.fn().mockResolvedValue({ status: 'stopped', message: 'Start the runtime first' }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      takeover: vi.fn(),
      currentDashboard: vi.fn(),
      dashboard: vi.fn(),
    };

    registerDesktopIpc({
      paths: desktopPaths,
      runtime: runtime as any,
    });

    await expect(handlers.get('desktop:locate-dashboard')?.({} as any)).resolves.toEqual({
      ok: false,
      reason: 'not_running',
      message: 'Start the runtime first',
    });
    expect(runtime.dashboard).not.toHaveBeenCalled();
  });
});
