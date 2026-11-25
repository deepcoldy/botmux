/**
 * 私聊专属群协作初始化的稳定 source store + CollabInitStore（design §10.1）。
 *
 * 文件：`{dataDir}/collab-group-init-{creatorAppId}.json`。同一文件、同次原子写承载
 * 三份结构：
 *   - `entries`        initId → entry（永久）
 *   - `sourceIndex`    sourceKey → initId（**永久**唯一索引）
 *   - `activeByDmChat` dmChatId → active initId（**临时**在途索引；done/failed/cancelled 释放）
 *
 * 所有「读 entry → 判重 → 写 entry」都由 per-app 异步 mutex 串行化；每次写走
 * tmp + rename + 0600 + fsync（复用 atomic-write.ts 的 durable 模式）。不同 initId
 * 也不能并发覆盖同一文件。
 *
 * 本模块不读 config；`dataDir` 由调用方显式传入（preflight 从 daemon 接缝带入），
 * 便于测试用临时目录 + 假时钟直接驱动。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { AsyncSerialQueue } from '../utils/async-serial-queue.js';
import type { SessionGroupCollaborationConfig } from './collab-group-config.js';
import { patchCollabGate } from './collab-gate-store.js';

export const COLLAB_INIT_SCHEMA_VERSION = 1;

export interface CollabInitStore {
  schemaVersion: number;
  entries: Record<string, CollabGroupInitEntry>;
  sourceIndex: Record<string, string>;
  activeByDmChat: Record<string, string>;
}

export type CollabInitState = 'running' | 'awaiting-input' | 'done' | 'failed' | 'cancelled';
export type CollabStepKey = 'create' | 'invite' | 'grants' | 'roles' | 'kickoff';
export type CollabStepStatus = 'pending' | 'running' | 'done' | 'failed';
export type CollabOperationKind = 'admission' | 'create' | 'forward' | 'invite' | 'grant' | 'role' | 'kickoff' | 'notice';
export type CollabOperationStatus = 'planned' | 'attempting' | 'done' | 'unknown' | 'failed';

export interface CollabGroupInitEntry {
  initId: string;
  dmChatId: string;
  sourceMessageId: string;
  configVersion: string;
  configSnapshot: SessionGroupCollaborationConfig;
  /** 参与 configVersion 的 S0 冻结角色内容；缺省代表旧/不完整账本，S4 必须 fail-closed。 */
  resolvedProfileEntries?: Record<string, string | null>;
  referencedTeamRoles?: Record<string, string | null>;
  /** 重启恢复 S1 所需的原 DM sender；open_id/union_id 只在 creatorAppId 视角使用。 */
  sourceSenderOpenId?: string;
  sourceSenderUnionId?: string;
  creatorAdmissionOperationId: string;
  creatorAdmissionReceipt?: unknown;
  chatId?: string;
  createAttempt: number;
  state: CollabInitState;
  awaiting?: { reason: string; operationId?: string; since: number; detail?: unknown };
  steps: Record<CollabStepKey, { status: CollabStepStatus; at: number; error?: string }>;
  operations: Record<string, {
    kind: CollabOperationKind;
    status: CollabOperationStatus;
    uuid?: string;
    firstAttemptAt?: number;
    payloadHash: string;
    receipt?: unknown;
    error?: string;
  }>;
  kickoffPending?: Record<string, { appId: string; since?: number; satisfiedBy?: unknown }>;
  createdAt: number;
  updatedAt: number;
  cancelReason?: string;
}

/** `{dataDir}/collab-group-init-{creatorAppId}.json`。 */
export function collabInitFilePath(dataDir: string, creatorAppId: string): string {
  return join(dataDir, `collab-group-init-${creatorAppId}.json`);
}

// ─── per-app 异步 mutex（进程内）───────────────────────────────────────────

const queues = new Map<string, AsyncSerialQueue>();

function queueFor(appId: string): AsyncSerialQueue {
  let q = queues.get(appId);
  if (!q) {
    q = new AsyncSerialQueue();
    queues.set(appId, q);
  }
  return q;
}

/** 仅测试用：清空进程内 mutex（避免跨用例串扰）。 */
export function __testOnly_resetCollabInitMutexes(): void {
  queues.clear();
  initIdQueues.clear();
}

// ─── per-initId 异步 mutex（S1 编排并发认领，R6）──────────────────────────

