import { Buffer } from 'node:buffer';

export const REMOTE_RUNNER_PROTOCOL = 'botmux.remote-runner';
export const REMOTE_RUNNER_PROTOCOL_VERSION = 1;
export const MAX_REMOTE_RUNNER_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_REMOTE_RUNNER_STATE_BYTES = 64 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const REMOTE_RUNNER_CAPABILITIES = [
  'start',
  'resume',
  'turn',
  'cancel',
  'detach',
  'status',
] as const;

export type RemoteRunnerCapability = typeof REMOTE_RUNNER_CAPABILITIES[number];

/**
 * Provider-neutral state persisted by BotMux.
 *
 * `remoteSessionId` and `agentThreadId` deliberately have independent
 * lifetimes: a provider may replace an expired compute session while keeping
 * the same native agent thread. `generation` fences late events from the old
 * compute owner. `providerState` is opaque JSON, size-bounded, and MUST NOT
 * contain credentials.
 */
export interface RemoteRunnerBackendState {
  version: 1;
  provider: string;
  generation: number;
  remoteSessionId?: string;
  agentThreadId?: string;
  providerState?: JsonObject;
}

export interface RemoteRunnerTrustedCaller {
  requestUserOpenId?: string;
  requestUserUnionId?: string;
  requestLarkAppId?: string;
  source?: 'schedule_creator';
  taskId?: string;
  senderType?: 'user' | 'bot';
}

interface RemoteRunnerCommandBase {
  protocol: typeof REMOTE_RUNNER_PROTOCOL;
  version: typeof REMOTE_RUNNER_PROTOCOL_VERSION;
  requestId: string;
}

export type RemoteRunnerCommand =
  | (RemoteRunnerCommandBase & {
      type: 'hello';
      sessionId: string;
      requiredCapabilities: RemoteRunnerCapability[];
    })
  | (RemoteRunnerCommandBase & {
      type: 'start';
      sessionId: string;
      cwd: string;
      model?: string;
      reasoningEffort?: string;
    })
  | (RemoteRunnerCommandBase & {
      type: 'resume';
      sessionId: string;
      cwd: string;
      state: RemoteRunnerBackendState;
      model?: string;
      reasoningEffort?: string;
    })
  | (RemoteRunnerCommandBase & {
      type: 'turn';
      turnId: string;
      content: string;
      trustedCaller?: RemoteRunnerTrustedCaller;
    })
  | (RemoteRunnerCommandBase & { type: 'cancel' })
  | (RemoteRunnerCommandBase & { type: 'detach' })
  | (RemoteRunnerCommandBase & { type: 'status' });

interface RemoteRunnerEventBase {
  protocol: typeof REMOTE_RUNNER_PROTOCOL;
  version: typeof REMOTE_RUNNER_PROTOCOL_VERSION;
}

export type RemoteRunnerStatus =
  | 'starting'
  | 'ready'
  | 'busy'
  | 'closed'
  | 'detached'
  | 'error';

export type RemoteRunnerEvent =
  | (RemoteRunnerEventBase & {
      type: 'hello';
      requestId: string;
      provider: string;
      capabilities: RemoteRunnerCapability[];
    })
  | (RemoteRunnerEventBase & {
      type: 'ready';
      requestId?: string;
      state: RemoteRunnerBackendState;
    })
  | (RemoteRunnerEventBase & {
      type: 'progress';
      turnId: string;
      content: string;
    })
  | (RemoteRunnerEventBase & {
      type: 'final';
      turnId: string;
      content: string;
      state?: RemoteRunnerBackendState;
    })
  | (RemoteRunnerEventBase & {
      type: 'failure';
      requestId?: string;
      turnId?: string;
      code: string;
      message: string;
      status: 'failed' | 'ambiguous' | 'cancelled';
      retryable: boolean;
    })
  | (RemoteRunnerEventBase & {
      type: 'access_url';
      url: string;
    })
  | (RemoteRunnerEventBase & {
      type: 'lineage_changed';
      state: RemoteRunnerBackendState;
    })
  | (RemoteRunnerEventBase & {
      type: 'status';
      requestId: string;
      status: RemoteRunnerStatus;
      state?: RemoteRunnerBackendState;
    });

const CAPABILITY_SET: ReadonlySet<string> = new Set(REMOTE_RUNNER_CAPABILITIES);
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9._-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function validJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1));
  const object = record(value);
  return !!object && Object.entries(object).every(
    ([key, item]) => key.length <= 256 && validJson(item, depth + 1),
  );
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const id = nonEmptyString(value, 256);
  return id && ID_RE.test(id) ? id : null;
}

