import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCodexNotifierCompletionEvent } from './event.js';
import { resolveCodexNotifierConfig, type ResolvedCodexNotifierConfig } from './config.js';
import { enqueueCodexNotifierEvent } from './outbox.js';
import {
  detectScreenLock,
  shouldNotifyForLockState,
  type ScreenLockState,
} from './screen-lock.js';
import type {
  CodexTaskCompletedEvent,
  CodexTaskStatus,
} from './types.js';

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_STATE_BYTES = 32 * 1024 * 1024;
const IPC_RETRY_MS = 1_000;
const SCAN_INTERVAL_MS = 500;
const IPC_CONNECT_TIMEOUT_MS = 5_000;
const IPC_INITIALIZE_TIMEOUT_MS = 5_000;
const MAX_RECENT_THREAD_IDS = 64;
const MAX_TRACKED_CONVERSATIONS = 128;
const MAX_PENDING_SIDE_EVENTS = 256;
const MAX_PENDING_SIDE_BYTES = 2 * 1024 * 1024;
const THREAD_STREAM_FOLLOWING_VERSION = 1;
const MIN_DATE_MS = -8_640_000_000_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

type JsonObject = Record<string, any>;

export interface CodexVisualizationThread {
  id: string;
  mtimeMs: number;
}

export interface CodexConversationPatch {
  op: 'add' | 'replace' | 'remove';
  path: Array<string | number>;
  value?: unknown;
}

interface TrackedConversation {
  revision: number;
  state: JsonObject;
  bytes: number;
}

interface TrackerResult {
  events: CodexTaskCompletedEvent[];
  needsSnapshot: boolean;
}

interface IpcMessage {
  type?: string;
  method?: string;
  requestId?: string;
  resultType?: string;
  sourceClientId?: string;
  params?: JsonObject;
  result?: JsonObject;
}

function plainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function forbiddenPatchSegment(value: string | number): boolean {
  return typeof value === 'string'
    && (value === '__proto__' || value === 'prototype' || value === 'constructor');
}

/** 应用 Codex Desktop 发出的 Immer 风格 JSON Patch。 */
export function applyCodexConversationPatches(
  state: JsonObject,
  patches: CodexConversationPatch[],
): JsonObject {
  if (patches.length > 20_000) throw new Error('codex_side_chat_patch_count_exceeded');
  let root: unknown = state;
  for (const patch of patches) {
    if (
      (patch.op !== 'add' && patch.op !== 'replace' && patch.op !== 'remove')
      || !Array.isArray(patch.path)
      || patch.path.length > 64
      || patch.path.some(forbiddenPatchSegment)
    ) {
      throw new Error('codex_side_chat_patch_path_invalid');
    }
    if (patch.path.length === 0) {
      if (patch.op === 'remove' || !plainObject(patch.value)) {
        throw new Error('codex_side_chat_root_patch_invalid');
      }
      root = patch.value;
      continue;
    }

    let parent: any = root;
    for (const segment of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') {
        throw new Error('codex_side_chat_patch_parent_invalid');
      }
      parent = parent[segment];
    }
    if (!parent || typeof parent !== 'object') {
      throw new Error('codex_side_chat_patch_parent_invalid');
    }

    const key = patch.path.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index > parent.length) {
        throw new Error('codex_side_chat_patch_index_invalid');
      }
      if (patch.op === 'add') parent.splice(index, 0, patch.value);
      else if (patch.op === 'replace' && index < parent.length) parent[index] = patch.value;
      else if (patch.op === 'remove' && index < parent.length) parent.splice(index, 1);
      else throw new Error('codex_side_chat_patch_index_invalid');
      continue;
    }

    if (typeof key !== 'string') throw new Error('codex_side_chat_patch_key_invalid');
    if (patch.op === 'remove') delete parent[key];
    else parent[key] = patch.value;
  }
  if (!plainObject(root)) throw new Error('codex_side_chat_state_invalid');
  return root;
}

