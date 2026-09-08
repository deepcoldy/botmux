import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H5_PREFIX = 'BOTMUX_DASHBOARD_FEISHU_H5_';
const FUTURE_H5_KEY = `${H5_PREFIX}FUTURE_ENTRY_TEST`;
const DOTENV_ONLY_KEY = 'BOTMUX_SUPERVISOR_DOTENV_ONLY_TEST';
const KEEP_KEY = 'BOTMUX_SUPERVISOR_ENTRY_KEEP_TEST';
const RESTART_MARKER = 'BOTMUX_INTERNAL_REFRESH_DAEMON_ENV';
const RESTART_FALLBACK = 'BOTMUX_INTERNAL_RESTART_ENV_FALLBACK';

const boundary = vi.hoisted(() => ({
  envAtFleetModuleLoad: undefined as NodeJS.ProcessEnv | undefined,
  envAtFleetStart: undefined as NodeJS.ProcessEnv | undefined,
}));

// Keep the real supervisor entry and its env scrub. Replace only the live fleet
// machinery below that boundary so importing the entry cannot spawn processes
// or write fleet state.
vi.mock('../src/core/fleet-supervisor.js', () => {
  boundary.envAtFleetModuleLoad = { ...process.env };
  return {
    FleetSupervisor: class {
      async stopAll(): Promise<void> {}
      async drainCommands(): Promise<void> {}
      start(): void {
        boundary.envAtFleetStart = { ...process.env };
      }
    },
  };
});

vi.mock('../src/core/fleet-runtime.js', () => ({
  fleetStatePath: () => '/unused/fleet-state.json',
  fleetDistDir: () => '/unused/dist',
  fleetLogDir: () => '/unused/logs',
  fleetCommandPath: () => '/unused/fleet-commands.json',
  resolveFleetBots: () => [],
  resolveFleetMembers: () => [],
  resolveFleetDaemonEnv: () => ({ ...process.env }),
  fleetDaemonNodeArgs: () => [],
}));

vi.mock('../src/core/fleet-command-queue.js', () => ({
  drainFleetCommands: () => [],
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn() },
}));

vi.mock('../src/utils/stdio-epipe-guard.js', () => ({
  installStdioEpipeGuard: vi.fn(),
}));

const originalSignalListeners = new Map(
  (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map(signal => [signal, new Set(process.listeners(signal))]),
);

afterEach(() => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const original = originalSignalListeners.get(signal)!;
    for (const listener of process.listeners(signal)) {
      if (!original.has(listener)) process.removeListener(signal, listener);
    }
  }
  for (const key of [
    'BOTMUX_DASHBOARD_FEISHU_H5_APP_ID',
    'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET',
    FUTURE_H5_KEY,
    DOTENV_ONLY_KEY,
    KEEP_KEY,
    RESTART_MARKER,
    RESTART_FALLBACK,
  ]) delete process.env[key];
});

describe('index-supervisor environment boundary', () => {
  it('holds no H5-prefixed value and does not wholesale-load dotenv before fleet startup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-supervisor-env-'));
    try {
      const configDir = join(home, '.botmux');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.env'), [
        'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=file-secret',
        `${FUTURE_H5_KEY}=file-future-secret`,
        `${DOTENV_ONLY_KEY}=loaded-only-by-wholesale-dotenv`,
      ].join('\n'));

      vi.stubEnv('HOME', home);
      vi.stubEnv('BOTMUX_DASHBOARD_FEISHU_H5_APP_ID', 'inherited-app-id');
      vi.stubEnv(FUTURE_H5_KEY, 'inherited-future-secret');
      vi.stubEnv(RESTART_MARKER, '1');
      vi.stubEnv(RESTART_FALLBACK, '{"version":1}');
      vi.stubEnv(KEEP_KEY, 'keep');
      boundary.envAtFleetModuleLoad = undefined;
      boundary.envAtFleetStart = undefined;
      vi.resetModules();

      await import('../src/index-supervisor.js');
      await vi.waitFor(() => expect(boundary.envAtFleetStart).toBeDefined());

      const observed = boundary.envAtFleetModuleLoad!;
      expect(Object.keys(observed).filter(key => key.startsWith(H5_PREFIX))).toEqual([]);
      expect(observed[DOTENV_ONLY_KEY]).toBeUndefined();
      expect(observed[RESTART_MARKER]).toBeUndefined();
      expect(observed[RESTART_FALLBACK]).toBeUndefined();
      expect(observed[KEEP_KEY]).toBe('keep');
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
