/**
 * Claude Code 权限确认的「CLI 自行了结」观察器。
 *
 * PermissionRequest hook 挂着等飞书卡片时，Claude Code 可能不经 hook 就结束这次确认：
 * 内置安全检查的确认框超时自动拒绝、有人在终端里选了 Yes。这两种情况 hook 子进程既不被
 * 杀也收不到信号（实测 2.1.319），只会被丢下。唯一确定的痕迹是 transcript 里这次工具调用的
 * tool_result 条目：它带 `permissionDecision`（decision / source / reasonType）或
 * `toolDenialKind`，写明了是谁、怎么裁决的。
 *
 * hook payload 不带 tool_use_id，只能按 tool_name + tool_input 在 transcript 尾部找创建于 hook 启动之前、
 * 尚未出结果（或 hook 启动后才出结果）的 tool_use。找不到、不唯一、或结果的 promptId 对不上时不做任何判断，
 * hook 照旧只等卡片。子代理的调用记在别的文件里，主 transcript 里同参数的调用只可能是别人的，所以不监听。
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { CliPermissionOutcome } from '../ask-types.js';
import type { PermissionOutcomeWatcher } from './types.js';

/** The pending tool_use is appended right before the hook starts, so the tail
 *  covers it without reading a long session's whole history. */
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;
/** A tool_use is created before its permission check spawns the hook; this only absorbs clock rounding. */
const TOOL_USE_CLOCK_SLACK_MS = 1000;

interface WatchTarget {
  transcriptPath: string;
  toolName: string;
  toolInput: unknown;
  promptId?: string;
}

interface Candidate {
  toolUseId: string;
  /** Its tool_result, kept only when written after this hook process started. */
  result?: Record<string, unknown>;
}

export function createClaudePermissionWatcher(payload: unknown): PermissionOutcomeWatcher | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.transcript_path !== 'string' || !p.transcript_path) return null;
  if (typeof p.tool_name !== 'string' || !p.tool_name) return null;
  if (!p.tool_input || typeof p.tool_input !== 'object') return null;
  if (typeof p.agent_id === 'string' && p.agent_id) return null;
  return new TranscriptPermissionWatcher({
    transcriptPath: p.transcript_path,
    toolName: p.tool_name,
    toolInput: p.tool_input,
    promptId: typeof p.prompt_id === 'string' && p.prompt_id ? p.prompt_id : undefined,
  });
}

class TranscriptPermissionWatcher implements PermissionOutcomeWatcher {
  private offset = -1;
  private carry: Buffer = Buffer.alloc(0);
  /** Matching calls in the initial tail with no tool_result yet, or one written after this hook started. */
  private pending: Candidate[] = [];
  private target: Candidate | null = null;
  /** Set once the initial tail has been read; a matching call flushed after it may still be this one. */
  private primed = false;
  private disabled = false;

  constructor(private readonly watch: WatchTarget, private readonly startedAtMs = performance.timeOrigin) {}

