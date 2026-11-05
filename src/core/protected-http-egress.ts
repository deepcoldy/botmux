import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isValidProtectedMcpCapabilityId } from './protected-mcp-capabilities.js';
import { readPluginRegistry } from '../services/plugin-registry-store.js';
import { readPluginMcpDescriptor } from './plugins/mcp/private-store.js';

export const MAX_PROTECTED_EGRESS_TARGETS = 8;
export const MAX_PROTECTED_EGRESS_ROUTES = 128;
export const MAX_PROTECTED_EGRESS_METHODS = 8;
export const MAX_PROTECTED_EGRESS_ADDRESSES_PER_TARGET = 32;

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

export interface CollectedProtectedHttpEgressPolicy {
  pluginId: string;
  capabilityId: string;
  policy: ProtectedHttpEgressPolicy;
  policyDigest: string;
}

export interface ProtectedHttpEgressWorkerPolicy extends CollectedProtectedHttpEgressPolicy {
  frozenAddresses: string[][];
}

export type ProtectedHttpEgressLookup = (
  host: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
const HTTP_PATH_CONTROL = /[\u0000-\u001f\u007f]/;

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

/** Read protected policies only for the session's effective enabled plugins.
 * Private descriptor failures are launch failures: silently dropping a policy
 * would restore the direct-network bypass the descriptor exists to close. */
export function collectProtectedHttpEgressPolicies(
  pluginIds: readonly string[] | undefined,
): CollectedProtectedHttpEgressPolicy[] {
  const registry = readPluginRegistry();
  const collected: CollectedProtectedHttpEgressPolicy[] = [];
  for (const pluginId of [...new Set(pluginIds ?? [])]) {
    const contribution = registry.plugins[pluginId]?.contributions?.mcp;
    if (!contribution) continue;
    const descriptor = readPluginMcpDescriptor(pluginId, contribution);
    if (descriptor.transport !== 'stdio' || !descriptor.protectedEgressPolicy) continue;
    const policy = normalizeProtectedHttpEgressPolicy(descriptor.protectedEgressPolicy);
    if (!policy) throw new Error(`invalid_plugin_mcp_protected_egress_policy:${pluginId}`);
    if (!descriptor.protectedCapability) {
      throw new Error(`plugin_mcp_protected_egress_capability_required:${pluginId}`);
    }
    collected.push({
      pluginId,
      capabilityId: descriptor.protectedCapability,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
    });
  }
  return collected;
}

/** Resolve every target exactly once for one worker generation. The frozen
 * addresses are the single source for both the host forwarder and kernel deny
 * rules, preventing DNS re-resolution from splitting those decisions. */
export async function resolveProtectedHttpEgressTargets(
  policy: ProtectedHttpEgressPolicy,
  lookup: ProtectedHttpEgressLookup = dnsLookup,
): Promise<string[][]> {
  const normalized = normalizeProtectedHttpEgressPolicy(policy);
  if (!normalized) throw new Error('invalid_protected_http_egress_policy');
  const frozen: string[][] = [];
  for (const target of normalized.targets) {
    const results = await lookup(target.host, { all: true, verbatim: true });
    const addresses: string[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      const family = isIP(result.address);
      if ((family !== 4 && family !== 6) || family !== result.family) {
        throw new Error('protected_http_egress_target_not_frozen');
      }
      if (seen.has(result.address)) continue;
      if (seen.size >= MAX_PROTECTED_EGRESS_ADDRESSES_PER_TARGET) {
        throw new Error('protected_http_egress_target_address_limit_exceeded');
      }
      seen.add(result.address);
      addresses.push(result.address);
    }
    if (addresses.length === 0) throw new Error('protected_http_egress_target_not_frozen');
    frozen.push(addresses);
  }
  return frozen;
}

function normalizeProtectedHttpMethod(raw: string): string {
  const method = raw.toUpperCase();
  if (!HTTP_TOKEN.test(method)) throw new Error('invalid_protected_http_method');
  return method;
}

/**
 * Validate a worker-supplied origin-form target, preserving query text and
 * pathname case. Reject encodings, matrix parameters and whitespace instead
 * of guessing how an upstream router decodes or strips them. This is a
 * conservative accepted grammar, not a complete model of server routing:
 * policies still need to enumerate other aliases recognized by the target.
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
  // No encoded pathname byte is currently proven unambiguous across target
  // routers, so there is deliberately no percent-encoding allowlist.
  if ((pathname.length > 1 && pathname.endsWith('/'))
    || pathname.includes('//')
    || pathname.includes('%')
    || pathname.includes(';')
    || /\s/u.test(pathname)) {
    throw new Error('invalid_protected_http_path');
  }
  if (pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('invalid_protected_http_path');
  }

  return raw;
}

export function protectedHttpEgressDecision(
  policy: ProtectedHttpEgressPolicy,
  policyId: string,
  targetIndex: number,
  method: string,
  path: string,
): 'allow' | 'deny' {
  if (policyId !== policy.id) throw new Error('protected_http_egress_policy_mismatch');
  const target = policy.targets[targetIndex];
  if (!Number.isSafeInteger(targetIndex) || !target) {
    throw new Error('protected_http_egress_target_mismatch');
  }
  const normalizedMethod = normalizeProtectedHttpMethod(method);
  const normalizedPath = normalizeProtectedHttpPath(path);
  const requestPathname = normalizedPath.split('?', 1)[0];
  for (const route of target.denyRoutes) {
    const routePath = normalizeProtectedHttpPath(route.path).split('?', 1)[0];
    // Treat case-only write aliases as protected even on case-insensitive
    // upstream routers, without changing the case of forwarded read paths.
    if (route.methods.includes(normalizedMethod)
      && routePath.toLowerCase() === requestPathname.toLowerCase()) return 'deny';
  }
  return 'allow';
}
