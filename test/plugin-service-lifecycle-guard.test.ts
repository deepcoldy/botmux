import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const supervisor = vi.hoisted(() => ({
  capture: vi.fn<(...args: any[]) => any[]>(),
  run: vi.fn(),
}));

vi.mock('../src/core/plugins/supervisor-client.js', () => ({
  readPluginProcesses: supervisor.capture,
  changePluginService: supervisor.run,
}));

import {
  assertPluginServiceStopped,
  deletePluginServicesOrThrowUnlocked,
  PluginServiceDeleteError,
  PluginServiceRunningError,
} from '../src/core/plugins/service-manager.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';

function supervisorList(status: string, pid = 0) {
  return [{ name: 'botmux-plugin-service-demo', ...(pid > 0 ? { pid } : {}), status }];
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
    supervisor.capture.mockReset();
    supervisor.run.mockReset();
    supervisor.capture.mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('allows absent, stopped, and errored supervisor apps', () => {
    expect(() => assertPluginServiceStopped('service-demo', 'update')).not.toThrow();

    supervisor.capture.mockReturnValue(supervisorList('stopped'));
    expect(() => assertPluginServiceStopped('service-demo', 'update')).not.toThrow();

    supervisor.capture.mockReturnValue(supervisorList('errored'));
    expect(() => assertPluginServiceStopped('service-demo', 'uninstall')).not.toThrow();
  });

  it.each([
    ['online', 4123],
    ['launching', 0],
    ['stopping', 0],
    ['unknown', 0],
  ])('blocks lifecycle changes while supervisor status is %s', (status, pid) => {
    supervisor.capture.mockReturnValue(supervisorList(status, pid));
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

  it('does not inspect supervisor on first install, but blocks a running-service update before replacing dist', () => {
    writePluginSource(source, '0.1.0', 'v1');
    const first = installLocalPlugin(source);
    expect(supervisor.capture).not.toHaveBeenCalled();
    expect(readFileSync(join(first.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');

    writePluginSource(source, '0.2.0', 'v2');
    let observedServiceLock = false;
    supervisor.capture.mockImplementation(() => {
      observedServiceLock = existsSync(join(home, '.botmux', 'plugins', 'service-manager.lock'));
      return supervisorList('online', 4123);
    });
    expect(() => installLocalPlugin(source)).toThrow(PluginServiceRunningError);
    expect(observedServiceLock).toBe(true);
    expect(readFileSync(join(first.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(home, '.botmux', 'plugins', 'service-demo', 'config.json'))).toBe(true);

    supervisor.capture.mockReturnValue(supervisorList('stopped'));
    const updated = installLocalPlugin(source);
    expect(readFileSync(join(updated.runtimeDir, 'marker.txt'), 'utf8')).toBe('v2\n');
  });

  it('fails closed when supervisor deletion fails and preserves every plugin-owned file', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    const installed = installLocalPlugin(source);
    const pluginRoot = join(home, '.botmux', 'plugins', 'service-demo');
    const registryPath = join(home, '.botmux', 'plugins-registry.json');
    const serviceStatePath = join(pluginRoot, 'service.json');
    writeFileSync(serviceStatePath, '{"status":"stopped"}\n');
    const registryBefore = readFileSync(registryPath, 'utf8');

    supervisor.capture.mockReturnValue(supervisorList('stopped'));
    supervisor.run.mockImplementation(() => { throw new Error('simulated supervisor delete failure'); });

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .rejects.toBeInstanceOf(PluginServiceDeleteError);
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore);
    expect(readFileSync(join(installed.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(pluginRoot, 'config.json'))).toBe(true);
    expect(existsSync(join(pluginRoot, 'settings.json'))).toBe(true);
    expect(existsSync(serviceStatePath)).toBe(true);
  });

  it('treats a supervisor record that remains after delete as a failed deletion', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    installLocalPlugin(source);
    supervisor.capture.mockReturnValue(supervisorList('stopped'));

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .rejects.toMatchObject({
        code: 'plugin_service_delete_failed',
        failures: [expect.objectContaining({
          pluginId: 'service-demo',
          action: 'failed',
          warning: expect.stringContaining('plugin_delete_not_applied'),
        })],
      });
  });

  it('deletes the supervisor app and service state after a verified successful deletion', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    installLocalPlugin(source);
    const serviceStatePath = join(home, '.botmux', 'plugins', 'service-demo', 'service.json');
    writeFileSync(serviceStatePath, '{"status":"stopped"}\n');
    supervisor.capture
      .mockReturnValueOnce(supervisorList('stopped'))
      .mockReturnValueOnce([]);

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .resolves.toEqual([
        expect.objectContaining({
          pluginId: 'service-demo',
          action: 'deleted',
        }),
      ]);
    expect(supervisor.run).toHaveBeenCalledWith(
      'service-demo', 'remove',
    );
    expect(existsSync(serviceStatePath)).toBe(false);
  });

  it('deletes the supervisor app even when the installed service entry is missing', async () => {
    writePluginSource(source, '0.1.0', 'v1');
    const installed = installLocalPlugin(source);
    rmSync(join(installed.runtimeDir, 'service', 'index.js'));
    supervisor.capture
      .mockReturnValueOnce(supervisorList('stopped'))
      .mockReturnValueOnce([]);

    await expect(deletePluginServicesOrThrowUnlocked(['service-demo']))
      .resolves.toEqual([expect.objectContaining({ pluginId: 'service-demo', action: 'deleted' })]);
    expect(supervisor.run).toHaveBeenCalledWith(
      'service-demo', 'remove',
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
    // otherwise a concurrent `plugin service start` can create an orphan supervisor app.
    expect(lockStart).toBeGreaterThanOrEqual(0);
    expect(serviceCheck).toBeGreaterThan(lockStart);
    expect(serviceDelete).toBeGreaterThan(serviceCheck);
    expect(materializedDelete).toBeGreaterThan(serviceDelete);
    expect(registryDelete).toBeGreaterThan(materializedDelete);
    expect(runtimeDelete).toBeGreaterThan(registryDelete);
  });
});