const initIdQueues = new Map<string, AsyncSerialQueue>();

function initIdQueueFor(initId: string): AsyncSerialQueue {
  let q = initIdQueues.get(initId);
  if (!q) {
    q = new AsyncSerialQueue();
    initIdQueues.set(initId, q);
  }
  return q;
}

/**
 * 串行化同一 initId 的 S1 编排（含外部副作用）：store 的 per-app mutex 只覆盖单个
 * JSON 读改写，覆盖不了「两个执行者都读到未完成并各自调外部 create/register/forward」。
 * 用本 mutex 把整个 S1 临界区串起来，后来者进入时会重读已完成的 operation 而跳过。
 */
export function withCollabInitIdMutex<T>(initId: string, task: () => Promise<T>): Promise<T> {
  return initIdQueueFor(initId).run(task);
}

// ─── 读写（数据目录显式传入，不做内存缓存）───────────────────────────────

function emptyStore(): CollabInitStore {
  return { schemaVersion: COLLAB_INIT_SCHEMA_VERSION, entries: {}, sourceIndex: {}, activeByDmChat: {} };
}

export type CollabInitStoreReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupted'; message: string }
  | { kind: 'ok'; store: CollabInitStore };

export class CollabInitStoreCorruptedError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`collab init store corrupted at ${filePath}: ${message}`);
    this.name = 'CollabInitStoreCorruptedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringOrNullMap(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every(v => typeof v === 'string' || v === null);
}

function parseStore(raw: string): CollabInitStore {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.schemaVersion !== COLLAB_INIT_SCHEMA_VERSION) {
    throw new Error('schemaVersion 不符或文件不是对象');
  }
  if (!isRecord(parsed.entries) || !isRecord(parsed.sourceIndex) || !isRecord(parsed.activeByDmChat)) {
    throw new Error('entries/sourceIndex/activeByDmChat 必须是对象');
  }
  const entries = parsed.entries as unknown as Record<string, CollabGroupInitEntry>;
  const states = new Set(['running', 'awaiting-input', 'done', 'failed', 'cancelled']);
  const stepKeys = new Set(['create', 'invite', 'grants', 'roles', 'kickoff']);
  const stepStates = new Set(['pending', 'running', 'done', 'failed']);
  const operationKinds = new Set(['admission', 'create', 'forward', 'invite', 'grant', 'role', 'kickoff', 'notice']);
  const operationStates = new Set(['planned', 'attempting', 'done', 'unknown', 'failed']);
  for (const [initId, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.initId !== initId) throw new Error(`entry ${initId} 身份不符`);
    if (typeof entry.dmChatId !== 'string' || !entry.dmChatId
      || typeof entry.sourceMessageId !== 'string' || !entry.sourceMessageId
      || typeof entry.configVersion !== 'string' || !entry.configVersion
      || !isRecord(entry.configSnapshot) || !states.has(entry.state)
      || !isRecord(entry.steps) || !isRecord(entry.operations)) {
      throw new Error(`entry ${initId} 结构不完整`);
    }
    if ((entry.sourceSenderOpenId !== undefined && (typeof entry.sourceSenderOpenId !== 'string' || !entry.sourceSenderOpenId))
      || (entry.sourceSenderUnionId !== undefined && (typeof entry.sourceSenderUnionId !== 'string' || !entry.sourceSenderUnionId))) {
      throw new Error(`entry ${initId} sourceSenderOpenId/UnionId 非法`);
    }
    if (typeof entry.creatorAdmissionOperationId !== 'string' || !entry.creatorAdmissionOperationId
      || typeof entry.createAttempt !== 'number' || !Number.isInteger(entry.createAttempt) || entry.createAttempt < 0
      || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)
      || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) {
      throw new Error(`entry ${initId} 准入身份或时间戳非法`);
    }
    for (const stepKey of stepKeys) {
      const step = entry.steps[stepKey as CollabStepKey];
      if (!isRecord(step) || !stepStates.has(step.status) || typeof step.at !== 'number' || !Number.isFinite(step.at)) {
        throw new Error(`entry ${initId} step ${stepKey} 非法`);
      }
    }
    for (const [opKey, operation] of Object.entries(entry.operations)) {
      if (!isRecord(operation) || !operationKinds.has(operation.kind) || !operationStates.has(operation.status)
        || typeof operation.payloadHash !== 'string' || !operation.payloadHash
        || (operation.firstAttemptAt !== undefined
          && (typeof operation.firstAttemptAt !== 'number' || !Number.isFinite(operation.firstAttemptAt)))
        || (operation.uuid !== undefined && (typeof operation.uuid !== 'string' || !operation.uuid))) {
        throw new Error(`entry ${initId} operation ${opKey} 非法`);
      }
    }
    if (entry.awaiting !== undefined && (!isRecord(entry.awaiting)
      || typeof entry.awaiting.reason !== 'string' || !entry.awaiting.reason
      || typeof entry.awaiting.since !== 'number' || !Number.isFinite(entry.awaiting.since))) {
      throw new Error(`entry ${initId} awaiting 非法`);
    }
    if (entry.resolvedProfileEntries !== undefined && !isStringOrNullMap(entry.resolvedProfileEntries)
      || entry.referencedTeamRoles !== undefined && !isStringOrNullMap(entry.referencedTeamRoles)) {
      throw new Error(`entry ${initId} 角色快照非法`);
    }
  }
  const sourceIndex = parsed.sourceIndex as unknown as Record<string, string>;
  for (const [sourceKey, initId] of Object.entries(sourceIndex)) {
    if (typeof initId !== 'string' || !entries[initId]) throw new Error(`sourceIndex 悬空: ${sourceKey}`);
  }
  const activeByDmChat = parsed.activeByDmChat as unknown as Record<string, string>;
  for (const [dmChatId, initId] of Object.entries(activeByDmChat)) {
    const entry = typeof initId === 'string' ? entries[initId] : undefined;
    if (!entry || entry.dmChatId !== dmChatId) {
      throw new Error(`activeByDmChat 悬空或身份不符: ${dmChatId}`);
    }
  }
  return { schemaVersion: COLLAB_INIT_SCHEMA_VERSION, entries, sourceIndex, activeByDmChat };
}

