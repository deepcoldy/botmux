import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CardActionTimeField {
  path: string;
  type: string;
  status: 'missing' | 'numeric' | 'invalid';
  /** Only numeric scalars and null are safe to retain; other values are omitted. */
  raw?: string | number | null;
}

export interface CardActionTimeSample {
  stage: 'sdk-invoke' | 'card-action-trigger';
  correlationKey: string;
  fields: CardActionTimeField[];
  /** Local observation time, never a substitute for a native time field. */
  local: { receivedAtMs: number | null; observedAtMs: number };
}

export interface CardActionTimeProbeOptions {
  /** Host-selected card; never read from action.value or form contents. */
  messageId: string;
  emit(sample: CardActionTimeSample): void | Promise<void>;
}

interface ObservationContext {
  correlationKey: string;
  receivedAtMs: number | null;
}

export interface CardActionTimeProbe {
  invoke<T>(data: unknown, original: (data: unknown) => T): T;
  observe(data: unknown): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function own(value: unknown, key: string): unknown {
  const object = record(value);
  const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function timeField(path: string, raw: unknown): CardActionTimeField {
  const type = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
  if (raw === undefined) return { path, type, status: 'missing' };
  const numericString = typeof raw === 'string' && /^[+-]?\d{1,20}(?:\.\d{1,9})?$/.test(raw);
  const safe = (typeof raw === 'number' && Number.isFinite(raw)) || numericString || raw === null;
  const value = numericString ? Number(raw) : raw;
  const status = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? 'numeric' : 'invalid';
  return { path, type, status, ...(safe ? { raw: raw as string | number | null } : {}) };
}

/** No logger, environment switch, transport, or persistence. The host owns the sink. */
export function createCardActionTimeProbe(options: CardActionTimeProbeOptions): CardActionTimeProbe {
  const { messageId, emit } = options;
  const scope = new AsyncLocalStorage<ObservationContext>();
  function matches(source: unknown): boolean {
    const contextId = own(own(source, 'context'), 'open_message_id');
    const topId = own(source, 'open_message_id');
    const ids = [contextId, topId].filter(id => id !== undefined);
    return typeof messageId === 'string' && messageId.length > 0
      && ids.length > 0 && ids.every(id => id === messageId);
  }
  function newContext(): ObservationContext {
    return { correlationKey: randomUUID(), receivedAtMs: Date.now() };
  }
  function sample(stage: CardActionTimeSample['stage'], data: unknown, context: ObservationContext): void {
    try {
      const fields: CardActionTimeField[] = [];
      for (const prefix of ['', 'header.', 'event.']) {
        const object = prefix ? own(data, prefix.slice(0, -1)) : data;
        for (const name of ['create_time', 'event_time', 'timestamp', 'action_time']) {
          fields.push(timeField(prefix + name, own(object, name)));
        }
      }
      void Promise.resolve(emit({ stage, correlationKey: context.correlationKey, fields,
        local: { receivedAtMs: context.receivedAtMs, observedAtMs: Date.now() } }))
        .catch(() => { /* Never await or surface an optional sink failure through ACK. */ });
    } catch { /* An optional observer cannot change callback authentication or ACK. */ }
  }
  return {
    invoke<T>(data: unknown, original: (data: unknown) => T): T {
      let context: ObservationContext | undefined;
      try {
        const eventType = own(own(data, 'header'), 'event_type')
          ?? own(own(data, 'event'), 'type') ?? own(data, 'event_type');
        const source = record(own(data, 'event')) ?? record(data);
        if (eventType === 'card.action.trigger' && matches(source)) context = newContext();
      } catch { /* Malformed observation input must still reach the original SDK. */ }
      if (!context) return original(data);
      sample('sdk-invoke', data, context);
      return scope.run(context, () => original(data));
    },
    observe(data): void {
      try {
        const source = own(data, 'action') === undefined
          ? record(own(data, 'event')) ?? record(data) : record(data);
        if (matches(source)) sample('card-action-trigger', data,
          scope.getStore() ?? { correlationKey: randomUUID(), receivedAtMs: null });
      } catch { /* An optional observer cannot change callback authentication or ACK. */ }
    },
  };
}
