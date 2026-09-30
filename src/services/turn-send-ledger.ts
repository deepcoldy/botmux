import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLock } from '../utils/file-lock.js';

export type TurnSendKind = 'progress' | 'final' | 'auxiliary';

export interface TurnSendLedgerKey {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}

interface TurnSendLedgerRecord extends TurnSendLedgerKey {
  version: 1;
  nonIdempotentSequence?: {
    fingerprint: string;
    target: string;
    stepCount: number;
    completedSteps: number;
    inFlightStep?: number;
  };
  final?: {
    fingerprint: string;
    messageId: string;
    deliveredAtMs: number;
  };
}

export interface TurnSendLedgerResult {
  messageId: string;
  replayed: boolean;
}

export interface NonIdempotentStepEffects {
  /** Persist the unknown-delivery checkpoint immediately before a provider request. */
  providerRequestStarted(): void;
  /** Clear that checkpoint only after a provider response proves rejection. */
  providerRequestNotDelivered(): void;
}

export type TurnSendLedgerInspection = Pick<TurnSendLedgerKey, 'larkAppId' | 'sessionId' | 'turnId'> & (
  | {
      state: 'completed';
      messageId: string;
      deliveredAtMs: number;
    }
  | {
      state: 'incomplete' | 'in_flight';
      target: string;
      stepCount: number;
      completedSteps: number;
      /** Human-facing one-based step number. */
      inFlightStep?: number;
    }
);

export const TURN_SEND_LEDGER_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TURN_SEND_LEDGER_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const TURN_SEND_LEDGER_PRUNE_MARKER = '.completed-prune';

/**
 * Cross-process final-answer fence for every primary `botmux send` path.
 *
 * Reply-card state remains responsible for card rendering and PATCH reuse. This
 * The caller supplies a canonical identity covering payload, route, mentions,
 * and attachments. Once a turn has published a final answer, no other primary
 * route or recipient can mint a second one.
 */
