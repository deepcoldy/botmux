import type { SendMessageFn, ReplyMessageFn } from '../cli/send-dispatch.js';
import { describeSendFailure } from '../cli/send-dispatch.js';
import type { ManagedHookOrigin } from './hook-runner.js';
import type { DurableJson, DurableOutboxMessage, DurableOutboxRecord } from './durable-coordination.js';
import type {
  DurableOutboxDeliveryContext,
  DurableOutboxDeliveryResult,
} from './durable-outbox-pump.js';
import { classifyFeishuError } from '../workflows/hostExecutors/feishu-send.js';
import { PROVIDER_TTL_MS } from '../workflows/shared/provider-reconciler.js';

export const DURABLE_LARK_OUTBOX_VERSION = 1 as const;
export const LARK_OUTBOX_IDEMPOTENCY_TTL_MS = PROVIDER_TTL_MS['feishu-im'];
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;
const IDEMPOTENCY_EXPIRY_GUARD_MS = 60_000;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_HOOK_CONTEXT_BYTES = 32 * 1024;
const UUID_RE = /^[A-Za-z0-9_-]{1,50}$/;

export type DurableLarkOutboxTarget =
  | { kind: 'send'; chatId: string }
  | { kind: 'reply'; messageId: string; replyInThread: boolean };

export interface DurableLarkOutboxEnvelope {
  version: typeof DURABLE_LARK_OUTBOX_VERSION;
  type: 'botmux.lark.outbound';
  messageId: string;
  larkAppId: string;
  target: DurableLarkOutboxTarget;
  content: string;
  msgType: string;
  providerUuid: string;
  hookContext?: { [key: string]: DurableJson };
}

export interface DurableLarkOutboxInput {
  messageId: string;
  sessionKey: string;
  larkAppId: string;
  target: DurableLarkOutboxTarget;
  content: string;
  msgType?: string;
  providerUuid: string;
  hookContext?: Record<string, unknown>;
  visibleAt?: number;
  createdAt?: number;
}

export interface DurableLarkHookAuthority {
  /** Runs after provider acceptance and immediately before the distinct hook. */
  beforeHook: () => void | Promise<void>;
  /** Frozen origin for the read-isolated hook forwarding path. */
  hookOrigin?: ManagedHookOrigin;
}

export interface DurableLarkOutboxDeliveryOptions {
  now?: () => number;
  retryDelaysMs?: readonly number[];
  /** Revalidate Session/epoch authority immediately before each provider call. */
  beforeEffect?: (
    envelope: DurableLarkOutboxEnvelope,
    context: DurableOutboxDeliveryContext,
  ) => void | Promise<void>;
  /** Resolve a post-provider hook fence. Absence suppresses hooks fail-closed. */
  hookAuthority?: (
    envelope: DurableLarkOutboxEnvelope,
    context: DurableOutboxDeliveryContext,
  ) => DurableLarkHookAuthority | Promise<DurableLarkHookAuthority>;
}

