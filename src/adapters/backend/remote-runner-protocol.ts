import { Buffer } from 'node:buffer';

export const REMOTE_RUNNER_PROTOCOL = 'botmux.remote-runner';
export const REMOTE_RUNNER_PROTOCOL_VERSION = 1;
export const MAX_REMOTE_RUNNER_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_REMOTE_RUNNER_STATE_BYTES = 64 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const REMOTE_RUNNER_BASE_CAPABILITIES = [
  'start',
  'resume',
  'turn',
  'cancel',
  'detach',
  'reattach',
  'status',
] as const;

export const REMOTE_RUNNER_TERMINAL_CAPABILITIES = [
  'terminal_screen',
  'terminal_input',
  'terminal_resize',
] as const;

/** Optional provider-to-host message delivery.  It is deliberately not part
 * of {@link REMOTE_RUNNER_BASE_CAPABILITIES}: existing providers must not be
 * forced to implement a chat-facing side channel when upgrading BotMux. */
export const REMOTE_RUNNER_OUTBOUND_CAPABILITIES = [
  'outbound_message',
] as const;

/** Optional provider-to-host access to a small, read-only BotMux session tool
 * surface.  The provider contributes structured arguments only; the host
 * freezes the current session/turn and translates them into an allowlisted
 * local CLI invocation. */
export const REMOTE_RUNNER_SESSION_TOOL_CAPABILITIES = [
  'session_tool',
] as const;

