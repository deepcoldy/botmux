import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePluginPackageManifest } from '../src/core/plugins/manifest.js';
import { normalizePluginIdList } from '../src/core/plugins/ids.js';
import { pluginRegistryPath, resolvePluginPath } from '../src/core/plugins/paths.js';
import { readPluginRegistry, upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';
import { resolveEffectivePluginIds } from '../src/core/plugins/effective.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { pluginMcpConfigPath, resolveStaticPluginMcpServers, writePluginMcpConfig } from '../src/core/plugins/mcp.js';
import { collectPluginCliCommands, resolvePluginMcpServers } from '../src/core/plugins/runtime.js';

describe('plugin manifest and registry basics', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('normalizes plugin id lists by filtering invalid ids and deduping', () => {
    expect(normalizePluginIdList(['agent-chrome', 'bad/id', 'agent-chrome', '', 'gitlab'])).toEqual(['agent-chrome', 'gitlab']);
    expect(normalizePluginIdList(['bad/id', 1, ''])).toBeUndefined();
    expect(normalizePluginIdList('agent-chrome')).toBeUndefined();
  });

  it('parses a package.json botmux manifest with static mcp, dashboard, skills, and host service', () => {
    const pkg = parsePluginPackageManifest({
      name: '@botmux/plugin-agent-chrome',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'agent-chrome',
        displayName: 'Agent Chrome',
        main: './dist/plugin.js',
        hooks: ['cli', 'worker', 'dashboard'],
        capabilities: ['network:localhost', 'filesystem:pluginDir'],
        dependencies: { plugins: { gitlab: '^1.0.0' } },
        skills: [{ path: './skills/browser' }],
        dashboard: [{ id: 'agent-chrome', route: '#/plugins/agent-chrome', entry: './dashboard/index.html' }],
        services: {
          agentChrome: {
            scope: 'host',
            mode: 'managed',
            command: ['node', './dist/acs.js'],
            port: 9300,
            healthUrl: 'http://127.0.0.1:9300/health',
          },
        },
        mcp: [{ name: 'agent-chrome', command: ['node', './dist/mcp.js'], env: { ACS_URL: '${plugin.settings.acsUrl}' } }],
      },
    });

    expect(pkg.botmux.id).toBe('agent-chrome');
    expect(pkg.botmux.main).toBe('dist/plugin.js');
    expect(pkg.botmux.services?.agentChrome.command).toEqual(['node', 'dist/acs.js']);
    expect(pkg.botmux.mcp?.[0].env).toEqual({ ACS_URL: '${plugin.settings.acsUrl}' });
  });

  it('rejects unsafe relative paths in manifest entries', () => {
    expect(() => parsePluginPackageManifest({
      name: '@botmux/plugin-bad',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'bad-plugin',
        main: '../outside.js',
      },
    })).toThrow(/escapes_root/);
  });

  it('writes and reads installed plugin registry atomically under ~/.botmux', () => {
    const now = new Date().toISOString();
    upsertInstalledPlugin({
      id: 'agent-chrome',
      packageName: '@botmux/plugin-agent-chrome',
      version: '0.1.0',
      source: { type: 'npm', spec: '@botmux/plugin-agent-chrome' },
      manifest: { schemaVersion: 1, id: 'agent-chrome' },
      installedAt: now,
      updatedAt: now,
    });

    const registry = readPluginRegistry();
    expect(registry.plugins['agent-chrome'].packageName).toBe('@botmux/plugin-agent-chrome');
    expect(JSON.parse(readFileSync(pluginRegistryPath(), 'utf8')).plugins['agent-chrome'].version).toBe('0.1.0');
  });

  it('resolves plugin paths only inside the plugin root', () => {
    const root = join(home, '.botmux', 'plugins', 'agent-chrome', 'current');
    mkdirSync(root, { recursive: true });
    expect(resolvePluginPath(root, './dist/plugin.js')).toBe(join(root, 'dist/plugin.js'));
    expect(() => resolvePluginPath(root, '../other')).toThrow(/escapes_root/);
  });

  it('unions global defaults with bot-level plugins in stable order', () => {
    expect(resolveEffectivePluginIds(
      { plugins: ['agent-chrome', 'gitlab'] },
      { plugins: ['gitlab', 'lint-bot'] },
    )).toEqual(['gitlab', 'lint-bot', 'agent-chrome']);
  });

  it('installs a local plugin directory into plugin scope and updates current + registry', () => {
    const source = join(home, 'plugin-src');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-local-demo',
      version: '0.2.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'local-demo',
        main: './dist/plugin.js',
      },
    }));
    writeFileSync(join(source, 'dist', 'plugin.js'), 'export default { apply() {} };\n');

    const result = installLocalPlugin(source);

    expect(result.record.id).toBe('local-demo');
    expect(result.packageDir).toBe(join(home, '.botmux', 'plugins', 'local-demo', 'versions', '0.2.0', 'package'));
    expect(readlinkSync(join(home, '.botmux', 'plugins', 'local-demo', 'current'))).toBe(result.packageDir);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'settings.json'))).toBe(true);
    expect(readPluginRegistry().plugins['local-demo'].packageName).toBe('@botmux/plugin-local-demo');
  });

  it('resolves static MCP servers with plugin settings and session templates', () => {
    const now = new Date().toISOString();
    upsertInstalledPlugin({
      id: 'agent-chrome',
      packageName: '@botmux/plugin-agent-chrome',
      version: '0.1.0',
      source: { type: 'npm', spec: '@botmux/plugin-agent-chrome' },
      manifest: {
        schemaVersion: 1,
        id: 'agent-chrome',
        mcp: [{
          name: 'agent-chrome',
          command: ['node', './dist/mcp.js', '--session', '${sessionId}'],
          env: { ACS_URL: '${plugin.settings.acsUrl}', BOT_ID: '${botId}', TOKEN: '${plugin.config.token}' },
        }],
      },
      installedAt: now,
      updatedAt: now,
    });
    mkdirSync(join(home, '.botmux', 'plugins', 'agent-chrome'), { recursive: true });
    writeFileSync(join(home, '.botmux', 'plugins', 'agent-chrome', 'settings.json'), JSON.stringify({
      schemaVersion: 1,
      defaults: { acsUrl: 'http://127.0.0.1:9300' },
      bots: { dev: { acsUrl: 'http://127.0.0.1:9400' } },
    }));
    writeFileSync(join(home, '.botmux', 'plugins', 'agent-chrome', 'config.json'), JSON.stringify({
      token: 'secret-token',
    }));

    expect(resolveStaticPluginMcpServers({
      pluginIds: ['agent-chrome'],
      botId: 'dev',
      sessionId: 's1',
    })).toEqual([{
      pluginId: 'agent-chrome',
      name: 'agent-chrome',
      transport: 'stdio',
      command: ['node', './dist/mcp.js', '--session', 's1'],
      env: { ACS_URL: 'http://127.0.0.1:9400', BOT_ID: 'dev', TOKEN: 'secret-token' },
      cwd: join(home, '.botmux', 'plugins', 'agent-chrome', 'current'),
    }]);
  });

  it('loads apply(api, ctx) for cli commands and dynamic worker mcp', async () => {
    const source = join(home, 'plugin-apply-src');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-apply-demo',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'apply-demo',
        main: './dist/plugin.js',
        hooks: ['cli', 'worker'],
        mcp: [{ name: 'static-demo', command: ['node', './dist/static-mcp.js'] }],
      },
    }));
    writeFileSync(join(source, 'dist', 'plugin.js'), `
      export default {
        apply(api, ctx) {
          if (ctx.runtime === 'cli') {
            api.cli.registerCommand({
              name: 'demo:hello',
              run({ args }) {
                api.config.set('lastName', args[0] || 'world');
                return 'hello ' + (args[0] || 'world');
              }
            });
          }
          if (ctx.runtime === 'worker') {
            api.worker.configureMcp.tap('apply-demo', (mcp) => {
              mcp.addMcpServer('dynamic-demo', {
                command: ['node', './dist/dynamic-mcp.js', '--session', mcp.sessionId],
                env: { BOT_ID: mcp.botId }
              });
            });
          }
        }
      };
    `);

    installLocalPlugin(source);

    const commands = await collectPluginCliCommands(['apply-demo']);
    expect(commands.map(command => command.name)).toEqual(['demo:hello']);
    expect(await commands[0].run({
      runtime: 'cli',
      pluginId: 'apply-demo',
      pluginDir: join(home, '.botmux', 'plugins', 'apply-demo', 'current'),
      packageName: '@botmux/plugin-apply-demo',
      version: '0.1.0',
      manifest: { schemaVersion: 1, id: 'apply-demo' },
      args: ['botmux'],
    })).toBe('hello botmux');
    expect(JSON.parse(readFileSync(join(home, '.botmux', 'plugins', 'apply-demo', 'config.json'), 'utf8')).lastName).toBe('botmux');

    const mcp = await resolvePluginMcpServers({ pluginIds: ['apply-demo'], botId: 'dev-bot', sessionId: 's-1' });
    expect(mcp.map(server => server.name)).toEqual(['static-demo', 'dynamic-demo']);
    expect(mcp[1].command).toEqual(['node', './dist/dynamic-mcp.js', '--session', 's-1']);
    expect(mcp[1].env).toEqual({ BOT_ID: 'dev-bot' });

    const path = writePluginMcpConfig('s-1', mcp);
    expect(path).toBe(pluginMcpConfigPath('s-1'));
    const config = JSON.parse(readFileSync(path!, 'utf8'));
    expect(config.mcpServers['dynamic-demo']).toMatchObject({
      command: 'node',
      args: ['./dist/dynamic-mcp.js', '--session', 's-1'],
      env: { BOT_ID: 'dev-bot' },
    });
  });
});
