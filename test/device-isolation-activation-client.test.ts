import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';
import {
  activateDeviceCredentialIsolation,
  DeviceIsolationDaemonActivationError,
} from '../src/platform/device-isolation-activation-client.js';
import { deviceCredentialIsolationMarkerPath } from '../src/adapters/cli/read-isolation.js';
import { readDeviceCredentialIsolationMarker } from '../src/platform/device-isolation.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-activation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function daemonDescriptor(overrides: Partial<OnlineDaemonInfo> = {}): OnlineDaemonInfo {
  return {
    larkAppId: 'cli_test',
    ipcPort: 12345,
    bootInstanceId: 'boot-1',
    pid: 321,
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

describe('activateDeviceCredentialIsolation', () => {
  it('freezes every daemon before marker write, commits, reasserts and releases', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const calls: Array<{ path: string; body: Record<string, unknown>; markerExists: boolean }> = [];
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({
        path,
        body,
        markerExists: (() => {
          try { readFileSync(deviceCredentialIsolationMarkerPath(homeDir)); return true; }
          catch { return false; }
        })(),
      });
      return new Response(JSON.stringify({
        ok: true,
        activationVersion: 1,
        nonce: body.nonce,
        leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000,
        inventoryGeneration: path.endsWith('/prepare') ? 'g1' : 'g2',
        daemon: {
          larkAppId: descriptor.larkAppId,
          bootInstanceId: descriptor.bootInstanceId,
          pid: descriptor.pid,
          procStart: 'proc-321',
          dataDir,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await activateDeviceCredentialIsolation({
      homeDir,
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      dependencies: {
        listDaemons: () => [descriptor],
        fetchDaemon: fakeFetch,
        processStart: pid => pid === 321 ? 'proc-321' : undefined,
        nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    });

    expect(result).toMatchObject({ activated: true, daemonCount: 1 });
    expect(result.markerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.map(call => call.path)).toEqual([
      '/api/device-isolation/activation/prepare',
      '/api/device-isolation/activation/commit',
      '/api/device-isolation/activation/release',
    ]);
    expect(calls[0].markerExists).toBe(false);
    expect(calls[1].markerExists).toBe(true);
    expect(calls[2].markerExists).toBe(true);
    expect(calls[1].body.markerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[1].body.markerSha256).not.toBe(result.markerSha256);
    expect(calls[2].body.markerSha256).toBe(result.markerSha256);
  });

  it('treats an existing valid marker as a completed one-way transition', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const deps = {
      listDaemons: () => { throw new Error('must not enumerate daemons'); },
      expectedDataDir: dataDir,
    };
    // First call creates the marker through the full fake transaction.
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, _path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    await activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    });
    const result = await activateDeviceCredentialIsolation({ homeDir, dependencies: deps });
    expect(result.activated).toBe(false);
    expect(result.daemonCount).toBe(0);
  });

  it('rejects an old daemon before creating the marker', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [daemonDescriptor({ bootInstanceId: undefined })],
        expectedDataDir: dataDir,
      },
    })).rejects.toBeInstanceOf(DeviceIsolationDaemonActivationError);
    expect(() => readFileSync(deviceCredentialIsolationMarkerPath(homeDir))).toThrow();
  });

  it('rejects a response bound to another daemon instance and releases its lease', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    const descriptor = daemonDescriptor();
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      paths.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: 'wrong-boot',
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).rejects.toThrow(/身份不匹配/);
    expect(paths).toEqual([
      '/api/device-isolation/activation/prepare',
      '/api/device-isolation/activation/release',
    ]);
  });

  it('never treats a marker left by a failed commit as completed', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    let failCommit = true;
    let prepareCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit') && failCommit) {
        return new Response(JSON.stringify({ error: 'quiesce_failed' }), { status: 503 });
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, nonce: body.nonce, leaseId: 'lease-1',
        expiresAt: Date.now() + 30_000, inventoryGeneration: 'g1',
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };
    const options = {
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    };

    await expect(activateDeviceCredentialIsolation(options)).rejects.toThrow(/quiesce_failed/);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
    failCommit = false;
    await expect(activateDeviceCredentialIsolation(options)).resolves.toMatchObject({ activated: true });
    expect(prepareCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });

  it('automatically retries once when commit reports inventory_changed', async () => {
    const homeDir = tempRoot();
    const dataDir = join(homeDir, '.botmux', 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const descriptor = daemonDescriptor();
    let prepareCalls = 0;
    let commitCalls = 0;
    const fakeFetch = async (_port: number, path: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path.endsWith('/prepare')) prepareCalls += 1;
      if (path.endsWith('/commit')) {
        commitCalls += 1;
        if (commitCalls === 1) {
          return new Response(JSON.stringify({ error: 'inventory_changed' }), { status: 409 });
        }
      }
      return new Response(JSON.stringify({
        ok: true, activationVersion: 1, nonce: body.nonce, leaseId: `lease-${prepareCalls}`,
        expiresAt: Date.now() + 30_000, inventoryGeneration: `g${prepareCalls}`,
        daemon: {
          larkAppId: descriptor.larkAppId, bootInstanceId: descriptor.bootInstanceId,
          pid: descriptor.pid, procStart: 'proc-321', dataDir,
        },
      }));
    };

    await expect(activateDeviceCredentialIsolation({
      homeDir,
      dependencies: {
        listDaemons: () => [descriptor], fetchDaemon: fakeFetch,
        processStart: () => 'proc-321', nonceFactory: () => 'n'.repeat(43),
        expectedDataDir: dataDir,
      },
    })).resolves.toMatchObject({ activated: true, daemonCount: 1 });
    expect(prepareCalls).toBe(2);
    expect(commitCalls).toBe(2);
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('active');
  });
});