export const REMOTE_RUNNER_CAPABILITIES = [
  ...REMOTE_RUNNER_BASE_CAPABILITIES,
  ...REMOTE_RUNNER_TERMINAL_CAPABILITIES,
  ...REMOTE_RUNNER_OUTBOUND_CAPABILITIES,
  ...REMOTE_RUNNER_SESSION_TOOL_CAPABILITIES,
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

/**
 * Provider-reported usage at one durable remote turn boundary.
 *
 * These fields intentionally mirror BotMux's native card usage facts without
 * exposing a provider transcript format. Every metric is optional by way of a
 * nullable group and must come from the provider's authoritative runtime; a
 * provider must never estimate missing values.
 */
export interface RemoteRunnerUsageSnapshot {
  context: {
    usedTokens: number;
    windowTokens?: number;
    percentUsed?: number;
  } | null;
  tokens: {
    in: number;
    out: number;
  } | null;
  turnTokens?: {
    in: number;
    out: number;
  } | null;
  model?: string;
  reasoningEffort?: string;
  modelBackendVariant?: string;
}

/** Generation fence plus the latest provider-native usage snapshot. */
export interface RemoteRunnerUsageReport {
  generation: number;
  snapshot: RemoteRunnerUsageSnapshot;
}

export interface RemoteRunnerTrustedCaller {
  requestUserOpenId?: string;
  requestUserUnionId?: string;
  requestLarkAppId?: string;
  source?: 'schedule_creator';
  taskId?: string;
  senderType?: 'user' | 'bot';
}

export type RemoteRunnerOutboundResponseKind = 'progress' | 'auxiliary';
export type RemoteRunnerOutboundMention = 'none' | 'requester';

/** A non-terminal message request emitted by a provider for the active turn.
 * Routing is intentionally absent: BotMux derives the only legal destination
 * from the authenticated session/turn that owns the backend. */
export interface RemoteRunnerOutboundMessage {
  operationId: string;
  turnId: string;
  generation: number;
  content: string;
  responseKind: RemoteRunnerOutboundResponseKind;
  mention: RemoteRunnerOutboundMention;
}

export type RemoteRunnerOutboundMessageResult =
  | {
      outcome: 'delivered';
      messageId: string;
    }
  | {
      outcome: 'rejected' | 'unknown';
      code: string;
      message: string;
    };

export type RemoteRunnerSessionToolRequest =
  | {
      tool: 'history';
      limit?: number;
      scope?: 'session' | 'thread' | 'chat' | 'ambient';
      withCardJson?: boolean;
    }
  | {
      tool: 'quoted';
      messageId: string;
      raw?: boolean;
    }
  | { tool: 'bots.list' }
  | { tool: 'skill.list' }
  | { tool: 'skill.show'; name: string }
  | { tool: 'skill.read'; name: string; path: string }
  | { tool: 'skill.resources'; name: string };

export interface RemoteRunnerSessionToolOperation {
  operationId: string;
  turnId: string;
  generation: number;
  request: RemoteRunnerSessionToolRequest;
}

export interface RemoteRunnerSessionToolAttachment {
  placeholder: string;
  name: string;
  type: 'image' | 'file';
  mimeType?: string;
  dataBase64: string;
}

export type RemoteRunnerSessionToolResult =
  | {
      outcome: 'completed';
      exitCode: number;
      stdout: string;
      stderr: string;
      attachments?: RemoteRunnerSessionToolAttachment[];
    }
  | {
      outcome: 'rejected' | 'unknown';
      code: string;
      message: string;
    };

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
      modelBackendVariant?: 'standard' | 'max';
      reasoningEffort?: string;
    })
  | (RemoteRunnerCommandBase & {
      type: 'resume';
      sessionId: string;
      cwd: string;
      state: RemoteRunnerBackendState;
      /** `rebuild` means the prior remote resource was explicitly cancelled;
       * the provider must create a new generation before reporting ready. */
      resumeMode?: 'reattach' | 'rebuild';
      model?: string;
      modelBackendVariant?: 'standard' | 'max';
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
  | (RemoteRunnerCommandBase & { type: 'reattach' })
  | (RemoteRunnerCommandBase & { type: 'status' })
  | (RemoteRunnerCommandBase & {
      type: 'outbound_message_result';
      operationId: string;
      turnId: string;
      generation: number;
      result: RemoteRunnerOutboundMessageResult;
    })
  | (RemoteRunnerCommandBase & {
      type: 'session_tool_result';
      operationId: string;
      turnId: string;
      generation: number;
      result: RemoteRunnerSessionToolResult;
    })
  | (RemoteRunnerCommandBase & { type: 'terminal_input'; generation: number; data: string })
  | (RemoteRunnerCommandBase & { type: 'terminal_resize'; generation: number; cols: number; rows: number });

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
      /** Unknown valid names are retained so older BotMux clients remain
       * forward-compatible with additive provider capabilities. */
      capabilities: string[];
    })
  | (RemoteRunnerEventBase & {
      type: 'ready';
      requestId: string;
      state: RemoteRunnerBackendState;
    })
  | (RemoteRunnerEventBase & {
      type: 'progress';
      turnId: string;
      content: string;
    })
  | (RemoteRunnerEventBase & {
      type: 'outbound_message';
      operationId: string;
      turnId: string;
      generation: number;
      content: string;
      responseKind: RemoteRunnerOutboundResponseKind;
      mention: RemoteRunnerOutboundMention;
    })
  | (RemoteRunnerEventBase & {
      type: 'session_tool';
      operationId: string;
      turnId: string;
      generation: number;
      request: RemoteRunnerSessionToolRequest;
    })
  | (RemoteRunnerEventBase & {
      type: 'final';
      turnId: string;
      content: string;
      state?: RemoteRunnerBackendState;
      /** Optional additive v1 field. Older BotMux versions safely ignore it. */
      usage?: RemoteRunnerUsageReport;
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
      type: 'terminal_screen';
      generation: number;
      sequence: number;
      cols: number;
      rows: number;
      snapshot: string;
    })
  | (RemoteRunnerEventBase & {
      type: 'status';
      requestId: string;
      status: RemoteRunnerStatus;
      state?: RemoteRunnerBackendState;
    });

const CAPABILITY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9._-]{0,127}$/;
export const MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES = 32 * 1024;
export const MAX_REMOTE_RUNNER_SESSION_TOOL_TEXT_BYTES = 512 * 1024;
export const MAX_REMOTE_RUNNER_SESSION_TOOL_ATTACHMENT_BYTES = 512 * 1024;
const SENSITIVE_STATE_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'cookie',
  'credential',
  'authorization',
  'privatekey',
  'accesskey',
] as const;

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
  return !!object && Object.entries(object).every(([key, item]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return key.length <= 256
      && !SENSITIVE_STATE_KEY_PARTS.some(part => normalizedKey.includes(part))
      && validJson(item, depth + 1);
  });
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

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function normalizeTokenPair(value: unknown): { in: number; out: number } | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const input = nonNegativeInteger(raw.in);
  const output = nonNegativeInteger(raw.out);
  if (input === undefined || output === undefined) return undefined;
  return { in: input, out: output };
}

