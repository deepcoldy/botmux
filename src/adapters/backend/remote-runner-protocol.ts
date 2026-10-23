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
  'outbound_message_explicit_mention',
  'outbound_message_final',
] as const;

/** Optional provider-to-host access to a small BotMux session tool surface.
 * The provider contributes structured arguments only; the host freezes the
 * current session/turn and translates them into an allowlisted local CLI
 * invocation. Mutating operations remain subject to the daemon's live-turn
 * authorization. */
export const REMOTE_RUNNER_SESSION_TOOL_CAPABILITIES = [
  'session_tool',
  'session_tool_schedule',
  'session_tool_schedule_actor',
] as const;

/** Optional recovery of a provider-owned turn that survived the host process. */
export const REMOTE_RUNNER_TURN_RECOVERY_CAPABILITIES = [
  'turn_recovery',
] as const;

export const REMOTE_RUNNER_CAPABILITIES = [
  ...REMOTE_RUNNER_BASE_CAPABILITIES,
  ...REMOTE_RUNNER_TERMINAL_CAPABILITIES,
  ...REMOTE_RUNNER_OUTBOUND_CAPABILITIES,
  ...REMOTE_RUNNER_SESSION_TOOL_CAPABILITIES,
  ...REMOTE_RUNNER_TURN_RECOVERY_CAPABILITIES,
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
    /** Optional cumulative cache reads / writes, both subsets of `in`. */
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
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
  source?: 'schedule_creator' | 'failed_turn_recovery';
  taskId?: string;
  senderType?: 'user' | 'bot';
  botOwner?: {
    openId: string;
    unionId: string;
    email: string;
    source: 'bot_config';
  };
}

export interface RemoteRunnerRecoveredTurn {
  turnId: string;
  generation: number;
  dispatchAttempt?: number;
  startedAtMs?: number;
  trustedCaller?: RemoteRunnerTrustedCaller;
}

export type RemoteRunnerOutboundResponseKind = 'progress' | 'auxiliary' | 'final';
export type RemoteRunnerOutboundMention = 'none' | 'requester' | 'explicit';

export interface RemoteRunnerOutboundImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  dataBase64: string;
}

/** A message request emitted by a provider for the active turn. Routing is
 * intentionally absent: BotMux derives the only legal destination from the
 * authenticated session/turn that owns the backend. `final` additionally
 * requires bilateral `outbound_message_final` negotiation. */
