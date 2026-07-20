import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { installLocalPlugin } from '../src/core/plugins/install.js';
import { startPluginServices } from '../src/core/plugins/service-manager.js';

function pm2List(hash: string, status = 'online'): string {
  return JSON.stringify([{
    name: 'botmux-plugin-linked-service',
    pid: 4123,
    pm2_env: {
      status,
      BOTMUX_PLUGIN_SERVICE_CONFIG_HASH: hash,
    },
  }]);
}

function writePluginSource(root: string): void {
  mkdirSync(join(root, 'dist', 'service'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@botmux-ai/plugin-linked-service',
    version: '0.1.0',
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id: 'linked-service',
      service: { mode: 'manual' },
    },
  }));
  writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  mkdirSync(join(root, 'dist', 'botmux-build'));
  writeFileSync(join(root, 'dist', 'botmux-build', 'stamp'), 'initial\n');
  writeFileSync(join(root, 'dist', 'service', 'server.js'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(root, 'dist', 'service', 'index.js'), `
    module.exports = {
      mode: 'manual',
      pm2: {
        script: './service/server.js',
        autorestart: true,
        killTimeoutMs: 9000,
        watchDelayMs: 2500
      }
    };
  `);
}

describe('linked plugin service watcher', () => {
  let home: string;
  let source: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-link-watch-'));
    source = join(home, 'source');
    vi.stubEnv('HOME', home);
    pm2.capture.mockReset();
    pm2.run.mockReset();
    pm2.capture.mockReturnValue('[]');
    writePluginSource(source);
    installLocalPlugin(source, { link: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('starts linked services with a delayed watcher and graceful kill timeout', async () => {
    await startPluginServices(['linked-service']);

    const startCall = pm2.run.mock.calls.find(call => call[0][0] === 'start');
    expect(startCall).toBeDefined();
    expect(startCall![0]).toEqual([
      'start',
      join(home, '.botmux', 'plugins', 'linked-service', 'service.pm2.json'),
      '--only',
      'botmux-plugin-linked-service',
      '--update-env',
    ]);
    expect(startCall![1].env).toMatchObject({
      BOTMUX_PLUGIN_LINKED: '1',
      BOTMUX_PLUGIN_ID: 'linked-service',
    });
    expect(startCall![1].env.BOTMUX_PLUGIN_SERVICE_CONFIG_HASH).toMatch(/^[a-f0-9]{16}$/);
    const config = JSON.parse(readFileSync(startCall![0][1], 'utf8'));
    expect(config.apps[0]).toMatchObject({
      name: 'botmux-plugin-linked-service',
      autorestart: true,
      kill_timeout: 9000,
      watch: [join(source, 'dist', 'botmux-build')],
      watch_delay: 2500,
    });
  });

  it('keeps a matching online app but recreates a stale PM2 definition', async () => {
    await startPluginServices(['linked-service']);
    const firstStart = pm2.run.mock.calls.find(call => call[0][0] === 'start');
    const hash = firstStart![1].env.BOTMUX_PLUGIN_SERVICE_CONFIG_HASH;

    pm2.run.mockReset();
    pm2.capture.mockReturnValue(pm2List(hash));
    const matching = await startPluginServices(['linked-service']);
    expect(matching[0].action).toBe('already-running');
    expect(pm2.run).not.toHaveBeenCalled();

    pm2.capture.mockReturnValue(pm2List('stale-config'));
    const stale = await startPluginServices(['linked-service']);
    expect(stale[0].action).toBe('started');
    expect(pm2.run.mock.calls.map(call => call[0][0])).toEqual(['delete', 'start']);
  });

  it('recreates a stopped linked app so PM2 enables its watcher again', async () => {
    await startPluginServices(['linked-service']);
    const firstStart = pm2.run.mock.calls.find(call => call[0][0] === 'start');
    const hash = firstStart![1].env.BOTMUX_PLUGIN_SERVICE_CONFIG_HASH;

    pm2.run.mockReset();
    pm2.capture.mockReturnValue(pm2List(hash, 'stopped'));
    const reports = await startPluginServices(['linked-service']);

    expect(reports[0].action).toBe('started');
    expect(pm2.run.mock.calls.map(call => call[0][0])).toEqual(['delete', 'start']);
  });

  it('does not enable file watching after switching back to a copied local install', async () => {
    installLocalPlugin(source);
    pm2.run.mockReset();
    pm2.capture.mockReturnValue('[]');

    await startPluginServices(['linked-service']);

    const startCall = pm2.run.mock.calls.find(call => call[0][0] === 'start');
    const config = JSON.parse(readFileSync(startCall![0][1], 'utf8'));
    expect(config.apps[0].watch).toBe(false);
    expect(config.apps[0]).not.toHaveProperty('watch_delay');
    expect(startCall![1].env.BOTMUX_PLUGIN_LINKED).toBe('0');
  });
});
