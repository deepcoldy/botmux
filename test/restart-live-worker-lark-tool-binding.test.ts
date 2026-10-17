import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { latestLarkToolBindingForRespawn } from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import type { DaemonSession } from '../src/core/types.js';

describe('latestLarkToolBindingForRespawn (daemon-side carrier)', () => {
  const makeSession = (appId = 'cli_test'): DaemonSession => ({
    larkAppId: appId,
    session: { sessionId: 's1' },
  } as unknown as DaemonSession);

  it('returns true when larkToolBinding is explicitly enabled on the bot or unconfigured (default on)', () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test', larkToolBinding: true },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBe(true);

    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test' },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBe(true);
  });

  it('returns null when larkToolBinding is explicitly false (worker clears snapshot)', () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test', larkToolBinding: false },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBeNull();
  });

  it('returns undefined when bot lookup throws (worker keeps snapshot)', () => {
    vi.spyOn(botRegistry, 'getBot').mockImplementation(() => {
      throw new Error('bot_not_found');
    });
    expect(latestLarkToolBindingForRespawn(makeSession())).toBeUndefined();
  });
});

describe('every daemon-side restart IPC producer carries larkToolBinding', () => {
  const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
  const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');

  it('worker-pool.ts: every {type:restart} send includes larkToolBinding', () => {
    const sends = workerPoolSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(2);
    for (const s of sends) {
      expect(s).toContain('larkToolBinding: latestLarkToolBindingForRespawn(ds)');
    }
  });

  it('dashboard-ipc-server.ts: every {type:restart} send includes larkToolBinding', () => {
    const sends = dashboardIpcSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBe(2);
    for (const s of sends) {
      expect(s).toContain('larkToolBinding: latestLarkToolBindingForRespawn(ds)');
    }
  });

  it('covers all >= 4 restart senders across worker-pool and dashboard-ipc-server', () => {
    const poolSends = workerPoolSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    const ipcSends = dashboardIpcSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(poolSends.length).toBeGreaterThanOrEqual(2);
    expect(ipcSends.length).toBeGreaterThanOrEqual(2);
    expect(poolSends.length + ipcSends.length).toBeGreaterThanOrEqual(4);
  });

  it('types.ts: declares larkToolBinding in restart and message messages', () => {
    const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    const restartAt = typesSource.indexOf("| { type: 'restart';");
    expect(restartAt).toBeGreaterThanOrEqual(0);
    const restartLine = typesSource.slice(restartAt, typesSource.indexOf('\n', restartAt));
    expect(restartLine).toContain('larkToolBinding?: boolean | null');

    const messageAt = typesSource.indexOf("| { type: 'message';");
    expect(messageAt).toBeGreaterThanOrEqual(0);
    const messageLine = typesSource.slice(messageAt, typesSource.indexOf('\n', messageAt));
    expect(messageLine).toContain('larkToolBinding?: boolean | null');
  });

  it('worker.ts: merges larkToolBinding in case "restart" and case "message"', () => {
    const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(workerSource).toContain('lastInitConfig.larkToolBinding = msg.larkToolBinding === null ? false : msg.larkToolBinding;');
  });
});
