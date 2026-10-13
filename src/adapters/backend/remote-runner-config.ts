import {
  REMOTE_RUNNER_CAPABILITIES,
  type RemoteRunnerCapability,
} from './remote-runner-protocol.js';

export interface RemoteRunnerConfig {
  /** Optional provider name pin verified during the hello handshake. */
  expectedProvider?: string;
  /** Capabilities the provider must advertise before BotMux sends start/resume. */
  requiredCapabilities?: RemoteRunnerCapability[];
  /** Bounded hello + start/resume deadline. */
  handshakeTimeoutMs?: number;
  /** Bounded status/cancel/detach deadline. */
  operationTimeoutMs?: number;
}

const CAPABILITIES = new Set<string>(REMOTE_RUNNER_CAPABILITIES);
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function optionalTimeout(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 100 || Number(value) > 300_000) {
    throw new Error(`remoteRunner.${field} must be an integer between 100 and 300000`);
  }
  return Number(value);
}

export function normalizeRemoteRunnerConfig(value: unknown): RemoteRunnerConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('remoteRunner must be an object');
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'expectedProvider',
    'requiredCapabilities',
    'handshakeTimeoutMs',
    'operationTimeoutMs',
  ]);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`remoteRunner contains unsupported field(s): ${unknown.join(', ')}`);

  let expectedProvider: string | undefined;
  if (raw.expectedProvider !== undefined) {
    if (typeof raw.expectedProvider !== 'string' || !PROVIDER_RE.test(raw.expectedProvider.trim())) {
      throw new Error('remoteRunner.expectedProvider is invalid');
    }
    expectedProvider = raw.expectedProvider.trim();
  }

  let requiredCapabilities: RemoteRunnerCapability[] | undefined;
  if (raw.requiredCapabilities !== undefined) {
    if (!Array.isArray(raw.requiredCapabilities)
        || raw.requiredCapabilities.some(item => typeof item !== 'string' || !CAPABILITIES.has(item))) {
      throw new Error('remoteRunner.requiredCapabilities contains an unsupported capability');
    }
    requiredCapabilities = [...new Set(raw.requiredCapabilities)] as RemoteRunnerCapability[];
  }

  const handshakeTimeoutMs = optionalTimeout(raw.handshakeTimeoutMs, 'handshakeTimeoutMs');
  const operationTimeoutMs = optionalTimeout(raw.operationTimeoutMs, 'operationTimeoutMs');
  return {
    ...(expectedProvider ? { expectedProvider } : {}),
    ...(requiredCapabilities ? { requiredCapabilities } : {}),
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
  };
}
