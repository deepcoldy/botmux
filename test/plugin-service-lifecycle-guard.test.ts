import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pm2 = vi.hoisted(() => ({
  capture: vi.fn<(...args: any[]) => string>(),
  run: vi.fn(),
}));

vi.mock('../src/core/plugins/pm2.js', () => ({
  capturePluginPm2: pm2.capture,
  pluginPm2AppName: (pluginId: string) => `botmux-plugin-${pluginId}`,
  runPluginPm2: pm2.run,
}));

import {
  assertPluginServiceStopped,
  deletePluginServicesOrThrowUnlocked,
  PluginServiceDeleteError,
  PluginServiceRunningError,
} from '../src/core/plugins/service-manager.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';

function pm2List(status: string, pid = 0): string {
  return JSON.stringify([{
    name: 'botmux-plugin-service-demo',
    pid,
    pm2_env: { status },
  }]);
}

function writePluginSource(root: string, version: string, marker: string): void {
  mkdirSync(join(root, 'dist', 'service'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@botmux-ai/plugin-service-demo',
    version,
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id: 'service-demo',
      service: { mode: 'manual' },
    },
  }));
  writeFileSync(join(root, 'dist', 'marker.txt'), `${marker}\n`);
  writeFileSync(join(root, 'dist', 'service', 'index.js'), 'module.exports = { pm2: { script: "./service/server.js" } };\n');
}

