import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isValidPluginId } from './plugins/ids.js';
import { acceptMcpGatewayHandshake, sendMcpGatewayHandshake } from './plugins/mcp/socket-auth.js';
import {
  privateBrokerContainmentEnabled,
  type SandboxNetworkPolicy,
} from './sandbox-network-policy.js';
import type { ProtectedHttpEgressWorkerPolicy } from './protected-http-egress.js';

const PROTECTED_MCP_CAPABILITY_ID = /^[a-z][a-z0-9._:-]{0,127}$/;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PROTECTED_MCP_CONTAINMENT_PROFILE = 'local-stdio-secret-v1' as const;
export const PROTECTED_MCP_EGRESS_GUARD_CONTAINMENT_PROFILE = 'local-stdio-secret-egress-guard-v1' as const;
export type ProtectedMcpContainmentProfile =
  | typeof PROTECTED_MCP_CONTAINMENT_PROFILE
  | typeof PROTECTED_MCP_EGRESS_GUARD_CONTAINMENT_PROFILE;
export const PROTECTED_MCP_SECRET_FD_ENV = 'BOTMUX_PROTECTED_SECRET_FD' as const;
export const PROTECTED_MCP_CHILD_SECRET_FD = 3;

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

export interface ProtectedMcpWorkerPolicy {
  capabilities: Array<{
    id: string;
    allowedPluginIds: string[];
    principal?: 'verified-human-email';
    containmentProfile: ProtectedMcpContainmentProfile;
  }>;
  protectedHomePaths: string[];
  redactEnv: string[];
}

export interface TrustedTurnPrincipal {
  type: 'human';
  openId?: string;
  unionId?: string;
  verifiedEmail: string;
  appId: string;
  turnId: string;
  dispatchAttempt?: number;
}

export interface GrantedMcpCapability {
  id: string;
  principal?: TrustedTurnPrincipal;
}

export interface ProtectedMcpWorkerProvisioning {
  workerPolicy: ProtectedMcpWorkerPolicy;
  secrets: Map<string, string>;
}

type ProtectedMcpSecretEnvironment = NodeJS.ProcessEnv | ReadonlyMap<string, string>;

let daemonProtectedSecretEnv = new Map<string, string>();
let daemonProtectedEnvKeys: string[] = [];

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
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined;
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

/**
 * Conservatively collect syntactically valid protected env names even when
 * the surrounding capability record is rejected for another field.
 */
export function protectedMcpConfiguredEnvKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const keys = new Set<string>();
  for (const value of Object.values(raw)) {
    if (!isRecord(value)) continue;
    if (isRecord(value.secret) && isValidEnvironmentVariableName(value.secret.name)) {
      keys.add(value.secret.name);
    }
    if (!isRecord(value.isolation) || !Array.isArray(value.isolation.redactEnv)) continue;
    for (const name of value.isolation.redactEnv) {
      if (isValidEnvironmentVariableName(name)) keys.add(name);
    }
  }
  return [...keys];
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

/** Machine-configured env names are secret-bearing regardless of bot plugins. */
export function protectedMcpGlobalRedactedEnvKeys(
  config: ProtectedMcpCapabilityConfigMap | undefined,
): string[] {
  const keys = new Set<string>();
  for (const capability of Object.values(config ?? {})) {
    keys.add(capability.secret.name);
    for (const name of capability.isolation?.redactEnv ?? []) keys.add(name);
  }
  return [...keys];
}

/**
 * Capture configured daemon-only secret sources before removing every
 * protected name from the daemon environment inherited by arbitrary children.
 */
export function captureProtectedMcpDaemonEnvironment(
  config: ProtectedMcpCapabilityConfigMap | undefined,
  env: NodeJS.ProcessEnv,
  configuredEnvKeys: readonly string[] = protectedMcpGlobalRedactedEnvKeys(config),
): ReadonlyMap<string, string> {
  const captured = new Map<string, string>();
  for (const capability of Object.values(config ?? {})) {
    const value = env[capability.secret.name]?.trim();
    if (value) captured.set(capability.secret.name, value);
  }
  for (const key of configuredEnvKeys) delete env[key];
  delete env[PROTECTED_MCP_SECRET_FD_ENV];
  daemonProtectedSecretEnv = captured;
  daemonProtectedEnvKeys = [...new Set(configuredEnvKeys.filter(isValidEnvironmentVariableName))];
  return new Map(captured);
}

/** Snapshot of secret source values retained only by the daemon process. */
export function protectedMcpDaemonSecretEnvironment(): ReadonlyMap<string, string> {
  return new Map(daemonProtectedSecretEnv);
}

/** Machine-wide protected env names captured at daemon boot, including safe names from rejected records. */
export function protectedMcpDaemonRedactedEnvKeys(): string[] {
  return [...daemonProtectedEnvKeys];
}

function protectedSecretValue(
  source: ProtectedMcpSecretEnvironment,
  name: string,
): string | undefined {
  const raw = typeof (source as ReadonlyMap<string, string>).get === 'function'
    ? (source as ReadonlyMap<string, string>).get(name)
    : (source as NodeJS.ProcessEnv)[name];
  const value = raw?.trim();
  return value || undefined;
}

