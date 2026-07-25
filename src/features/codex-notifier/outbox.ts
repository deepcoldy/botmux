import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { parseCodexNotifierEvent } from './event.js';
import { codexNotifierDeadLetterDir, codexNotifierOutboxDir } from './paths.js';
import type {
  CodexClientSurface,
  CodexConversationKind,
  CodexTaskCompletedEvent,
} from './types.js';

const EVENT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const OUTBOX_ITEM_KEYS = new Set([
  'schemaVersion',
  'targetBotAppId',
  'clientSurface',
  'conversationKind',
  'event',
]);

class CodexNotifierOutboxReadError extends Error {
  constructor(
    message: string,
    readonly fileDigest: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'CodexNotifierOutboxReadError';
  }
}

type PersistedCodexNotifierEvent = Omit<
  CodexTaskCompletedEvent,
  'clientSurface' | 'conversationKind'
>;

export interface CodexNotifierOutboxItem {
  schemaVersion: 1;
  targetBotAppId: string;
  clientSurface?: CodexClientSurface;
  conversationKind?: CodexConversationKind;
  event: PersistedCodexNotifierEvent;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseCodexNotifierOutboxItem(value: unknown): CodexNotifierOutboxItem {
  if (!plainObject(value)
    || Object.keys(value).some(key => !OUTBOX_ITEM_KEYS.has(key))
    || ['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(value, key))) {
    throw new Error('codex_notifier_outbox_invalid');
  }
  const item = value;
  if (item.schemaVersion !== 1) throw new Error('codex_notifier_outbox_schema_unsupported');
  if (typeof item.targetBotAppId !== 'string' || !item.targetBotAppId.trim() || item.targetBotAppId.length > 256) {
    throw new Error('codex_notifier_outbox_target_invalid');
  }
  if (
    item.clientSurface !== undefined
    && item.clientSurface !== 'codex-app'
    && item.clientSurface !== 'codex-cli'
  ) {
    throw new Error('codex_notifier_outbox_client_surface_invalid');
  }
  if (item.conversationKind !== undefined && item.conversationKind !== 'side') {
    throw new Error('codex_notifier_outbox_conversation_kind_invalid');
  }
  const parsedEvent = parseCodexNotifierEvent(item.event);
  if (
    item.clientSurface !== undefined
    && parsedEvent.clientSurface !== undefined
    && item.clientSurface !== parsedEvent.clientSurface
  ) {
    throw new Error('codex_notifier_outbox_client_surface_conflict');
  }
  if (
    item.conversationKind !== undefined
    && parsedEvent.conversationKind !== undefined
    && item.conversationKind !== parsedEvent.conversationKind
  ) {
    throw new Error('codex_notifier_outbox_conversation_kind_conflict');
  }
  const clientSurface = item.clientSurface ?? parsedEvent.clientSurface;
  const conversationKind = item.conversationKind ?? parsedEvent.conversationKind;
  const {
    clientSurface: _legacyClientSurface,
    conversationKind: _legacyConversationKind,
    ...event
  } = parsedEvent;
  return {
    schemaVersion: 1,
    targetBotAppId: item.targetBotAppId.trim(),
    ...(clientSurface ? { clientSurface } : {}),
    ...(conversationKind ? { conversationKind } : {}),
    event,
  };
}

/** 把兼容存储字段还原到 daemon 内部事件；旧 worker 会忽略该字段但不会丢通知。 */
export function materializeCodexNotifierOutboxEvent(
  item: CodexNotifierOutboxItem,
): CodexTaskCompletedEvent {
  return parseCodexNotifierEvent({
    ...item.event,
    ...(item.clientSurface ? { clientSurface: item.clientSurface } : {}),
    ...(item.conversationKind ? { conversationKind: item.conversationKind } : {}),
  });
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 先完整落盘临时文件，再通过硬链接以排他方式发布目标文件。
 * 同一 eventId 的并发写入只有第一个能创建目标，后续写入不会覆盖已冻结的 Bot。
 */
function publishCodexNotifierOutboxItem(
  directory: string,
  path: string,
  content: string,
): boolean {
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.pending`);
  atomicWriteFileSync(temporaryPath, content, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
  try {
    linkSync(temporaryPath, path);
    fsyncDirectory(directory);
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 发布结果已经确定，临时文件清理失败不能把可靠入队误报为失败。
    }
  }
}

/** Hook 只负责可靠入队，不等待 BotMux daemon 或飞书网络。 */
export function enqueueCodexNotifierEvent(
  dataDir: string,
  targetBotAppId: string,
  event: CodexTaskCompletedEvent,
): string {
  const item = parseCodexNotifierOutboxItem({
    schemaVersion: 1,
    targetBotAppId,
    ...(event.clientSurface ? { clientSurface: event.clientSurface } : {}),
    ...(event.conversationKind ? { conversationKind: event.conversationKind } : {}),
    event,
  });
  const directory = codexNotifierOutboxDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${item.event.eventId}.json`);

  while (true) {
    try {
      readCodexNotifierOutboxItem(path);
      return path;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        quarantineCodexNotifierOutboxItem(dataDir, path, error);
      }
    }
    if (publishCodexNotifierOutboxItem(directory, path, `${JSON.stringify(item, null, 2)}\n`)) {
      return path;
    }
  }
}

export function listCodexNotifierOutbox(dataDir: string): Array<{ name: string; path: string; mtimeMs: number }> {
  const directory = codexNotifierOutboxDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => EVENT_FILE_PATTERN.test(name))
    .flatMap(name => {
      const path = join(directory, name);
      try {
        return [{ name, path, mtimeMs: statSync(path).mtimeMs }];
      } catch (error: any) {
        // producer 或 worker 可能在 readdir 后立即发布、删除或隔离同一文件。
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

export function readCodexNotifierOutboxItem(path: string): CodexNotifierOutboxItem {
  const content = readFileSync(path, 'utf8');
  try {
    return parseCodexNotifierOutboxItem(JSON.parse(content));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CodexNotifierOutboxReadError(message, fileDigest(content), cause);
  }
}

export function removeCodexNotifierOutboxItem(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** 隔离损坏队列文件，让同一稳定 eventId 可以重新入队且不阻塞后续事件。 */
export function quarantineCodexNotifierOutboxItem(
  dataDir: string,
  path: string,
  readError?: unknown,
): string | null {
  const directory = codexNotifierDeadLetterDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const expectedDigest = readError instanceof CodexNotifierOutboxReadError
    ? readError.fileDigest
    : undefined;
  if (expectedDigest) {
    try {
      if (fileDigest(readFileSync(path)) !== expectedDigest) return null;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  const destination = join(
    directory,
    `${basename(path, '.json')}.${Date.now()}.${randomUUID()}.json`,
  );
  try {
    renameSync(path, destination);
    if (expectedDigest && fileDigest(readFileSync(destination)) !== expectedDigest) {
      // 校验到隔离之间若文件被替换，恢复更早出现的队列项，避免误隔离有效通知。
      renameSync(destination, path);
      fsyncDirectory(codexNotifierOutboxDir(dataDir));
      return null;
    }
    return destination;
  } catch (error: any) {
    // 另一个 producer/worker 已先处理同一文件时，当前调用无需重复隔离。
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function fileDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
