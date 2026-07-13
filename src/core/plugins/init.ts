import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidPluginId, isValidPluginId } from './ids.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';

export const DEFAULT_PLUGIN_TEMPLATE_REPO = 'https://github.com/botmux-ai/botmux-plugin-template.git';
export const OFFICIAL_PLUGIN_SCOPE = '@botmux-ai';
export const OFFICIAL_PLUGIN_PACKAGE_PREFIX = `${OFFICIAL_PLUGIN_SCOPE}/plugin-`;
export const OFFICIAL_PLUGIN_REPO_PREFIX = 'botmux-plugin-';

export interface PluginInitOptions {
  cwd?: string;
  templateSource?: string;
  skipSelfTest?: boolean;
}

export interface PluginInitResult {
  pluginId: string;
  packageName: string;
  repoName: string;
  displayName: string;
  targetDir: string;
  commandPrefix: string;
  templateSource: string;
  selfTestRan: boolean;
}

function stripKnownPluginPrefix(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('plugin_init_missing_id');
  if (value.endsWith('/')) value = value.slice(0, -1);

  if (value.startsWith(OFFICIAL_PLUGIN_PACKAGE_PREFIX)) {
    value = value.slice(OFFICIAL_PLUGIN_PACKAGE_PREFIX.length);
  } else if (value.startsWith('@')) {
    throw new Error('plugin_init_invalid_package_scope');
  } else {
    value = basename(value);
    if (value.startsWith(OFFICIAL_PLUGIN_REPO_PREFIX)) {
      value = value.slice(OFFICIAL_PLUGIN_REPO_PREFIX.length);
    } else if (value.startsWith('plugin-')) {
      value = value.slice('plugin-'.length);
    }
  }
  return value;
}

export function normalizePluginInitName(raw: string): Pick<PluginInitResult, 'pluginId' | 'packageName' | 'repoName' | 'displayName' | 'commandPrefix'> {
  const pluginId = assertValidPluginId(stripKnownPluginPrefix(raw), 'plugin_init_id');
  const repoName = `${OFFICIAL_PLUGIN_REPO_PREFIX}${pluginId}`;
  const packageName = `${OFFICIAL_PLUGIN_PACKAGE_PREFIX}${pluginId}`;
  const displayName = pluginId
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { pluginId, packageName, repoName, displayName, commandPrefix: `${pluginId}:` };
}

function isLocalTemplateSource(source: string): boolean {
  if (source.startsWith('file:')) return true;
  if (source.startsWith('.') || source.startsWith('~') || isAbsolute(source)) return true;
  return existsSync(resolve(source));
}

function resolveLocalTemplateSource(source: string, cwd: string): string {
  if (source.startsWith('file:')) return fileURLToPath(source);
  if (source.startsWith('~/')) return resolve(process.env.HOME ?? '', source.slice(2));
  return isAbsolute(source) ? source : resolve(cwd, source);
}

function copyTemplateSource(source: string, targetDir: string, cwd: string): void {
  if (isLocalTemplateSource(source)) {
    const sourceDir = resolveLocalTemplateSource(source, cwd);
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`plugin_template_not_found:${source}`);
    cpSync(sourceDir, targetDir, {
      recursive: true,
      filter: src => basename(src) !== '.git' && basename(src) !== 'node_modules',
    });
    return;
  }
  execFileSync('git', ['clone', '--depth', '1', source, targetDir], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

type PluginTemplateVariables = Record<'pluginId' | 'packageName' | 'repoName' | 'displayName' | 'commandPrefix' | 'envPrefix', string>;

function templateVariables(normalized: ReturnType<typeof normalizePluginInitName>): PluginTemplateVariables {
  const envId = normalized.pluginId.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return {
    ...normalized,
    envPrefix: `BOTMUX_PLUGIN_${envId}`,
  };
}

function renderTemplateString(value: string, variables: PluginTemplateVariables, field: string): string {
  const rendered = value.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      throw new Error(`plugin_template_unknown_variable:${field}:${name}`);
    }
    return variables[name as keyof PluginTemplateVariables];
  });
  return rendered;
}

