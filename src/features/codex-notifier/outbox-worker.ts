import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { resolveCodexNotifierConfig, type ResolvedCodexNotifierConfig } from './config.js';
import {
  listCodexNotifierOutbox,
  quarantineCodexNotifierOutboxItem,
  readCodexNotifierOutboxItem,
  removeCodexNotifierOutboxItem,
  type CodexNotifierOutboxItem,
} from './outbox.js';
import { codexNotifierWorkerStatePath } from './paths.js';
import {
  acquireCodexNotifierWorkerLease,
  type CodexNotifierWorkerLease,
} from './worker-lock.js';

export type CodexNotifierDisposition = 'accepted' | 'duplicate';
export const CODEX_NOTIFIER_WORKER_STALE_MS = 90_000;

export interface CodexNotifierWorkerState {
  schemaVersion: 1;
  heartbeatAt: string;
  pendingCount: number;
  lastDeliveredAt: string | null;
  lastDisposition: CodexNotifierDisposition | null;
  lastError: { at: string; message: string; retryAt: string } | null;
  stats: { accepted: number; duplicate: number; failed: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    // 防止调用方恰好在首次检查和监听器注册之间取消。
    if (signal?.aborted) finish();
  });
}

function readSavedState(path: string): Partial<CodexNotifierWorkerState> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<CodexNotifierWorkerState>;
  } catch {
    return {};
  }
}

/** 读取 worker 的非敏感运行摘要，供 Dashboard 和诊断 CLI 展示。 */
export function readCodexNotifierWorkerState(dataDir: string): CodexNotifierWorkerState | null {
  const saved = readSavedState(codexNotifierWorkerStatePath(dataDir));
  if (
    saved.schemaVersion !== 1
    || typeof saved.heartbeatAt !== 'string'
    || !Number.isSafeInteger(saved.pendingCount)
    || (saved.pendingCount ?? -1) < 0
  ) {
    return null;
  }
  const stats = saved.stats;
  if (
    !stats
    || !Number.isSafeInteger(stats.accepted)
    || !Number.isSafeInteger(stats.duplicate)
    || !Number.isSafeInteger(stats.failed)
  ) {
    return null;
  }
  const lastError = saved.lastError
    && typeof saved.lastError.at === 'string'
    && typeof saved.lastError.message === 'string'
    && typeof saved.lastError.retryAt === 'string'
    ? {
        at: saved.lastError.at,
        message: saved.lastError.message.slice(0, 500),
        retryAt: saved.lastError.retryAt,
      }
    : null;
  return {
    schemaVersion: 1,
    heartbeatAt: saved.heartbeatAt,
    pendingCount: saved.pendingCount!,
    lastDeliveredAt: typeof saved.lastDeliveredAt === 'string' ? saved.lastDeliveredAt : null,
    lastDisposition: saved.lastDisposition === 'accepted' || saved.lastDisposition === 'duplicate'
      ? saved.lastDisposition
      : null,
    lastError,
    stats: {
      accepted: stats.accepted,
      duplicate: stats.duplicate,
      failed: stats.failed,
    },
  };
}

/** Dashboard 只把近期持续刷新的 heartbeat 视为 worker 在线。 */
export function isCodexNotifierWorkerStateFresh(
  state: CodexNotifierWorkerState | null,
  now = Date.now(),
  staleMs = CODEX_NOTIFIER_WORKER_STALE_MS,
): boolean {
  if (!state) return false;
  const heartbeatAt = Date.parse(state.heartbeatAt);
  return Number.isFinite(heartbeatAt)
    && heartbeatAt <= now + 5_000
    && now - heartbeatAt <= staleMs;
}

export interface CodexNotifierOutboxWorkerOptions {
  dataDir: string;
  emit: (item: CodexNotifierOutboxItem) => Promise<CodexNotifierDisposition>;
  runProducer?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  logger?: Pick<Console, 'error'>;
  readConfig?: () => ResolvedCodexNotifierConfig;
  pollIntervalMs?: number;
  maxBatchMs?: number;
}