export function normalizeRemoteRunnerUsageReport(
  value: unknown,
): RemoteRunnerUsageReport | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const generation = nonNegativeInteger(raw.generation);
  const snapshotRaw = record(raw.snapshot);
  if (generation === undefined || !snapshotRaw) return undefined;

  let context: RemoteRunnerUsageSnapshot['context'];
  if (snapshotRaw.context === null) {
    context = null;
  } else {
    const contextRaw = record(snapshotRaw.context);
    const usedTokens = nonNegativeInteger(contextRaw?.usedTokens);
    if (!contextRaw || usedTokens === undefined) return undefined;
    const windowTokens = contextRaw.windowTokens === undefined
      ? undefined
      : nonNegativeInteger(contextRaw.windowTokens);
    if (contextRaw.windowTokens !== undefined
        && (windowTokens === undefined || windowTokens === 0)) return undefined;
    const percentUsed = contextRaw.percentUsed;
    if (percentUsed !== undefined
        && (typeof percentUsed !== 'number'
          || !Number.isFinite(percentUsed)
          || percentUsed < 0
          || percentUsed > 100)) return undefined;
    context = {
      usedTokens,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      ...(percentUsed !== undefined ? { percentUsed } : {}),
    };
  }

  let tokens: RemoteRunnerUsageSnapshot['tokens'];
  if (snapshotRaw.tokens === null) {
    tokens = null;
  } else {
    tokens = normalizeTokenPair(snapshotRaw.tokens) ?? null;
    if (tokens === null) return undefined;
  }

  let turnTokens: RemoteRunnerUsageSnapshot['turnTokens'];
  if (snapshotRaw.turnTokens === null) {
    turnTokens = null;
  } else if (snapshotRaw.turnTokens !== undefined) {
    turnTokens = normalizeTokenPair(snapshotRaw.turnTokens);
    if (!turnTokens) return undefined;
  }

  const model = snapshotRaw.model === undefined
    ? undefined
    : nonEmptyString(snapshotRaw.model, 256);
  const reasoningEffort = snapshotRaw.reasoningEffort === undefined
    ? undefined
    : nonEmptyString(snapshotRaw.reasoningEffort, 64);
  const modelBackendVariant = snapshotRaw.modelBackendVariant === undefined
    ? undefined
    : nonEmptyString(snapshotRaw.modelBackendVariant, 64);
  if ((snapshotRaw.model !== undefined && !model)
      || (snapshotRaw.reasoningEffort !== undefined && !reasoningEffort)
      || (snapshotRaw.modelBackendVariant !== undefined && !modelBackendVariant)) {
    return undefined;
  }

  return {
    generation,
    snapshot: {
      context,
      tokens,
      ...(turnTokens !== undefined ? { turnTokens } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(modelBackendVariant ? { modelBackendVariant } : {}),
    },
  };
}

function hasExactKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function normalizeRemoteRunnerSessionToolRequest(
  value: unknown,
): RemoteRunnerSessionToolRequest | undefined {
  const raw = record(value);
  if (!raw || typeof raw.tool !== 'string') return undefined;

  if (raw.tool === 'history') {
    const allowed = new Set(['tool', 'limit', 'scope', 'withCardJson']);
    if (Object.keys(raw).some(key => !allowed.has(key))) return undefined;
    const limit = raw.limit === undefined ? undefined : nonNegativeInteger(raw.limit);
    if (raw.limit !== undefined && (limit === undefined || limit < 1 || limit > 100)) {
      return undefined;
    }
    const scope = raw.scope === undefined ? undefined : String(raw.scope);
    if (scope !== undefined && !['session', 'thread', 'chat', 'ambient'].includes(scope)) {
      return undefined;
    }
    if (raw.withCardJson !== undefined && typeof raw.withCardJson !== 'boolean') {
      return undefined;
    }
    return {
      tool: 'history',
      ...(limit !== undefined ? { limit } : {}),
      ...(scope !== undefined ? { scope: scope as 'session' | 'thread' | 'chat' | 'ambient' } : {}),
      ...(raw.withCardJson !== undefined ? { withCardJson: raw.withCardJson } : {}),
    };
  }

  if (raw.tool === 'quoted') {
    const allowed = new Set(['tool', 'messageId', 'raw']);
    if (Object.keys(raw).some(key => !allowed.has(key))) return undefined;
    const messageId = nonEmptyString(raw.messageId, 256);
    if (!messageId || !/^om_[A-Za-z0-9_-]+$/.test(messageId)) return undefined;
    if (raw.raw !== undefined && typeof raw.raw !== 'boolean') return undefined;
    return {
      tool: 'quoted',
      messageId,
      ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
    };
  }

  if (raw.tool === 'bots.list' || raw.tool === 'skill.list') {
    return hasExactKeys(raw, ['tool']) ? { tool: raw.tool } : undefined;
  }

  if (raw.tool === 'skill.show' || raw.tool === 'skill.resources') {
    const name = nonEmptyString(raw.name, 256);
    if (!hasExactKeys(raw, ['tool', 'name']) || !name || !ID_RE.test(name)) return undefined;
    return { tool: raw.tool, name };
  }

  if (raw.tool === 'skill.read') {
    const name = nonEmptyString(raw.name, 256);
    const path = nonEmptyString(raw.path, 1024);
    if (!hasExactKeys(raw, ['tool', 'name', 'path']) || !name || !ID_RE.test(name) || !path) {
      return undefined;
    }
    const normalizedPath = path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    if (normalizedPath.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')) {
      return undefined;
    }
    return { tool: 'skill.read', name, path: normalizedPath };
  }

  return undefined;
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
    const capabilities = raw.capabilities.map(item => nonEmptyString(item, 64));
    if (capabilities.some(item => !item || !CAPABILITY_RE.test(item))
        || new Set(capabilities).size !== capabilities.length) {
      return undefined;
    }
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'hello', requestId: id, provider, capabilities: capabilities as string[] };
  }

  if (raw.type === 'ready' || raw.type === 'lineage_changed') {
    const state = normalizeRemoteRunnerBackendState(raw.state);
    if (!state) return undefined;
    if (raw.type === 'ready') {
      const id = requestId(raw);
      if (!id) return undefined;
      return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'ready', requestId: id, state };
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
    const usage = raw.usage === undefined
      ? undefined
      : normalizeRemoteRunnerUsageReport(raw.usage);
    if (raw.usage !== undefined && !usage) return undefined;
    return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'final', turnId, content: raw.content,
      ...(state ? { state } : {}), ...(usage ? { usage } : {}) };
  }

  if (raw.type === 'outbound_message') {
    const operationId = nonEmptyString(raw.operationId, 256);
    const turnId = nonEmptyString(raw.turnId, 256);
    if (!operationId || !ID_RE.test(operationId)
        || !turnId || !ID_RE.test(turnId)
        || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
        || typeof raw.content !== 'string'
        || !raw.content.trim()
        || Buffer.byteLength(raw.content, 'utf8') > MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES
        || !['progress', 'auxiliary'].includes(String(raw.responseKind))
        || !['none', 'requester'].includes(String(raw.mention))) {
      return undefined;
    }
    return {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'outbound_message',
      operationId,
      turnId,
      generation: Number(raw.generation),
      content: raw.content,
      responseKind: raw.responseKind as RemoteRunnerOutboundResponseKind,
      mention: raw.mention as RemoteRunnerOutboundMention,
    };
  }

  if (raw.type === 'session_tool') {
    const operationId = nonEmptyString(raw.operationId, 256);
    const turnId = nonEmptyString(raw.turnId, 256);
    const request = normalizeRemoteRunnerSessionToolRequest(raw.request);
    if (!operationId || !ID_RE.test(operationId)
        || !turnId || !ID_RE.test(turnId)
        || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
        || !request) {
      return undefined;
    }
    return {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'session_tool',
      operationId,
      turnId,
      generation: Number(raw.generation),
      request,
    };
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

  if (raw.type === 'terminal_screen') {
    if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
        || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0
        || !Number.isSafeInteger(raw.cols) || Number(raw.cols) < 1 || Number(raw.cols) > 1000
        || !Number.isSafeInteger(raw.rows) || Number(raw.rows) < 1 || Number(raw.rows) > 1000
        || typeof raw.snapshot !== 'string'
        || Buffer.byteLength(raw.snapshot, 'utf8') > MAX_REMOTE_RUNNER_LINE_BYTES) {
      return undefined;
    }
    return {
      protocol: REMOTE_RUNNER_PROTOCOL,
      version: REMOTE_RUNNER_PROTOCOL_VERSION,
      type: 'terminal_screen',
      generation: Number(raw.generation),
      sequence: Number(raw.sequence),
      cols: Number(raw.cols),
      rows: Number(raw.rows),
      snapshot: raw.snapshot,
    };
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
