import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parsePluginPackageManifest } from '../src/core/plugins/manifest.js';
import { scanPluginContributions } from '../src/core/plugins/convention-scanner.js';
import { normalizePluginIdList } from '../src/core/plugins/ids.js';
import { pluginMaterializedPath, pluginRegistryPath, resolvePluginPath } from '../src/core/plugins/paths.js';
import { readPluginRegistry, upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';
import { resolveEffectivePluginIds, updateBotPluginOverride } from '../src/core/plugins/effective.js';
import { assertPluginBindingTransition, enabledPluginDependents } from '../src/core/plugins/dependencies.js';
import { pluginPm2AppName } from '../src/core/plugins/pm2.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { collectPluginCliCommands } from '../src/core/plugins/runtime.js';
import { dematerializePlugin, materializePlugin } from '../src/core/plugins/materializer.js';
import { resolvePluginSkillPackages } from '../src/core/plugins/skills.js';
import { readSkillRegistry } from '../src/services/skill-registry-store.js';

describe('plugin manifest and registry basics', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', join(home, '.codex'));
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

  it('parses a package.json botmux manifest with identity, dependencies, and service mode', () => {
    const pkg = parsePluginPackageManifest({
      name: '@botmux/plugin-agent-chrome',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'agent-chrome',
        displayName: 'Agent Chrome',
        dependencies: { plugins: ['gitlab'] },
        service: { mode: 'auto' },
      },
    });

    expect(pkg.botmux.id).toBe('agent-chrome');
    expect(pkg.botmux.dependencies?.plugins).toEqual(['gitlab']);
    expect(pkg.botmux.service?.mode).toBe('auto');
  });

  it('does not gate plugin protocol compatibility on schemaVersion metadata', () => {
    for (const botmux of [
      { id: 'without-schema' },
      { schemaVersion: 999, id: 'future-schema', futureCapability: true },
    ]) {
      expect(parsePluginPackageManifest({
        name: `@botmux/plugin-${botmux.id}`,
        version: '0.1.0',
        keywords: ['botmux-plugin'],
        botmux,
      }).botmux.id).toBe(botmux.id);
    }
  });

  it('enforces plugin dependencies without implicitly changing the enabled set', () => {
    const now = new Date().toISOString();
    const registry = {
      schemaVersion: 1 as const,
      plugins: {
        base: {
          id: 'base',
          packageName: '@botmux/plugin-base',
          version: '0.1.0',
          source: { type: 'local' as const, spec: '/base' },
          manifest: { schemaVersion: 1 as const, id: 'base' },
          installedAt: now,
          updatedAt: now,
        },
        addon: {
          id: 'addon',
          packageName: '@botmux/plugin-addon',
          version: '0.1.0',
          source: { type: 'local' as const, spec: '/addon' },
          manifest: { schemaVersion: 1 as const, id: 'addon', dependencies: { plugins: ['base'] } },
          installedAt: now,
          updatedAt: now,
        },
      },
    };

    expect(() => assertPluginBindingTransition('addon', true, [], registry))
      .toThrow(/plugin_dependency_not_enabled:addon:base/);
    expect(() => assertPluginBindingTransition('addon', true, ['base'], registry)).not.toThrow();
    expect(() => assertPluginBindingTransition('base', false, ['base', 'addon'], registry))
      .toThrow(/plugin_has_enabled_dependents:base:addon/);
    expect(enabledPluginDependents('base', ['addon'], registry)).toEqual(['addon']);
    expect(enabledPluginDependents('base', [], registry)).toEqual([]);
  });

  it('derives the PM2 service name only from the unique plugin id', () => {
    expect(pluginPm2AppName('agent-chrome')).toBe('botmux-plugin-agent-chrome');
    expect(pluginPm2AppName('demo-addon')).toBe('botmux-plugin-demo-addon');
  });

  it('ignores unconsumed manifest fields for forward compatibility', () => {
    const pkg = parsePluginPackageManifest({
      name: '@botmux/plugin-compatible',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 999,
        id: 'compatible-plugin',
        displayName: 'Compatible Plugin',
        main: '../outside.js',
        hooks: ['worker'],
        capabilities: ['network'],
        skills: [{ path: './skills/demo' }],
        mcp: [{ command: ['node', './mcp/index.js'] }],
        dashboard: [{ entry: './dashboard/index.js' }],
        services: { legacy: { mode: 'manual' } },
        futureCapability: { enabled: true },
        dependencies: { plugins: ['base'] },
        service: { mode: 'auto' },
      },
    });

    expect(pkg.botmux).toEqual({
      schemaVersion: 1,
      id: 'compatible-plugin',
      displayName: 'Compatible Plugin',
      dependencies: { plugins: ['base'] },
      service: { mode: 'auto' },
    });
  });

  it('requires package versions to use standard semver metadata', () => {
    expect(() => parsePluginPackageManifest({
      name: '@botmux/plugin-bad',
      version: '../../outside',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'bad-plugin' },
    })).toThrow(/invalid_plugin_package_version/);
    expect(parsePluginPackageManifest({
      name: '@botmux/plugin-good',
      version: '1.2.3-beta.1+build.7',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'good-plugin' },
    }).version).toBe('1.2.3-beta.1+build.7');
  });

  it('scans fixed plugin convention directories into contributions', () => {
    const root = join(home, 'plugin-convention-src');
    mkdirSync(join(root, 'skills', 'browser'), { recursive: true });
    mkdirSync(join(root, 'mcp'), { recursive: true });
    mkdirSync(join(root, 'dashboard'), { recursive: true });
    mkdirSync(join(root, 'cli'), { recursive: true });
    mkdirSync(join(root, 'service'), { recursive: true });
    writeFileSync(join(root, 'skills', 'browser', 'SKILL.md'), '# Browser\n');
    writeFileSync(join(root, 'mcp', 'server.js'), 'process.stdin.resume();\n');
    writeFileSync(join(root, 'mcp', 'index.json'), JSON.stringify({
      command: ['node', './mcp/server.js'],
      env: { ACS_URL: 'http://127.0.0.1:9300' },
    }));
    writeFileSync(join(root, 'dashboard', 'index.js'), 'export default function Demo() { return null; }\n');
    writeFileSync(join(root, 'cli', 'index.js'), 'export default {};\n');
    writeFileSync(join(root, 'cli', 'commands.json'), JSON.stringify({
      schemaVersion: 1,
      commands: [{ name: 'chrome', description: 'Open Chrome tooling' }],
    }));
    writeFileSync(join(root, 'service', 'index.js'), 'export default { pm2: { script: "./service/server.js" } };\n');

    expect(scanPluginContributions(root, { schemaVersion: 1, id: 'agent-chrome', service: { mode: 'auto' } })).toEqual({
      skills: [{ name: 'browser', path: 'skills/browser' }],
      mcp: { name: 'agent-chrome', transport: 'stdio', command: ['node', './mcp/server.js'], env: { ACS_URL: 'http://127.0.0.1:9300' } },
      dashboard: [{ id: 'agent-chrome', route: '#/plugins/agent-chrome', entry: 'dashboard/index.js' }],
      cli: {
        entry: 'cli/index.js',
        commandsPath: 'cli/commands.json',
        commands: [{ name: 'chrome', description: 'Open Chrome tooling' }],
      },
      service: { entry: 'service/index.js', mode: 'auto' },
    });
  });

  it('rejects unsafe, missing, and runtime-templated static MCP command paths during scanning', () => {
    const makeSource = (name: string, command: string[], env?: Record<string, string>) => {
      const root = join(home, name);
      mkdirSync(join(root, 'mcp'), { recursive: true });
      writeFileSync(join(root, 'mcp', 'index.json'), JSON.stringify({ command, ...(env ? { env } : {}) }));
      return root;
    };

    expect(() => scanPluginContributions(
      makeSource('missing-mcp', ['node', './mcp/missing.js']),
      { schemaVersion: 1, id: 'missing-mcp' },
    )).toThrow(/plugin_mcp_command_path_not_found/);
    expect(() => scanPluginContributions(
      makeSource('unsafe-mcp', ['node', '../outside.js']),
      { schemaVersion: 1, id: 'unsafe-mcp' },
    )).toThrow(/escapes_root/);
    expect(() => scanPluginContributions(
      makeSource('templated-mcp', ['node', './mcp/server.js'], { SESSION_ID: '${sessionId}' }),
      { schemaVersion: 1, id: 'templated-mcp' },
    )).toThrow(/unsupported_plugin_mcp_runtime_template/);
  });

  it('scans Streamable HTTP MCP declarations without a local command', () => {
    const root = join(home, 'http-mcp');
    mkdirSync(join(root, 'mcp'), { recursive: true });
    writeFileSync(join(root, 'mcp', 'index.json'), JSON.stringify({
      transport: 'streamable-http',
      url: 'https://mcp.example.test/api',
      headers: { Authorization: 'Bearer test' },
    }));
    expect(scanPluginContributions(root, { schemaVersion: 1, id: 'http-mcp' })?.mcp).toEqual({
      name: 'http-mcp',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/api',
      headers: { Authorization: 'Bearer test' },
    });
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
    const root = join(home, '.botmux', 'plugins', 'agent-chrome', 'dist');
    mkdirSync(root, { recursive: true });
    expect(resolvePluginPath(root, './mcp/plugin.js')).toBe(join(root, 'mcp/plugin.js'));
    expect(() => resolvePluginPath(root, '../other')).toThrow(/escapes_root/);
  });

  it('combines global plugins with per-Bot additions', () => {
    expect(resolveEffectivePluginIds(
      { plugins: ['agent-chrome', 'gitlab'] },
      { plugins: ['gitlab', 'lint-bot'] },
    )).toEqual(['gitlab', 'lint-bot', 'agent-chrome']);
    expect(resolveEffectivePluginIds({}, { plugins: ['gitlab', 'lint-bot'] })).toEqual(['gitlab', 'lint-bot']);
    expect(resolveEffectivePluginIds({ plugins: [] }, { plugins: ['gitlab'] })).toEqual(['gitlab']);
    expect(updateBotPluginOverride(undefined, 'chrome', true)).toEqual(['chrome']);
    expect(updateBotPluginOverride(undefined, 'gitlab', false)).toEqual([]);
  });

  it('installs a local plugin directory into plugin scope without enabling it', () => {
    const source = join(home, 'plugin-src');
    mkdirSync(join(source, 'dist', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-local-demo',
      version: '0.2.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'local-demo',
      },
    }));
    writeFileSync(join(source, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(source, 'dist', 'skills', 'demo', 'SKILL.md'), '# Demo\n');

    const result = installLocalPlugin(source);

    expect(result.record.id).toBe('local-demo');
    expect(result.runtimeDir).toBe(join(home, '.botmux', 'plugins', 'local-demo', 'dist'));
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'package'))).toBe(false);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'package.json'))).toBe(false);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'versions'))).toBe(false);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'current'))).toBe(false);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'config.json'))).toBe(true);
    expect(existsSync(join(home, '.botmux', 'plugins', 'local-demo', 'settings.json'))).toBe(true);
    expect(readPluginRegistry().plugins['local-demo'].packageName).toBe('@botmux/plugin-local-demo');
    expect(readSkillRegistry().skills.demo).toBeUndefined();
    expect(existsSync(pluginMaterializedPath('local-demo'))).toBe(false);

    writeFileSync(join(home, '.botmux', 'plugins', 'local-demo', 'config.json'), '{"preserved":true}\n');
    const updatedPackage = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    updatedPackage.version = '0.3.0';
    writeFileSync(join(source, 'package.json'), JSON.stringify(updatedPackage));
    writeFileSync(join(source, 'dist', 'skills', 'demo', 'SKILL.md'), '# Demo v2\n');
    const updated = installLocalPlugin(source);
    expect(updated.runtimeDir).toBe(result.runtimeDir);
    expect(readPluginRegistry().plugins['local-demo'].version).toBe('0.3.0');
    expect(readFileSync(join(updated.runtimeDir, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo v2\n');
    expect(JSON.parse(readFileSync(join(home, '.botmux', 'plugins', 'local-demo', 'config.json'), 'utf8')).preserved).toBe(true);
  });

  it('requires a built dist directory before creating plugin state', () => {
    const source = join(home, 'plugin-without-dist');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-without-dist',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'without-dist' },
    }));

    expect(() => installLocalPlugin(source)).toThrow(/plugin_dist_not_found/);
    expect(existsSync(join(home, '.botmux', 'plugins', 'without-dist'))).toBe(false);
    expect(readPluginRegistry().plugins['without-dist']).toBeUndefined();
  });

  it('links only the built dist directory for local development', () => {
    const source = join(home, 'linked-plugin-src');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-linked-demo',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'linked-demo' },
    }));
    writeFileSync(join(source, 'dist', 'marker.txt'), 'v1\n');

    const result = installLocalPlugin(source, { link: true });
    expect(lstatSync(result.runtimeDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(result.runtimeDir, 'marker.txt'), 'utf8')).toBe('v1\n');

    writeFileSync(join(source, 'dist', 'marker.txt'), 'v2\n');
    expect(readFileSync(join(result.runtimeDir, 'marker.txt'), 'utf8')).toBe('v2\n');
  });

  it('collects CLI commands from commands.json and runs matching handler map entries lazily', async () => {
    const source = join(home, 'plugin-apply-src');
    mkdirSync(join(source, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-apply-demo',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'apply-demo',
      },
    }));
    writeFileSync(join(source, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(source, 'dist', 'cli', 'commands.json'), JSON.stringify({
      schemaVersion: 1,
      commands: [{ name: 'demo:hello', description: 'Say hello' }],
    }));
    writeFileSync(join(source, 'dist', 'cli', 'index.js'), `
      export default {
        'demo:hello'({ args }) {
          return 'hello ' + (args[0] || 'world');
        }
      };
    `);

    installLocalPlugin(source);

    const commands = await collectPluginCliCommands(['apply-demo']);
    expect(commands.map(command => `${command.name}:${command.pluginId}`)).toEqual(['demo:hello:apply-demo']);
    expect(await commands[0].run({
      runtime: 'cli',
      pluginId: 'apply-demo',
      pluginDir: join(home, '.botmux', 'plugins', 'apply-demo', 'dist'),
      packageName: '@botmux/plugin-apply-demo',
      version: '0.1.0',
      manifest: { schemaVersion: 1, id: 'apply-demo' },
      args: ['botmux'],
    })).toBe('hello botmux');
  });

  it('keeps plugin skills isolated while materializing MCP and contribution state markers', () => {
    const source = join(home, 'plugin-full-src');
    const runtime = join(source, 'dist');
    mkdirSync(join(runtime, 'skills', 'browser'), { recursive: true });
    mkdirSync(join(runtime, 'mcp'), { recursive: true });
    mkdirSync(join(runtime, 'cli'), { recursive: true });
    mkdirSync(join(runtime, 'dashboard'), { recursive: true });
    mkdirSync(join(runtime, 'service'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux/plugin-full-demo',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: {
        schemaVersion: 1,
        id: 'full-demo',
        service: { mode: 'manual' },
      },
    }));
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(runtime, 'skills', 'browser', 'SKILL.md'), '# Browser\n');
    writeFileSync(join(runtime, 'mcp', 'server.js'), 'process.stdin.resume();\n');
    writeFileSync(join(runtime, 'mcp', 'index.json'), JSON.stringify({
      command: ['node', './mcp/server.js'],
      env: { ACS_URL: 'http://127.0.0.1:9300' },
    }));
    writeFileSync(join(runtime, 'cli', 'commands.json'), JSON.stringify({
      schemaVersion: 1,
      commands: [{ name: 'browser:ping' }],
    }));
    writeFileSync(join(runtime, 'cli', 'index.js'), 'export default { "browser:ping": () => "pong" };\n');
    writeFileSync(join(runtime, 'dashboard', 'index.js'), 'export default function Demo() { return null; }\n');
    writeFileSync(join(runtime, 'service', 'index.js'), 'export default { pm2: { script: "./service/server.js" } };\n');

    const codexConfigPath = join(home, '.codex', 'config.toml');
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(codexConfigPath, [
      '[mcp_servers.keep]',
      'command = "keep-server"',
      '',
      '[mcp_servers."browser"]',
      'command = "legacy-relative-command"',
      '',
      '[mcp_servers."browser".env]',
      'LEGACY = "true"',
      '# <<< botmux plugin full-demo',
      '',
    ].join('\n'));

    const codexConfigBefore = readFileSync(codexConfigPath, 'utf8');
    installLocalPlugin(source);
    const materialized = materializePlugin('full-demo');

    expect(materialized.skills?.map(skill => skill.name)).toEqual(['browser']);
    expect(materialized.mcp?.map(server => `${server.cliId}:${server.name}`)).toEqual(['botmux-gateway:full-demo']);
    expect(materialized.cli?.map(command => command.name)).toEqual(['browser:ping']);
    expect(materialized.dashboard).toEqual([{ id: 'full-demo', entry: 'dashboard/index.js' }]);
    expect(materialized.service).toEqual([{ name: 'full-demo' }]);
    expect(readSkillRegistry().skills.browser).toBeUndefined();
    const pluginSkills = resolvePluginSkillPackages(['full-demo']);
    expect(pluginSkills.diagnostics).toEqual([]);
    expect(pluginSkills.skills.map(skill => skill.name)).toEqual(['browser']);
    expect(pluginSkills.skills[0].source).toMatchObject({ type: 'plugin', pluginId: 'full-demo' });
    expect(readFileSync(codexConfigPath, 'utf8')).toBe(codexConfigBefore);
    expect(existsSync(pluginMaterializedPath('full-demo'))).toBe(true);

    dematerializePlugin('full-demo');

    expect(readSkillRegistry().skills.browser).toBeUndefined();
    expect(readFileSync(codexConfigPath, 'utf8')).toBe(codexConfigBefore);
    expect(existsSync(pluginMaterializedPath('full-demo'))).toBe(false);
  });
});
