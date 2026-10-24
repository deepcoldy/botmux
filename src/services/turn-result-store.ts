import type { TurnResult, TurnResultBinding, TurnDeliveryReceipt, TurnResultLookup } from './turn-result.js';
import { isDeepStrictEqual } from 'node:util';

interface ResultEntry {
  binding: TurnResultBinding;
  createdAt: number;
  readyAt?: number;
  execution?: TurnResult['execution'];
  output?: TurnResult['output'];
  receipt?: TurnDeliveryReceipt;
  result?: TurnResult;
  bytes: number;
}

const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const PENDING_TTL_MS = 5 * 60 * 1000;
const READY_TTL_MS = 15 * 60 * 1000;

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);
}

function keyFor(ref: TurnResult['ref']): string {
  if (!validText(ref.botId) || !validText(ref.sessionId) || !validText(ref.turnId)
    || (ref.dispatchAttempt !== undefined && (!Number.isSafeInteger(ref.dispatchAttempt) || ref.dispatchAttempt < 0))) {
    throw new Error('invalid_turn_result_reference');
  }
  return JSON.stringify([ref.botId, ref.sessionId, ref.turnId, ref.dispatchAttempt ?? null]);
}

function snapshot<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(cloned);
  return cloned;
}

function optionalText(value: string | undefined): string | undefined {
  if (value !== undefined && !validText(value)) throw new Error('invalid_turn_result_metadata');
  return value;
}

export class TurnResultStore {
  private readonly entries = new Map<string, ResultEntry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  begin(binding: TurnResultBinding): void {
    const key = keyFor(binding.ref);
    this.prune();
    if (this.entries.has(key)) return;
    if (!Number.isSafeInteger(binding.workerGeneration) || binding.workerGeneration <= 0
      || !['im', 'http'].includes(binding.source.kind)) throw new Error('invalid_turn_result_binding');
    const normalized: TurnResultBinding = {
      ref: { botId: binding.ref.botId, sessionId: binding.ref.sessionId, turnId: binding.ref.turnId,
        ...(binding.ref.dispatchAttempt === undefined ? {} : { dispatchAttempt: binding.ref.dispatchAttempt }) },
      workerGeneration: binding.workerGeneration,
      source: { kind: binding.source.kind,
        ...(binding.source.platform === undefined ? {} : { platform: optionalText(binding.source.platform) }),
        ...(binding.source.chatId === undefined ? {} : { chatId: optionalText(binding.source.chatId) }),
        ...(binding.source.messageId === undefined ? {} : { messageId: optionalText(binding.source.messageId) }) },
    };
    const entry: ResultEntry = { binding: snapshot(normalized), createdAt: this.now(), bytes: 0 };
    this.entries.set(key, entry);
    this.bound();
  }

  private matching(binding: TurnResultBinding): ResultEntry | undefined {
    this.prune();
    const entry = this.entries.get(keyFor(binding.ref));
    return entry && isDeepStrictEqual(entry.binding, binding) ? entry : undefined;
  }

  recordTerminal(binding: TurnResultBinding, execution: TurnResult['execution'], empty = false): void {
    const entry = this.matching(binding);
    if (!entry || entry.result || entry.execution) return;
    if (!['completed', 'failed', 'cancelled', 'ambiguous'].includes(execution.status)
      || (execution.completedAt !== undefined && (!validText(execution.completedAt) || !Number.isFinite(Date.parse(execution.completedAt))))
      || (execution.durationMs !== undefined && (!Number.isSafeInteger(execution.durationMs) || execution.durationMs < 0))) {
      throw new Error('invalid_turn_result_terminal');
    }
    entry.execution = {
      status: execution.status,
      ...(execution.status !== 'completed' && execution.errorCode !== undefined
        ? { errorCode: optionalText(execution.errorCode) } : {}),
      ...(execution.completedAt === undefined ? {} : { completedAt: execution.completedAt }),
      ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
    };
    if (execution.status !== 'completed') entry.output = { status: 'unavailable', reason: `execution_${execution.status}` };
    else if (empty && !entry.output) entry.output = { status: 'empty' };
    this.settle(entry);
    this.bound();
  }