function turnEntities(state: JsonObject): JsonObject[] {
  const entities = state.turnHistory?.history?.entitiesByKey;
  if (!plainObject(entities)) return [];
  return Object.values(entities).filter(plainObject);
}

function terminalStatus(value: unknown): CodexTaskStatus | undefined {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'interrupted' || value === 'cancelled') return 'cancelled';
  return undefined;
}

function turnStatusById(state: JsonObject): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const turn of turnEntities(state)) {
    if (typeof turn.turnId === 'string' && turn.turnId) result.set(turn.turnId, turn.status);
  }
  return result;
}

function turnPrompt(turn: JsonObject): string | undefined {
  const input = turn.params?.input;
  if (Array.isArray(input)) {
    const text = input
      .filter(item => plainObject(item) && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) return text;
  }
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (!plainObject(item) || item.type !== 'userMessage' || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter(part => plainObject(part) && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) return text;
  }
  return undefined;
}

function turnFinalPreview(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      plainObject(item)
      && item.type === 'agentMessage'
      && typeof item.text === 'string'
      && item.text.trim()
    ) {
      return item.text;
    }
  }
  return undefined;
}

function validDateMs(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= MIN_DATE_MS && number <= MAX_DATE_MS
    ? number
    : undefined;
}

function turnCompletionMs(turn: JsonObject): number | undefined {
  const startedAt = Number(turn.turnStartedAtMs);
  const duration = Number(turn.durationMs);
  const completedAt = Number.isFinite(startedAt) && Number.isFinite(duration)
    ? startedAt + duration
    : Number.NaN;
  return validDateMs(completedAt);
}

function observedCompletionMs(state: JsonObject, turn: JsonObject): number | undefined {
  return turnCompletionMs(turn) ?? validDateMs(state.updatedAt);
}

function completedAt(state: JsonObject, turn: JsonObject, now: number): string {
  const value = observedCompletionMs(state, turn)
    ?? validDateMs(now)
    ?? validDateMs(Date.now())
    ?? 0;
  return new Date(value).toISOString();
}

/** 从 Side Chat 内存态提取跨进程完成事件；结构不完整时 fail closed。 */
export function createSideConversationCompletionEvent(
  state: JsonObject,
  turn: JsonObject,
  now = Date.now(),
): CodexTaskCompletedEvent | undefined {
  if (state.sideConversation !== true || state.ephemeral !== true) return undefined;
  const status = terminalStatus(turn.status);
  if (
    !status
    || typeof state.id !== 'string'
    || !THREAD_ID_PATTERN.test(state.id)
    || typeof turn.turnId !== 'string'
    || !turn.turnId
  ) {
    return undefined;
  }
  const cwd = typeof turn.params?.cwd === 'string' && turn.params.cwd.trim()
    ? turn.params.cwd
    : typeof state.cwd === 'string' && state.cwd.trim()
    ? state.cwd
    : undefined;
  if (!cwd) return undefined;

  try {
    return createCodexNotifierCompletionEvent({
      threadId: state.id,
      nativeTurnId: turn.turnId,
      status,
      cwd,
      clientSurface: 'codex-app',
      conversationKind: 'side',
      title: turnPrompt(turn) ?? (typeof state.title === 'string' ? state.title : undefined),
      finalPreview: turnFinalPreview(turn),
      completedAt: completedAt(state, turn, now),
    });
  } catch {
    return undefined;
  }
}

function transitionedEvents(
  previous: Map<string, unknown>,
  state: JsonObject,
  now: number,
): CodexTaskCompletedEvent[] {
  if (state.sideConversation !== true || state.ephemeral !== true) return [];
  const events: CodexTaskCompletedEvent[] = [];
  for (const turn of turnEntities(state)) {
    if (
      typeof turn.turnId !== 'string'
      || previous.get(turn.turnId) !== 'inProgress'
      || !terminalStatus(turn.status)
    ) {
      continue;
    }
    const event = createSideConversationCompletionEvent(state, turn, now);
    if (event) events.push(event);
  }
  return events;
}

