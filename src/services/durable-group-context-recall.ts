import type {
  DurableAuxiliaryStateStore,
  DurableJson,
  DurableSessionRecord,
  DurableSessionLeaseStore,
  WriteSessionResult,
} from './durable-coordination.js';
import {
  createDurableSessionFacade,
  type DurableSessionFacade,
} from './durable-session-facade.js';

const RECORD_VERSION = 1;
const RECORD_TYPE = 'botmux.group-context.recall-log';
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface DurableGroupContextRecall {
  messageId: string;
  deletedAt: number;
}

interface DurableGroupContextRecallValue {
  version: 1;
  type: typeof RECORD_TYPE;
  larkAppId: string;
  chatId: string;
  recalls: DurableGroupContextRecall[];
  updatedAt: number;
}

function boundedId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${label} must contain at most 512 non-empty characters`);
  }
  return normalized;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function durableGroupContextRecallKey(larkAppId: string, chatId: string): string {
  return `auxiliary::group-context-recalls::${boundedId(larkAppId, 'larkAppId')}::${boundedId(chatId, 'chatId')}`;
}

type DurableGroupContextRecallStore = DurableSessionLeaseStore & DurableAuxiliaryStateStore;

/**
 * 复用已经验证过的按 key FIFO + lease + CAS facade，但把记录明确路由到独立的
 * auxiliary_state 表，避免 recall tombstone 混入 canonical Session 列表和指标。
 */
export function createDurableGroupContextRecallFacade(input: {
  store: DurableGroupContextRecallStore;
  ownerId?: string;
}): DurableSessionFacade {
  const { store } = input;
  return createDurableSessionFacade({
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    store: {
      acquireSessionLease: value => store.acquireSessionLease(value),
      renewSessionLease: value => store.renewSessionLease(value),
      releaseSessionLease: value => store.releaseSessionLease(value),
      readSession: async stateKey => {
        const record = await store.readAuxiliaryState(stateKey);
        return record ? { ...record, sessionKey: record.stateKey } : undefined;
      },
      writeSession: async value => {
        const result = await store.writeAuxiliaryState(value);
        if (result.kind === 'written') {
          return {
            kind: 'written',
            record: { ...result.record, sessionKey: result.record.stateKey },
          } satisfies WriteSessionResult;
        }
        if (result.kind === 'conflict') {
          return {
            kind: 'conflict',
            ...(result.current
              ? { current: { ...result.current, sessionKey: result.current.stateKey } }
              : {}),
          } satisfies WriteSessionResult;
        }
        return result;
      },
    },
  });
}

function parseRecall(value: unknown, label: string): DurableGroupContextRecall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const raw = value as Record<string, unknown>;
  return {
    messageId: boundedId(String(raw.messageId ?? ''), `${label}.messageId`),
    deletedAt: boundedInteger(Number(raw.deletedAt), `${label}.deletedAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseDurableGroupContextRecallRecord(
  record: DurableSessionRecord,
  expected: { larkAppId: string; chatId: string },
): DurableGroupContextRecallValue {
  const value = record.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`durable group-context recall ${record.sessionKey} has an invalid envelope`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== RECORD_VERSION
      || raw.type !== RECORD_TYPE
      || raw.larkAppId !== expected.larkAppId
      || raw.chatId !== expected.chatId
      || !Array.isArray(raw.recalls)
      || raw.recalls.length > DEFAULT_MAX_ENTRIES) {
    throw new Error(`durable group-context recall ${record.sessionKey} has an invalid envelope`);
  }
  const recalls = raw.recalls.map((item, index) => parseRecall(item, `recalls[${index}]`));
  if (new Set(recalls.map(item => item.messageId)).size !== recalls.length) {
    throw new Error(`durable group-context recall ${record.sessionKey} has duplicate message ids`);
  }
  return {
    version: RECORD_VERSION,
    type: RECORD_TYPE,
    larkAppId: expected.larkAppId,
    chatId: expected.chatId,
    recalls,
    updatedAt: boundedInteger(Number(raw.updatedAt), 'updatedAt', 0, Number.MAX_SAFE_INTEGER),
  };
}

export async function recordDurableGroupContextRecall(input: {
  facade: DurableSessionFacade;
  larkAppId: string;
  chatId: string;
  messageId: string;
  deletedAt: number;
  now?: () => number;
  maxAgeMs?: number;
  maxEntries?: number;
}): Promise<void> {
  const larkAppId = boundedId(input.larkAppId, 'larkAppId');
  const chatId = boundedId(input.chatId, 'chatId');
  const messageId = boundedId(input.messageId, 'messageId');
  const now = boundedInteger((input.now ?? Date.now)(), 'now', 0, Number.MAX_SAFE_INTEGER);
  const deletedAt = boundedInteger(input.deletedAt, 'deletedAt', 0, Number.MAX_SAFE_INTEGER);
  const maxAgeMs = boundedInteger(
    input.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    'maxAgeMs',
    1,
    365 * 24 * 60 * 60_000,
  );
  const maxEntries = boundedInteger(input.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries', 1, DEFAULT_MAX_ENTRIES);
  const key = durableGroupContextRecallKey(larkAppId, chatId);
  let result: Awaited<ReturnType<DurableSessionFacade['writeExactFromCurrent']>>;
  try {
    result = await input.facade.writeExactFromCurrent(key, current => {
      const previous = current
        ? parseDurableGroupContextRecallRecord(current, { larkAppId, chatId }).recalls
        : [];
      const byMessage = new Map(previous.map(item => [item.messageId, item]));
      const prior = byMessage.get(messageId);
      byMessage.set(messageId, {
        messageId,
        deletedAt: Math.max(prior?.deletedAt ?? 0, deletedAt),
      });
      const cutoff = Math.max(0, now - maxAgeMs);
      const recalls = [...byMessage.values()]
        .filter(item => item.deletedAt >= cutoff)
        .sort((left, right) => left.deletedAt - right.deletedAt || left.messageId.localeCompare(right.messageId))
        .slice(-maxEntries);
      return {
        version: RECORD_VERSION,
        type: RECORD_TYPE,
        larkAppId,
        chatId,
        recalls,
        updatedAt: now,
      } as unknown as DurableJson;
    });
  } finally {
    await input.facade.releaseLease(key).catch(() => false);
  }
  if (result.kind !== 'written' && result.kind !== 'unchanged') {
    throw new Error(`durable group-context recall write did not commit: ${result.kind}`);
  }
}

export async function readDurableGroupContextRecalls(input: {
  store: DurableAuxiliaryStateStore;
  larkAppId: string;
  chatId: string;
}): Promise<DurableGroupContextRecall[]> {
  const larkAppId = boundedId(input.larkAppId, 'larkAppId');
  const chatId = boundedId(input.chatId, 'chatId');
  const state = await input.store.readAuxiliaryState(durableGroupContextRecallKey(larkAppId, chatId));
  const record = state ? { ...state, sessionKey: state.stateKey } : undefined;
  return record
    ? parseDurableGroupContextRecallRecord(record, { larkAppId, chatId }).recalls
    : [];
}
