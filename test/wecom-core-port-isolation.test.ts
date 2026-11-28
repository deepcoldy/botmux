import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_TERMINAL_PROXY_BASE_PORT_ENV,
  WECOM_CORE_TERMINAL_PROXY_BASE_PORT,
  wecomManagedCoreEnvironment,
} from '../src/im/wecom/config/managed-core-env.js';
import { startWecomManagedCore } from '../src/im/wecom/gateway/managed-core.js';

/**
 * A managed WeCom core is a core-only daemon: its listeners bind 127.0.0.1.
 * Feishu bot daemons and workers bind 0.0.0.0. On macOS the two coexist on one
 * port and the 127.0.0.1 listener receives every loopback connection, so a core
 * listening on a Feishu port silently takes that port over for the Dashboard
 * and the daemon's own terminal proxy. The core's listeners must stay off every
 * port the Feishu side uses.
 */

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>(done => server.close(() => done()));
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wecom-port-'));
  roots.push(root);
  return root;
}

function settings(root: string, port: number) {
  return {
    managedCore: {
      botId: 'local_wecom_ports',
      cli: 'codex',
      backend: 'pty' as const,
      workingDirectory: root,
      stateDir: join(root, 'state'),
      port,
    },
  };
}

/** Load config.ts fresh under the current process.env and read its web/dashboard defaults. */
async function freshConfig() {
  vi.resetModules();
  const { config } = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return config;
}

/** Run the real core-only entry up to the daemon start, with startDaemon stubbed out. */
async function runCoreEntry(env: NodeJS.ProcessEnv): Promise<{ proxyBase: number; envAtStart: NodeJS.ProcessEnv }> {
  const before = { ...process.env };
  let captured: { proxyBase: number; envAtStart: NodeJS.ProcessEnv } | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.resetModules();
  vi.doMock('../src/daemon.js', async () => {
    const { config } = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
    return {
      startDaemon: async () => {
        captured = { proxyBase: config.web.proxyBasePort, envAtStart: { ...process.env } };
      },
    };
  });
  try {
    for (const key of ['BOTMUX_WEB_PROXY_BASE_PORT', CORE_TERMINAL_PROXY_BASE_PORT_ENV]) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    await import('../src/index-core-only.js');
    await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 30_000 });
    expect(exit).not.toHaveBeenCalled();
    return captured!;
  } finally {
    vi.doUnmock('../src/daemon.js');
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, before);
  }
}

describe('managed WeCom core listening ports', () => {
  it('starts the core terminal proxy clear of every port the Feishu side listens on', async () => {
    vi.stubEnv('BOTMUX_WEB_PROXY_BASE_PORT', '');
    vi.stubEnv('BOTMUX_DASHBOARD_PORT', '');
    vi.stubEnv('BOTMUX_DAEMON_IPC_BASE_PORT', '');
    const config = await freshConfig();
    const coreRange = [WECOM_CORE_TERMINAL_PROXY_BASE_PORT, WECOM_CORE_TERMINAL_PROXY_BASE_PORT + 20];
    const manyBots = 256;
    const feishuRanges = [
      [config.web.proxyBasePort, config.web.proxyBasePort + manyBots + 20],
      [config.dashboard.port, config.dashboard.port + 20],
      [config.dashboard.ipcBasePort, config.dashboard.ipcBasePort + manyBots],
    ];
    for (const [low, high] of feishuRanges) {
      expect(coreRange[1] < low || coreRange[0] > high, `${coreRange} vs ${low}-${high}`).toBe(true);
    }
    // Below every OS ephemeral range Feishu workers draw their ports from (Linux starts at 32768).
    expect(coreRange[1]).toBeLessThan(32768);
  });

  it('hands the core its own terminal-proxy base and never a Feishu relay port', () => {
    const root = tempRoot();
    const env = wecomManagedCoreEnvironment(settings(root, 45931), {
      PATH: process.env.PATH,
      HOME: root,
      BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      WEB_EXTERNAL_PORT: '9443',
    });

    expect(env[CORE_TERMINAL_PROXY_BASE_PORT_ENV]).toBe(String(WECOM_CORE_TERMINAL_PROXY_BASE_PORT));
    expect(env.BOTMUX_WEB_PROXY_BASE_PORT).toBeUndefined();
    expect(env.WEB_EXTERNAL_PORT).toBeUndefined();
  });

  it('the core entry applies that base and removes it before anything is spawned', async () => {
    const root = tempRoot();
    const managedEnv = wecomManagedCoreEnvironment(settings(root, 45932), { PATH: process.env.PATH, HOME: root });

    const { proxyBase, envAtStart } = await runCoreEntry(managedEnv);

    expect(proxyBase).toBe(WECOM_CORE_TERMINAL_PROXY_BASE_PORT);
    expect(envAtStart.BOTMUX_WEB_PROXY_BASE_PORT).toBeUndefined();
    expect(envAtStart[CORE_TERMINAL_PROXY_BASE_PORT_ENV]).toBeUndefined();
  }, 60_000);

  it('leaves a core-only service started without the managed knob as it was', async () => {
    const root = tempRoot();

    const { proxyBase, envAtStart } = await runCoreEntry({
      HOME: root,
      BOTMUX_API_PORT: '45933',
      BOTMUX_CORE_STATE_DIR: join(root, 'state'),
      BOTMUX_CORE_SKIP_DOTENV: '1',
      BOTMUX_WEB_PROXY_BASE_PORT: '9100',
    });

    expect(proxyBase).toBe(9100);
    expect(envAtStart.BOTMUX_WEB_PROXY_BASE_PORT).toBe('9100');
  }, 60_000);

  it('refuses a core port another process listens on with 0.0.0.0', async () => {
    const root = tempRoot();
    const wildcard = createServer();
    wildcard.listen(0, '0.0.0.0');
    await once(wildcard, 'listening');
    servers.push(wildcard);
    const port = (wildcard.address() as { port: number }).port;
    const spawn = vi.fn();

    await expect(startWecomManagedCore(settings(root, port), { spawn })).rejects.toThrow(/端口已占用/);

    expect(spawn).not.toHaveBeenCalled();
    expect(wildcard.listening).toBe(true);
  });
});