/** 只有 ENOENT 是 missing；读取、JSON、schema 或索引一致性错误均为 corrupted。 */
export function readCollabInitStoreStrict(dataDir: string, creatorAppId: string): CollabInitStoreReadResult {
  const fp = collabInitFilePath(dataDir, creatorAppId);
  let raw: string;
  try { raw = readFileSync(fp, 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) };
  }
  try { return { kind: 'ok', store: parseStore(raw) }; }
  catch (err) { return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) }; }
}

/**
 * 常规读取：文件不存在返回空 store；损坏抛错，调用方不得把旧文件当空账本覆盖。
 */
export function readCollabInitStore(dataDir: string, creatorAppId: string): CollabInitStore {
  const read = readCollabInitStoreStrict(dataDir, creatorAppId);
  if (read.kind === 'missing') return emptyStore();
  if (read.kind === 'corrupted') throw new CollabInitStoreCorruptedError(collabInitFilePath(dataDir, creatorAppId), read.message);
  return read.store;
}

function writeStore(dataDir: string, creatorAppId: string, store: CollabInitStore): void {
  const fp = collabInitFilePath(dataDir, creatorAppId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, durable: true });
}

// ─── 原子占位 / 判重 / 释放 ────────────────────────────────────────────────

export type CollabPlaceResult =
  | { kind: 'existing'; initId: string; status: string }
  | { kind: 'busy'; initId: string }
  | { kind: 'created'; initId: string };

/**
 * 在 per-app mutex 内完成「读 entry → source/DM 判重 → 写 entry」并原子占位：
 *   - sourceIndex 命中 → existing（同 sourceKey 重投，永不建第二请求）；
 *   - activeByDmChat 命中 → busy（同 DM 不同 source 且上一请求活动）；
 *   - 否则新建 entry（state='running'，永久占 sourceIndex，临时占 activeByDmChat）。
 *
 * `now` 由调用方注入（假时钟），不内部调 Date.now()。
 */
