import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ScreenStatus } from '../types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import {
  CardStreamStore,
  type CardStreamAuthority,
  type CardStreamSequenceLease,
} from './card-stream-store.js';

const SCHEMA_VERSION = 1;
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]{8,256}$/;
const LABEL_MAX_CHARS = 32;

const DEFAULT_LABELS: Record<ScreenStatus, string> = {
  working: '执行中',
  analyzing: '思考中',
  idle: '等待下一步',
  stalled: '可能卡住',
  limited: '等待额度',
};

const STATUS_COLOR: Record<ScreenStatus, 'blue' | 'turquoise' | 'grey' | 'orange'> = {
  working: 'blue',
  analyzing: 'turquoise',
  idle: 'grey',
  stalled: 'orange',
  limited: 'orange',
};

function activeStatus(status: ScreenStatus): boolean {
  return status === 'working' || status === 'analyzing';
}

function escapeCardText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return Array.from(normalized).slice(0, LABEL_MAX_CHARS).join('');
}

function normalizeLabels(value: Partial<Record<ScreenStatus, string>> | undefined): Record<ScreenStatus, string> {
  return {
    working: normalizeLabel(value?.working, DEFAULT_LABELS.working),
    analyzing: normalizeLabel(value?.analyzing, DEFAULT_LABELS.analyzing),
    idle: normalizeLabel(value?.idle, DEFAULT_LABELS.idle),
    stalled: normalizeLabel(value?.stalled, DEFAULT_LABELS.stalled),
    limited: normalizeLabel(value?.limited, DEFAULT_LABELS.limited),
  };
}

export interface CardRuntimeStatusBindingInput {
  streamId: string;
  authority: CardStreamAuthority;
  statusElementId: string;
  imageElementId: string;
  activeImageKey: string;
  inactiveImageKey: string;
  labels?: Partial<Record<ScreenStatus, string>>;
}

interface CardRuntimeStatusBindingRecord extends CardRuntimeStatusBindingInput {
  schemaVersion: typeof SCHEMA_VERSION;
  labels: Record<ScreenStatus, string>;
  lastStatus?: ScreenStatus;
  lastImageKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CardRuntimeStatusLarkAdapter {
  updateContent(input: CardStreamSequenceLease & {
    larkAppId: string;
    elementId: string;
    content: string;
  }): Promise<void>;
  patchElement(input: CardStreamSequenceLease & {
    larkAppId: string;
    elementId: string;
    partialElement: Record<string, unknown>;
  }): Promise<void>;
}

export class CardRuntimeStatusBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardRuntimeStatusBridgeError';
  }
}

function assertElementId(value: string, label: string): void {
  if (!ELEMENT_ID_RE.test(value)) {
    throw new CardRuntimeStatusBridgeError(`${label} 格式无效：需字母开头且最多 20 字符`);
  }
}

function assertImageKey(value: string, label: string): void {
  if (!IMAGE_KEY_RE.test(value)) throw new CardRuntimeStatusBridgeError(`${label} 格式无效`);
}

function isScreenStatus(value: unknown): value is ScreenStatus {
  return value === 'working' || value === 'analyzing' || value === 'idle'
    || value === 'stalled' || value === 'limited';
}

function parseRecord(raw: string): CardRuntimeStatusBindingRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CardRuntimeStatusBridgeError('runtime status binding 文件损坏'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CardRuntimeStatusBridgeError('runtime status binding 格式无效');
  }
  const record = value as Partial<CardRuntimeStatusBindingRecord>;
  if (
    record.schemaVersion !== SCHEMA_VERSION
    || typeof record.streamId !== 'string'
    || !record.authority
    || typeof record.authority.sessionId !== 'string'
    || typeof record.authority.larkAppId !== 'string'
    || typeof record.authority.chatId !== 'string'
    || typeof record.statusElementId !== 'string'
    || typeof record.imageElementId !== 'string'
    || typeof record.activeImageKey !== 'string'
    || typeof record.inactiveImageKey !== 'string'
    || !record.labels
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || (record.lastStatus !== undefined && !isScreenStatus(record.lastStatus))
  ) {
    throw new CardRuntimeStatusBridgeError('runtime status binding 字段无效');
  }
  assertElementId(record.statusElementId, 'statusElementId');
  assertElementId(record.imageElementId, 'imageElementId');
  assertImageKey(record.activeImageKey, 'activeImageKey');
  assertImageKey(record.inactiveImageKey, 'inactiveImageKey');
  return {
    ...record as CardRuntimeStatusBindingRecord,
    labels: normalizeLabels(record.labels),
  };
}

