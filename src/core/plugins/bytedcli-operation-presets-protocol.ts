import { parseBytedcliOperationPolicy, type BytedcliOperationPolicy } from '../bytedcli-operation-policy-config.js';

export const PLUGIN_BYTEDCLI_PRESETS_SCHEMA = 'botmux.bytedcli-operation-presets.v1' as const;
export const PLUGIN_BYTEDCLI_PRESETS_MAX_BYTES = 256 * 1024;
export interface PluginBytedcliOperationPreset {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly policy: BytedcliOperationPolicy;
}
export interface PluginBytedcliOperationPresetsContribution {
  readonly schema: typeof PLUGIN_BYTEDCLI_PRESETS_SCHEMA;
  readonly presets: readonly PluginBytedcliOperationPreset[];
}
export interface AvailableBytedcliOperationPreset extends PluginBytedcliOperationPreset {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly revision: string;
  readonly machineWriteExceptions: readonly string[];
}
export interface PluginBytedcliOperationPresetReference {
  readonly pluginId: string;
  readonly presetId: string;
  readonly revision: string;
}
export interface PluginBytedcliOperationPresetsSnapshot {
  readonly presets: readonly AvailableBytedcliOperationPreset[];
  readonly issues: readonly { readonly pluginId: string; readonly code: 'invalid_contribution' | 'plugin_not_installed' | 'too_many_presets' }[];
}
function invalid(): never { throw new Error('invalid_plugin_bytedcli_operation_presets'); }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  if (Reflect.ownKeys(raw).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    return typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) invalid();
  return raw as Record<string, unknown>;
}
function text(raw: unknown, maximum: number): string {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)
    || new TextEncoder().encode(raw).length > maximum) invalid();
  return raw.trim();
}
export function parsePluginBytedcliOperationPresets(raw: unknown): PluginBytedcliOperationPresetsContribution {
  const root = record(raw);
  if (Object.keys(root).length !== 2 || root.schema !== PLUGIN_BYTEDCLI_PRESETS_SCHEMA
    || !Array.isArray(root.presets) || root.presets.length === 0 || root.presets.length > 8) invalid();
  const seen = new Set<string>();
  const presets = root.presets.map(value => {
    const row = record(value);
    if (Object.keys(row).some(key => !['id', 'title', 'description', 'policy'].includes(key))) invalid();
    const id = row.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(id) || seen.has(id)) invalid();
    seen.add(id);
    const title = text(row.title, 128);
    const description = row.description === undefined ? undefined : text(row.description, 512);
    let policy: BytedcliOperationPolicy | undefined;
    try { policy = parseBytedcliOperationPolicy(row.policy); } catch { invalid(); }
    if (!policy) invalid();
    return Object.freeze({ id, title, ...(description ? { description } : {}), policy });
  });
  const parsed = Object.freeze({ schema: PLUGIN_BYTEDCLI_PRESETS_SCHEMA, presets: Object.freeze(presets) });
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > PLUGIN_BYTEDCLI_PRESETS_MAX_BYTES) invalid();
  return parsed;
}