export interface DurableLarkOutboxDeps {
  sendMessage: SendMessageFn;
  replyMessage: ReplyMessageFn;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must contain bounded non-empty text`);
  }
  return value;
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function content(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('durable Lark outbox content exceeds the supported byte limit');
  }
  return value;
}

function providerUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error('durable Lark outbox providerUuid must be 1..50 URL-safe characters');
  }
  return value;
}

function durableObject(value: unknown, name: string, maximumBytes: number): { [key: string]: DurableJson } {
  const source = record(value);
  if (!source) throw new Error(`${name} must be a JSON object`);
  const encoded = JSON.stringify(source);
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) throw new Error(`${name} exceeds the supported byte limit`);
  return JSON.parse(encoded) as { [key: string]: DurableJson };
}

function target(value: unknown): DurableLarkOutboxTarget {
  const item = record(value);
  if (item?.kind === 'send') {
    const chatId = nonempty(item.chatId, 'durable Lark chatId', 256);
    if (!chatId.startsWith('oc_')) throw new Error('durable Lark send target must be a chat id');
    return { kind: 'send', chatId };
  }
  if (item?.kind === 'reply') {
    const messageId = nonempty(item.messageId, 'durable Lark reply messageId', 256);
    if (!messageId.startsWith('om_')) throw new Error('durable Lark reply target must be a message id');
    if (typeof item.replyInThread !== 'boolean') throw new Error('durable Lark reply target requires replyInThread');
    return { kind: 'reply', messageId, replyInThread: item.replyInThread };
  }
  throw new Error('durable Lark outbox target is invalid');
}

function envelope(value: unknown): DurableLarkOutboxEnvelope {
  const item = record(value);
  if (item?.version !== DURABLE_LARK_OUTBOX_VERSION || item.type !== 'botmux.lark.outbound') {
    throw new Error('durable Lark outbox envelope version/type is invalid');
  }
  const messageId = nonempty(item.messageId, 'durable Lark messageId', 256);
  const larkAppId = nonempty(item.larkAppId, 'durable Lark app id', 256);
  if (!larkAppId.startsWith('cli_')) throw new Error('durable Lark app id is invalid');
  const msgType = nonempty(item.msgType, 'durable Lark message type', 64);
  return {
    version: DURABLE_LARK_OUTBOX_VERSION,
    type: 'botmux.lark.outbound',
    messageId,
    larkAppId,
    target: target(item.target),
    content: content(item.content),
    msgType,
    providerUuid: providerUuid(item.providerUuid),
    ...(item.hookContext === undefined
      ? {}
      : { hookContext: durableObject(item.hookContext, 'durable Lark hookContext', MAX_HOOK_CONTEXT_BYTES) }),
  };
}

export function durableLarkOutboxMessage(input: DurableLarkOutboxInput): DurableOutboxMessage {
  const createdAt = timestamp(input.createdAt ?? Date.now(), 'createdAt');
  const visibleAt = timestamp(input.visibleAt ?? createdAt, 'visibleAt');
  const value: DurableLarkOutboxEnvelope = envelope({
    version: DURABLE_LARK_OUTBOX_VERSION,
    type: 'botmux.lark.outbound',
    messageId: input.messageId,
    larkAppId: input.larkAppId,
    target: input.target,
    content: input.content,
    msgType: input.msgType ?? 'text',
    providerUuid: input.providerUuid,
    ...(input.hookContext ? { hookContext: input.hookContext } : {}),
  });
  return {
    messageId: value.messageId,
    sessionKey: nonempty(input.sessionKey, 'durable Lark sessionKey', 1_024),
    payload: value as unknown as DurableJson,
    visibleAt,
    createdAt,
  };
}

export function parseDurableLarkOutboxRecord(record: DurableOutboxRecord): DurableLarkOutboxEnvelope {
  const parsed = envelope(record.payload);
  if (parsed.messageId !== record.messageId) {
    throw new Error('durable Lark outbox message identity does not match its row');
  }
  return parsed;
}

function retryAt(
  record: DurableOutboxRecord,
  attempt: number,
  now: number,
  delays: readonly number[],
): number | undefined {
  const delay = delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)];
  if (!Number.isSafeInteger(delay) || delay < 0) return undefined;
  const visibleAt = now + delay;
  const expiresAt = record.createdAt + LARK_OUTBOX_IDEMPOTENCY_TTL_MS;
  return visibleAt < expiresAt - IDEMPOTENCY_EXPIRY_GUARD_MS ? visibleAt : undefined;
}

/** Deliver one already-attempting durable row through existing Lark clients. */
export async function deliverDurableLarkOutbox(
  record: DurableOutboxRecord,
  context: DurableOutboxDeliveryContext,
  deps: DurableLarkOutboxDeps,
  options: DurableLarkOutboxDeliveryOptions = {},
): Promise<DurableOutboxDeliveryResult> {
  let parsed: DurableLarkOutboxEnvelope;
  try {
    parsed = parseDurableLarkOutboxRecord(record);
  } catch (error) {
    return {
      kind: 'ambiguous',
      error: `invalid durable Lark payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const safeRetry = (error: string, proof: 'no_side_effect' | 'stable_target_idempotency') => {
    const visibleAt = retryAt(record, context.attempt.attempt, now(), delays);
    return visibleAt === undefined
      ? { kind: 'ambiguous' as const, error: `${error}; provider UUID dedupe window is exhausted` }
      : { kind: 'retry' as const, visibleAt, error, proof };
  };

  if (context.signal.aborted) {
    return safeRetry('delivery aborted before provider invocation', 'no_side_effect');
  }

  let hookAuthority: DurableLarkHookAuthority | undefined;
  try {
    await options.beforeEffect?.(parsed, context);
    if (context.attempt.attempt === 1 && options.hookAuthority) {
      hookAuthority = await options.hookAuthority(parsed, context);
    }
  } catch (error) {
    return safeRetry(
      `delivery authority unavailable before provider invocation: ${describeSendFailure(error)}`,
      'no_side_effect',
    );
  }
  if (context.signal.aborted) {
    return safeRetry('delivery aborted after authority check and before provider invocation', 'no_side_effect');
  }

  const hookContext = parsed.hookContext as Record<string, unknown> | undefined;
  const outboundOptions = context.attempt.attempt > 1 || !hookAuthority
    ? { suppressHook: true as const }
    : {
        beforeHook: hookAuthority.beforeHook,
        ...(hookAuthority.hookOrigin ? { hookOrigin: hookAuthority.hookOrigin } : {}),
      };

  try {
    const providerMessageId = parsed.target.kind === 'send'
      ? await deps.sendMessage(
          parsed.larkAppId,
          parsed.target.chatId,
          parsed.content,
          parsed.msgType,
          parsed.providerUuid,
          hookContext,
          outboundOptions,
        )
      : await deps.replyMessage(
          parsed.larkAppId,
          parsed.target.messageId,
          parsed.content,
          parsed.msgType,
          parsed.target.replyInThread,
          parsed.providerUuid,
          hookContext,
          outboundOptions,
        );
    return {
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId,
        providerUuid: parsed.providerUuid,
        operation: parsed.target.kind,
        targetId: parsed.target.kind === 'send' ? parsed.target.chatId : parsed.target.messageId,
      },
    };
  } catch (error) {
    const detail = describeSendFailure(error);
    const classification = classifyFeishuError(error);
    if (classification?.errorClass === 'retryable') {
      return safeRetry(detail, 'stable_target_idempotency');
    }
    return { kind: 'ambiguous', error: detail };
  }
}