export function placeCollabGroupInit(opts: {
  dataDir: string;
  creatorAppId: string;
  dmChatId: string;
  sourceKey: string;
  initId: string;
  sourceMessageId: string;
  configVersion: string;
  configSnapshot: SessionGroupCollaborationConfig;
  resolvedProfileEntries?: Record<string, string | null>;
  referencedTeamRoles?: Record<string, string | null>;
  sourceSenderOpenId?: string;
  sourceSenderUnionId?: string;
  creatorAdmissionOperationId: string;
  createAttempt: number;
  now: number;
}): Promise<CollabPlaceResult> {
  return queueFor(opts.creatorAppId).run(async () => {
    const store = readCollabInitStore(opts.dataDir, opts.creatorAppId);

    if (store.sourceIndex[opts.sourceKey]) {
      const existingInitId = store.sourceIndex[opts.sourceKey];
      const entry = store.entries[existingInitId];
      // 同 source 的配置变化不得沿用旧 running 快照自动恢复。原地转入人工态，
      // activeByDmChat 保留；终态请求只返回原结果，不因配置编辑重新打开。
      if ((entry.state === 'running' || entry.state === 'awaiting-input') && entry.configVersion !== opts.configVersion) {
        if (entry.state !== 'awaiting-input' || entry.awaiting?.reason !== 'CONFIG_CHANGED') {
          entry.state = 'awaiting-input';
          entry.awaiting = {
            reason: 'CONFIG_CHANGED',
            since: opts.now,
            detail: { storedConfigVersion: entry.configVersion, incomingConfigVersion: opts.configVersion },
          };
          entry.updatedAt = opts.now;
          writeStore(opts.dataDir, opts.creatorAppId, store);
          if (entry.chatId) {
            // entry 先落盘，admission 交叉检查可在 gate 写失败时仍 fail-closed。
            // gate 随后同步关闭，取消终态不被 CONFIG_CHANGED 覆盖。
            patchCollabGate(opts.dataDir, entry.chatId, (gate) => ({
              ...gate,
              phase: gate.phase === 'cancelled' ? 'cancelled' : 'awaiting-input',
              participants: Object.fromEntries(Object.entries(gate.participants).map(([appId, participant]) => [
                appId, { ...participant, acceptingUserTasks: false },
              ])),
            }));
          }
        }
      }
      return { kind: 'existing', initId: existingInitId, status: entry.state };
    }

    const activeInitId = store.activeByDmChat[opts.dmChatId];
    const activeEntry = activeInitId ? store.entries[activeInitId] : undefined;
    if (activeEntry && (activeEntry.state === 'running' || activeEntry.state === 'awaiting-input')) {
      return { kind: 'busy', initId: activeInitId };
    }
    // entry 终态是权威：清理上一轮中途写出的 stale active 指针，不让它制造永久 busy。
    if (activeInitId) delete store.activeByDmChat[opts.dmChatId];

    store.sourceIndex[opts.sourceKey] = opts.initId;
    store.activeByDmChat[opts.dmChatId] = opts.initId;
    store.entries[opts.initId] = {
      initId: opts.initId,
      dmChatId: opts.dmChatId,
      sourceMessageId: opts.sourceMessageId,
      configVersion: opts.configVersion,
      configSnapshot: opts.configSnapshot,
      ...(opts.resolvedProfileEntries !== undefined ? { resolvedProfileEntries: { ...opts.resolvedProfileEntries } } : {}),
      ...(opts.referencedTeamRoles !== undefined ? { referencedTeamRoles: { ...opts.referencedTeamRoles } } : {}),
      ...(opts.sourceSenderOpenId !== undefined ? { sourceSenderOpenId: opts.sourceSenderOpenId } : {}),
      ...(opts.sourceSenderUnionId !== undefined ? { sourceSenderUnionId: opts.sourceSenderUnionId } : {}),
      creatorAdmissionOperationId: opts.creatorAdmissionOperationId,
      createAttempt: opts.createAttempt,
      state: 'running',
      steps: {
        create: { status: 'pending', at: opts.now },
        invite: { status: 'pending', at: opts.now },
        grants: { status: 'pending', at: opts.now },
        roles: { status: 'pending', at: opts.now },
        kickoff: { status: 'pending', at: opts.now },
      },
      operations: {},
      createdAt: opts.now,
      updatedAt: opts.now,
    };
    writeStore(opts.dataDir, opts.creatorAppId, store);
    return { kind: 'created', initId: opts.initId };
  });
}

/**
 * 将某 entry 置为终态（done/failed/cancelled），并释放它占用的 activeByDmChat
 * 在途索引（仅当该 dmChatId 仍指向此 initId 时）。sourceIndex 永久保留。
 */
