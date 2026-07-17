import { describe, expect, it, vi } from 'vitest';
import type { DesktopRuntimeState } from '../../src/desktop/shared/types.js';
import { autoStartCliRuntimeOnLaunch, shouldAutoStartCliRuntime } from '../../src/desktop/main/auto-start.js';

function runtimeState(overrides: Partial<DesktopRuntimeState>): DesktopRuntimeState {
  return {
    status: 'stopped',
    appVersion: '2.95.0',
    runtimeVersion: '2.95.0',
    runtimeSource: 'global-cli',
    runtimeManaged: true,
    runtimePath: '/usr/local/bin/botmux',
    botCount: 1,
    onlineDaemonCount: 0,
    attentionCount: 0,
    dashboardUrl: null,
    ...overrides,
  };
}

describe('desktop launch auto-start', () => {
  it('starts the selected CLI runtime when the app opens and the runtime is stopped', async () => {
    const start = vi.fn().mockResolvedValue({ code: 0, stdout: 'started', stderr: '' });
    const monitor = { refresh: vi.fn().mockResolvedValue(undefined) };

    const result = await autoStartCliRuntimeOnLaunch({
      runtime: {
        getState: vi.fn().mockResolvedValue(runtimeState({ status: 'stopped' })),
        start,
      },
      monitor,
    });

    expect(result).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
    expect(monitor.refresh).toHaveBeenCalledTimes(1);
  });

  it('skips states that are not safe for Desktop to start automatically', async () => {
    expect(shouldAutoStartCliRuntime(runtimeState({ status: 'running' }))).toBe(false);
    expect(shouldAutoStartCliRuntime(runtimeState({ status: 'not_configured' }))).toBe(false);
    expect(shouldAutoStartCliRuntime(runtimeState({ status: 'degraded' }))).toBe(false);
    expect(shouldAutoStartCliRuntime(runtimeState({ runtimeManaged: false }))).toBe(false);
    expect(shouldAutoStartCliRuntime(runtimeState({ runtimeSource: 'none' }))).toBe(false);
  });
});