/** Environment names that must stay daemon-only for this worker generation. */
export function protectedMcpRedactedEnvKeys(
  policy: Pick<ProtectedMcpWorkerPolicy, 'redactEnv'> | undefined,
): string[] {
  const keys = new Set<string>([PROTECTED_MCP_SECRET_FD_ENV]);
  for (const key of policy?.redactEnv ?? []) {
    if (isValidEnvironmentVariableName(key)) keys.add(key);
  }
  return [...keys];
}

/** Resolve validated capability-relative paths beneath the daemon account Home. */
export function protectedMcpHomePaths(
  home: string,
  policy: Pick<ProtectedMcpWorkerPolicy, 'protectedHomePaths'> | undefined,
): string[] {
  const root = resolve(home);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const paths = new Set<string>();
  for (const relativePath of policy?.protectedHomePaths ?? []) {
    if (!isProtectedHomeRelativePath(relativePath)) continue;
    const path = resolve(root, relativePath);
    if (path.startsWith(prefix)) paths.add(path);
  }
  return [...paths];
}

/**
 * Resolve the trusted Home root once, then lstat every existing intermediate
 * component without following it. The protected leaf stays lexical so a leaf
 * symlink is masked rather than turning its target into the policy boundary.
 */
export function protectedMcpHomeDenyPaths(
  home: string,
  policy: Pick<ProtectedMcpWorkerPolicy, 'protectedHomePaths'> | undefined,
): string[] {
  const root = realpathSync(home);
  const paths: string[] = [];
  for (const relativePath of policy?.protectedHomePaths ?? []) {
    if (!isProtectedHomeRelativePath(relativePath)) continue;
    const parts = relativePath.split('/');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`protected MCP Home path has an intermediate symbolic link: ${current}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`protected MCP Home path has a non-directory intermediate component: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    paths.push(join(root, ...parts));
  }
  return [...new Set(paths)];
}

export function prepareProtectedMcpWorkerProvisioning(
  pluginIds: readonly string[] | undefined,
  env: ProtectedMcpSecretEnvironment,
  config: ProtectedMcpCapabilityConfigMap | undefined,
  containmentConfigured: boolean,
  containmentProfile: ProtectedMcpContainmentProfile = PROTECTED_MCP_CONTAINMENT_PROFILE,
): ProtectedMcpWorkerProvisioning {
  const isolation = protectedMcpIsolationPolicy(pluginIds, config);
  const workerPolicy: ProtectedMcpWorkerPolicy = {
    capabilities: [],
    protectedHomePaths: isolation.protectedHomePaths,
    redactEnv: [...new Set([
      ...protectedMcpGlobalRedactedEnvKeys(config),
      ...protectedMcpDaemonRedactedEnvKeys(),
    ])],
  };
  const secrets = new Map<string, string>();
  const enabledPlugins = new Set(pluginIds ?? []);
  if (!containmentConfigured) return { workerPolicy, secrets };

  for (const [id, capability] of Object.entries(config ?? {})) {
    if (!capability.enabled) continue;
    if (!capability.allowedPluginIds.some(pluginId => enabledPlugins.has(pluginId))) continue;
    const secret = protectedSecretValue(env, capability.secret.name);
    if (!secret) continue;
    workerPolicy.capabilities.push({
      id,
      allowedPluginIds: [...capability.allowedPluginIds],
      ...(capability.principal ? { principal: capability.principal } : {}),
      containmentProfile,
    });
    secrets.set(id, secret);
  }
  return { workerPolicy, secrets };
}

export function protectedMcpContainmentConfigured(input: {
  platform: string;
  backendType: string;
  sandboxMode: 'off' | 'oncall' | 'scratch';
  networkPolicy: SandboxNetworkPolicy | undefined;
  protectedHttpEgressPolicy?: ProtectedHttpEgressWorkerPolicy;
  adopt: boolean;
}): boolean {
  const structural = input.platform === 'linux'
    && input.backendType === 'pty'
    && input.sandboxMode === 'oncall'
    && !input.adopt;
  if (!structural) return false;
  if (input.protectedHttpEgressPolicy) {
    return input.protectedHttpEgressPolicy.policy.targets.length > 0
      && input.protectedHttpEgressPolicy.policy.targets.length
        === input.protectedHttpEgressPolicy.frozenAddresses.length
      && input.protectedHttpEgressPolicy.frozenAddresses.every(addresses => addresses.length > 0);
  }
  return privateBrokerContainmentEnabled(input.networkPolicy);
}