/** Dashboard 单例持有的可靠 outbox worker。 */
export class CodexNotifierOutboxWorker {
  private readonly statePath: string;
  private readonly retry = new Map<string, { attempts: number; nextAt: number }>();
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly readConfig: () => ResolvedCodexNotifierConfig;
  private readonly pollIntervalMs: number;
  private readonly maxBatchMs: number;
  private readonly stats: CodexNotifierWorkerState['stats'];
  private lastDeliveredAt: string | null;
  private lastDisposition: CodexNotifierDisposition | null;
  private lastError: CodexNotifierWorkerState['lastError'];
  private lastStateWriteAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: CodexNotifierOutboxWorkerOptions) {
    this.statePath = codexNotifierWorkerStatePath(options.dataDir);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.readConfig = options.readConfig ?? resolveCodexNotifierConfig;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxBatchMs = options.maxBatchMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxBatchMs) || this.maxBatchMs <= 0) {
      throw new Error('codex_notifier_worker_batch_budget_invalid');
    }
    const saved = readSavedState(this.statePath);
    this.stats = {
      accepted: Number.isSafeInteger(saved.stats?.accepted) ? saved.stats!.accepted : 0,
      duplicate: Number.isSafeInteger(saved.stats?.duplicate) ? saved.stats!.duplicate : 0,
      failed: Number.isSafeInteger(saved.stats?.failed) ? saved.stats!.failed : 0,
    };
    this.lastDeliveredAt = saved.lastDeliveredAt ?? null;
    this.lastDisposition = saved.lastDisposition ?? null;
    this.lastError = saved.lastError ?? null;
  }

  private writeState(force = false): void {
    if (!force && this.now() - this.lastStateWriteAt < 30_000) return;
    const state: CodexNotifierWorkerState = {
      schemaVersion: 1,
      heartbeatAt: new Date(this.now()).toISOString(),
      pendingCount: listCodexNotifierOutbox(this.options.dataDir).length,
      lastDeliveredAt: this.lastDeliveredAt,
      lastDisposition: this.lastDisposition,
      lastError: this.lastError,
      stats: this.stats,
    };
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    this.lastStateWriteAt = this.now();
  }

  async processOnce(): Promise<{ accepted: number; duplicate: number; failed: number; deferred: number }> {
    const summary = { accepted: 0, duplicate: 0, failed: 0, deferred: 0 };
    if (!this.readConfig().enabled) {
      this.writeState();
      return summary;
    }
    const batchStartedAt = this.now();
    let attempted = 0;
    for (const file of listCodexNotifierOutbox(this.options.dataDir)) {
      if (this.options.signal?.aborted) break;
      const retry = this.retry.get(file.name);
      if (retry && retry.nextAt > this.now()) {
        summary.deferred += 1;
        continue;
      }
      if (
        attempted >= 50
        || (attempted > 0 && this.now() - batchStartedAt >= this.maxBatchMs)
      ) {
        break;
      }
      attempted += 1;
      let item: CodexNotifierOutboxItem;
      try {
        item = readCodexNotifierOutboxItem(file.path);
      } catch (error) {
        const quarantined = quarantineCodexNotifierOutboxItem(
          this.options.dataDir,
          file.path,
          error,
        );
        this.retry.delete(file.name);
        if (!quarantined) continue;
        this.stats.failed += 1;
        summary.failed += 1;
        const now = this.now();
        this.lastError = {
          at: new Date(now).toISOString(),
          message: `invalid_outbox_quarantined:${errorMessage(error)}`.slice(0, 500),
          retryAt: new Date(now).toISOString(),
        };
        this.logger.error(`[codex-notifier] 损坏的 outbox 已隔离: ${file.name}`);
        continue;
      }
      try {
        const disposition = await this.options.emit(item);
        removeCodexNotifierOutboxItem(file.path);
        this.retry.delete(file.name);
        this.stats[disposition] += 1;
        summary[disposition] += 1;
        this.lastDeliveredAt = new Date(this.now()).toISOString();
        this.lastDisposition = disposition;
        this.lastError = null;
      } catch (error) {
        if (!existsSync(file.path)) continue;
        const attempts = (retry?.attempts ?? 0) + 1;
        const retryMs = Math.min(2_000 * (2 ** Math.min(attempts - 1, 20)), 60_000);
        this.retry.set(file.name, { attempts, nextAt: this.now() + retryMs });
        this.stats.failed += 1;
        summary.failed += 1;
        this.lastError = {
          at: new Date(this.now()).toISOString(),
          message: errorMessage(error).slice(0, 500),
          retryAt: new Date(this.now() + retryMs).toISOString(),
        };
        this.logger.error(`[codex-notifier] 事件投递失败，将在 ${retryMs}ms 后重试: ${this.lastError.message}`);
      }
    }
    this.writeState(summary.accepted + summary.duplicate + summary.failed > 0);
    return summary;
  }

  /** 常驻轮询 outbox；目标 daemon 离线时保留文件并指数退避。 */
  async run(): Promise<void> {
    const producerAbort = this.options.runProducer ? new AbortController() : undefined;
    const stopProducer = () => producerAbort?.abort(this.options.signal?.reason);
    let producer: Promise<void> | undefined;
    if (producerAbort && this.options.runProducer) {
      this.options.signal?.addEventListener('abort', stopProducer, { once: true });
      if (this.options.signal?.aborted) stopProducer();
      producer = this.options.runProducer(producerAbort.signal).catch((error) => {
        this.logger.error(`[codex-notifier] producer stopped unexpectedly: ${errorMessage(error)}`);
      });
    }

    try {
      while (!this.options.signal?.aborted) {
        try {
          await this.processOnce();
        } catch (error) {
          this.logger.error(`[codex-notifier] worker 循环失败: ${errorMessage(error)}`);
          this.writeState(true);
        }
        await delay(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      if (producerAbort) {
        producerAbort.abort();
        this.options.signal?.removeEventListener('abort', stopProducer);
        await producer;
      }
      this.writeState(true);
    }
  }
}

export interface CodexNotifierWorkerSupervisorOptions extends CodexNotifierOutboxWorkerOptions {
  acquireLease?: (dataDir: string) => CodexNotifierWorkerLease;
  leaseRetryMs?: number;
  onLeaseUnavailable?: (path: string) => void;
}

/** Dashboard 重叠重启时持续争抢 lease，直到本进程接管或退出。 */
export async function runCodexNotifierWorkerSupervisor(
  options: CodexNotifierWorkerSupervisorOptions,
): Promise<void> {
  const acquireLease = options.acquireLease ?? acquireCodexNotifierWorkerLease;
  const retryMs = options.leaseRetryMs ?? 1_000;
  let reportedUnavailable = false;

  while (!options.signal?.aborted) {
    let lease: CodexNotifierWorkerLease;
    try {
      lease = acquireLease(options.dataDir);
    } catch (error) {
      options.logger?.error(`[codex-notifier] worker lease 获取失败: ${errorMessage(error)}`);
      await delay(retryMs, options.signal);
      continue;
    }
    if (!lease.acquired) {
      if (!reportedUnavailable) options.onLeaseUnavailable?.(lease.path);
      reportedUnavailable = true;
      await delay(retryMs, options.signal);
      continue;
    }

    reportedUnavailable = false;
    try {
      await new CodexNotifierOutboxWorker(options).run();
    } catch (error) {
      options.logger?.error(`[codex-notifier] worker stopped unexpectedly: ${errorMessage(error)}`);
    } finally {
      lease.release();
    }
    if (!options.signal?.aborted) await delay(retryMs, options.signal);
  }
}
