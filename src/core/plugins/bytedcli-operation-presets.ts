import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { BYTEDCLI_OPERATION_CATALOG } from '../bytedcli-operation-catalog.js';
import type { BotConfig } from '../../bot-registry.js';
import { readGlobalConfig, type GlobalConfig } from '../../global-config.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { resolveEffectivePluginIds } from './effective.js';
import { isValidPluginId } from './ids.js';
import type { PluginRegistryFile } from './types.js';
import {
  parsePluginBytedcliOperationPresets, PLUGIN_BYTEDCLI_PRESETS_MAX_BYTES,
  type AvailableBytedcliOperationPreset, type PluginBytedcliOperationPresetsContribution,
  type PluginBytedcliOperationPresetsSnapshot,
} from './bytedcli-operation-presets-protocol.js';
export { parsePluginBytedcliOperationPresets } from './bytedcli-operation-presets-protocol.js';

/** Only a fixed declarative file inside the installed runtime is scanned. */
export function scanPluginBytedcliOperationPresets(runtimeDir: string): PluginBytedcliOperationPresetsContribution | undefined {
  const root = realpathSync(runtimeDir), directory = join(root, 'bytedcli'), file = join(directory, 'operation-presets.json');
  let before: Stats;
  try { before = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const dir = lstatSync(directory), rel = relative(root, realpathSync(file));
  if (dir.isSymbolicLink() || !dir.isDirectory() || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || before.size > PLUGIN_BYTEDCLI_PRESETS_MAX_BYTES || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid_plugin_bytedcli_operation_presets');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('invalid_plugin_bytedcli_operation_presets');
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
    const after = lstatSync(file), current = fstatSync(fd);
    if (count !== before.size || [after, current].some(stat => stat.ino !== before.ino || stat.dev !== before.dev
      || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs || stat.nlink !== 1)) throw new Error('invalid_plugin_bytedcli_operation_presets');
    try { return parsePluginBytedcliOperationPresets(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))); }
    catch { throw new Error('invalid_plugin_bytedcli_operation_presets'); }
  } finally { closeSync(fd); }
}

/** Presets are suggestions from the effective installed plugins, never authority. */
export function readPluginBytedcliOperationPresets(
  bot: Pick<BotConfig, 'plugins'>, global: Pick<GlobalConfig, 'plugins'> = readGlobalConfig(), registry: PluginRegistryFile = readPluginRegistry(),
): PluginBytedcliOperationPresetsSnapshot {
  const presets: AvailableBytedcliOperationPreset[] = [];
  const issues: Array<PluginBytedcliOperationPresetsSnapshot['issues'][number]> = [];
  for (const pluginId of resolveEffectivePluginIds(bot, global)) {
    const issue = (code: PluginBytedcliOperationPresetsSnapshot['issues'][number]['code']) => { if (issues.length < 64) issues.push(Object.freeze({ pluginId, code })); };
    const installed = registry.plugins[pluginId];
    if (!installed) { issue('plugin_not_installed'); continue; }
    const raw = installed.contributions?.bytedcliOperationPresets;
    if (raw === undefined) continue;
    try {
      if (installed.id !== pluginId || installed.manifest.id !== pluginId || typeof installed.version !== 'string'
        || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(installed.version) || installed.version.length > 128) throw new Error('invalid');
      const contribution = parsePluginBytedcliOperationPresets(raw);
      if (presets.length + contribution.presets.length > 64) { issue('too_many_presets'); continue; }
      for (const preset of contribution.presets) {
        const revision = 'sha256:' + createHash('sha256').update(JSON.stringify([pluginId, installed.version, preset])).digest('base64url');
        const machineWriteExceptions = BYTEDCLI_OPERATION_CATALOG.filter(row => row.effect === 'write' && preset.policy.rules[row.id] === 'machine').map(row => row.id);
        presets.push(Object.freeze({ ...preset, pluginId, pluginName: pluginId, pluginVersion: installed.version, revision, machineWriteExceptions: Object.freeze(machineWriteExceptions) }));
      }
    } catch { issue('invalid_contribution'); }
  }
  return Object.freeze({ presets: Object.freeze(presets), issues: Object.freeze(issues) });
}

export function selectPluginBytedcliOperationPreset(snapshot: PluginBytedcliOperationPresetsSnapshot, raw: unknown): AvailableBytedcliOperationPreset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_bytedcli_operation_preset_reference');
  const ref = raw as Record<string, unknown>;
  if (Object.keys(ref).length !== 3 || !isValidPluginId(ref.pluginId) || typeof ref.presetId !== 'string'
    || !/^[a-z][a-z0-9._-]{0,63}$/.test(ref.presetId) || typeof ref.revision !== 'string' || !/^sha256:[A-Za-z0-9_-]{43}$/.test(ref.revision)) throw new Error('invalid_bytedcli_operation_preset_reference');
  const preset = snapshot.presets.find(row => row.pluginId === ref.pluginId && row.id === ref.presetId);
  if (!preset) throw new Error('bytedcli_operation_preset_unavailable');
  if (preset.revision !== ref.revision) throw new Error('bytedcli_operation_preset_changed');
  return preset;
}
