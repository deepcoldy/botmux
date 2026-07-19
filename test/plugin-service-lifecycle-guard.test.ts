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
});
