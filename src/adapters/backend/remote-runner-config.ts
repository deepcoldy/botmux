import { normalizeDelegatedSlashCommand } from '../../core/delegated-slash.js';
export { normalizeDelegatedSlashCommand, resolveDelegatedSlashCommands } from '../../core/delegated-slash.js';
import {
  REMOTE_RUNNER_CAPABILITIES,
  type RemoteRunnerCapability,
} from './remote-runner-protocol.js';

export interface RemoteRunnerConfig {
  /** Opt-in daemon commands delivered as structured turns; /disconnect normalizes to /detach. */
  delegatedSlashCommands?: Array<'/adopt' | '/detach'>;
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
    'delegatedSlashCommands',
    'expectedProvider',
    'requiredCapabilities',
    'handshakeTimeoutMs',
    'operationTimeoutMs',
  ]);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`remoteRunner contains unsupported field(s): ${unknown.join(', ')}`);

  let delegatedSlashCommands: RemoteRunnerConfig['delegatedSlashCommands'];
  if (raw.delegatedSlashCommands !== undefined) {
    if (!Array.isArray(raw.delegatedSlashCommands)) {
      throw new Error('remoteRunner.delegatedSlashCommands must be an array');
    }
    const commands = raw.delegatedSlashCommands.map(normalizeDelegatedSlashCommand);
    if (commands.some(command => command === null)) {
      throw new Error('remoteRunner.delegatedSlashCommands only accepts /adopt, /detach, /disconnect');
    }
    delegatedSlashCommands = [...new Set(commands)] as NonNullable<RemoteRunnerConfig['delegatedSlashCommands']>;
  }

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
    if (requiredCapabilities.includes('session_tool_schedule')
        && !requiredCapabilities.includes('session_tool')) {
      throw new Error('remoteRunner.requiredCapabilities session_tool_schedule requires session_tool');
    }
    if (requiredCapabilities.includes('session_tool_schedule_actor')
        && !requiredCapabilities.includes('session_tool_schedule')) {
      throw new Error('remoteRunner.requiredCapabilities session_tool_schedule_actor requires session_tool_schedule');
    }
    if (requiredCapabilities.includes('outbound_message_final')
        && !requiredCapabilities.includes('outbound_message')) {
      throw new Error('remoteRunner.requiredCapabilities outbound_message_final requires outbound_message');
    }
  }

  const handshakeTimeoutMs = optionalTimeout(raw.handshakeTimeoutMs, 'handshakeTimeoutMs');
  const operationTimeoutMs = optionalTimeout(raw.operationTimeoutMs, 'operationTimeoutMs');
  return {
    ...(delegatedSlashCommands ? { delegatedSlashCommands } : {}),
    ...(expectedProvider ? { expectedProvider } : {}),
    ...(requiredCapabilities ? { requiredCapabilities } : {}),
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
    ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
  };
}