  recordDelivery(binding: TurnResultBinding, output: TurnResult['output'], receipt: TurnDeliveryReceipt): void {
    const entry = this.matching(binding);
    if (!entry || entry.result) return;
    if (!['available', 'empty', 'unavailable'].includes(output.status)
      || (output.status === 'available' && typeof output.content !== 'string')
      || (output.format !== undefined && !['text', 'markdown'].includes(output.format))
      || (output.source !== undefined && !['explicit', 'transcript'].includes(output.source))
      || !['im', 'http'].includes(receipt.channel)
      || !['delivered', 'partial', 'failed', 'unknown', 'suppressed'].includes(receipt.status)
      || !Array.isArray(receipt.messages) || receipt.messages.length > 256
      || receipt.messages.some(message => !validText(message.messageId) || !['primary', 'attachment'].includes(message.kind))) {
      throw new Error('invalid_turn_result_delivery');
    }
    // A failed/partial plugin attempt is provisional until the native terminal
    // arrives. If the model recovers and publishes a fully acknowledged final,
    // that user-visible success is authoritative. Never replace an already
    // delivered receipt, and never mutate a settled result.
    if (entry.receipt) {
      if (entry.receipt.status === 'delivered' || receipt.status !== 'delivered') return;
    }
    entry.output = {
      status: output.status,
      ...(output.status === 'available' ? { content: output.content, ...(output.format ? { format: output.format } : {}),
        ...(output.source ? { source: output.source } : {}) } : {}),
      ...(output.reason === undefined ? {} : { reason: optionalText(output.reason) }),
    };
    entry.receipt = {
      channel: receipt.channel, status: receipt.status,
      messages: receipt.messages.map(message => ({ messageId: message.messageId, kind: message.kind })),
      ...(receipt.platform === undefined ? {} : { platform: optionalText(receipt.platform) }),
      ...(receipt.chatId === undefined ? {} : { chatId: optionalText(receipt.chatId) }),
      ...(receipt.parentMessageId === undefined ? {} : { parentMessageId: optionalText(receipt.parentMessageId) }),
      ...(receipt.reason === undefined ? {} : { reason: optionalText(receipt.reason) }),
    };
    if (Buffer.byteLength(JSON.stringify({ output: entry.output, receipt: entry.receipt, binding: entry.binding })) > MAX_RESULT_BYTES) {
      entry.output = { status: 'unavailable', reason: 'result_too_large' };
    }
    this.settle(entry);
    this.bound();
  }

  private settle(entry: ResultEntry): void {
    if (!entry.execution || !entry.output
      || (entry.output.status !== 'empty' && !entry.receipt)) return;
    if (entry.execution.status !== 'completed') entry.output = { status: 'unavailable', reason: `execution_${entry.execution.status}` };
    entry.readyAt = this.now();
    const result: TurnResult = {
      version: 1, ref: entry.binding.ref, source: entry.binding.source,
      execution: entry.execution, output: entry.output, deliveries: entry.receipt ? [entry.receipt] : [],
    };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
      result.output = { status: 'unavailable', reason: 'result_too_large' };
    }
    entry.result = snapshot(result);
    delete entry.output;
    delete entry.receipt;
    delete entry.execution;
  }

  read(ref: TurnResult['ref']): TurnResultLookup {
    const key = keyFor(ref);
    const entry = this.entries.get(key);
    if (entry && entry.readyAt === undefined && this.now() - entry.createdAt >= PENDING_TTL_MS) {
      this.entries.delete(key);
      this.prune();
      return { status: 'unavailable', reason: 'result_not_settled' };
    }
    this.prune();
    const current = this.entries.get(key);
    if (!current) return { status: 'not_found' };
    return current.result ? { status: 'ready', result: snapshot(current.result) } : { status: 'not_ready' };
  }

  readBinding(ref: TurnResult['ref']): TurnResultBinding | undefined {
    this.prune();
    const binding = this.entries.get(keyFor(ref))?.binding;
    return binding ? snapshot(binding) : undefined;
  }

  forget(ref: TurnResult['ref']): void {
    let key: string;
    try { key = keyFor(ref); } catch { return; }
    this.entries.delete(key);
  }

  clearBot(botId: string): void {
    for (const [key, entry] of this.entries) if (entry.binding.ref.botId === botId) this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.readyAt === undefined ? now - entry.createdAt >= PENDING_TTL_MS : now - entry.readyAt >= READY_TTL_MS) {
        this.entries.delete(key);
      }
    }
  }

  private bound(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) {
      entry.bytes = Buffer.byteLength(JSON.stringify(entry));
      bytes += entry.bytes;
    }
    while (this.entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      bytes -= oldest[1].bytes;
      this.entries.delete(oldest[0]);
    }
  }
}