  scan(): CliPermissionOutcome | null {
    if (this.disabled) return null;
    let fd: number;
    try { fd = openSync(this.watch.transcriptPath, 'r'); } catch { return null; }
    try {
      const size = fstatSync(fd).size;
      let dropPartialHead = false;
      if (this.offset < 0) {
        this.offset = Math.max(0, size - INITIAL_TAIL_BYTES);
        dropPartialHead = this.offset > 0;
      }
      if (size < this.offset) {
        this.disabled = true;
        return null;
      }
      let budget = MAX_SCAN_BYTES;
      while (this.offset < size && budget > 0) {
        const length = Math.min(READ_CHUNK_BYTES, size - this.offset, budget);
        const chunk = Buffer.allocUnsafe(length);
        const read = readSync(fd, chunk, 0, length, this.offset);
        if (read <= 0) break;
        this.offset += read;
        budget -= read;
        const data = this.carry.length ? Buffer.concat([this.carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        let start = 0;
        if (dropPartialHead) {
          const firstNewline = data.indexOf(NEWLINE);
          if (firstNewline < 0) {
            this.carry = Buffer.alloc(0);
            continue;
          }
          start = firstNewline + 1;
          dropPartialHead = false;
        }
        for (let nl = data.indexOf(NEWLINE, start); nl >= 0; nl = data.indexOf(NEWLINE, start)) {
          const outcome = this.consume(data.subarray(start, nl));
          start = nl + 1;
          if (outcome) {
            this.disabled = true;
            return outcome;
          }
          if (this.disabled) return null;
        }
        this.carry = Buffer.from(data.subarray(start));
      }
      if (!this.primed) {
        this.primed = true;
        const outcome = this.pickTarget();
        if (outcome) {
          this.disabled = true;
          return outcome;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** The current call is the only matching tool_use in the initial tail that has no result, or
   *  whose result was written after this hook started (the terminal answered before the first
   *  scan). Two or more such calls can't be told apart. */
  private pickTarget(): CliPermissionOutcome | null {
    if (this.pending.length === 0) return null;
    if (this.pending.length > 1) {
      this.disabled = true;
      return null;
    }
    this.target = this.pending[0]!;
    return this.target.result ? this.verdict(this.target.result) : null;
  }

  private verdict(entry: Record<string, unknown>): CliPermissionOutcome | null {
    if (this.watch.promptId && typeof entry.promptId === 'string' && entry.promptId !== this.watch.promptId) {
      this.disabled = true;
      return null;
    }
    return classifyToolResult(entry);
  }

  private createdBeforeHook(entry: Record<string, unknown>): boolean {
    const createdAt = Date.parse(String(entry.timestamp));
    return Number.isFinite(createdAt) && createdAt <= this.startedAtMs + TOOL_USE_CLOCK_SLACK_MS;
  }

  private consume(line: Buffer): CliPermissionOutcome | null {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return null;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line.toString('utf8')) as Record<string, unknown>; } catch { return null; }
    if (entry.isSidechain === true) return null;
    const message = entry.message as { content?: unknown } | undefined;
    if (!message || !Array.isArray(message.content)) return null;
    for (const block of message.content as Array<Record<string, unknown> | null>) {
      if (!block || typeof block !== 'object') continue;
      if (entry.type === 'assistant' && block.type === 'tool_use') {
        if (block.name !== this.watch.toolName || typeof block.id !== 'string') continue;
        if (!isDeepStrictEqual(block.input, this.watch.toolInput) || !this.createdBeforeHook(entry)) continue;
        if (this.target?.toolUseId === block.id || this.pending.some(c => c.toolUseId === block.id)) continue;
        const candidate: Candidate = { toolUseId: block.id };
        if (!this.primed) {
          this.pending.push(candidate);
        } else if (!this.target) {
          this.target = candidate;
        } else {
          this.disabled = true;
          return null;
        }
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        if (this.target?.toolUseId === block.tool_use_id) return this.verdict(entry);
        const early = this.primed ? undefined : this.pending.find(c => c.toolUseId === block.tool_use_id);
        if (early && Date.parse(String(entry.timestamp)) >= this.startedAtMs) early.result = entry;
        else this.pending = this.pending.filter(c => c.toolUseId !== block.tool_use_id);
      }
    }
    return null;
  }
}

function classifyToolResult(entry: Record<string, unknown>): CliPermissionOutcome {
  const decision = entry.permissionDecision as Record<string, unknown> | undefined;
  if (decision && typeof decision === 'object') {
    const source = typeof decision.source === 'string' ? decision.source : '';
    if (decision.decision === 'accept') return source.startsWith('user') ? 'terminal_allowed' : 'allowed_elsewhere';
    if (decision.decision === 'reject') {
      return decision.reasonType === 'safetyCheck' && source === 'config' ? 'cli_auto_denied' : 'denied_elsewhere';
    }
  }
  if (entry.toolDenialKind === 'user-rejected') return 'terminal_rejected';
  return 'resolved_elsewhere';
}