export class CardRuntimeStatusBridge {
  private readonly dir: string;
  private readonly pendingStatuses = new Map<string, ScreenStatus>();
  private readonly publishRuns = new Map<string, Promise<boolean>>();

  constructor(
    dataDir: string,
    private readonly streams: CardStreamStore,
    private readonly lark: CardRuntimeStatusLarkAdapter,
  ) {
    this.dir = join(dataDir, 'card-runtime-status');
  }

  async bind(input: CardRuntimeStatusBindingInput): Promise<void> {
    assertElementId(input.statusElementId, 'statusElementId');
    assertElementId(input.imageElementId, 'imageElementId');
    assertImageKey(input.activeImageKey, 'activeImageKey');
    assertImageKey(input.inactiveImageKey, 'inactiveImageKey');
    const stream = await this.streams.inspect(input.streamId, input.authority);
    if (stream.status !== 'open') throw new CardRuntimeStatusBridgeError('只能绑定仍在打开的卡片流');
    const path = this.pathFor(input.authority.larkAppId, input.authority.sessionId);
    this.ensureDirectory();
    await withFileLock(path, async () => {
      const now = new Date().toISOString();
      const record: CardRuntimeStatusBindingRecord = {
        schemaVersion: SCHEMA_VERSION,
        ...input,
        labels: normalizeLabels(input.labels),
        createdAt: now,
        updatedAt: now,
      };
      this.write(path, record);
    });
  }