export function normalizeRemoteRunnerBackendState(
  value: unknown,
): RemoteRunnerBackendState | undefined {
  const raw = record(value);
  if (!raw || raw.version !== REMOTE_RUNNER_PROTOCOL_VERSION) return undefined;
  const provider = nonEmptyString(raw.provider, 64);
  if (!provider || !PROVIDER_RE.test(provider)) return undefined;
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0) return undefined;
  const remoteSessionId = optionalId(raw.remoteSessionId);
  const agentThreadId = optionalId(raw.agentThreadId);
  if (remoteSessionId === null || agentThreadId === null) return undefined;

  let providerState: JsonObject | undefined;
  if (raw.providerState !== undefined) {
    const candidate = record(raw.providerState);
    if (!candidate || !validJson(candidate)) return undefined;
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_REMOTE_RUNNER_STATE_BYTES) {
      return undefined;
    }
    providerState = candidate as JsonObject;
  }

  return {
    version: REMOTE_RUNNER_PROTOCOL_VERSION,
    provider,
    generation: Number(raw.generation),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    ...(agentThreadId ? { agentThreadId } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

function validBase(raw: Record<string, unknown>): boolean {
  return raw.protocol === REMOTE_RUNNER_PROTOCOL
    && raw.version === REMOTE_RUNNER_PROTOCOL_VERSION;
}

function requestId(raw: Record<string, unknown>): string | undefined {
  const value = nonEmptyString(raw.requestId, 128);
  return value && REQUEST_ID_RE.test(value) ? value : undefined;
}

function stateField(raw: Record<string, unknown>): RemoteRunnerBackendState | undefined | null {
  if (raw.state === undefined) return undefined;
  return normalizeRemoteRunnerBackendState(raw.state) ?? null;
}

export function parseRemoteRunnerEvent(value: unknown): RemoteRunnerEvent | undefined {
  const raw = record(value);
  if (!raw || !validBase(raw) || typeof raw.type !== 'string') return undefined;

  if (raw.type === 'hello') {
    const id = requestId(raw);
    const provider = nonEmptyString(raw.provider, 64);
    if (!id || !provider || !PROVIDER_RE.test(provider) || !Array.isArray(raw.capabilities)) {
      return undefined;
    }
    const capabilities = raw.capabilities.filter(
      (item): item is RemoteRunnerCapability => typeof item === 'string' && CAPABILITY_SET.has(item),
    );
    if (capabilities.length !== raw.capabilities.length || new Set(capabilities).size !== capabilities.length) {
      return undefined;
    }
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'hello', requestId: id, provider, capabilities };
  }

  if (raw.type === 'ready' || raw.type === 'lineage_changed') {
    const state = normalizeRemoteRunnerBackendState(raw.state);
    if (!state) return undefined;
    if (raw.type === 'ready') {
      const id = raw.requestId === undefined ? undefined : requestId(raw);
      if (raw.requestId !== undefined && !id) return undefined;
      return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'ready', state, ...(id ? { requestId: id } : {}) };
    }
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'lineage_changed', state };
  }

  if (raw.type === 'progress' || raw.type === 'final') {
    const turnId = nonEmptyString(raw.turnId, 256);
    if (!turnId || typeof raw.content !== 'string') return undefined;
    if (raw.type === 'progress') {
      return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'progress', turnId, content: raw.content };
    }
    const state = stateField(raw);
    if (state === null) return undefined;
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'final', turnId, content: raw.content, ...(state ? { state } : {}) };
  }

  if (raw.type === 'failure') {
    const id = raw.requestId === undefined ? undefined : requestId(raw);
    const turnId = raw.turnId === undefined ? undefined : nonEmptyString(raw.turnId, 256);
    const code = nonEmptyString(raw.code, 128);
    const message = nonEmptyString(raw.message, 4096);
    if ((raw.requestId !== undefined && !id) || (raw.turnId !== undefined && !turnId)
        || !code || !ERROR_CODE_RE.test(code) || !message
        || !['failed', 'ambiguous', 'cancelled'].includes(String(raw.status))
        || typeof raw.retryable !== 'boolean') return undefined;
    return {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'failure',
      ...(id ? { requestId: id } : {}),
      ...(turnId ? { turnId } : {}),
      code,
      message,
      status: raw.status as 'failed' | 'ambiguous' | 'cancelled',
      retryable: raw.retryable,
    };
  }

  if (raw.type === 'access_url') {
    const url = nonEmptyString(raw.url, 4096);
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    } catch {
      return undefined;
    }
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'access_url', url };
  }

  if (raw.type === 'status') {
    const id = requestId(raw);
    if (!id || !['starting', 'ready', 'busy', 'closed', 'detached', 'error'].includes(String(raw.status))) {
      return undefined;
    }
    const state = stateField(raw);
    if (state === null) return undefined;
    return {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'status',
      requestId: id,
      status: raw.status as RemoteRunnerStatus,
      ...(state ? { state } : {}),
    };
  }

  return undefined;
}

export function parseRemoteRunnerEventLine(line: string): RemoteRunnerEvent | undefined {
  if (Buffer.byteLength(line, 'utf8') > MAX_REMOTE_RUNNER_LINE_BYTES) return undefined;
  try {
    return parseRemoteRunnerEvent(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function encodeRemoteRunnerCommand(command: RemoteRunnerCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export function remoteRunnerCommand<T extends RemoteRunnerCommand['type']>(
  type: T,
  body: Omit<Extract<RemoteRunnerCommand, { type: T }>, 'protocol' | 'version' | 'type'>,
): Extract<RemoteRunnerCommand, { type: T }> {
  return {
    protocol: REMOTE_RUNNER_PROTOCOL,
    version: REMOTE_RUNNER_PROTOCOL_VERSION,
    type,
    ...body,
  } as Extract<RemoteRunnerCommand, { type: T }>;
}