describe('plugin service lifecycle guard', () => {
  let home: string;
  let source: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-lifecycle-'));
    source = join(home, 'source');
    vi.stubEnv('HOME', home);
    pm2.capture.mockReset();
    pm2.run.mockReset();
    pm2.capture.mockReturnValue('[]');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('allows absent, stopped, and errored PM2 apps', () => {
    expect(() => assertPluginServiceStopped('service-demo', 'update')).not.toThrow();

    pm2.capture.mockReturnValue(pm2List('stopped'));
    expect(() => assertPluginServiceStopped('service-demo', 'update')).not.toThrow();

    pm2.capture.mockReturnValue(pm2List('errored'));
    expect(() => assertPluginServiceStopped('service-demo', 'uninstall')).not.toThrow();
  });

  it.each([
    ['online', 4123],
    ['launching', 0],
    ['stopping', 0],
    ['unknown', 0],
  ])('blocks lifecycle changes while PM2 status is %s', (status, pid) => {
    pm2.capture.mockReturnValue(pm2List(status, pid));
    expect(() => assertPluginServiceStopped('service-demo', 'update')).toThrow(PluginServiceRunningError);
    try {
      assertPluginServiceStopped('service-demo', 'update');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'plugin_service_running',
        pluginId: 'service-demo',
        operation: 'update',
        serviceStatus: status,
        ...(pid > 0 ? { pid } : {}),
      });
    }
  });

  it('does not inspect PM2 on first install, but blocks a running-service update before replacing dist', () => {
    writePluginSource(source, '0.1.0', 'v1');
    const first = installLocalPlugin(source);
    expect(pm2.capture).not.toHaveBeenCalled();
    expect(readFileSync(join(first.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');

    writePluginSource(source, '0.2.0', 'v2');
    let observedServiceLock = false;
    pm2.capture.mockImplementation(() => {
      observedServiceLock = existsSync(join(home, '.botmux', 'plugins', 'service-manager.lock'));
      return pm2List('online', 4123);
    });
    expect(() => installLocalPlugin(source)).toThrow(PluginServiceRunningError);
    expect(observedServiceLock).toBe(true);
    expect(readFileSync(join(first.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(home, '.botmux', 'plugins', 'service-demo', 'config.json'))).toBe(true);

    pm2.capture.mockReturnValue(pm2List('stopped'));
    const updated = installLocalPlugin(source);
    expect(readFileSync(join(updated.runtimeDir, 'marker.txt'), 'utf8')).toBe('v2\n');
  });

  it('fails closed when PM2 deletion fails and preserves every plugin-owned file', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    const installed = installLocalPlugin(source);
    const pluginRoot = join(home, '.botmux', 'plugins', 'service-demo');
    const registryPath = join(home, '.botmux', 'plugins-registry.json');
    const serviceStatePath = join(pluginRoot, 'service.json');
    writeFileSync(serviceStatePath, '{"status":"stopped"}\n');
    const registryBefore = readFileSync(registryPath, 'utf8');

    pm2.capture.mockReturnValue(pm2List('stopped'));
    pm2.run.mockImplementation(() => { throw new Error('simulated pm2 delete failure'); });

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .rejects.toBeInstanceOf(PluginServiceDeleteError);
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore);
    expect(readFileSync(join(installed.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(pluginRoot, 'config.json'))).toBe(true);
    expect(existsSync(join(pluginRoot, 'settings.json'))).toBe(true);
    expect(existsSync(serviceStatePath)).toBe(true);
  });

  it('treats a PM2 record that remains after delete as a failed deletion', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    installLocalPlugin(source);
    pm2.capture.mockReturnValue(pm2List('stopped'));

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .rejects.toMatchObject({
        code: 'plugin_service_delete_failed',
        failures: [expect.objectContaining({
          pluginId: 'service-demo',
          action: 'failed',
          warning: expect.stringContaining('pm2_delete_not_applied'),
        })],
      });
  });

  it('deletes the PM2 app and service state after a verified successful deletion', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    installLocalPlugin(source);
    const serviceStatePath = join(home, '.botmux', 'plugins', 'service-demo', 'service.json');
    writeFileSync(serviceStatePath, '{"status":"stopped"}\n');
    pm2.capture
      .mockReturnValueOnce(pm2List('stopped'))
      .mockReturnValueOnce('[]');

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .resolves.toEqual([
        expect.objectContaining({
          pluginId: 'service-demo',
          action: 'deleted',
        }),
      ]);
    expect(pm2.run).toHaveBeenCalledWith(
      ['delete', 'botmux-plugin-service-demo'],
      { inherit: false, timeoutMs: 30_000 },
    );
    expect(existsSync(serviceStatePath)).toBe(false);
  });

  it('deletes the PM2 app even when the installed service entry is missing', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    const installed = installLocalPlugin(source);
    rmSync(join(installed.runtimeDir, 'service', 'index.js'));
    pm2.capture
      .mockReturnValueOnce(pm2List('stopped'))
      .mockReturnValueOnce('[]');

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .resolves.toEqual([expect.objectContaining({ pluginId: 'service-demo', action: 'deleted' })]);
    expect(pm2.run).toHaveBeenCalledWith(
      ['delete', 'botmux-plugin-service-demo'],
      { inherit: false, timeoutMs: 30_000 },
    );
  });

  it('keeps the uninstall service check and destructive cleanup in one service lock', () => {
    const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const branchStart = cliSource.indexOf("if (sub === 'uninstall' || sub === 'remove' || sub === 'rm')");
    const branchEnd = cliSource.indexOf("if (sub === 'service' || sub === 'services')", branchStart);

    expect(branchStart).toBeGreaterThanOrEqual(0);
    expect(branchEnd).toBeGreaterThan(branchStart);

    const uninstallBranch = cliSource.slice(branchStart, branchEnd);
    const lockStart = uninstallBranch.indexOf('withPluginServiceLock');
    const serviceCheck = uninstallBranch.indexOf("assertPluginServiceStopped(pluginId, 'uninstall')");
    const serviceDelete = uninstallBranch.indexOf('deletePluginServicesOrThrowUnlocked([pluginId])');
    const materializedDelete = uninstallBranch.indexOf('dematerializePlugin(pluginId)');
    const registryDelete = uninstallBranch.indexOf('removeInstalledPlugin(pluginId)');
    const runtimeDelete = uninstallBranch.indexOf('rmSync(pluginHome(pluginId)');

    // The status check and every destructive step must share the same lock;
    // otherwise a concurrent `plugin service start` can create an orphan PM2 app.
    expect(lockStart).toBeGreaterThanOrEqual(0);
    expect(serviceCheck).toBeGreaterThan(lockStart);
    expect(serviceDelete).toBeGreaterThan(serviceCheck);
    expect(materializedDelete).toBeGreaterThan(serviceDelete);
    expect(registryDelete).toBeGreaterThan(materializedDelete);
    expect(runtimeDelete).toBeGreaterThan(registryDelete);
  });
});