  async reanchor(
    previousStreamId: string,
    currentStreamId: string,
    authority: CardStreamAuthority,
  ): Promise<boolean> {
    const path = this.pathFor(authority.larkAppId, authority.sessionId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      if (!existsSync(path)) return false;
      const record = this.read(path);
      this.assertAuthority(record, authority);
      if (record.streamId !== previousStreamId) {
        throw new CardRuntimeStatusBridgeError('runtime status binding 与旧 streamId 不匹配');
      }
      const current = await this.streams.inspect(currentStreamId, authority);
      if (current.status !== 'open') {
        throw new CardRuntimeStatusBridgeError('只能迁移到仍在打开的卡片流');
      }
      this.write(path, {
        ...record,
        streamId: currentStreamId,
        lastStatus: undefined,
        lastImageKey: undefined,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async unbind(streamId: string, authority: CardStreamAuthority): Promise<boolean> {
    const path = this.pathFor(authority.larkAppId, authority.sessionId);
    this.ensureDirectory();
    return withFileLock(path, async () => {
      if (!existsSync(path)) return false;
      const record = this.read(path);
      this.assertAuthority(record, authority);
      if (record.streamId !== streamId) throw new CardRuntimeStatusBridgeError('runtime status binding 与 streamId 不匹配');
      try {
        const stream = await this.streams.inspect(record.streamId, record.authority);
        if (stream.status === 'open' && record.lastImageKey !== record.inactiveImageKey) {
          await this.streams.write(record.streamId, record.authority, lease => this.lark.patchElement({
            ...lease,
            larkAppId: record.authority.larkAppId,
            elementId: record.imageElementId,
            partialElement: { img_key: record.inactiveImageKey },
          }));
        }
      } finally {
        // Provider-side streaming can time out before Botmux's local store sees
        // a finish. Always remove this binding after authority is verified so a
        // dead stream cannot keep receiving daemon status publishes forever.
        if (existsSync(path)) unlinkSync(path);
      }
      return true;
    });
  }

  async publish(input: { sessionId: string; larkAppId: string; status: ScreenStatus }): Promise<boolean> {
    const key = `${input.larkAppId}\0${input.sessionId}`;
    this.pendingStatuses.set(key, input.status);
    const running = this.publishRuns.get(key);
    if (running) return running;
    const run = this.drainPublishes(key, input.larkAppId, input.sessionId);
    this.publishRuns.set(key, run);
    try { return await run; } finally { this.publishRuns.delete(key); }
  }

  private async drainPublishes(key: string, larkAppId: string, sessionId: string): Promise<boolean> {
    let changed = false;
    while (this.pendingStatuses.has(key)) {
      const status = this.pendingStatuses.get(key)!;
      this.pendingStatuses.delete(key);
      changed = await this.publishOnce({ sessionId, larkAppId, status }) || changed;
    }
    return changed;
  }

  private async publishOnce(input: { sessionId: string; larkAppId: string; status: ScreenStatus }): Promise<boolean> {
    const path = this.pathFor(input.larkAppId, input.sessionId);
    if (!existsSync(path)) return false;
    this.ensureDirectory();
    return withFileLock(path, async () => {
      if (!existsSync(path)) return false;
      const record = this.read(path);
      if (record.authority.sessionId !== input.sessionId || record.authority.larkAppId !== input.larkAppId) {
        throw new CardRuntimeStatusBridgeError('runtime status binding authority 不匹配');
      }
      const stream = await this.streams.inspect(record.streamId, record.authority);
      if (stream.status !== 'open') {
        unlinkSync(path);
        return false;
      }
      const desiredImageKey = activeStatus(input.status) ? record.activeImageKey : record.inactiveImageKey;
      if (record.lastStatus === input.status && record.lastImageKey === desiredImageKey) return false;

      const content = `<text_tag color='${STATUS_COLOR[input.status]}'>${escapeCardText(record.labels[input.status])}</text_tag>`;
      await this.streams.write(record.streamId, record.authority, lease => this.lark.updateContent({
        ...lease,
        larkAppId: record.authority.larkAppId,
        elementId: record.statusElementId,
        content,
      }));
      if (record.lastImageKey !== desiredImageKey) {
        await this.streams.write(record.streamId, record.authority, lease => this.lark.patchElement({
          ...lease,
          larkAppId: record.authority.larkAppId,
          elementId: record.imageElementId,
          partialElement: { img_key: desiredImageKey },
        }));
      }

      this.write(path, {
        ...record,
        lastStatus: input.status,
        lastImageKey: desiredImageKey,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  private ensureDirectory(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CardRuntimeStatusBridgeError('card-runtime-status 目录不安全');
    }
  }

  private pathFor(larkAppId: string, sessionId: string): string {
    const digest = createHash('sha256').update(`${larkAppId}\0${sessionId}`).digest('hex').slice(0, 32);
    return join(this.dir, `${digest}.json`);
  }

  private read(path: string): CardRuntimeStatusBindingRecord {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CardRuntimeStatusBridgeError('runtime status binding 文件不安全');
    return parseRecord(readFileSync(path, 'utf-8'));
  }

  private write(path: string, record: CardRuntimeStatusBindingRecord): void {
    atomicWriteFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600, followTargetSymlink: false });
  }

  private assertAuthority(record: CardRuntimeStatusBindingRecord, authority: CardStreamAuthority): void {
    if (
      record.authority.sessionId !== authority.sessionId
      || record.authority.larkAppId !== authority.larkAppId
      || record.authority.chatId !== authority.chatId
    ) {
      throw new CardRuntimeStatusBridgeError('当前会话无权操作 runtime status binding');
    }
  }
}