export class TurnSendLedger {
  readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'turn-send-ledger');
  }

  id(key: TurnSendLedgerKey): string {
    return createHash('sha256').update(JSON.stringify([
      key.larkAppId,
      key.sessionId,
      key.turnId,
    ])).digest('hex').slice(0, 32);
  }

  private path(key: TurnSendLedgerKey): string {
    return join(this.directory, `${this.id(key)}.json`);
  }

  private fingerprint(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private validateRecord(record: TurnSendLedgerRecord, expectedId: string): TurnSendLedgerRecord {
    if (record.version !== 1 || this.id(record) !== expectedId) {
      throw new Error('Invalid turn-send ledger record');
    }
    if (record.final && (!record.final.fingerprint || !record.final.messageId
      || !Number.isFinite(record.final.deliveredAtMs))) {
      throw new Error('Invalid turn-send final record');
    }
    const sequence = record.nonIdempotentSequence;
    if (sequence && (
      !sequence.fingerprint
      || !sequence.target
      || !Number.isSafeInteger(sequence.stepCount)
      || sequence.stepCount <= 0
      || !Number.isSafeInteger(sequence.completedSteps)
      || sequence.completedSteps < 0
      || sequence.completedSteps > sequence.stepCount
      || (sequence.inFlightStep !== undefined && (
        !Number.isSafeInteger(sequence.inFlightStep)
        || sequence.inFlightStep !== sequence.completedSteps
        || sequence.inFlightStep >= sequence.stepCount
      ))
    )) {
      throw new Error('Invalid turn-send non-idempotent sequence record');
    }
    return record;
  }

  private readPath(path: string): TurnSendLedgerRecord {
    const directoryStat = lstatSync(this.directory);
    const fileStat = lstatSync(path);
    if (directoryStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('Unsafe turn-send ledger record');
    }
    const file = basename(path);
    if (!/^[a-f0-9]{32}\.json$/.test(file)) throw new Error('Invalid turn-send ledger filename');
    const record = JSON.parse(readFileSync(path, 'utf8')) as TurnSendLedgerRecord;
    return this.validateRecord(record, file.slice(0, -'.json'.length));
  }

  private read(key: TurnSendLedgerKey): TurnSendLedgerRecord | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    return this.readPath(path);
  }

  private write(key: TurnSendLedgerKey, record: TurnSendLedgerRecord): void {
    atomicWriteFileSync(this.path(key), JSON.stringify(record), {
      mode: 0o600,
      followTargetSymlink: false,
      durable: true,
    });
  }

  private inspection(record: TurnSendLedgerRecord): TurnSendLedgerInspection {
    const identity = {
      larkAppId: record.larkAppId,
      sessionId: record.sessionId,
      turnId: record.turnId,
    };
    if (record.final) {
      return {
        ...identity,
        state: 'completed',
        messageId: record.final.messageId,
        deliveredAtMs: record.final.deliveredAtMs,
      };
    }
    const sequence = record.nonIdempotentSequence;
    if (!sequence) throw new Error('Invalid empty turn-send ledger record');
    return {
      ...identity,
      state: sequence.inFlightStep === undefined ? 'incomplete' : 'in_flight',
      target: sequence.target,
      stepCount: sequence.stepCount,
      completedSteps: sequence.completedSteps,
      ...(sequence.inFlightStep === undefined ? {} : { inFlightStep: sequence.inFlightStep + 1 }),
    };
  }

  /** Resolve hashed filenames back to operator-facing session/turn identities. */
  inspect(filter: { larkAppId?: string; sessionId?: string; turnId?: string } = {}): TurnSendLedgerInspection[] {
    if (!existsSync(this.directory)) return [];
    const directoryStat = lstatSync(this.directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('Unsafe turn-send ledger directory');
    }
    const records: TurnSendLedgerInspection[] = [];
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).sort()) {
      const record = this.readPath(join(this.directory, file));
      if (filter.larkAppId && record.larkAppId !== filter.larkAppId) continue;
      if (filter.sessionId && record.sessionId !== filter.sessionId) continue;
      if (filter.turnId && record.turnId !== filter.turnId) continue;
      records.push(this.inspection(record));
    }
    return records;
  }

  /**
   * Human reconciliation for a provider response whose acceptance is unknown.
   * `delivered` advances past the uncertain step; `not-delivered` makes that
   * same step eligible for retry. Both preserve all earlier checkpoints.
   */
  async resolveUnknownStep(
    key: TurnSendLedgerKey,
    outcome: 'delivered' | 'not-delivered',
  ): Promise<TurnSendLedgerInspection> {
    if (outcome !== 'delivered' && outcome !== 'not-delivered') {
      throw new Error('Unknown turn-send recovery outcome');
    }
    if (!existsSync(this.path(key))) throw new Error('Turn-send ledger record not found');
    return withFileLock(this.path(key), async () => {
      const record = this.read(key);
      const sequence = record?.nonIdempotentSequence;
      if (!record || record.final || sequence?.inFlightStep === undefined) {
        throw new Error('Turn-send ledger has no unknown in-flight step to resolve');
      }
      if (outcome === 'delivered') sequence.completedSteps = sequence.inFlightStep + 1;
      delete sequence.inFlightStep;
      this.write(key, record);
      return this.inspection(record);
    }, { maxWaitMs: 60_000 });
  }

  /** Delete only safely completed records after the retention horizon. */
  async pruneCompleted(nowMs = Date.now()): Promise<{ removed: number; retained: number }> {
    if (!existsSync(this.directory)) return { removed: 0, retained: 0 };
    const directoryStat = lstatSync(this.directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('Unsafe turn-send ledger directory');
    }
    if (!Number.isFinite(nowMs)) throw new Error('Invalid turn-send ledger prune time');
    const cutoffMs = nowMs - TURN_SEND_LEDGER_COMPLETED_RETENTION_MS;
    let removed = 0;
    let retained = 0;
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
      const path = join(this.directory, file);
      try {
        await withFileLock(path, async () => {
          if (!existsSync(path)) return;
          const record = this.readPath(path);
          if (record.final && record.final.deliveredAtMs <= cutoffMs) {
            unlinkSync(path);
            removed++;
          } else {
            retained++;
          }
        }, { maxWaitMs: 0 });
      } catch (error) {
        if (!(error instanceof FileLockTimeoutError)) throw error;
        // A live send owns this record. Retain it and let a later sweep retry;
        // maintenance must never wait behind the delivery correctness path.
        retained++;
      }
    }
    return { removed, retained };
  }

  /**
   * Cheap startup/send-path trigger around the full prune. The marker check is
   * repeated under one directory-scoped lock so concurrent short-lived CLI
   * processes cannot all scan the ledger at once.
   */
  async pruneCompletedIfDue(nowMs = Date.now()): Promise<{
    ran: boolean;
    removed: number;
    retained: number;
  }> {
    if (!Number.isFinite(nowMs)) throw new Error('Invalid turn-send ledger prune time');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    const markerPath = join(this.directory, TURN_SEND_LEDGER_PRUNE_MARKER);
    const readLastRun = (): number | undefined => {
      if (!existsSync(markerPath)) return undefined;
      const stat = lstatSync(markerPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe turn-send ledger prune marker');
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as { lastRunMs?: unknown };
      return typeof parsed.lastRunMs === 'number' && Number.isFinite(parsed.lastRunMs)
        ? parsed.lastRunMs
        : undefined;
    };
    const due = (lastRunMs: number | undefined): boolean =>
      lastRunMs === undefined || nowMs - lastRunMs >= TURN_SEND_LEDGER_PRUNE_INTERVAL_MS;
    if (!due(readLastRun())) return { ran: false, removed: 0, retained: 0 };
    try {
      return await withFileLock(markerPath, async () => {
        if (!due(readLastRun())) return { ran: false, removed: 0, retained: 0 };
        const result = await this.pruneCompleted(nowMs);
        atomicWriteFileSync(markerPath, JSON.stringify({ lastRunMs: nowMs }), {
          mode: 0o600,
          followTargetSymlink: false,
          durable: true,
        });
        return { ran: true, ...result };
      }, { maxWaitMs: 0 });
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        return { ran: false, removed: 0, retained: 0 };
      }
      throw error;
    }
  }

  /**
   * Cheap effect-boundary check used before payload preparation that itself may
   * call external providers (TTS/uploads/lookups). `execute` repeats the same
   * decision under the publication lock, so this is an early fail-closed gate,
   * not the concurrency authority.
   */
  async replayOrThrow(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
  ): Promise<TurnSendLedgerResult | undefined> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const final = this.read(key)?.final;
      if (!final || kind === 'auxiliary') return undefined;
      if (kind === 'progress') {
        throw new Error('本轮 final 已完成，不能再发送 progress；如需补充消息，请使用 --response-kind auxiliary');
      }
      if (final.fingerprint !== this.fingerprint(renderedContent)) {
        throw new Error('本轮 final 已投递，但本次请求的目标、提及或附件与已投递请求不同；如需补充消息，请使用 --response-kind auxiliary');
      }
      return { messageId: final.messageId, replayed: true };
    }, { maxWaitMs: 60_000 });
  }

  async execute(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
    dispatch: (providerUuid?: string) => Promise<string>,
  ): Promise<TurnSendLedgerResult> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const record = this.read(key) ?? { ...key, version: 1 as const };
      if (!record.final && record.nonIdempotentSequence) {
        const step = record.nonIdempotentSequence.inFlightStep;
        if (step !== undefined) {
          throw new Error(`第 ${step + 1} 个投递分块的结果未知；请先运行 botmux turn-send-ledger inspect，再核对并使用 resolve 恢复`);
        }
        throw new Error('本轮存在未完成的分块投递；请重试原 final 请求，或运行 botmux turn-send-ledger inspect 查看状态');
      }
      if (record.final && kind !== 'auxiliary') {
        if (kind === 'progress') {
          throw new Error('本轮 final 已完成，不能再发送 progress；如需补充消息，请使用 --response-kind auxiliary');
        }
        if (record.final.fingerprint !== this.fingerprint(renderedContent)) {
          throw new Error('本轮 final 已投递，但本次请求的目标、提及或附件与已投递请求不同；如需补充消息，请使用 --response-kind auxiliary');
        }
        return { messageId: record.final.messageId, replayed: true };
      }

      const providerUuid = kind === 'final'
        ? `bts_${createHash('sha256').update(`${this.id(key)}:${this.fingerprint(renderedContent)}`).digest('hex').slice(0, 32)}`
        : undefined;
      const messageId = await dispatch(providerUuid);
      if (!messageId && kind === 'final') throw new Error('Missing primary message ID');
      if (kind === 'final') {
        record.final = {
          fingerprint: this.fingerprint(renderedContent),
          messageId,
          deliveredAtMs: Date.now(),
        };
        this.write(key, record);
      }
      return { messageId, replayed: false };
    }, { maxWaitMs: 60_000 });
  }

  /**
   * Checkpoint a sequence whose provider offers no idempotency key (document
   * comment chunks are the current caller). Each step is marked in-flight and
   * durably written before the provider call. If the process loses the
   * response, a retry fails closed at that step: repeating it could duplicate
   * content already accepted by the provider.
   */
  async executeNonIdempotentSequence(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
    stepCount: number,
    dispatchStep: (index: number, effects: NonIdempotentStepEffects) => Promise<void>,
    messageId: string,
  ): Promise<TurnSendLedgerResult> {
    if (kind !== 'final') throw new Error('分块投递只允许 final 回复；请使用 --response-kind final');
    if (!Number.isSafeInteger(stepCount) || stepCount <= 0) throw new Error('Non-idempotent delivery sequence must contain at least one step');
    if (!messageId) throw new Error('Missing non-idempotent delivery message ID');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const record = this.read(key) ?? { ...key, version: 1 as const };
      const fingerprint = this.fingerprint(renderedContent);
      if (record.final) {
        if (record.final.fingerprint !== fingerprint) {
          throw new Error('本轮 final 已投递，但本次请求的目标、提及或附件与已投递请求不同；如需补充消息，请使用 --response-kind auxiliary');
        }
        return { messageId: record.final.messageId, replayed: true };
      }

      const sequence = record.nonIdempotentSequence ?? {
        fingerprint,
        target: messageId,
        stepCount,
        completedSteps: 0,
      };
      if (sequence.fingerprint !== fingerprint
        || sequence.target !== messageId
        || sequence.stepCount !== stepCount) {
        throw new Error('本轮已开始另一组文档评论分块；请勿更换正文、目标或分块方式。先运行 botmux turn-send-ledger inspect 查看状态');
      }
      record.nonIdempotentSequence = sequence;
      if (sequence.inFlightStep !== undefined) {
        throw new Error(`第 ${sequence.inFlightStep + 1} 个投递分块的结果未知；请先运行 botmux turn-send-ledger inspect，再核对并使用 resolve 恢复`);
      }

      for (let index = sequence.completedSteps; index < stepCount; index++) {
        let providerRequestInFlight = false;
        const effects: NonIdempotentStepEffects = {
          providerRequestStarted: () => {
            if (providerRequestInFlight) {
              throw new Error(`第 ${index + 1} 个投递分块已有 provider 请求进行中`);
            }
            sequence.inFlightStep = index;
            providerRequestInFlight = true;
            this.write(key, record);
          },
          providerRequestNotDelivered: () => {
            if (!providerRequestInFlight || sequence.inFlightStep !== index) return;
            delete sequence.inFlightStep;
            providerRequestInFlight = false;
            this.write(key, record);
          },
        };
        await dispatchStep(index, effects);
        // Legacy/internal callbacks that return successfully without the newer
        // lifecycle signal are still safe to complete: a returned dispatch has
        // a known outcome. The document-comment caller always signals before its
        // actual POST so crashes retain the durable unknown checkpoint.
        sequence.completedSteps = index + 1;
        delete sequence.inFlightStep;
        this.write(key, record);
      }

      record.final = { fingerprint, messageId, deliveredAtMs: Date.now() };
      this.write(key, record);
      return { messageId, replayed: false };
    }, { maxWaitMs: 60_000 });
  }
}