export function protectedMcpContainmentActive(input: {
  platform: string;
  containmentProfile?: ProtectedMcpContainmentProfile;
  provisionedCapabilityCount: number;
  sandboxEngaged: boolean;
  mcpSocketMounted: boolean;
  egressSocketMounted?: boolean;
  directTargetDenyRulesInstalled?: boolean;
  guardLive?: boolean;
  expectedPolicyDigest?: string;
  guardPolicyDigest?: string;
  pidNamespaceRetained: boolean;
  networkPolicy: SandboxNetworkPolicy | undefined;
}): boolean {
  const common = input.platform === 'linux'
    && input.provisionedCapabilityCount > 0
    && input.sandboxEngaged
    && input.mcpSocketMounted
    && input.pidNamespaceRetained;
  if (!common) return false;
  if (input.containmentProfile === PROTECTED_MCP_EGRESS_GUARD_CONTAINMENT_PROFILE) {
    return input.egressSocketMounted === true
      && input.directTargetDenyRulesInstalled === true
      && input.guardLive === true
      && !!input.expectedPolicyDigest
      && input.guardPolicyDigest === input.expectedPolicyDigest;
  }
  return privateBrokerContainmentEnabled(input.networkPolicy);
}

export function serveProtectedMcpSecrets(
  child: Pick<ChildProcess, 'connected' | 'on' | 'off' | 'send'>,
  secrets: ReadonlyMap<string, string>,
): void {
  if (secrets.size === 0) return;
  const active = new Set<Socket>();
  let reservedChannels = 0;
  const sendFailure = (requestId: string, error: string) => {
    if (!child.connected) return;
    child.send({
      type: 'protected_mcp_secret_channel_result',
      requestId,
      ok: false,
      error,
    });
  };
  const onMessage = (raw: unknown) => {
    const message = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
    if (message?.type !== 'protected_mcp_secret_channel_request'
      || typeof message.requestId !== 'string'
      || typeof message.capabilityId !== 'string') return;
    const requestId = message.requestId;
    const secret = secrets.get(message.capabilityId);
    if (!secret) {
      sendFailure(requestId, 'protected_mcp_capability_unavailable');
      return;
    }
    if (reservedChannels >= 128) {
      sendFailure(requestId, 'protected_mcp_secret_channel_limit');
      return;
    }
    reservedChannels += 1;
    void createProtectedSecretSocketPair().then(({ daemonSocket, workerSocket }) => {
      if (!child.connected) {
        reservedChannels -= 1;
        daemonSocket.destroy();
        workerSocket.destroy();
        return;
      }
      active.add(daemonSocket);
      daemonSocket.once('close', () => {
        if (active.delete(daemonSocket)) reservedChannels -= 1;
      });
      serveOneShotProtectedSecret(daemonSocket, secret);
      child.send({
        type: 'protected_mcp_secret_channel_result',
        requestId,
        ok: true,
      }, workerSocket, error => {
        workerSocket.destroy();
        if (error) daemonSocket.destroy();
      });
    }).catch(() => {
      reservedChannels -= 1;
      sendFailure(requestId, 'protected_mcp_secret_channel_unavailable');
    });
  };
  const cleanup = () => {
    child.off('message', onMessage);
    for (const socket of active) socket.destroy();
    active.clear();
  };
  child.on('message', onMessage);
  child.on('exit', cleanup);
}

async function createProtectedSecretSocketPair(): Promise<{
  daemonSocket: Socket;
  workerSocket: Socket;
}> {
  // Authenticate the daemon-created connector before transferring its peer to
  // the worker. A same-UID process may discover and reach the short-lived Unix
  // listener first, but it cannot obtain this in-memory nonce; rejected peers
  // do not consume the listener, so they can neither steal the secret nor win
  // the accept race and strand the legitimate fd.
  const socketDir = mkdtempSync(join(tmpdir(), 'bmx-ps-'));
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, 's');
  const authToken = randomBytes(32).toString('base64url');
  const server = createServer();
  let workerSocket: Socket | undefined;
  try {
    const accepted = new Promise<Socket>((resolveAccepted) => {
      server.on('connection', socket => {
        void acceptMcpGatewayHandshake(socket, authToken).then(authenticated => {
          if (authenticated) resolveAccepted(socket);
        });
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    workerSocket = createConnection({ path: socketPath });
    await once(workerSocket, 'connect');
    await sendMcpGatewayHandshake(workerSocket, authToken);
    const daemonSocket = await accepted;
    workerSocket.pause();
    daemonSocket.resume();
    daemonSocket.setNoDelay(true);
    workerSocket.setNoDelay(true);
    return { daemonSocket, workerSocket };
  } catch (error) {
    workerSocket?.destroy();
    throw error;
  } finally {
    if (server.listening) server.close();
    rmSync(socketDir, { recursive: true, force: true });
  }
}

function serveOneShotProtectedSecret(socket: Socket, secret: string): void {
  const response = Buffer.from(`${Buffer.byteLength(secret)}\n${secret}`, 'utf8');
  let request = '';
  let settled = false;
  const clear = () => {
    response.fill(0);
    request = '';
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    clear();
    socket.destroy();
  };
  const timeout = setTimeout(fail, 10_000);
  timeout.unref();
  socket.on('error', fail);
  socket.on('close', () => {
    clearTimeout(timeout);
    clear();
  });
  socket.on('data', chunk => {
    if (settled) return;
    request += String(chunk);
    if (request.length > 16) {
      fail();
      return;
    }
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    if (request.slice(0, newline) !== 'KEY' || request.slice(newline + 1).length > 0) {
      fail();
      return;
    }
    settled = true;
    clearTimeout(timeout);
    socket.end(response, clear);
  });
}
