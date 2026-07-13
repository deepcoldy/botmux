import { assertValidPluginId, isValidPluginId } from './ids.js';
import type {
  BotmuxPluginManifest,
  PluginPackageManifest,
  PluginServiceConfig,
} from './types.js';

const PACKAGE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${field}`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readDependencies(raw: unknown): BotmuxPluginManifest['dependencies'] {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, 'botmux_dependencies');
  const out: BotmuxPluginManifest['dependencies'] = {};
  if (record.plugins !== undefined) {
    if (!Array.isArray(record.plugins)) throw new Error('invalid_botmux_dependencies_plugins');
    const deps: string[] = [];
    for (const id of record.plugins) {
      if (!isValidPluginId(id)) throw new Error(`invalid_plugin_dependency:${id}`);
      if (!deps.includes(id)) deps.push(id);
    }
    if (deps.length > 0) out.plugins = deps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readService(raw: unknown): PluginServiceConfig | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, 'botmux_service');
  const mode = record.mode === undefined ? 'manual' : record.mode;
  if (mode !== 'manual' && mode !== 'auto') throw new Error('invalid_plugin_service_mode');
  return { mode };
}

export function parseBotmuxManifest(raw: unknown): BotmuxPluginManifest {
  const record = asRecord(raw, 'botmux_manifest');
  const id = assertValidPluginId(record.id, 'botmux_plugin_id');
  const displayName = optionalString(record.displayName);
  const dependencies = readDependencies(record.dependencies);
  const service = readService(record.service);
  return {
    schemaVersion: 1,
    id,
    ...(displayName ? { displayName } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(service ? { service } : {}),
  };
}

export function parsePluginPackageManifest(raw: unknown): PluginPackageManifest {
  const record = asRecord(raw, 'package_json');
  const name = optionalString(record.name);
  const version = optionalString(record.version);
  if (!name) throw new Error('plugin_package_missing_name');
  if (!version) throw new Error('plugin_package_missing_version');
  if (!PACKAGE_VERSION_RE.test(version)) throw new Error('invalid_plugin_package_version');
  const botmux = parseBotmuxManifest(record.botmux);
  const keywords = Array.isArray(record.keywords)
    ? record.keywords.filter((value): value is string => typeof value === 'string')
    : undefined;
  if (!keywords?.includes('botmux-plugin')) throw new Error('plugin_package_missing_keyword');
  return {
    name,
    version,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    keywords,
    botmux,
  };
}