export function markCollabInitTerminal(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  dmChatId: string;
  state: 'done' | 'failed' | 'cancelled';
  now: number;
  cancelReason?: string;
}): Promise<void> {
  return queueFor(opts.creatorAppId).run(async () => {
    const store = readCollabInitStore(opts.dataDir, opts.creatorAppId);
    const entry = store.entries[opts.initId];
    if (!entry) return;
    // cancelled/done 是更高优先级事实；迟到的 failed 或旧操作不得覆盖它们。
    if ((entry.state === 'cancelled' && opts.state !== 'cancelled')
      || (entry.state === 'done' && opts.state !== 'done')) return;
    entry.state = opts.state;
    entry.updatedAt = opts.now;
    if (opts.cancelReason !== undefined) entry.cancelReason = opts.cancelReason;
    if (store.activeByDmChat[opts.dmChatId] === opts.initId) {
      delete store.activeByDmChat[opts.dmChatId];
    }
    writeStore(opts.dataDir, opts.creatorAppId, store);
  });
}

// ─── entry patch 原语（S1 编排逐 operation 落账，PR-2）────────────────────

/**
 * 在 per-app mutex 内原子 patch 一个 entry（读→改→写，同文件同次原子写）。
 * `mutate` 返回 false 表示「不写盘」（no-op），true 表示需落盘。
 * 返回 patch 后的 entry（entry 不存在返回 undefined）。
 */
export function patchCollabInitEntry(
  opts: {
    dataDir: string;
    creatorAppId: string;
    initId: string;
    /** 可选 CAS：仅当读到的当前 phase 符合时才执行 mutate/write。 */
    expectedState?: CollabInitState;
    mutate: (entry: CollabGroupInitEntry) => boolean;
  },
): Promise<CollabGroupInitEntry | undefined> {
  return queueFor(opts.creatorAppId).run(async () => {
    const store = readCollabInitStore(opts.dataDir, opts.creatorAppId);
    const entry = store.entries[opts.initId];
    if (!entry) return undefined;
    if (opts.expectedState !== undefined && entry.state !== opts.expectedState) return undefined;
    const dirty = opts.mutate(entry);
    if (dirty) writeStore(opts.dataDir, opts.creatorAppId, store);
    return entry;
  });
}

/** 读取单个 entry（不写，不在 mutex 内）。 */
export function readCollabInitEntry(
  dataDir: string,
  creatorAppId: string,
  initId: string,
): CollabGroupInitEntry | undefined {
  return readCollabInitStore(dataDir, creatorAppId).entries[initId];
}

/**
 * 原子推进某个 step 的状态（S1 编排用）。同文件同次原子写；entry 不存在为 no-op。
 */
export function advanceCollabStep(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  step: CollabStepKey;
  status: CollabStepStatus;
  now: number;
  error?: string;
}): Promise<void> {
  return queueFor(opts.creatorAppId).run(async () => {
    const store = readCollabInitStore(opts.dataDir, opts.creatorAppId);
    const entry = store.entries[opts.initId];
    if (!entry) return;
    entry.steps[opts.step] = { status: opts.status, at: opts.now, ...(opts.error !== undefined ? { error: opts.error } : {}) };
    entry.updatedAt = opts.now;
    writeStore(opts.dataDir, opts.creatorAppId, store);
  });
}

/**
 * 原子写入/更新一个 operation（逐 operation 落账 §10.1）。`opKey` 即 operations 的
 * 键（如 creatorAdmissionOperationId / createUuid / forwardUuid）。同文件同次原子写；
 * entry 不存在为 no-op。重入判 payloadHash 由调用方负责。
 */
export function writeCollabOperation(opts: {
  dataDir: string;
  creatorAppId: string;
  initId: string;
  opKey: string;
  op: {
    kind: CollabOperationKind;
    status: CollabOperationStatus;
    uuid?: string;
    firstAttemptAt?: number;
    payloadHash: string;
    receipt?: unknown;
    error?: string;
  };
  now: number;
}): Promise<void> {
  return queueFor(opts.creatorAppId).run(async () => {
    const store = readCollabInitStore(opts.dataDir, opts.creatorAppId);
    const entry = store.entries[opts.initId];
    if (!entry) return;
    entry.operations[opts.opKey] = opts.op;
    entry.updatedAt = opts.now;
    writeStore(opts.dataDir, opts.creatorAppId, store);
  });
}
