import { Buffer } from 'node:buffer';
import { pluginCardActionSelectorOverlapsBotmux } from '../../card-action-namespace.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { isValidPluginId } from '../ids.js';
import type {
  PluginCardActionsContribution,
  PluginRegistryFile,
} from '../types.js';
import type { PluginCardActionRoutingRecord } from './gateway.js';

export const PLUGIN_CARD_ACTION_CAPABILITIES_ENV = 'BOTMUX_PLUGIN_CARD_ACTION_CAPABILITIES';
export const PLUGIN_CARD_ACTION_CAPABILITIES_MAX_BYTES = 128 * 1024;

export interface PluginCardActionCapability {
  id: string;
  cardActions: PluginCardActionsContribution;
}

export interface PluginCardActionCapabilitiesSnapshot {
  schemaVersion: 1;
  plugins: PluginCardActionCapability[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const normalizeSelectors = (
  raw: unknown,
  kind: 'action' | 'prefix',
): string[] | undefined | null => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1_024) return null;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (
      typeof value !== 'string'
      || value !== value.trim()
      || Array.from(value).length === 0
      || Array.from(value).length > 256
      || /[\u0000-\u001f\u007f]/.test(value)
      || pluginCardActionSelectorOverlapsBotmux(value, kind)
      || seen.has(value)
    ) return null;
    seen.add(value);
    values.push(value);
  }
  return values;
};

const normalizeEndpoint = (raw: unknown): string | undefined => {
  if (
    typeof raw !== 'string'
    || raw !== raw.trim()
    || !raw.startsWith('/')
    || raw.startsWith('//')
    || raw.includes('\\')
    || raw.includes('?')
    || raw.includes('#')
    || /[\u0000-\u001f\u007f]/.test(raw)
  ) return undefined;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (decoded.split('/').includes('..')) return undefined;
  return raw;
};

const normalizeContribution = (raw: unknown): PluginCardActionsContribution | undefined => {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return undefined;
  const actions = normalizeSelectors(raw.actions, 'action');
  const actionPrefixes = normalizeSelectors(raw.actionPrefixes, 'prefix');
  const endpoint = normalizeEndpoint(raw.endpoint);
  if (actions === null || actionPrefixes === null || !endpoint) return undefined;
  if (!actions && !actionPrefixes) return undefined;
  return {
    schemaVersion: 1,
    ...(actions ? { actions } : {}),
    ...(actionPrefixes ? { actionPrefixes } : {}),
    endpoint,
  };
};

/**
 * Build the public, session-scoped selector snapshot that a child CLI may use
 * to validate a card before sending it. The daemon still re-resolves the live
 * registry and service state when the callback arrives; this is not authority.
 */
export function buildPluginCardActionCapabilitiesSnapshot(
  pluginIds: readonly string[],
  registry: PluginRegistryFile = readPluginRegistry(),
): PluginCardActionCapabilitiesSnapshot {
  const plugins: PluginCardActionCapability[] = [];
  const seen = new Set<string>();
  for (const id of pluginIds) {
    if (!isValidPluginId(id) || seen.has(id)) continue;
    seen.add(id);
    const cardActions = normalizeContribution(registry.plugins[id]?.contributions?.cardActions);
    if (cardActions) plugins.push({ id, cardActions });
  }
  return { schemaVersion: 1, plugins };
}

export function serializePluginCardActionCapabilitiesSnapshot(
  snapshot: PluginCardActionCapabilitiesSnapshot,
): string {
  const raw = JSON.stringify(snapshot);
  if (Buffer.byteLength(raw) > PLUGIN_CARD_ACTION_CAPABILITIES_MAX_BYTES) {
    throw new Error('plugin_card_action_capabilities_too_large');
  }
  return raw;
}

export function parsePluginCardActionCapabilitiesSnapshot(
  raw: string,
): PluginCardActionCapabilitiesSnapshot | undefined {
  if (!raw || Buffer.byteLength(raw) > PLUGIN_CARD_ACTION_CAPABILITIES_MAX_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) return undefined;
  const plugins: PluginCardActionCapability[] = [];
  const seen = new Set<string>();
  for (const item of parsed.plugins) {
    if (!isRecord(item) || !isValidPluginId(item.id) || seen.has(item.id)) return undefined;
    const cardActions = normalizeContribution(item.cardActions);
    if (!cardActions) return undefined;
    seen.add(item.id);
    plugins.push({ id: item.id, cardActions });
  }
  return { schemaVersion: 1, plugins };
}

export function pluginCardActionCapabilityRecords(
  snapshot: PluginCardActionCapabilitiesSnapshot,
): PluginCardActionRoutingRecord[] {
  return snapshot.plugins.map(plugin => ({
    id: plugin.id,
    contributions: { cardActions: plugin.cardActions },
  }));
}
