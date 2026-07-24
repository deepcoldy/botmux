import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CodexClientSurface,
  CodexConversationKind,
  CodexTaskCompletedEvent,
  CodexTaskStatus,
} from './types.js';

export const CODEX_NOTIFIER_PLUGIN_ID = 'codex-watch';
export const MAX_CODEX_NOTIFIER_EVENT_BYTES = 64 * 1024;

/** 飞书消息幂等键基于完整事件 ID，避免只截断长 ID 前缀造成碰撞。 */
export function codexNotifierMessageUuid(eventId: string): string {
  return `cw_${createHash('sha256').update(eventId).digest('hex').slice(0, 47)}`;
}

export type CodexNotifierEventValidationCode =
  | 'invalid_plugin'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_event';

/** 插件事件边界的可分类校验错误，供 HTTP 层映射 4xx 响应。 */
export class CodexNotifierEventValidationError extends Error {
  constructor(
    public readonly code: CodexNotifierEventValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexNotifierEventValidationError';
  }
}

const requiredText = (max: number) => z.string().trim().min(1).max(max);

const CodexTaskCompletedEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: requiredText(128),
  type: z.literal('task.completed'),
  source: z.literal('codex-desktop'),
  clientSurface: z.enum(['codex-app', 'codex-cli']).optional(),
  conversationKind: z.literal('side').optional(),
  threadId: requiredText(256),
  nativeTurnId: requiredText(256),
  status: z.enum(['completed', 'failed', 'cancelled']),
  title: requiredText(300).optional(),
  cwd: requiredText(4096),
  completedAt: z.string().datetime({ offset: true }),
  finalPreview: requiredText(6500).optional(),
}).strict();

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLengthOfObject(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (cause) {
    throw new CodexNotifierEventValidationError('invalid_event', 'event payload is not serializable', { cause });
  }
}

function decodePayload(input: unknown, maxBytes: number): unknown {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    if (byteLengthOfObject(input) > maxBytes) {
      throw new CodexNotifierEventValidationError('payload_too_large', `event payload exceeds ${maxBytes} bytes`);
    }
    return input;
  }

  const bytes = Buffer.isBuffer(input) ? input.byteLength : Buffer.byteLength(input, 'utf8');
  if (bytes > maxBytes) {
    throw new CodexNotifierEventValidationError('payload_too_large', `event payload exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input);
  } catch (cause) {
    throw new CodexNotifierEventValidationError('invalid_json', 'event payload is not valid JSON', { cause });
  }
}

/**
 * 校验 Codex 完成事件。严格拒绝额外字段、非普通对象和超大输入，避免跨进程边界
 * 成为原型污染或无界内存入口。
 */
export function parseCodexNotifierEvent(
  input: unknown,
  maxBytes = MAX_CODEX_NOTIFIER_EVENT_BYTES,
): CodexTaskCompletedEvent {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new CodexNotifierEventValidationError('invalid_event', 'maxBytes must be a positive safe integer');
  }

  const decoded = decodePayload(input, maxBytes);
  if (!plainObject(decoded)) {
    throw new CodexNotifierEventValidationError('invalid_event', 'event payload must be a plain object');
  }
  // 这些键即使只是普通 JSON 自有属性也没有业务含义，显式拒绝可让边界策略更清晰。
  if (['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(decoded, key))) {
    throw new CodexNotifierEventValidationError('invalid_event', 'event payload contains a forbidden property');
  }

  const parsed = CodexTaskCompletedEventSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CodexNotifierEventValidationError(
      'invalid_event',
      `invalid codex completion event: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      { cause: parsed.error },
    );
  }
  const expectedId = codexNotifierEventId({
    source: parsed.data.source,
    threadId: parsed.data.threadId,
    nativeTurnId: parsed.data.nativeTurnId,
    status: parsed.data.status,
  });
  if (parsed.data.eventId !== expectedId) {
    throw new CodexNotifierEventValidationError('invalid_event', 'codex completion event id mismatch');
  }
  return parsed.data;
}

