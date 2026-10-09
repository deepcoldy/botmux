import { DURABLE_COORDINATION_CONTRACT_VERSION, type DurableJson } from './durable-coordination.js';

export const DURABLE_COORDINATION_PROVIDER_PROTOCOL = 'botmux.durable-coordination-provider' as const;
export const DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION = 1 as const;
export const MAX_DURABLE_COORDINATION_PROVIDER_LINE_BYTES = 4 * 1024 * 1024;

export const DURABLE_COORDINATION_PROVIDER_METHODS = [
  'acquireSessionLease',
  'renewSessionLease',
  'releaseSessionLease',
  'readSession',
  'writeSession',
  'enqueueInbox',
  'claimNextInbox',
  'renewInboxClaim',
  'completeInboxClaim',
  'retryInboxClaim',
  'enqueueOutbox',
  'reserveNextOutbox',
  'beginOutboxAttempt',
  'completeOutboxAttempt',
  'retryOutboxAttempt',
  'markOutboxAmbiguous',
  'readOutbox',
  'close',
] as const;

export type DurableCoordinationProviderMethod = typeof DURABLE_COORDINATION_PROVIDER_METHODS[number];

export type DurableCoordinationProviderRequest = {
  protocol: typeof DURABLE_COORDINATION_PROVIDER_PROTOCOL;
  version: typeof DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION;
  requestId: string;
} & (
  | {
      type: 'hello';
      contractVersion: typeof DURABLE_COORDINATION_CONTRACT_VERSION;
    }
  | {
      type: 'call';
      method: DurableCoordinationProviderMethod;
      input: DurableJson;
    }
);

export type DurableCoordinationProviderResponse = {
  protocol: typeof DURABLE_COORDINATION_PROVIDER_PROTOCOL;
  version: typeof DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION;
  requestId: string;
} & (
  | {
      type: 'hello';
      provider: string;
      contractVersion: typeof DURABLE_COORDINATION_CONTRACT_VERSION;
    }
  | {
      type: 'result';
      result: DurableJson;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      retryable: boolean;
    }
);

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9._-]{0,127}$/;
const METHODS = new Set<string>(DURABLE_COORDINATION_PROVIDER_METHODS);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function durableJson(value: unknown, depth = 0): value is DurableJson {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => durableJson(item, depth + 1));
  const object = record(value);
  return !!object && Object.entries(object).every(([key, item]) => (
    key.length <= 256 && durableJson(item, depth + 1)
  ));
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function lease(value: unknown): boolean {
  const item = record(value);
  return !!item
    && nonempty(item.sessionKey)
    && nonempty(item.ownerId)
    && integer(item.epoch, 1)
    && integer(item.leaseUntil);
}

function sessionRecord(value: unknown): boolean {
  const item = record(value);
  return !!item
    && nonempty(item.sessionKey)
    && integer(item.revision, 1)
    && durableJson(item.value)
    && integer(item.updatedAt);
}

function inboxEvent(value: unknown): boolean {
  const item = record(value);
  return !!item
    && nonempty(item.eventId)
    && nonempty(item.partitionKey)
    && durableJson(item.payload)
    && integer(item.visibleAt)
    && integer(item.createdAt);
}

function inboxClaim(value: unknown): boolean {
  const item = record(value);
  return !!item
    && inboxEvent(item.event)
    && nonempty(item.workerId)
    && integer(item.claimEpoch, 1)
    && integer(item.claimUntil)
    && integer(item.attempts);
}

const OUTBOX_STATES = new Set(['pending', 'reserved', 'attempting', 'ambiguous', 'delivered']);

function outboxRecord(value: unknown): boolean {
  const item = record(value);
  return !!item
    && nonempty(item.messageId)
    && nonempty(item.sessionKey)
    && durableJson(item.payload)
    && integer(item.visibleAt)
    && integer(item.createdAt)
    && typeof item.state === 'string'
    && OUTBOX_STATES.has(item.state)
    && integer(item.originEpoch, 1)
    && integer(item.attempts)
    && (item.receipt === undefined || durableJson(item.receipt))
    && (item.lastError === undefined || typeof item.lastError === 'string')
    && integer(item.updatedAt);
}

function outboxReservation(value: unknown): boolean {
  const item = record(value);
  return !!item
    && outboxRecord(item.record)
    && nonempty(item.workerId)
    && integer(item.claimEpoch, 1)
    && integer(item.claimUntil);
}

function outboxAttempt(value: unknown): boolean {
  const item = record(value);
  return !!item && outboxReservation(item) && integer(item.attempt, 1);
}

function oneOfKinds(value: unknown, kinds: readonly string[]): Record<string, unknown> | undefined {
  const item = record(value);
  return item && typeof item.kind === 'string' && kinds.includes(item.kind) ? item : undefined;
}

/** Runtime validation at the process boundary. A configured provider is trusted
 * code, but malformed rows must still fail closed before they reach daemon
 * state or an external side-effect transition. */
