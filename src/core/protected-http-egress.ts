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
const HTTP_PATH_CONTROL = /[\u0000-\u001f\u007f]/;
const HTTP_PATH_PERCENT = /%([0-9a-fA-F]{2})/g;
const HTTP_UNRESERVED_BYTE = /[A-Za-z0-9\-._~]/;

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

function normalizeProtectedHttpMethod(raw: string): string {
  const method = raw.toUpperCase();
  if (!HTTP_TOKEN.test(method)) throw new Error('invalid_protected_http_method');
  return method;
}

/**
 * Canonicalize a worker-supplied origin-form request target without ever
 * accepting an alternate spelling of a protected path. Query ordering and
 * contents are preserved; deny-route matching uses only the pathname.
 */
export function normalizeProtectedHttpPath(raw: string): string {
  if (typeof raw !== 'string'
    || !raw.startsWith('/')
    || raw.startsWith('//')
    || raw.includes('\\')
    || raw.includes('#')
    || HTTP_PATH_CONTROL.test(raw)) {
    throw new Error('invalid_protected_http_path');
  }

  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '%') continue;
    if (!/^[0-9a-fA-F]{2}$/.test(raw.slice(index + 1, index + 3))) {
      throw new Error('invalid_protected_http_path');
    }
    index += 2;
  }

  const queryAt = raw.indexOf('?');
  const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = queryAt < 0 ? '' : raw.slice(queryAt);
  try {
    decodeURIComponent(pathname);
  } catch {
    throw new Error('invalid_protected_http_path');
  }
  for (const match of pathname.matchAll(HTTP_PATH_PERCENT)) {
    const byte = Number.parseInt(match[1], 16);
    const character = String.fromCharCode(byte);
    if (byte === 0x2f
      || byte === 0x5c
      || byte <= 0x1f
      || byte === 0x7f
      || HTTP_UNRESERVED_BYTE.test(character)) {
      throw new Error('invalid_protected_http_path');
    }
  }
  if (pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('invalid_protected_http_path');
  }

  return `${pathname.replace(HTTP_PATH_PERCENT, (_escape, hex: string) => `%${hex.toUpperCase()}`)}${
    query.replace(HTTP_PATH_PERCENT, (_escape, hex: string) => `%${hex.toUpperCase()}`)
  }`;
}

export function protectedHttpEgressDecision(
  policy: ProtectedHttpEgressPolicy,
  policyId: string,
  method: string,
  path: string,
): 'allow' | 'deny' {
  if (policyId !== policy.id) throw new Error('protected_http_egress_policy_mismatch');
  const normalizedMethod = normalizeProtectedHttpMethod(method);
  const normalizedPath = normalizeProtectedHttpPath(path);
  const requestPathname = normalizedPath.split('?', 1)[0];
  for (const target of policy.targets) {
    for (const route of target.denyRoutes) {
      const routePath = normalizeProtectedHttpPath(route.path).split('?', 1)[0];
      if (route.methods.includes(normalizedMethod) && routePath === requestPathname) return 'deny';
    }
  }
  return 'allow';
}
