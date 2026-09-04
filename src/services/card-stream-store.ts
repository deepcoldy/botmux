import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

const CARD_STREAM_SCHEMA_VERSION = 1;
const STREAM_ID_RE = /^cs_[0-9a-f]{32}$/;

export type CardStreamStatus = 'opening' | 'open' | 'finished' | 'superseded';

export interface CardStreamBinding {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  messageId: string;
  anchorTurnId?: string;
}

export type CardStreamAuthority = Pick<CardStreamBinding, 'sessionId' | 'larkAppId' | 'chatId'>;

export interface CardStreamRecord extends CardStreamBinding {
  schemaVersion: typeof CARD_STREAM_SCHEMA_VERSION;
  streamId: string;
  cardId: string;
  status: CardStreamStatus;
  sequence: number;
  supersededByStreamId?: string;
  createdAt: string;
  updatedAt: string;
}

export class CardStreamStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStreamStoreError';
  }
}

export interface CardStreamSequenceLease {
  cardId: string;
  sequence: number;
  uuid: string;
}

export interface CardStreamOpenResult {
  record: CardStreamRecord;
  alreadyOpen: boolean;
}

export interface CardStreamFinishResult {
  record: CardStreamRecord;
  alreadyFinished: boolean;
}

export interface CardStreamReanchorResult {
  previous: CardStreamRecord;
  current: CardStreamRecord;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRecord(raw: string, expectedStreamId: string): CardStreamRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CardStreamStoreError(`流状态文件损坏: ${expectedStreamId}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CardStreamStoreError(`流状态文件格式无效: ${expectedStreamId}`);
  }
  const record = value as Partial<CardStreamRecord>;
  if (
    record.schemaVersion !== CARD_STREAM_SCHEMA_VERSION ||
    record.streamId !== expectedStreamId ||
    !nonEmptyString(record.sessionId) ||
    !nonEmptyString(record.larkAppId) ||
    !nonEmptyString(record.chatId) ||
    !nonEmptyString(record.messageId) ||
    !nonEmptyString(record.cardId) ||
    !['opening', 'open', 'finished', 'superseded'].includes(String(record.status)) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    !nonEmptyString(record.createdAt) ||
    !nonEmptyString(record.updatedAt) ||
    (record.anchorTurnId !== undefined && !nonEmptyString(record.anchorTurnId)) ||
    (record.supersededByStreamId !== undefined && !STREAM_ID_RE.test(record.supersededByStreamId))
  ) {
    throw new CardStreamStoreError(`流状态文件字段无效: ${expectedStreamId}`);
  }
  return record as CardStreamRecord;
}

function assertAuthority(record: CardStreamRecord, authority: CardStreamAuthority): void {
  if (
    record.sessionId !== authority.sessionId ||
    record.larkAppId !== authority.larkAppId ||
    record.chatId !== authority.chatId
  ) {
    throw new CardStreamStoreError('当前会话无权操作这个卡片流');
  }
}

function assertSameBinding(record: CardStreamRecord, binding: CardStreamBinding, cardId: string): void {
  assertAuthority(record, binding);
  if (record.messageId !== binding.messageId || record.cardId !== cardId) {
    throw new CardStreamStoreError('目标消息与已有卡片流绑定不一致');
  }
  if (record.anchorTurnId && binding.anchorTurnId && record.anchorTurnId !== binding.anchorTurnId) {
    throw new CardStreamStoreError('目标消息属于另一个 turn，请使用 stream reanchor');
  }
}

function nextSequence(record: CardStreamRecord): number {
  const next = record.sequence + 1;
  if (!Number.isSafeInteger(next)) throw new CardStreamStoreError('卡片流 sequence 已耗尽');
  return next;
}

/**
 * Persistent authority + sequence ledger for CardKit streams.
 *
 * Each provider write reserves its sequence on disk before making the network
 * call, while holding the per-stream file lock. A crash can therefore skip a
 * sequence but can never reuse or reorder one. CardKit only requires strictly
 * increasing sequences, so a skipped value is safe; reuse is not.
 */
export class CardStreamStore {
  private readonly streamsDir: string;

  constructor(dataDir: string) {
    if (!dataDir.trim()) throw new CardStreamStoreError('缺少 Botmux data dir');
    this.streamsDir = join(dataDir, 'card-streams');
  }

  static streamIdFor(binding: CardStreamBinding): string {
    const digest = createHash('sha256')
      .update([
        String(CARD_STREAM_SCHEMA_VERSION),
        binding.sessionId,
        binding.larkAppId,
        binding.chatId,
        binding.messageId,
      ].join('\0'))
      .digest('hex')
      .slice(0, 32);
    return `cs_${digest}`;
  }

  async open(
    binding: CardStreamBinding,
    cardId: string,
    enableStreaming: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamOpenResult> {
    const streamId = CardStreamStore.streamIdFor(binding);
    const path = this.pathFor(streamId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      const now = new Date().toISOString();
      let record: CardStreamRecord;
      if (existsSync(path)) {
        record = this.readRecord(path, streamId);
        assertSameBinding(record, binding, cardId);
        if (record.status === 'finished' || record.status === 'superseded') {
          throw new CardStreamStoreError('这个卡片流已经结束，不能重新打开');
        }
        if (record.status === 'open') {
          if (!record.anchorTurnId && binding.anchorTurnId) {
            record = { ...record, anchorTurnId: binding.anchorTurnId, updatedAt: now };
            this.writeRecord(path, record);
          }
          return { record, alreadyOpen: true };
        }
      } else {
        record = {
          schemaVersion: CARD_STREAM_SCHEMA_VERSION,
          streamId,
          ...binding,
          cardId,
          status: 'opening',
          sequence: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.writeRecord(path, record);
      }

      const sequence = nextSequence(record);
      record = { ...record, sequence, updatedAt: now };
      this.writeRecord(path, record);
      await enableStreaming({ cardId, sequence, uuid: this.uuidFor(streamId, sequence) });
      record = { ...record, status: 'open', updatedAt: new Date().toISOString() };
      this.writeRecord(path, record);
      return { record, alreadyOpen: false };
    });
  }

  async write(
    streamId: string,
    authority: CardStreamAuthority,
    writeContent: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamRecord> {
    const path = this.pathFor(streamId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      const record = this.readRequired(path, streamId);
      assertAuthority(record, authority);
      if (record.status === 'opening') {
        throw new CardStreamStoreError('卡片流仍在打开中，请先重试 stream open');
      }
      if (record.status === 'finished') {
        throw new CardStreamStoreError('卡片流已经结束，不能继续写入');
      }
      if (record.status === 'superseded') {
        throw new CardStreamStoreError('卡片流已经迁移，拒绝迟到写入');
      }
      const sequence = nextSequence(record);
      const reserved = { ...record, sequence, updatedAt: new Date().toISOString() };
      this.writeRecord(path, reserved);
      await writeContent({
        cardId: record.cardId,
        sequence,
        uuid: this.uuidFor(streamId, sequence),
      });
      const committed = { ...reserved, updatedAt: new Date().toISOString() };
      this.writeRecord(path, committed);
      return committed;
    });
  }

  async inspect(
    streamId: string,
    authority: CardStreamAuthority,
  ): Promise<CardStreamRecord> {
    const path = this.pathFor(streamId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      const record = this.readRequired(path, streamId);
      assertAuthority(record, authority);
      return record;
    });
  }

  async finish(
    streamId: string,
    authority: CardStreamAuthority,
    disableStreaming: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamFinishResult> {
    const path = this.pathFor(streamId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      const record = this.readRequired(path, streamId);
      assertAuthority(record, authority);
      if (record.status === 'finished') return { record, alreadyFinished: true };
      if (record.status === 'superseded') {
        throw new CardStreamStoreError('卡片流已经迁移，不能结束旧流');
      }
      if (record.status === 'opening') {
        throw new CardStreamStoreError('卡片流仍在打开中，请先重试 stream open');
      }
      const sequence = nextSequence(record);
      const reserved = { ...record, sequence, updatedAt: new Date().toISOString() };
      this.writeRecord(path, reserved);
      await disableStreaming({
        cardId: record.cardId,
        sequence,
        uuid: this.uuidFor(streamId, sequence),
      });
      const finished: CardStreamRecord = {
        ...reserved,
        status: 'finished',
        updatedAt: new Date().toISOString(),
      };
      this.writeRecord(path, finished);
      return { record: finished, alreadyFinished: false };
    });
  }

  /**
   * Open the replacement card while holding the old stream lock, then fence the
   * old stream before exposing the new binding. A late writer queued on the old
   * lock observes `superseded` and can never mutate the replacement card.
   */
  async reanchor(
    streamId: string,
    authority: CardStreamAuthority,
    nextBinding: CardStreamBinding,
    nextCardId: string,
    enableStreaming: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamReanchorResult> {
    const path = this.pathFor(streamId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      const previous = this.readRequired(path, streamId);
      assertAuthority(previous, authority);
      if (previous.status !== 'open') {
        throw new CardStreamStoreError(
          previous.status === 'superseded' ? '卡片流已经迁移' : '只能迁移仍在打开的卡片流',
        );
      }
      if (
        nextBinding.sessionId !== authority.sessionId
        || nextBinding.larkAppId !== authority.larkAppId
        || nextBinding.chatId !== authority.chatId
      ) {
        throw new CardStreamStoreError('新卡片必须属于同一会话、Bot 和群聊');
      }
      if (nextBinding.messageId === previous.messageId) {
        throw new CardStreamStoreError('reanchor 需要一个新的消息 id');
      }

      const opened = await this.open(nextBinding, nextCardId, enableStreaming);
      const superseded: CardStreamRecord = {
        ...previous,
        status: 'superseded',
        supersededByStreamId: opened.record.streamId,
        updatedAt: new Date().toISOString(),
      };
      this.writeRecord(path, superseded);
      return { previous: superseded, current: opened.record };
    });
  }

  private pathFor(streamId: string): string {
    if (!STREAM_ID_RE.test(streamId)) throw new CardStreamStoreError(`streamId 格式无效: ${streamId}`);
    return join(this.streamsDir, `${streamId}.json`);
  }

  private ensureDirectory(): void {
    mkdirSync(this.streamsDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.streamsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CardStreamStoreError('card-streams 状态目录不安全');
    }
  }

  private readRequired(path: string, streamId: string): CardStreamRecord {
    this.ensureDirectory();
    if (!existsSync(path)) throw new CardStreamStoreError(`未找到卡片流: ${streamId}`);
    return this.readRecord(path, streamId);
  }

  private readRecord(path: string, streamId: string): CardStreamRecord {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CardStreamStoreError(`流状态文件不安全: ${streamId}`);
    }
    return parseRecord(readFileSync(path, 'utf-8'), streamId);
  }

  private writeRecord(path: string, record: CardStreamRecord): void {
    atomicWriteFileSync(path, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      followTargetSymlink: false,
    });
  }

  private uuidFor(streamId: string, sequence: number): string {
    return `bmx_${streamId.slice(3, 19)}_${sequence}`;
  }
}