/** 兼容一个迁移周期的旧插件入口；内建链路直接调用 parseCodexNotifierEvent。 */
export function parseCodexNotifierPluginEvent(
  pluginId: string,
  input: unknown,
  maxBytes = MAX_CODEX_NOTIFIER_EVENT_BYTES,
): CodexTaskCompletedEvent {
  if (pluginId !== CODEX_NOTIFIER_PLUGIN_ID) {
    throw new CodexNotifierEventValidationError('invalid_plugin', `unsupported plugin event source: ${pluginId}`);
  }
  return parseCodexNotifierEvent(input, maxBytes);
}

function requiredHookText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexNotifierEventValidationError('invalid_event', `hook payload is missing ${name}`);
  }
  return value.trim();
}

function optionalSingleLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

function optionalMultiline(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

/** 事件 ID 只依赖 Codex 原生任务身份，Hook 重试不会生成第二条通知。 */
export function codexNotifierEventId(input: {
  source: CodexTaskCompletedEvent['source'];
  threadId: string;
  nativeTurnId: string;
  status: CodexTaskCompletedEvent['status'];
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.source, input.threadId, input.nativeTurnId, input.status]))
    .digest('hex');
}

/** 把 Codex Stop Hook 的稳定字段转换成内建完成事件。 */
export function createCodexNotifierEvent(
  payload: Record<string, unknown>,
  options: {
    clientSurface?: CodexClientSurface;
    conversationKind?: CodexConversationKind;
    title?: string;
    finalPreview?: string;
    completedAt?: string;
  } = {},
): CodexTaskCompletedEvent {
  if (payload.hook_event_name !== 'Stop') {
    throw new CodexNotifierEventValidationError('invalid_event', 'unsupported Codex hook event');
  }
  const threadId = requiredHookText(payload.session_id, 'session_id');
  const nativeTurnId = requiredHookText(payload.turn_id, 'turn_id');
  const cwd = requiredHookText(payload.cwd, 'cwd');
  return createCodexNotifierCompletionEvent({
    threadId,
    nativeTurnId,
    status: 'completed',
    cwd,
    ...options,
    finalPreview: options.finalPreview
      ?? (typeof payload.last_assistant_message === 'string'
        ? payload.last_assistant_message
        : undefined),
  });
}

/** 从 Hook 或 Codex App IPC 的终态构造同一种可靠完成事件。 */
export function createCodexNotifierCompletionEvent(input: {
  threadId: string;
  nativeTurnId: string;
  status: CodexTaskStatus;
  cwd: string;
  clientSurface?: CodexClientSurface;
  conversationKind?: CodexConversationKind;
  title?: string;
  finalPreview?: string;
  completedAt?: string;
}): CodexTaskCompletedEvent {
  const threadId = requiredHookText(input.threadId, 'threadId');
  const nativeTurnId = requiredHookText(input.nativeTurnId, 'nativeTurnId');
  const cwd = requiredHookText(input.cwd, 'cwd');
  const completedAt = input.completedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(completedAt))) {
    throw new CodexNotifierEventValidationError('invalid_event', 'completedAt must be an ISO timestamp');
  }
  const identity = {
    source: 'codex-desktop' as const,
    threadId,
    nativeTurnId,
    status: input.status,
  };
  const title = optionalSingleLine(input.title, 300);
  const finalPreview = optionalMultiline(input.finalPreview, 6500);
  return parseCodexNotifierEvent({
    schemaVersion: 1,
    eventId: codexNotifierEventId(identity),
    type: 'task.completed',
    ...identity,
    ...(input.clientSurface ? { clientSurface: input.clientSurface } : {}),
    ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
    cwd,
    completedAt,
    ...(title ? { title } : {}),
    ...(finalPreview ? { finalPreview } : {}),
  });
}
