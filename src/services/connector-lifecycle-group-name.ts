import type { ConnectorDefinition } from './connector-store.js';
import { getJsonPathValue } from './webhook-lifecycle-extractors.js';

export const CONNECTOR_LIFECYCLE_GROUP_NAME_MAX_LENGTH = 60;

const TEMPLATE_TOKEN = /{{\s*([^{}]+?)\s*}}/g;
const VALID_PATH = /^(?:\$\.)?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function codepoints(value: string): string[] {
  return Array.from(value);
}

function truncateUtf16(value: string, maxLength: number, suffix = ''): string {
  if (value.length <= maxLength) return value;
  const budget = Math.max(0, maxLength - suffix.length);
  let truncated = '';
  for (const character of value) {
    if (truncated.length + character.length > budget) break;
    truncated += character;
  }
  return `${truncated}${suffix}`;
}

function truncateGroupName(value: string): string {
  return codepoints(value).slice(0, CONNECTOR_LIFECYCLE_GROUP_NAME_MAX_LENGTH).join('');
}

function compactGroupName(value: string): string {
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function normalizePathToken(token: string): string | null {
  const path = token;
  if (!VALID_PATH.test(path)) return null;
  const normalized = path.startsWith('$.') ? path.slice(2) : path;
  if (normalized.split('.').some(segment => UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return path;
}

export function defaultConnectorLifecycleGroupName(connector: ConnectorDefinition, dedupKey: string): string {
  const cleanKey = compactGroupName(dedupKey);
  const name = `${connector.name}: ${cleanKey}`;
  return truncateUtf16(name, 58, '...');
}

export function isValidConnectorLifecycleGroupNameTemplate(text: string): boolean {
  const stripped = text.replace(TEMPLATE_TOKEN, (_token, rawName: string) => {
    const name = rawName.trim();
    if (name === 'source' || name === 'dedupKey' || name === 'requestId') return '';
    return normalizePathToken(name) ? '' : '{{invalid}}';
  });
  return !stripped.includes('{{') && !stripped.includes('}}');
}

export function renderConnectorLifecycleGroupName(
  connector: ConnectorDefinition,
  payload: unknown,
  args: { dedupKey: string; requestId: string },
): string {
  const cfg = connector.lifecycleGroupName;
  if (cfg?.mode === 'fixed' && cfg.text) {
    const fixed = compactGroupName(cfg.text);
    if (fixed) return truncateGroupName(fixed);
  }

  if (cfg?.mode === 'template' && cfg.text && isValidConnectorLifecycleGroupNameTemplate(cfg.text)) {
    const rendered = cfg.text.replace(TEMPLATE_TOKEN, (_token, rawName: string) => {
      const name = rawName.trim();
      if (name === 'source') return connector.promptEnvelope.sourceName || connector.name;
      if (name === 'dedupKey') return args.dedupKey;
      if (name === 'requestId') return args.requestId;
      const path = normalizePathToken(name);
      const value = path ? scalarText(getJsonPathValue(payload, path)) : undefined;
      return value ?? '';
    });
    const name = compactGroupName(rendered);
    if (name) return truncateGroupName(name);
  }

  return defaultConnectorLifecycleGroupName(connector, args.dedupKey);
}
