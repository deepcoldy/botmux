import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { pluginCardActionTokenPath, pluginMaterializedPath, pluginRegistryPath } from '../src/core/plugins/paths.js';
import { materializePlugin } from '../src/core/plugins/materializer.js';

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
  mkdirSync(join(root, 'dist', 'card-actions'), { recursive: true });
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
      port: 43210,
      pm2: {
        script: './service/server.js',
        env: {
          BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'forged-token',
          BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT: '/forged-endpoint'
        },
        autorestart: true,
        killTimeoutMs: 9000,
        watchDelayMs: 2500
      }
    };
  `);
  writeFileSync(join(root, 'dist', 'card-actions', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    actions: ['example.linked.submit'],
    endpoint: '/botmux/card-actions/v1',
  }));
}

function writeSecondPluginSource(root: string): void {
  mkdirSync(join(root, 'dist', 'service'), { recursive: true });
  mkdirSync(join(root, 'dist', 'card-actions'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@botmux-ai/plugin-second-service',
    version: '0.1.0',
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id: 'second-service',
      service: { mode: 'manual' },
    },
  }));
  writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(join(root, 'dist', 'service', 'server.js'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(root, 'dist', 'service', 'index.js'), `
    module.exports = {
      mode: 'manual',
      port: 43211,
      pm2: {
        script: './service/server.js',
        env: {
          BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'another-forged-token',
          BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT: '/another-forged-endpoint'
        }
      }
    };
  `);
  writeFileSync(join(root, 'dist', 'card-actions', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    actionPrefixes: ['example.second.'],
    endpoint: '/botmux/second-actions/v1',
  }));
}

function writeInvalidPortPluginSource(root: string): void {
  mkdirSync(join(root, 'dist', 'service'), { recursive: true });
  mkdirSync(join(root, 'dist', 'card-actions'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@botmux-ai/plugin-invalid-port-service',
    version: '0.1.0',
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id: 'invalid-port-service',
      service: { mode: 'manual' },
    },
  }));
  writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(join(root, 'dist', 'service', 'server.js'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(root, 'dist', 'service', 'index.js'), `
    module.exports = { mode: 'manual', pm2: { script: './service/server.js' } };
  `);
  writeFileSync(join(root, 'dist', 'card-actions', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    actions: ['example.invalid-port.submit'],
    endpoint: '/botmux/card-actions/v1',
  }));
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

  it('为每个插件服务注入独立且不可覆盖的私有 token', async () => {
    const secondSource = join(home, 'second-source');
    writeSecondPluginSource(secondSource);
    installLocalPlugin(secondSource, { link: true });
    materializePlugin('linked-service');
    materializePlugin('second-service');

    const reports = await startPluginServices(['linked-service', 'second-service']);
    const starts = pm2.run.mock.calls.filter(call => call[0][0] === 'start');
    expect(starts).toHaveLength(2);
    const envByPlugin = Object.fromEntries(starts.map(call => [call[1].env.BOTMUX_PLUGIN_ID, call[1].env]));
    const firstToken = envByPlugin['linked-service'].BOTMUX_PLUGIN_CARD_ACTION_TOKEN;
    const secondToken = envByPlugin['second-service'].BOTMUX_PLUGIN_CARD_ACTION_TOKEN;
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstToken).not.toBe(secondToken);
    expect(firstToken).not.toBe('forged-token');
    expect(secondToken).not.toBe('another-forged-token');
    expect(envByPlugin['linked-service']).toMatchObject({
      BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT: '/botmux/card-actions/v1',
      PORT: '43210',
    });
    expect(envByPlugin['second-service']).toMatchObject({
      BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT: '/botmux/second-actions/v1',
      PORT: '43211',
    });

    for (const pluginId of ['linked-service', 'second-service']) {
      const stat = lstatSync(pluginCardActionTokenPath(pluginId));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(reports)).not.toContain(firstToken);
    expect(JSON.stringify(reports)).not.toContain(secondToken);
    expect(readFileSync(pluginRegistryPath(), 'utf8')).not.toContain(firstToken);
    expect(readFileSync(pluginRegistryPath(), 'utf8')).not.toContain(secondToken);
    expect(readFileSync(pluginMaterializedPath('linked-service'), 'utf8')).not.toContain(firstToken);
    expect(readFileSync(pluginMaterializedPath('second-service'), 'utf8')).not.toContain(secondToken);

    const firstPath = pluginCardActionTokenPath('linked-service');
    const firstBeforeRestart = readFileSync(firstPath, 'utf8');
    pm2.capture.mockReturnValue('[]');
    await startPluginServices(['linked-service']);
    expect(readFileSync(firstPath, 'utf8')).toBe(firstBeforeRestart);
  });

  it('rejects a card action service definition without a fixed valid port before PM2 start', async () => {
    const invalidSource = join(home, 'invalid-port-source');
    writeInvalidPortPluginSource(invalidSource);
    installLocalPlugin(invalidSource);
    pm2.run.mockClear();

    const reports = await startPluginServices(['invalid-port-service']);
    expect(reports).toEqual([expect.objectContaining({
      pluginId: 'invalid-port-service',
      action: 'failed',
      warning: 'plugin_card_actions_fixed_port_required:invalid-port-service',
    })]);
    expect(pm2.run).not.toHaveBeenCalled();
  });
});