export function validateDurableCoordinationProviderResult(
  method: DurableCoordinationProviderMethod,
  value: DurableJson,
): DurableJson {
  let valid = false;
  switch (method) {
    case 'acquireSessionLease': {
      const item = oneOfKinds(value, ['acquired', 'occupied']);
      valid = !!item && (item.kind === 'acquired'
        ? lease(item.lease)
        : nonempty(item.ownerId) && integer(item.epoch, 1) && integer(item.leaseUntil));
      break;
    }
    case 'renewSessionLease':
    case 'releaseSessionLease': {
      const item = oneOfKinds(value, ['applied', 'stale']);
      valid = !!item && (item.kind === 'stale' || lease(item.lease));
      break;
    }
    case 'readSession':
      valid = value === null || sessionRecord(value);
      break;
    case 'writeSession': {
      const item = oneOfKinds(value, ['written', 'conflict', 'stale_lease']);
      valid = !!item && (item.kind === 'written'
        ? sessionRecord(item.record)
        : item.kind === 'conflict'
          ? item.current === undefined || sessionRecord(item.current)
          : true);
      break;
    }
    case 'enqueueInbox': {
      valid = !!oneOfKinds(value, ['inserted', 'duplicate', 'conflict']);
      break;
    }
    case 'claimNextInbox':
      valid = value === null || inboxClaim(value);
      break;
    case 'renewInboxClaim':
    case 'completeInboxClaim':
    case 'retryInboxClaim': {
      const item = oneOfKinds(value, ['applied', 'stale']);
      valid = !!item && (item.kind === 'stale' || item.claim === undefined || inboxClaim(item.claim));
      break;
    }
    case 'enqueueOutbox':
      valid = !!oneOfKinds(value, ['inserted', 'duplicate', 'conflict', 'stale_lease']);
      break;
    case 'reserveNextOutbox':
      valid = value === null || outboxReservation(value);
      break;
    case 'beginOutboxAttempt': {
      const item = oneOfKinds(value, ['applied', 'stale']);
      valid = !!item && (item.kind === 'stale'
        || outboxRecord(item.record) && outboxAttempt(item.attempt));
      break;
    }
    case 'completeOutboxAttempt':
    case 'retryOutboxAttempt':
    case 'markOutboxAmbiguous': {
      const item = oneOfKinds(value, ['applied', 'stale']);
      valid = !!item && (item.kind === 'stale' || outboxRecord(item.record));
      break;
    }
    case 'readOutbox':
      valid = value === null || outboxRecord(value);
      break;
    case 'close':
      valid = value === null;
      break;
  }
  if (!valid) throw new Error(`durable coordination provider returned an invalid ${method} result`);
  return value;
}

export function providerHelloRequest(requestId: string): DurableCoordinationProviderRequest {
  if (!validRequestId(requestId)) throw new Error('durable coordination provider request id is invalid');
  return {
    protocol: DURABLE_COORDINATION_PROVIDER_PROTOCOL,
    version: DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION,
    requestId,
    type: 'hello',
    contractVersion: DURABLE_COORDINATION_CONTRACT_VERSION,
  };
}

export function providerCallRequest(
  requestId: string,
  method: DurableCoordinationProviderMethod,
  input: DurableJson,
): DurableCoordinationProviderRequest {
  if (!validRequestId(requestId)) throw new Error('durable coordination provider request id is invalid');
  if (!METHODS.has(method)) throw new Error('durable coordination provider method is invalid');
  if (!durableJson(input)) throw new Error('durable coordination provider input is not JSON-safe');
  return {
    protocol: DURABLE_COORDINATION_PROVIDER_PROTOCOL,
    version: DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION,
    requestId,
    type: 'call',
    method,
    input,
  };
}

export function parseDurableCoordinationProviderResponse(line: string): DurableCoordinationProviderResponse {
  if (Buffer.byteLength(line, 'utf8') > MAX_DURABLE_COORDINATION_PROVIDER_LINE_BYTES) {
    throw new Error('durable coordination provider response line is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('durable coordination provider response is not valid JSON');
  }
  const value = record(parsed);
  if (!value
      || value.protocol !== DURABLE_COORDINATION_PROVIDER_PROTOCOL
      || value.version !== DURABLE_COORDINATION_PROVIDER_PROTOCOL_VERSION
      || !validRequestId(value.requestId)) {
    throw new Error('durable coordination provider response envelope is invalid');
  }
  if (value.type === 'hello') {
    if (typeof value.provider !== 'string' || !PROVIDER_RE.test(value.provider)
        || value.contractVersion !== DURABLE_COORDINATION_CONTRACT_VERSION) {
      throw new Error('durable coordination provider hello is incompatible');
    }
    return value as DurableCoordinationProviderResponse;
  }
  if (value.type === 'result') {
    if (!durableJson(value.result)) {
      throw new Error('durable coordination provider result is not JSON-safe');
    }
    return value as DurableCoordinationProviderResponse;
  }
  if (value.type === 'error') {
    if (typeof value.code !== 'string' || !ERROR_CODE_RE.test(value.code)
        || typeof value.message !== 'string' || value.message.length > 4096
        || typeof value.retryable !== 'boolean') {
      throw new Error('durable coordination provider error is invalid');
    }
    return value as DurableCoordinationProviderResponse;
  }
  throw new Error('durable coordination provider response type is invalid');
}