function latestTerminalEvent(
  state: JsonObject,
  now: number,
  terminalNotBeforeMs?: number,
): CodexTaskCompletedEvent | undefined {
  const turns = turnEntities(state)
    .filter(turn => terminalStatus(turn.status))
    .sort((left, right) =>
      Number(left.turnStartedAtMs ?? 0) - Number(right.turnStartedAtMs ?? 0));
  const latest = turns.at(-1);
  if (
    latest
    && terminalNotBeforeMs !== undefined
    && (turnCompletionMs(latest) ?? Number.NEGATIVE_INFINITY) < terminalNotBeforeMs
  ) {
    return undefined;
  }
  return latest ? createSideConversationCompletionEvent(state, latest, now) : undefined;
}

/**
 * 维护 IPC snapshot + patch revision，并且只把 inProgress → 终态识别为新完成。
 * 首个 snapshot 默认只建立基线，避免 Dashboard 启动时补发历史 Side Chat。
 */
export class CodexSideConversationTracker {
  private readonly conversations = new Map<string, TrackedConversation>();
  private totalStateBytes = 0;

  constructor(
    private readonly maxConversations = MAX_TRACKED_CONVERSATIONS,
    private readonly maxStateBytes = MAX_TRACKED_STATE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxConversations) || maxConversations <= 0) {
      throw new Error('codex_side_chat_tracker_limit_invalid');
    }
    if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes <= 0) {
      throw new Error('codex_side_chat_tracker_bytes_invalid');
    }
  }

  has(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  clear(): void {
    this.conversations.clear();
    this.totalStateBytes = 0;
  }

  private delete(conversationId: string): void {
    const tracked = this.conversations.get(conversationId);
    if (!tracked) return;
    this.totalStateBytes -= tracked.bytes;
    this.conversations.delete(conversationId);
  }

  private save(
    conversationId: string,
    tracked: Omit<TrackedConversation, 'bytes'>,
  ): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(tracked.state), 'utf8');
    } catch {
      this.delete(conversationId);
      return;
    }
    this.delete(conversationId);
    if (bytes > this.maxStateBytes) return;
    this.conversations.set(conversationId, { ...tracked, bytes });
    this.totalStateBytes += bytes;
    while (
      this.conversations.size > this.maxConversations
      || this.totalStateBytes > this.maxStateBytes
    ) {
      const oldest = this.conversations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
    }
  }

  observeSnapshot(
    conversationId: string,
    revision: number,
    state: unknown,
    options: {
      notifyTerminalOnFirstSnapshot?: boolean;
      terminalNotBeforeMs?: number;
      now?: number;
    } = {},
  ): TrackerResult {
    if (!plainObject(state) || state.id !== conversationId || !Number.isSafeInteger(revision)) {
      return { events: [], needsSnapshot: true };
    }
    if (state.sideConversation !== true || state.ephemeral !== true) {
      this.delete(conversationId);
      return { events: [], needsSnapshot: false };
    }
    const previous = this.conversations.get(conversationId);
    const events = previous
      ? transitionedEvents(turnStatusById(previous.state), state, options.now ?? Date.now())
      : options.notifyTerminalOnFirstSnapshot
      ? [latestTerminalEvent(
          state,
          options.now ?? Date.now(),
          options.terminalNotBeforeMs,
        )].filter(
          (event): event is CodexTaskCompletedEvent => !!event,
        )
      : [];
    this.save(conversationId, { revision, state });
    return { events, needsSnapshot: false };
  }

  observePatches(
    conversationId: string,
    baseRevision: number,
    revision: number,
    patches: unknown,
    now = Date.now(),
  ): TrackerResult {
    const tracked = this.conversations.get(conversationId);
    if (
      !tracked
      || tracked.revision !== baseRevision
      || !Number.isSafeInteger(revision)
      || !Array.isArray(patches)
    ) {
      return { events: [], needsSnapshot: true };
    }
    const previous = turnStatusById(tracked.state);
    try {
      const state = applyCodexConversationPatches(
        structuredClone(tracked.state),
        patches as CodexConversationPatch[],
      );
      this.save(conversationId, { state, revision });
      return {
        events: transitionedEvents(previous, state, now),
        needsSnapshot: false,
      };
    } catch {
      return { events: [], needsSnapshot: true };
    }
  }
}