export interface RemoteRunnerOutboundMessage {
  operationId: string;
  turnId: string;
  generation: number;
  content: string;
  responseKind: RemoteRunnerOutboundResponseKind;
  mention: RemoteRunnerOutboundMention;
  mentions?: string[];
  images?: RemoteRunnerOutboundImage[];
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
  | { tool: 'skill.resources'; name: string }
  | { tool: 'schedule.list' }
  | {
      tool: 'schedule.add';
      schedule: string;
      prompt: string;
      name?: string;
      position?: 'top-level' | 'topic' | 'new-topic';
      followActive?: boolean;
      topicTitle?: string;
      silent?: boolean;
      model?: string;
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
      calendar?: string;
      calendarDayType?: 'workday' | 'restday';
    }
  | {
      tool: 'schedule.update';
      taskId: string;
      prompt?: string;
      calendar?: string | null;
      calendarDayType?: 'workday' | 'restday';
    }
  | {
      tool: 'schedule.remove' | 'schedule.pause';
      taskId: string;
    }
  | {
      tool: 'schedule.resume' | 'schedule.run';
      taskId: string;
    };

export interface RemoteRunnerSessionToolOperation {
  operationId: string;
  turnId: string;
  generation: number;
  request: RemoteRunnerSessionToolRequest;
  controllerOpenId?: string;
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
      dispatchAttempt?: number;
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
      recoveredTurn?: RemoteRunnerRecoveredTurn;
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
      mentions?: string[];
      images?: RemoteRunnerOutboundImage[];
    })
  | (RemoteRunnerEventBase & {
      type: 'session_tool';
      operationId: string;
      turnId: string;
      generation: number;
      request: RemoteRunnerSessionToolRequest;
      /** Effective human Actor selected by a trusted provider policy for a
       * bot-authored schedule mutation. The host freezes all other scope. */
      controllerOpenId?: string;
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
const CLI_FLAG_SHAPED_VALUE_RE = /^--?\w/;

export function isCliFlagShapedRemoteRunnerValue(value: string): boolean {
  return CLI_FLAG_SHAPED_VALUE_RE.test(value.trim());
}

export const MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES = 32 * 1024;
export const MAX_REMOTE_RUNNER_OUTBOUND_IMAGES = 4;
export const MAX_REMOTE_RUNNER_OUTBOUND_IMAGE_BYTES = 2 * 1024 * 1024;
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

function normalizeBotOwner(value: unknown): RemoteRunnerTrustedCaller['botOwner'] | undefined | null {
  if (value === undefined) return undefined;
  const raw = record(value);
  const openId = nonEmptyString(raw?.openId, 256);
  const unionId = nonEmptyString(raw?.unionId, 256);
  const email = nonEmptyString(raw?.email, 320)?.toLowerCase();
  if (!raw || !openId?.startsWith('ou_') || !unionId?.startsWith('on_')
      || !email || !email.includes('@') || raw.source !== 'bot_config') return null;
  return { openId, unionId, email, source: 'bot_config' };
}

function normalizeRecoveredTurn(value: unknown): RemoteRunnerRecoveredTurn | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const turnId = nonEmptyString(raw.turnId, 256);
  const generation = nonNegativeInteger(raw.generation);
  const dispatchAttempt = raw.dispatchAttempt === undefined
    ? undefined
    : nonNegativeInteger(raw.dispatchAttempt);
  const startedAtMs = raw.startedAtMs === undefined
    ? undefined
    : nonNegativeInteger(raw.startedAtMs);
  if (!turnId || !ID_RE.test(turnId) || generation === undefined
      || (raw.dispatchAttempt !== undefined && dispatchAttempt === undefined)
      || (raw.startedAtMs !== undefined && startedAtMs === undefined)) return undefined;

  let trustedCaller: RemoteRunnerTrustedCaller | undefined;
  if (raw.trustedCaller !== undefined) {
    const caller = record(raw.trustedCaller);
    const openId = nonEmptyString(caller?.requestUserOpenId, 256);
    const appId = nonEmptyString(caller?.requestLarkAppId, 256);
    const botOwner = normalizeBotOwner(caller?.botOwner);
    if (!caller || !openId || !appId || !['user', 'bot'].includes(String(caller.senderType))
      || botOwner === null || (botOwner !== undefined && caller.senderType !== 'bot')) {
      return undefined;
    }
    // botOwner is host-attested: the daemon mints it only for an outbound turn
    // command after roster + Contact API verification. A provider reporting it
    // back inside recoveredTurn cannot be the source of truth, so the field is
    // validated above (malformed shapes still reject the event) but never
    // carried into the recovered caller. The next outbound turn command sends a
    // freshly attested owner; host-side authorization never reads the field.
    trustedCaller = {
      requestUserOpenId: openId,
      requestLarkAppId: appId,
      senderType: caller.senderType as 'user' | 'bot',
    };
  }
  return {
    turnId,
    generation,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(trustedCaller ? { trustedCaller } : {}),
  };
}

function normalizeTokenPair(value: unknown): { in: number; out: number } | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const input = nonNegativeInteger(raw.in);
  const output = nonNegativeInteger(raw.out);
  if (input === undefined || output === undefined) return undefined;
  return { in: input, out: output };
}

/** Cumulative tokens: the in/out pair plus optional cache counters. A cache
 *  counter that is present must be a non-negative integer no larger than `in`;
 *  otherwise the whole snapshot is rejected, like any other malformed metric. */
function normalizeCumulativeTokens(value: unknown): RemoteRunnerUsageSnapshot['tokens'] | undefined {
  const tokens: RemoteRunnerUsageSnapshot['tokens'] | undefined = normalizeTokenPair(value);
  if (!tokens) return undefined;
  const raw = record(value)!;
  for (const key of ['cacheReadTokens', 'cacheCreateTokens'] as const) {
    if (raw[key] === undefined) continue;
    const count = nonNegativeInteger(raw[key]);
    if (count === undefined || count > tokens.in) return undefined;
    tokens[key] = count;
  }
  return tokens;
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
    tokens = normalizeCumulativeTokens(snapshotRaw.tokens) ?? null;
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

function boundedUtf8String(value: unknown, maxBytes: number, trim = false): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const normalized = trim ? value.trim() : value;
  if (!normalized.trim() || Buffer.byteLength(normalized, 'utf8') > maxBytes) return undefined;
  return normalized;
}

const SCHEDULE_TASK_ID_RE = /^[0-9a-f]{8}$/;
const LARK_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,160}$/;
const SCHEDULE_REASONING_EFFORTS = new Set([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

const OUTBOUND_IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,122}\.(?:png|jpe?g|gif|webp)$/i;
const OUTBOUND_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const);

