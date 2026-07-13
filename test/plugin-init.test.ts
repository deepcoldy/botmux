import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_PLUGIN_TEMPLATE_PACKAGE,
  initPlugin,
  normalizePluginInitName,
  resolveOfficialPluginPackageSpec,
} from '../src/core/plugins/init.js';
import { upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function createTemplateFixture(root: string): string {
  const template = join(root, 'template-src');
  const project = join(template, 'template');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  mkdirSync(join(project, 'src', 'cli'), { recursive: true });
  mkdirSync(join(project, 'src', 'dashboard'), { recursive: true });
  mkdirSync(join(project, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(project, 'src', 'service'), { recursive: true });
  mkdirSync(join(project, 'skills', '{{pluginId}}'), { recursive: true });
  mkdirSync(join(project, 'assets'), { recursive: true });
  writeJson(join(template, 'package.json'), {
    name: '@botmux-ai/plugin-test-template',
    version: '0.0.0',
    files: ['template.json', 'template/'],
  });
  writeJson(join(template, 'template.json'), {
    package: {
      version: '0.1.0',
      description: 'Botmux plugin: {{displayName}}.',
      type: 'module',
      keywords: ['botmux-plugin'],
      scripts: {
        test: 'node ./scripts/validate.mjs',
      },
      botmux: {
        schemaVersion: 1,
        service: { mode: 'manual' },
      },
    },
  });
  writeFileSync(join(project, 'scripts', 'validate.mjs'), `
    import { readFileSync } from 'node:fs';
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    if (!pkg.name.startsWith('@botmux-ai/plugin-')) throw new Error('bad package name');
    if (!pkg.botmux.id || pkg.botmux.id.includes(' ')) throw new Error('bad plugin id');
    console.log('ok');
  `);
  writeFileSync(join(project, 'src', 'cli', 'index.js.tmpl'), `
    export default {
      '{{commandPrefix}}hello': { description: 'hello', run() { return '{{pluginId}}'; } },
      '{{commandPrefix}}set-config': { run() {} },
      '{{commandPrefix}}show-config': { run() {} },
    };
  `);
  writeFileSync(join(project, 'src', 'dashboard', 'index.js.tmpl'), 'export default function PluginDashboard() { return "{{displayName}} dashboard"; }\n');
  writeFileSync(join(project, 'src', 'mcp', 'index.js'), 'export default { command: ["node", "./mcp/server.js"] };\n');
  writeFileSync(join(project, 'src', 'service', 'index.js.tmpl'), 'export default { mode: "manual", pm2: { script: "./service/server.js", env: { PORT: process.env.{{envPrefix}}_PORT ?? "9360" } } };\n');
  writeFileSync(join(project, 'skills', '{{pluginId}}', 'SKILL.md.tmpl'), '---\nname: {{pluginId}}-skill\n---\n# {{displayName}} Skill\n');
  writeFileSync(join(project, 'README.md.tmpl'), '# {{repoName}}\n\nRun `botmux {{commandPrefix}}hello`.\n');
  writeFileSync(join(project, 'gitignore'), 'node_modules/\n');
  writeFileSync(join(project, 'assets', 'logo.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42]));
  return template;
}

function packTemplateFixture(template: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  const result = JSON.parse(execFileSync('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ], { cwd: template, encoding: 'utf-8' }));
  return join(destination, result[0].filename);
}

describe('plugin init', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-init-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'botmux-plugin-init-workspace-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('normalizes short, repo-prefixed, and scoped package names to the same plugin identity', () => {
    expect(normalizePluginInitName('agent-chrome')).toMatchObject({
      pluginId: 'agent-chrome',
      repoName: 'botmux-plugin-agent-chrome',
      packageName: '@botmux-ai/plugin-agent-chrome',
      displayName: 'Agent Chrome',
      commandPrefix: 'agent-chrome:',
    });
    expect(normalizePluginInitName('botmux-plugin-agent-chrome').pluginId).toBe('agent-chrome');
    expect(normalizePluginInitName('@botmux-ai/plugin-agent-chrome').pluginId).toBe('agent-chrome');
    expect(() => normalizePluginInitName('@other/plugin-agent-chrome')).toThrow(/plugin_init_invalid_package_scope/);
    expect(() => normalizePluginInitName('Bad Plugin')).toThrow(/invalid_plugin_init_id/);
  });

  it('uses the official npm template package by default', () => {
    expect(DEFAULT_PLUGIN_TEMPLATE_PACKAGE).toBe('@botmux-ai/plugin-template');
  });

  it('resolves short install specs to the official npm package scope', () => {
    expect(resolveOfficialPluginPackageSpec('agent-chrome')).toBe('@botmux-ai/plugin-agent-chrome');
    expect(resolveOfficialPluginPackageSpec('@botmux-ai/plugin-agent-chrome')).toBe('@botmux-ai/plugin-agent-chrome');
    expect(resolveOfficialPluginPackageSpec('file:./plugin.tgz')).toBe('file:./plugin.tgz');
  });

  it('creates a plugin repository from a local template source and runs self-test', () => {
    const template = createTemplateFixture(workspace);
    const result = initPlugin('@botmux-ai/plugin-agent-chrome', { cwd: workspace, templateSource: template });

    expect(result.selfTestRan).toBe(true);
    expect(result.targetDir).toBe(join(workspace, 'botmux-plugin-agent-chrome'));
    expect(existsSync(join(result.targetDir, '.git'))).toBe(true);
    expect(existsSync(join(result.targetDir, '.gitignore'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(result.targetDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@botmux-ai/plugin-agent-chrome');
    expect(pkg.description).toBe('Botmux plugin: Agent Chrome.');
    expect(pkg.botmux.id).toBe('agent-chrome');
    expect(pkg.botmux.displayName).toBe('Agent Chrome');
    expect(existsSync(join(result.targetDir, 'package-lock.json'))).toBe(true);
    expect(readFileSync(join(result.targetDir, 'src', 'cli', 'index.js'), 'utf-8')).toContain("'agent-chrome:hello'");
    expect(existsSync(join(result.targetDir, 'skills', 'agent-chrome', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(result.targetDir, 'src', 'mcp', 'index.js'), 'utf-8')).toContain('./mcp/server.js');
    expect(readFileSync(join(result.targetDir, 'assets', 'logo.bin'))).toEqual(Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42]));
  });

  it('creates a plugin repository from an npm template tarball without running its lifecycle scripts', () => {
    const template = createTemplateFixture(workspace);
    const lifecycleMarker = join(workspace, 'template-lifecycle-ran');
    const pkg = JSON.parse(readFileSync(join(template, 'package.json'), 'utf-8'));
    pkg.scripts = {
      preinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(lifecycleMarker)}, 'ran')"`,
    };
    writeJson(join(template, 'package.json'), pkg);
    const tarball = packTemplateFixture(template, join(workspace, 'packed'));

    const result = initPlugin('npm-template-test', {
      cwd: workspace,
      templateSource: tarball,
      skipSelfTest: true,
    });

    expect(result.templateSource).toBe(tarball);
    expect(existsSync(join(result.targetDir, 'package.json'))).toBe(true);
    expect(existsSync(lifecycleMarker)).toBe(false);
  });

  it('rejects an npm package that does not contain a generation template', () => {
    const invalidPackage = join(workspace, 'not-a-template');
    mkdirSync(invalidPackage, { recursive: true });
    writeJson(join(invalidPackage, 'package.json'), {
      name: '@botmux-ai/not-a-template',
      version: '0.0.0',
    });
    const tarball = packTemplateFixture(invalidPackage, join(workspace, 'invalid-packed'));

    expect(() => initPlugin('invalid-template-test', {
      cwd: workspace,
      templateSource: tarball,
      skipSelfTest: true,
    })).toThrow(/plugin_template_expected_one_package_found_0/);
    expect(existsSync(join(workspace, 'botmux-plugin-invalid-template-test'))).toBe(false);
  });

  it('refuses to overwrite an existing target directory', () => {
    const template = createTemplateFixture(workspace);
    mkdirSync(join(workspace, 'botmux-plugin-agent-chrome'));

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template, skipSelfTest: true }))
      .toThrow(/plugin_init_target_exists/);
  });

  it('refuses to create a plugin id that is already installed', () => {
    const now = new Date().toISOString();
    upsertInstalledPlugin({
      id: 'agent-chrome',
      packageName: '@botmux-ai/plugin-agent-chrome',
      version: '0.1.0',
      source: { type: 'npm', spec: '@botmux-ai/plugin-agent-chrome' },
      manifest: { schemaVersion: 1, id: 'agent-chrome' },
      installedAt: now,
      updatedAt: now,
    });

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: createTemplateFixture(workspace), skipSelfTest: true }))
      .toThrow(/plugin_init_id_already_installed/);
  });

  it('cleans up the target directory when template copy fails', () => {
    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: join(workspace, 'missing-template'), skipSelfTest: true }))
      .toThrow(/plugin_template_not_found/);
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });

  it('rejects unknown template variables without leaving a partial project', () => {
    const template = createTemplateFixture(workspace);
    writeFileSync(join(template, 'template', 'bad.txt.tmpl'), '{{unknownValue}}\n');

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template, skipSelfTest: true }))
      .toThrow(/plugin_template_unknown_variable/);
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });

  it('rejects generated output collisions', () => {
    const template = createTemplateFixture(workspace);
    writeFileSync(join(template, 'template', 'collision.txt'), 'plain\n');
    writeFileSync(join(template, 'template', 'collision.txt.tmpl'), '{{pluginId}}\n');

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template, skipSelfTest: true }))
      .toThrow(/plugin_template_output_collision/);
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });

  it('reserves package.json for structured generation', () => {
    const template = createTemplateFixture(workspace);
    writeFileSync(join(template, 'template', 'package.json'), '{}\n');

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template, skipSelfTest: true }))
      .toThrow(/plugin_template_package_json_reserved/);
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });

  it('requires rendered .tmpl files to be valid UTF-8 text', () => {
    const template = createTemplateFixture(workspace);
    writeFileSync(join(template, 'template', 'bad.bin.tmpl'), Buffer.from([0xff, 0xfe, 0x00]));

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template, skipSelfTest: true }))
      .toThrow(/plugin_template_text_invalid_utf8/);
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });

  it('cleans up when the generated project self-test fails', () => {
    const template = createTemplateFixture(workspace);
    const definitionPath = join(template, 'template.json');
    const definition = JSON.parse(readFileSync(definitionPath, 'utf-8'));
    definition.package.scripts.test = 'node -e "process.exit(7)"';
    writeJson(definitionPath, definition);

    expect(() => initPlugin('agent-chrome', { cwd: workspace, templateSource: template }))
      .toThrow();
    expect(existsSync(join(workspace, 'botmux-plugin-agent-chrome'))).toBe(false);
  });
});
