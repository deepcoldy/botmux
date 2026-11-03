import { isValidPluginId } from './plugins/ids.js';

const PROTECTED_MCP_CAPABILITY_ID = /^[a-z][a-z0-9._:-]{0,127}$/;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PROTECTED_MCP_CONTAINMENT_PROFILE = 'local-stdio-secret-v1' as const;
export const PROTECTED_MCP_SECRET_FD_ENV = 'BOTMUX_PROTECTED_SECRET_FD' as const;

export interface ProtectedMcpCapabilityConfig {
  enabled: boolean;
  allowedPluginIds: string[];
  secret: {
    source: 'env';
    name: string;
  };
  principal?: 'verified-human-email';
  containmentProfile: typeof PROTECTED_MCP_CONTAINMENT_PROFILE;
  isolation?: {
    protectedHomePaths?: string[];
    redactEnv?: string[];
  };
}

export type ProtectedMcpCapabilityConfigMap = Record<string, ProtectedMcpCapabilityConfig>;

export interface ProtectedMcpIsolationPolicy {
  protectedHomePaths: string[];
  secretEnvNames: string[];
  redactEnv: string[];
}

export function isValidProtectedMcpCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && PROTECTED_MCP_CAPABILITY_ID.test(value);
}

export function isValidEnvironmentVariableName(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_VARIABLE_NAME.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueValidatedStrings(
  raw: unknown,
  validate: (value: unknown) => value is string,
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!validate(value)) return undefined;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function isProtectedHomeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function normalizeCapabilityConfig(raw: unknown): ProtectedMcpCapabilityConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const allowedPluginIds = uniqueValidatedStrings(raw.allowedPluginIds, isValidPluginId);
  if (!allowedPluginIds?.length) return undefined;

  if (!isRecord(raw.secret)
    || raw.secret.source !== 'env'
    || !isValidEnvironmentVariableName(raw.secret.name)) return undefined;
  if (raw.principal !== undefined && raw.principal !== 'verified-human-email') return undefined;
  if (raw.containmentProfile !== PROTECTED_MCP_CONTAINMENT_PROFILE) return undefined;

  let isolation: ProtectedMcpCapabilityConfig['isolation'];
  if (raw.isolation !== undefined) {
    if (!isRecord(raw.isolation)) return undefined;
    const protectedHomePaths = raw.isolation.protectedHomePaths === undefined
      ? undefined
      : uniqueValidatedStrings(raw.isolation.protectedHomePaths, isProtectedHomeRelativePath);
    const redactEnv = raw.isolation.redactEnv === undefined
      ? undefined
      : uniqueValidatedStrings(raw.isolation.redactEnv, isValidEnvironmentVariableName);
    if (raw.isolation.protectedHomePaths !== undefined && protectedHomePaths === undefined) return undefined;
    if (raw.isolation.redactEnv !== undefined && redactEnv === undefined) return undefined;
    if (protectedHomePaths?.length || redactEnv?.length) {
      isolation = {
        ...(protectedHomePaths?.length ? { protectedHomePaths } : {}),
        ...(redactEnv?.length ? { redactEnv } : {}),
      };
    }
  }

  return {
    enabled: raw.enabled === true,
    allowedPluginIds,
    secret: { source: 'env', name: raw.secret.name },
    ...(raw.principal === 'verified-human-email' ? { principal: raw.principal } : {}),
    containmentProfile: PROTECTED_MCP_CONTAINMENT_PROFILE,
    ...(isolation ? { isolation } : {}),
  };
}

export function normalizeProtectedMcpCapabilities(raw: unknown): ProtectedMcpCapabilityConfigMap | undefined {
  if (!isRecord(raw)) return undefined;
  const normalized: ProtectedMcpCapabilityConfigMap = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isValidProtectedMcpCapabilityId(id)) continue;
    const config = normalizeCapabilityConfig(value);
    if (config) normalized[id] = config;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function protectedMcpIsolationPolicy(
  pluginIds: readonly string[] | undefined,
  config: ProtectedMcpCapabilityConfigMap | undefined,
): ProtectedMcpIsolationPolicy {
  const enabledPlugins = new Set(pluginIds ?? []);
  const protectedHomePaths = new Set<string>();
  const secretEnvNames = new Set<string>();
  const redactEnv = new Set<string>();
  for (const capability of Object.values(config ?? {})) {
    if (!capability.allowedPluginIds.some(pluginId => enabledPlugins.has(pluginId))) continue;
    secretEnvNames.add(capability.secret.name);
    for (const path of capability.isolation?.protectedHomePaths ?? []) protectedHomePaths.add(path);
    for (const name of capability.isolation?.redactEnv ?? []) redactEnv.add(name);
  }
  return {
    protectedHomePaths: [...protectedHomePaths],
    secretEnvNames: [...secretEnvNames],
    redactEnv: [...redactEnv],
  };
}