function localDatePath(root: string, date: Date): string {
  return join(
    root,
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

/** 视觉产物目录由 Codex 为每个本地线程预创建，可用于发现不落 rollout 的 Side Chat。 */
export function listRecentCodexVisualizationThreads(
  codexHome: string,
  now = Date.now(),
  limit = MAX_RECENT_THREAD_IDS,
): CodexVisualizationThread[] {
  const root = join(codexHome, 'visualizations');
  const datePaths = new Set([
    localDatePath(root, new Date(now)),
    localDatePath(root, new Date(now - 24 * 60 * 60_000)),
  ]);
  const result: CodexVisualizationThread[] = [];
  for (const path of datePaths) {
    if (!existsSync(path)) continue;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !THREAD_ID_PATTERN.test(entry.name)) continue;
      try {
        result.push({ id: entry.name, mtimeMs: statSync(join(path, entry.name)).mtimeMs });
      } catch {
        // 目录可能在扫描期间被 Codex 清理。
      }
    }
  }
  return result
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function encodeIpcFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

export interface CodexSideConversationMonitorOptions {
  dataDir: string;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  now?: () => number;
  scanIntervalMs?: number;
  retryMs?: number;
  connectTimeoutMs?: number;
  initializeTimeoutMs?: number;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  logger?: Pick<Console, 'debug' | 'warn'>;
  readConfig?: () => ResolvedCodexNotifierConfig;
  detectLockState?: () => ScreenLockState;
  enqueue?: typeof enqueueCodexNotifierEvent;
  listThreads?: typeof listRecentCodexVisualizationThreads;
  connect?: (path: string) => Socket;
}

/** 监听 Codex Desktop 内部线程流，补齐原生 Hook 不覆盖的 Side Chat。 */
export class CodexSideConversationMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly codexHome: string;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly scanIntervalMs: number;
  private readonly retryMs: number;
  private readonly connectTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private readonly logger: Pick<Console, 'debug' | 'warn'>;
  private readonly readConfig: () => ResolvedCodexNotifierConfig;
  private readonly detectLockState: () => ScreenLockState;
  private readonly enqueue: typeof enqueueCodexNotifierEvent;
  private readonly listThreads: typeof listRecentCodexVisualizationThreads;
  private readonly connect: (path: string) => Socket;
  private readonly tracker = new CodexSideConversationTracker();
  private readonly candidates = new Map<string, {
    notifyTerminalOnFirstSnapshot: boolean;
    terminalNotBeforeMs?: number;
  }>();
  private readonly pending = new Map<string, {
    event: CodexTaskCompletedEvent;
    targetBotAppId: string;
    bytes: number;
  }>();
  private pendingBytes = 0;
  private observationStartedAt: number | undefined;

  constructor(private readonly options: CodexSideConversationMonitorOptions) {
    this.platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const userHome = options.userHome ?? homedir();
    this.codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
      ? env.CODEX_HOME.trim()
      : join(userHome, '.codex');
    this.socketPath = join(this.codexHome, 'ipc', 'ipc.sock');
    this.now = options.now ?? Date.now;
    this.scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
    this.retryMs = options.retryMs ?? IPC_RETRY_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? IPC_CONNECT_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? IPC_INITIALIZE_TIMEOUT_MS;
    this.maxPendingEvents = options.maxPendingEvents ?? MAX_PENDING_SIDE_EVENTS;
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_SIDE_BYTES;
    if (!Number.isSafeInteger(this.maxPendingEvents) || this.maxPendingEvents <= 0) {
      throw new Error('codex_side_chat_pending_limit_invalid');
    }
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes <= 0) {
      throw new Error('codex_side_chat_pending_bytes_invalid');
    }
    this.logger = options.logger ?? console;
    this.readConfig = options.readConfig ?? resolveCodexNotifierConfig;
    this.detectLockState = options.detectLockState ?? detectScreenLock;
    this.enqueue = options.enqueue ?? enqueueCodexNotifierEvent;
    this.listThreads = options.listThreads ?? listRecentCodexVisualizationThreads;
    this.connect = options.connect ?? (path => createConnection(path));
  }

  private enabled(): boolean {
    const config = this.readConfig();
    return config.enabled && !!config.targetBotAppId;
  }

  private startObservation(): void {
    if (this.observationStartedAt !== undefined) return;
    this.tracker.clear();
    this.candidates.clear();
    this.observationStartedAt = this.now();
  }

  private stopObservation(): void {
    this.tracker.clear();
    this.candidates.clear();
    this.observationStartedAt = undefined;
  }

  private queueEvents(events: CodexTaskCompletedEvent[]): void {
    for (const event of events) {
      const config = this.readConfig();
      if (!config.enabled || !config.targetBotAppId) continue;
      const lockState = config.notifyWhen === 'always'
        ? 'unlocked'
        : this.detectLockState();
      if (!shouldNotifyForLockState(config.notifyWhen, lockState)) continue;
      if (this.pending.has(event.eventId)) continue;
      const item = {
        event,
        targetBotAppId: config.targetBotAppId,
      };
      const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
      if (
        this.pending.size >= this.maxPendingEvents
        || this.pendingBytes + bytes > this.maxPendingBytes
      ) {
        this.logger.warn(
          `[codex-notifier] Side Chat 内存待入队已达上限，跳过事件: ${event.eventId.slice(0, 12)}`,
        );
        continue;
      }
      this.pending.set(event.eventId, { ...item, bytes });
      this.pendingBytes += bytes;
    }
    this.flushPending();
  }

  private flushPending(): void {
    for (const [eventId, item] of this.pending) {
      try {
        this.enqueue(this.options.dataDir, item.targetBotAppId, item.event);
        this.pending.delete(eventId);
        this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
        this.logger.debug(`[codex-notifier] Side Chat 完成事件已入队: ${eventId.slice(0, 12)}`);
      } catch (error) {
        this.logger.warn(
          `[codex-notifier] Side Chat 完成事件入队失败，将重试: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async connectOnce(signal?: AbortSignal): Promise<void> {
    if (this.enabled()) this.startObservation();
    await new Promise<void>((resolve) => {
      let socket: Socket;
      try {
        socket = this.connect(this.socketPath);
      } catch (error) {
        this.logger.debug(
          `[codex-notifier] Codex Desktop IPC 连接失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        resolve();
        return;
      }
      const header = Buffer.allocUnsafe(4);
      let headerOffset = 0;
      let frame: Buffer | undefined;
      let frameOffset = 0;
      let clientId: string | undefined;
      let scanTimer: NodeJS.Timeout | undefined;
      let connectTimer: NodeJS.Timeout | undefined;
      let initializeTimer: NodeJS.Timeout | undefined;
      const followed = new Set<string>();
      const ignored = new Set<string>();
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (scanTimer) clearInterval(scanTimer);
        if (connectTimer) clearTimeout(connectTimer);
        if (initializeTimer) clearTimeout(initializeTimer);
        signal?.removeEventListener('abort', abort);
        if (!socket.destroyed) socket.destroy();
        resolve();
      };
      const abort = (): void => finish();
      const send = (message: unknown): void => {
        if (!socket.destroyed && socket.writable) socket.write(encodeIpcFrame(message));
      };
      const follow = (conversationId: string, force = false): void => {
        if (!clientId || !THREAD_ID_PATTERN.test(conversationId)) return;
        if (!force && followed.has(conversationId)) return;
        followed.add(conversationId);
        send({
          type: 'broadcast',
          method: 'thread-stream-following-changed',
          sourceClientId: clientId,
          params: { conversationId, hostId: 'local', following: true },
          version: THREAD_STREAM_FOLLOWING_VERSION,
        });
      };
      const unfollow = (conversationId: string): void => {
        if (!clientId || !followed.delete(conversationId)) return;
        send({
          type: 'broadcast',
          method: 'thread-stream-following-changed',
          sourceClientId: clientId,
          params: { conversationId, hostId: 'local', following: false },
          version: THREAD_STREAM_FOLLOWING_VERSION,
        });
      };
      const ignore = (conversationId: string): void => {
        ignored.delete(conversationId);
        ignored.add(conversationId);
        while (ignored.size > MAX_TRACKED_CONVERSATIONS) {
          const oldest = ignored.values().next().value as string | undefined;
          if (!oldest) break;
          ignored.delete(oldest);
        }
      };
      const scan = (): void => {
        if (!this.enabled()) {
          this.stopObservation();
          finish();
          return;
        }
        this.startObservation();
        this.flushPending();
        for (const thread of this.listThreads(this.codexHome, this.now())) {
          if (ignored.has(thread.id)) continue;
          if (
            !followed.has(thread.id)
            && !this.tracker.has(thread.id)
            && !this.candidates.has(thread.id)
          ) {
            this.candidates.set(thread.id, {
              notifyTerminalOnFirstSnapshot: this.observationStartedAt !== undefined,
              ...(this.observationStartedAt !== undefined
                ? { terminalNotBeforeMs: this.observationStartedAt }
                : {}),
            });
          }
          follow(thread.id);
        }
      };
      const handleState = (message: IpcMessage): void => {
        if (!this.enabled()) {
          this.stopObservation();
          finish();
          return;
        }
        const params = message.params;
        if (
          !params
          || params.hostId !== 'local'
          || typeof params.conversationId !== 'string'
          || !plainObject(params.change)
        ) {
          return;
        }
        const change = params.change;
        let result: TrackerResult;
        if (change.type === 'snapshot') {
          const candidate = this.candidates.get(params.conversationId);
          result = this.tracker.observeSnapshot(
            params.conversationId,
            change.revision,
            change.conversationState,
            {
              notifyTerminalOnFirstSnapshot: candidate?.notifyTerminalOnFirstSnapshot,
              terminalNotBeforeMs: candidate?.terminalNotBeforeMs,
              now: this.now(),
            },
          );
          this.candidates.delete(params.conversationId);
          if (
            plainObject(change.conversationState)
            && (
              change.conversationState.sideConversation !== true
              || change.conversationState.ephemeral !== true
            )
          ) {
            ignore(params.conversationId);
            unfollow(params.conversationId);
            return;
          }
        } else if (change.type === 'patches') {
          result = this.tracker.observePatches(
            params.conversationId,
            change.baseRevision,
            change.revision,
            change.patches,
            this.now(),
          );
        } else {
          return;
        }
        if (result.needsSnapshot) follow(params.conversationId, true);
        this.queueEvents(result.events);
      };
      const handleMessage = (message: IpcMessage): void => {
        if (
          message.type === 'response'
          && message.method === 'initialize'
          && message.resultType === 'success'
          && typeof message.result?.clientId === 'string'
        ) {
          if (initializeTimer) {
            clearTimeout(initializeTimer);
            initializeTimer = undefined;
          }
          clientId = message.result.clientId;
          scan();
          if (settled) return;
          for (const conversationId of this.candidates.keys()) follow(conversationId);
          scanTimer = setInterval(scan, this.scanIntervalMs);
          return;
        }
        if (message.type === 'client-discovery-request' && typeof message.requestId === 'string') {
          send({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false },
          });
          return;
        }
        if (message.type !== 'broadcast') return;
        if (message.method === 'thread-stream-state-changed') {
          handleState(message);
          return;
        }
        if (
          message.method === 'thread-stream-following-changed'
          && message.params?.hostId === 'local'
          && message.params.following === true
          && typeof message.params.conversationId === 'string'
        ) {
          if (ignored.has(message.params.conversationId)) return;
          if (
            !this.tracker.has(message.params.conversationId)
            && !this.candidates.has(message.params.conversationId)
          ) {
            this.candidates.set(message.params.conversationId, {
              notifyTerminalOnFirstSnapshot: this.observationStartedAt !== undefined,
              ...(this.observationStartedAt !== undefined
                ? { terminalNotBeforeMs: this.observationStartedAt }
                : {}),
            });
          }
          follow(message.params.conversationId);
        }
      };

      socket.on('connect', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        initializeTimer = setTimeout(() => {
          this.logger.warn('[codex-notifier] Codex Desktop IPC 初始化超时，将重连');
          finish();
        }, this.initializeTimeoutMs);
        initializeTimer.unref?.();
        send({
          type: 'request',
          requestId: randomUUID(),
          method: 'initialize',
          params: { clientType: 'botmux-codex-notifier' },
        });
      });
      socket.on('data', (chunk: Buffer) => {
        let chunkOffset = 0;
        while (chunkOffset < chunk.length && !settled) {
          if (!frame) {
            const headerBytes = Math.min(4 - headerOffset, chunk.length - chunkOffset);
            chunk.copy(header, headerOffset, chunkOffset, chunkOffset + headerBytes);
            headerOffset += headerBytes;
            chunkOffset += headerBytes;
            if (headerOffset < 4) continue;

            const frameLength = header.readUInt32LE(0);
            headerOffset = 0;
            if (frameLength === 0 || frameLength > IPC_MAX_FRAME_BYTES) {
              this.logger.warn(`[codex-notifier] Codex Desktop IPC 帧长度无效: ${frameLength}`);
              finish();
              return;
            }
            frame = Buffer.allocUnsafe(frameLength);
            frameOffset = 0;
          }

          const frameBytes = Math.min(frame.length - frameOffset, chunk.length - chunkOffset);
          chunk.copy(frame, frameOffset, chunkOffset, chunkOffset + frameBytes);
          frameOffset += frameBytes;
          chunkOffset += frameBytes;
          if (frameOffset < frame.length) continue;

          const completedFrame = frame;
          frame = undefined;
          frameOffset = 0;
          try {
            handleMessage(JSON.parse(completedFrame.toString('utf8')) as IpcMessage);
          } catch (error) {
            this.logger.warn(
              `[codex-notifier] Codex Desktop IPC 消息解析失败: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      });
      socket.on('error', (error) => {
        this.logger.debug(`[codex-notifier] Codex Desktop IPC 暂不可用: ${error.message}`);
      });
      socket.on('close', finish);
      signal?.addEventListener('abort', abort, { once: true });
      connectTimer = setTimeout(() => {
        this.logger.warn('[codex-notifier] Codex Desktop IPC 连接超时，将重连');
        finish();
      }, this.connectTimeoutMs);
      connectTimer.unref?.();
      if (signal?.aborted) abort();
    });
  }

  async run(): Promise<void> {
    if (this.platform !== 'darwin') return;
    while (!this.options.signal?.aborted) {
      if (!this.enabled()) {
        this.stopObservation();
        await delay(this.scanIntervalMs, this.options.signal);
        continue;
      }
      this.startObservation();
      await this.connectOnce(this.options.signal);
      if (!this.options.signal?.aborted) await delay(this.retryMs, this.options.signal);
    }
  }
}

export async function runCodexSideConversationMonitor(
  options: CodexSideConversationMonitorOptions,
): Promise<void> {
  await new CodexSideConversationMonitor(options).run();
}
