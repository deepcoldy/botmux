import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { CodexClientSurface } from './types.js';
import { isInternalCodexPrompt, isInternalCodexSessionMeta } from './internal-turn.js';

const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function cleanSingleLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : normalized;
}

export interface CodexTurnContext {
  clientSurface?: CodexClientSurface;
  prompt?: string;
  lastAssistantMessage?: string;
  internal?: boolean;
}

function detectSessionMeta(
  row: any,
  sessionId: unknown,
): Pick<CodexTurnContext, 'clientSurface' | 'internal'> {
  if (row?.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') return {};
  const payload = row.payload as Record<string, unknown>;
  const internal = isInternalCodexSessionMeta(payload);
  if (typeof sessionId === 'string' && sessionId) {
    let matchedIdentity = false;
    for (const key of ['session_id', 'id']) {
      const value = payload[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value !== sessionId) return internal ? { internal: true } : {};
      matchedIdentity = true;
    }
    if (!matchedIdentity) return internal ? { internal: true } : {};
  }
  const clientSurface = payload.source === 'vscode' && payload.originator === 'Codex Desktop'
    ? 'codex-app'
    : payload.source === 'exec' || payload.source === 'cli'
      ? 'codex-cli'
      : undefined;
  return {
    ...(clientSurface ? { clientSurface } : {}),
    ...(internal ? { internal: true } : {}),
  };
}

/** 从 rollout 尾部提取指定 turn 的用户问题和最终回复兜底。 */
export function parseCodexTurnContext(
  text: string,
  turnId: unknown,
  sessionId?: unknown,
): CodexTurnContext {
  let inTargetTurn = false;
  let inspectSessionMeta = true;
  let clientSurface: CodexClientSurface | undefined;
  let internal = false;
  let prompt: string | undefined;
  let lastAssistantMessage: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      inspectSessionMeta = false;
      continue;
    }
    if (inspectSessionMeta) {
      const meta = detectSessionMeta(row, sessionId);
      clientSurface = meta.clientSurface;
      internal = meta.internal === true;
      inspectSessionMeta = false;
    }
    if (row?.type !== 'event_msg' || !row.payload || typeof row.payload !== 'object') continue;
    const payload = row.payload as Record<string, unknown>;
    if (payload.type === 'task_started') {
      inTargetTurn = payload.turn_id === turnId;
      if (inTargetTurn) {
        prompt = undefined;
        lastAssistantMessage = undefined;
      }
      continue;
    }
    if (!inTargetTurn) continue;
    if (payload.type === 'user_message') {
      if (isInternalCodexPrompt(payload.message)) internal = true;
      prompt = cleanSingleLine(payload.message, 220);
      continue;
    }
    if (payload.type === 'task_complete' && payload.turn_id === turnId) {
      lastAssistantMessage = typeof payload.last_agent_message === 'string'
        ? payload.last_agent_message
        : undefined;
      break;
    }
  }
  return {
    ...(clientSurface ? { clientSurface } : {}),
    ...(prompt ? { prompt } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(internal ? { internal: true } : {}),
  };
}

/** 有界读取 transcript 头部来源和尾部当前回合；失败时由调用方退化到 Hook 原生字段。 */
export function readCodexTurnContext(
  transcriptPath: unknown,
  turnId: unknown,
  sessionId?: unknown,
): CodexTurnContext {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return {};
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return {};
    let headContext: CodexTurnContext = {};
    if (stat.size > MAX_TRANSCRIPT_TAIL_BYTES) {
      const headLength = Math.min(stat.size, MAX_TRANSCRIPT_HEAD_BYTES);
      const headBuffer = Buffer.allocUnsafe(headLength);
      const headBytesRead = readSync(fd, headBuffer, 0, headLength, 0);
      const headText = headBuffer.subarray(0, headBytesRead).toString('utf8');
      const firstNewline = headText.indexOf('\n');
      if (firstNewline >= 0) {
        headContext = parseCodexTurnContext(headText.slice(0, firstNewline + 1), turnId, sessionId);
      }
    }

    const length = Math.min(stat.size, MAX_TRANSCRIPT_TAIL_BYTES);
    const start = stat.size - length;
    let startsAtRecordBoundary = start === 0;
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      startsAtRecordBoundary = readSync(fd, previousByte, 0, 1, start - 1) === 1
        && previousByte[0] === 0x0a;
    }
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (!startsAtRecordBoundary) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const tailContext = parseCodexTurnContext(text, turnId, sessionId);
    const clientSurface = stat.size > MAX_TRANSCRIPT_TAIL_BYTES
      ? headContext.clientSurface
      : tailContext.clientSurface;
    return {
      ...(clientSurface ? { clientSurface } : {}),
      ...(tailContext.prompt ? { prompt: tailContext.prompt } : {}),
      ...(tailContext.lastAssistantMessage ? { lastAssistantMessage: tailContext.lastAssistantMessage } : {}),
      ...((headContext.internal || tailContext.internal) ? { internal: true } : {}),
    };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 文件已关闭时无需额外处理。
      }
    }
  }
}
