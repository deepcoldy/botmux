import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isValidProtectedMcpCapabilityId } from './protected-mcp-capabilities.js';

export const MAX_PROTECTED_EGRESS_TARGETS = 8;
export const MAX_PROTECTED_EGRESS_ROUTES = 128;
export const MAX_PROTECTED_EGRESS_METHODS = 8;

export interface ProtectedHttpEgressRoute {
  methods: string[];
  path: string;
}

export interface ProtectedHttpEgressTarget {
  scheme: 'https';
  host: string;
  port: number;
  denyRoutes: ProtectedHttpEgressRoute[];
}

export interface ProtectedHttpEgressPolicy {
  id: string;
  targets: ProtectedHttpEgressTarget[];
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function isDnsName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (value !== value.toLowerCase() || value.endsWith('.') || isIP(value) !== 0) return false;
  try {
    if (new URL(`https://${value}/`).hostname !== value) return false;
  } catch {
    return false;
  }
  return value.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function normalizeRoute(
  raw: unknown,
  methodPathPairs: Set<string>,
): ProtectedHttpEgressRoute | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['methods', 'path'])) return undefined;
  if (!Array.isArray(raw.methods)
    || raw.methods.length === 0
    || raw.methods.length > MAX_PROTECTED_EGRESS_METHODS) return undefined;
  if (typeof raw.path !== 'string' || !raw.path.startsWith('/')) return undefined;

  const methods: string[] = [];
  for (const method of raw.methods) {
    if (typeof method !== 'string' || !HTTP_TOKEN.test(method)) return undefined;
    const pair = `${method}\0${raw.path}`;
    if (methodPathPairs.has(pair)) return undefined;
    methodPathPairs.add(pair);
    methods.push(method);
  }
  return { methods, path: raw.path };
}

function normalizeTarget(raw: unknown): ProtectedHttpEgressTarget | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['scheme', 'host', 'port', 'denyRoutes'])) return undefined;
  if (raw.scheme !== 'https' || !isDnsName(raw.host)) return undefined;
  if (!Number.isInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65_535) {
    return undefined;
  }
  if (!Array.isArray(raw.denyRoutes)
    || raw.denyRoutes.length === 0
    || raw.denyRoutes.length > MAX_PROTECTED_EGRESS_ROUTES) return undefined;

  const methodPathPairs = new Set<string>();
  const denyRoutes: ProtectedHttpEgressRoute[] = [];
  for (const route of raw.denyRoutes) {
    const normalized = normalizeRoute(route, methodPathPairs);
    if (!normalized) return undefined;
    denyRoutes.push(normalized);
  }
  return {
    scheme: 'https',
    host: raw.host,
    port: raw.port as number,
    denyRoutes,
  };
}

export function normalizeProtectedHttpEgressPolicy(raw: unknown): ProtectedHttpEgressPolicy | undefined {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'targets'])) return undefined;
  if (!isValidProtectedMcpCapabilityId(raw.id)) return undefined;
  if (!Array.isArray(raw.targets)
    || raw.targets.length === 0
    || raw.targets.length > MAX_PROTECTED_EGRESS_TARGETS) return undefined;

  const targets: ProtectedHttpEgressTarget[] = [];
  const targetKeys = new Set<string>();
  for (const target of raw.targets) {
    const normalized = normalizeTarget(target);
    if (!normalized) return undefined;
    const key = `${normalized.scheme}\0${normalized.host}\0${normalized.port}`;
    if (targetKeys.has(key)) return undefined;
    targetKeys.add(key);
    targets.push(normalized);
  }
  return { id: raw.id, targets };
}

function keySorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keySorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, keySorted(value[key])]),
  );
}

export function protectedHttpEgressPolicyDigest(policy: ProtectedHttpEgressPolicy): string {
  const normalized = normalizeProtectedHttpEgressPolicy(policy);
  if (!normalized) throw new Error('invalid_protected_http_egress_policy');
  return createHash('sha256').update(JSON.stringify(keySorted(normalized))).digest('hex');
}