function renderTemplateValue(value: unknown, variables: PluginTemplateVariables, field: string): unknown {
  if (typeof value === 'string') return renderTemplateString(value, variables, field);
  if (Array.isArray(value)) return value.map((entry, index) => renderTemplateValue(entry, variables, `${field}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const rendered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    rendered[key] = renderTemplateValue(entry, variables, `${field}.${key}`);
  }
  return rendered;
}

function readTemplatePackage(templateRoot: string, variables: PluginTemplateVariables): Record<string, unknown> {
  const definitionPath = join(templateRoot, 'template.json');
  if (!existsSync(definitionPath)) throw new Error('plugin_template_definition_not_found');
  let definition: unknown;
  try {
    definition = JSON.parse(readFileSync(definitionPath, 'utf-8'));
  } catch {
    throw new Error('plugin_template_definition_invalid_json');
  }
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('plugin_template_definition_invalid');
  }
  const packageTemplate = (definition as Record<string, unknown>).package;
  if (!packageTemplate || typeof packageTemplate !== 'object' || Array.isArray(packageTemplate)) {
    throw new Error('plugin_template_package_missing');
  }
  return renderTemplateValue(packageTemplate, variables, 'template.package') as Record<string, unknown>;
}

function generatedPackageJson(packageTemplate: Record<string, unknown>, variables: PluginTemplateVariables): Record<string, unknown> {
  const { name: _name, keywords: rawKeywords, botmux: rawBotmux, ...rest } = packageTemplate;
  if (rawBotmux !== undefined && (!rawBotmux || typeof rawBotmux !== 'object' || Array.isArray(rawBotmux))) {
    throw new Error('plugin_template_botmux_manifest_invalid');
  }
  const keywords = Array.isArray(rawKeywords)
    ? rawKeywords.filter((value): value is string => typeof value === 'string')
    : [];
  if (!keywords.includes('botmux-plugin')) keywords.push('botmux-plugin');
  return {
    name: variables.packageName,
    ...rest,
    keywords,
    botmux: {
      ...((rawBotmux ?? {}) as Record<string, unknown>),
      id: variables.pluginId,
      displayName: variables.displayName,
    },
  };
}

function safeGeneratedRelativePath(value: string): string {
  const platformPath = value.split('/').join(sep);
  if (!platformPath || isAbsolute(platformPath) || platformPath === '..' || platformPath.startsWith(`..${sep}`)) {
    throw new Error(`plugin_template_output_path_invalid:${value}`);
  }
  return platformPath;
}

function generateTemplateTree(templateDir: string, outputDir: string, variables: PluginTemplateVariables): void {
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    throw new Error('plugin_template_directory_not_found');
  }
  const outputs = new Map<string, string>();
  mkdirSync(outputDir, { recursive: true });

  const visit = (sourceDir: string): void => {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const sourcePath = join(sourceDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`plugin_template_symlink_not_allowed:${relative(templateDir, sourcePath)}`);
      const sourceRelative = relative(templateDir, sourcePath).split(sep).join('/');
      let outputRelative = renderTemplateString(sourceRelative, variables, `path:${sourceRelative}`);
      const isTemplateFile = entry.isFile() && outputRelative.endsWith('.tmpl');
      if (isTemplateFile) outputRelative = outputRelative.slice(0, -'.tmpl'.length);
      if (outputRelative === 'gitignore') outputRelative = '.gitignore';
      const outputPath = join(outputDir, safeGeneratedRelativePath(outputRelative));
      const previous = outputs.get(outputRelative);
      if (previous) throw new Error(`plugin_template_output_collision:${outputRelative}:${previous}:${sourceRelative}`);
      outputs.set(outputRelative, sourceRelative);

      const stat = statSync(sourcePath);
      if (entry.isDirectory()) {
        mkdirSync(outputPath, { recursive: true, mode: stat.mode });
        visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (outputRelative === 'package.json') throw new Error('plugin_template_package_json_reserved');
      mkdirSync(resolve(outputPath, '..'), { recursive: true });
      if (isTemplateFile) {
        let source: string;
        try {
          source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(sourcePath));
        } catch {
          throw new Error(`plugin_template_text_invalid_utf8:${sourceRelative}`);
        }
        writeFileSync(outputPath, renderTemplateString(source, variables, `file:${sourceRelative}`), { mode: stat.mode });
      } else {
        copyFileSync(sourcePath, outputPath);
        chmodSync(outputPath, stat.mode);
      }
    }
  };

  visit(templateDir);
}

function generatePluginProject(templateRoot: string, outputDir: string, normalized: ReturnType<typeof normalizePluginInitName>): void {
  const variables = templateVariables(normalized);
  const packageTemplate = readTemplatePackage(templateRoot, variables);
  generateTemplateTree(join(templateRoot, 'template'), outputDir, variables);
  writeFileSync(join(outputDir, 'package.json'), `${JSON.stringify(generatedPackageJson(packageTemplate, variables), null, 2)}\n`);
}

function runOptionalGitInit(targetDir: string): void {
  try {
    execFileSync('git', ['init'], { cwd: targetDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  } catch {
    // A plugin directory is still usable without git; init should not fail only
    // because git is missing or unavailable in a restricted environment.
  }
}

function runSelfTest(targetDir: string): void {
  execFileSync('npm', ['install'], {
    cwd: targetDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    timeout: 180_000,
  });
  execFileSync('npm', ['test'], {
    cwd: targetDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    timeout: 180_000,
  });
}

export function initPlugin(rawName: string, options: PluginInitOptions = {}): PluginInitResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const normalized = normalizePluginInitName(rawName);
  if (readPluginRegistry().plugins[normalized.pluginId]) throw new Error(`plugin_init_id_already_installed:${normalized.pluginId}`);
  const targetDir = join(cwd, normalized.repoName);
  if (existsSync(targetDir)) throw new Error(`plugin_init_target_exists:${targetDir}`);
  const templateSource = options.templateSource || process.env.BOTMUX_PLUGIN_TEMPLATE_SOURCE || DEFAULT_PLUGIN_TEMPLATE_REPO;
  const tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-plugin-init-'));
  const tmpTemplate = join(tmpRoot, 'template');
  const tmpGenerated = join(tmpRoot, 'generated');
  try {
    copyTemplateSource(templateSource, tmpTemplate, cwd);
    generatePluginProject(tmpTemplate, tmpGenerated, normalized);
    if (!options.skipSelfTest) runSelfTest(tmpGenerated);
    cpSync(tmpGenerated, targetDir, { recursive: true });
    runOptionalGitInit(targetDir);
    return {
      ...normalized,
      targetDir,
      templateSource,
      selfTestRan: !options.skipSelfTest,
    };
  } catch (err) {
    rmSync(targetDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function resolveOfficialPluginPackageSpec(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('@') || trimmed.startsWith('.') || trimmed.startsWith('~') || isAbsolute(trimmed) || existsSync(resolve(trimmed))) return trimmed;
  return isValidPluginId(trimmed) ? `${OFFICIAL_PLUGIN_PACKAGE_PREFIX}${trimmed}` : trimmed;
}