function detectedImageMime(content: Buffer): RemoteRunnerOutboundImage['mimeType'] | undefined {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg';
  }
  if (content.subarray(0, 6).toString('ascii') === 'GIF87a'
      || content.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (content.subarray(0, 4).toString('ascii') === 'RIFF'
      && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function imageNameMatchesMime(name: string, mimeType: string): boolean {
  const extension = name.toLowerCase().split('.').pop();
  if (mimeType === 'image/png') return extension === 'png';
  if (mimeType === 'image/jpeg') return extension === 'jpg' || extension === 'jpeg';
  if (mimeType === 'image/gif') return extension === 'gif';
  if (mimeType === 'image/webp') return extension === 'webp';
  return false;
}

function normalizeRemoteRunnerOutboundImages(
  value: unknown,
): RemoteRunnerOutboundImage[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REMOTE_RUNNER_OUTBOUND_IMAGES) return undefined;
  const images: RemoteRunnerOutboundImage[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    const raw = record(item);
    if (!raw || !hasExactKeys(raw, ['name', 'mimeType', 'dataBase64'])) return undefined;
    const name = nonEmptyString(raw.name, 160);
    const mimeType = raw.mimeType;
    const dataBase64 = raw.dataBase64;
    if (!name || !OUTBOUND_IMAGE_NAME_RE.test(name) || names.has(name)
        || typeof mimeType !== 'string' || !OUTBOUND_IMAGE_MIME_TYPES.has(mimeType)
        || !imageNameMatchesMime(name, mimeType)
        || typeof dataBase64 !== 'string'
        || dataBase64.length > Math.ceil(MAX_REMOTE_RUNNER_OUTBOUND_IMAGE_BYTES / 3) * 4 + 4) {
      return undefined;
    }
    const content = Buffer.from(dataBase64, 'base64');
    if (content.length === 0 || content.toString('base64') !== dataBase64
        || detectedImageMime(content) !== mimeType) return undefined;
    totalBytes += content.length;
    if (totalBytes > MAX_REMOTE_RUNNER_OUTBOUND_IMAGE_BYTES) return undefined;
    names.add(name);
    images.push({
      name,
      mimeType: mimeType as RemoteRunnerOutboundImage['mimeType'],
      dataBase64,
    });
  }
  return images;
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

  if (raw.tool === 'schedule.list') {
    return hasExactKeys(raw, ['tool']) ? { tool: 'schedule.list' } : undefined;
  }

  if (raw.tool === 'schedule.add') {
    const allowed = new Set([
      'tool', 'schedule', 'prompt', 'name', 'position', 'followActive',
      'topicTitle', 'silent', 'model', 'reasoningEffort', 'calendar',
      'calendarDayType',
    ]);
    if (Object.keys(raw).some(key => !allowed.has(key))) return undefined;
    const schedule = boundedUtf8String(raw.schedule, 512, true);
    const prompt = boundedUtf8String(raw.prompt, 32 * 1024);
    const name = raw.name === undefined ? undefined : boundedUtf8String(raw.name, 512, true);
    const position = raw.position === undefined ? undefined : String(raw.position);
    const topicTitle = raw.topicTitle === undefined
      ? undefined
      : boundedUtf8String(raw.topicTitle, 1024, true);
    const model = raw.model === undefined ? undefined : boundedUtf8String(raw.model, 256, true);
    const calendar = raw.calendar === undefined
      ? undefined
      : boundedUtf8String(raw.calendar, 256, true);
    const reasoningEffort = raw.reasoningEffort === undefined
      ? undefined
      : String(raw.reasoningEffort);
    const calendarDayType = raw.calendarDayType === undefined
      ? undefined
      : String(raw.calendarDayType);
    if (!schedule || !prompt
      || (raw.name !== undefined && !name)
      || (position !== undefined && !['top-level', 'topic', 'new-topic'].includes(position))
      || (raw.followActive !== undefined && typeof raw.followActive !== 'boolean')
      || (raw.topicTitle !== undefined && !topicTitle)
      || (raw.silent !== undefined && typeof raw.silent !== 'boolean')
      || (raw.model !== undefined && (!model || !ID_RE.test(model)))
      || (reasoningEffort !== undefined && !SCHEDULE_REASONING_EFFORTS.has(reasoningEffort))
      || (raw.calendar !== undefined && !calendar)
      || (calendarDayType !== undefined && !['workday', 'restday'].includes(calendarDayType))) {
      return undefined;
    }
    const resolvedPosition = position ?? 'top-level';
    if (raw.followActive === true && resolvedPosition !== 'topic') return undefined;
    if (topicTitle && resolvedPosition !== 'new-topic') return undefined;
    if (topicTitle && Array.from(topicTitle).length > 200) return undefined;
    return {
      tool: 'schedule.add',
      schedule,
      prompt,
      ...(name ? { name } : {}),
      ...(position ? { position: position as 'top-level' | 'topic' | 'new-topic' } : {}),
      ...(raw.followActive !== undefined ? { followActive: raw.followActive } : {}),
      ...(topicTitle ? { topicTitle } : {}),
      ...(raw.silent !== undefined ? { silent: raw.silent } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' } : {}),
      ...(calendar ? { calendar } : {}),
      ...(calendarDayType ? { calendarDayType: calendarDayType as 'workday' | 'restday' } : {}),
    };
  }

  if (raw.tool === 'schedule.update') {
    const allowed = new Set(['tool', 'taskId', 'prompt', 'calendar', 'calendarDayType']);
    if (Object.keys(raw).some(key => !allowed.has(key))) return undefined;
    const taskId = boundedUtf8String(raw.taskId, 8, true);
    const prompt = raw.prompt === undefined ? undefined : boundedUtf8String(raw.prompt, 32 * 1024);
    const calendar = raw.calendar === undefined || raw.calendar === null
      ? raw.calendar
      : boundedUtf8String(raw.calendar, 256, true);
    const calendarDayType = raw.calendarDayType === undefined
      ? undefined
      : String(raw.calendarDayType);
    if (!taskId || !SCHEDULE_TASK_ID_RE.test(taskId)
      || (raw.prompt !== undefined && !prompt)
      || (raw.calendar !== undefined && raw.calendar !== null && !calendar)
      || (calendarDayType !== undefined && !['workday', 'restday'].includes(calendarDayType))
      || (prompt === undefined && raw.calendar === undefined && calendarDayType === undefined)) {
      return undefined;
    }
    return {
      tool: 'schedule.update',
      taskId,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(raw.calendar !== undefined ? { calendar: calendar as string | null } : {}),
      ...(calendarDayType ? { calendarDayType: calendarDayType as 'workday' | 'restday' } : {}),
    };
  }

  if (raw.tool === 'schedule.remove' || raw.tool === 'schedule.pause'
      || raw.tool === 'schedule.resume' || raw.tool === 'schedule.run') {
    const taskId = boundedUtf8String(raw.taskId, 8, true);
    if (!hasExactKeys(raw, ['tool', 'taskId']) || !taskId
      || (!SCHEDULE_TASK_ID_RE.test(taskId)
        && !(taskId === 'self' && (raw.tool === 'schedule.remove' || raw.tool === 'schedule.pause')))) {
      return undefined;
    }
    return { tool: raw.tool, taskId };
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
      const recoveredTurn = raw.recoveredTurn === undefined
        ? undefined
        : normalizeRecoveredTurn(raw.recoveredTurn);
      if (!id || (raw.recoveredTurn !== undefined && !recoveredTurn)) return undefined;
      return { protocol: REMOTE_RUNNER_PROTOCOL, version: REMOTE_RUNNER_PROTOCOL_VERSION,
        type: 'ready', requestId: id, state,
        ...(recoveredTurn ? { recoveredTurn } : {}) };
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
    const images = normalizeRemoteRunnerOutboundImages(raw.images);
    const mentions = raw.mentions === undefined
      ? []
      : (Array.isArray(raw.mentions)
        && raw.mentions.length > 0
        && raw.mentions.every(value => (
          typeof value === 'string'
          && value.trim() !== ''
          && !value.includes('\0')
          && !isCliFlagShapedRemoteRunnerValue(value)
        ))
        && Buffer.byteLength(raw.mentions.join('\0'), 'utf8')
          <= MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES
        ? raw.mentions as string[]
        : undefined);
    const mention = String(raw.mention);
    const mentionShapeValid = mention === 'explicit'
      ? mentions !== undefined && mentions.length > 0
      : ['none', 'requester'].includes(mention)
        && raw.mentions === undefined;
    if (!operationId || !ID_RE.test(operationId)
        || !turnId || !ID_RE.test(turnId)
        || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
        || typeof raw.content !== 'string'
        || !raw.content.trim()
        || Buffer.byteLength(raw.content, 'utf8') > MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES
        || !['progress', 'auxiliary', 'final'].includes(String(raw.responseKind))
        || !mentionShapeValid
        || images === undefined) {
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
      mention: mention as RemoteRunnerOutboundMention,
      ...(mention === 'explicit' ? { mentions } : {}),
      ...(images.length ? { images } : {}),
    };
  }

  if (raw.type === 'session_tool') {
    const operationId = nonEmptyString(raw.operationId, 256);
    const turnId = nonEmptyString(raw.turnId, 256);
    const request = normalizeRemoteRunnerSessionToolRequest(raw.request);
    const controllerOpenId = raw.controllerOpenId === undefined
      ? undefined
      : nonEmptyString(raw.controllerOpenId, 163);
    if (!operationId || !ID_RE.test(operationId)
        || !turnId || !ID_RE.test(turnId)
        || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0
        || (raw.controllerOpenId !== undefined
          && (!controllerOpenId || !LARK_OPEN_ID_RE.test(controllerOpenId)))
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
      ...(controllerOpenId ? { controllerOpenId } : {}),
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
