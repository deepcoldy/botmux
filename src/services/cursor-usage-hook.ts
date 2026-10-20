import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const isCursorChatId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface CursorTurnUsage {
  v: 1;
  conversationId: string;
  generationId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
}

/** Native stop input_tokens INCLUDES both cache buckets. Normalize once here;
 * the common cost calculator expects mutually exclusive input/cache counters. */
export function parseCursorUsageHook(payload: unknown): CursorTurnUsage | null {
  if (!record(payload) || payload.hook_event_name !== 'stop'
    || !['completed', 'aborted', 'error'].includes(String(payload.status))
    || !isCursorChatId(payload.conversation_id) || !isCursorChatId(payload.generation_id)) return null;
  const { input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write } = payload;
  if (!integer(input) || !integer(output) || !integer(read) || !integer(write)
    || !integer(read + write) || read + write > input) return null;
  const model = typeof payload.model === 'string' && payload.model.length <= 512
    && !/[\x00-\x1f]/.test(payload.model) ? payload.model.trim() : '';
  return { v: 1, conversationId: payload.conversation_id, generationId: payload.generation_id,
    inputTokens: input - read - write, outputTokens: output, cacheReadTokens: read,
    cacheCreateTokens: write, model: model.trim() };
}

export function parseCursorTurnUsage(value: unknown): CursorTurnUsage | null {
  if (!record(value) || value.v !== 1) return null;
  const fields = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheCreateTokens];
  if (!fields.every(integer)) return null;
  return parseCursorUsageHook({ hook_event_name: 'stop', status: 'completed',
    conversation_id: value.conversationId, generation_id: value.generationId, model: value.model,
    input_tokens: (value.inputTokens as number) + (value.cacheReadTokens as number) + (value.cacheCreateTokens as number),
    output_tokens: value.outputTokens, cache_read_tokens: value.cacheReadTokens, cache_write_tokens: value.cacheCreateTokens });
}

export function cursorUsageJournalPath(dataDir: string, sessionId: string): string | null {
  if (!isAbsolute(dataDir) || !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) return null;
  return join(dataDir, 'cursor-usage', `${sessionId}.jsonl`);
}

/** Pre-create before bwrap binds the single session file. Never truncate: the
 * journal must survive worker/daemon restarts and native --resume. */
export function prepareCursorUsageJournal(dataDir: string, sessionId: string): void {
  const path = cursorUsageJournalPath(dataDir, sessionId);
  if (!path) return;
  if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { if (!fstatSync(fd).isFile()) throw new Error('Usage journal is not a regular file'); }
  finally { closeSync(fd); }
}

export function appendCursorUsage(dataDir: string, sessionId: string, payload: unknown): void {
  const value = parseCursorUsageHook(payload);
  const path = cursorUsageJournalPath(dataDir, sessionId);
  if (!value || !path) return;
  prepareCursorUsageJournal(dataDir, sessionId);
  const fd = openSync(path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fstatSync(fd).isFile()) appendFileSync(fd, JSON.stringify(value) + '\n');
  } finally { closeSync(fd); }
}

/** Quiet, bounded and fail-open: missing env, unsupported CLI payload or I/O
 * failure cannot block a Cursor turn. Never persist prompt text or credentials. */
export async function runCursorUsageHook(input: Readable = process.stdin, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.SESSION_DATA_DIR || !env.BOTMUX_SESSION_ID
    || !cursorUsageJournalPath(env.SESSION_DATA_DIR, env.BOTMUX_SESSION_ID)) return;
  const timer = setTimeout(() => input.destroy(), 2000);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) { input.destroy(); return; }
      chunks.push(buffer);
    }
    appendCursorUsage(env.SESSION_DATA_DIR, env.BOTMUX_SESSION_ID, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { /* telemetry is optional */ }
  finally { clearTimeout(timer); }
}

/** Cursor 2026.10.14 gates stop on user/project hooks before consulting plugin
 * hooks. Install one env-gated user hook; preserve all unrelated configuration.
 * A plugin-only hook is loaded but NEVER called on an otherwise clean setup. */
export function installCursorUsageHook(path: string, command: string): void {
  let config: Record<string, unknown> = { version: 1 };
  if (existsSync(path)) {
    if (statSync(path).size > 1024 * 1024) throw new Error('Cursor hooks configuration exceeds 1 MiB');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!record(parsed) || (parsed.version !== undefined && parsed.version !== 1)) throw new Error('Unsupported Cursor hooks configuration');
    config = parsed;
  }
  if (config.hooks !== undefined && !record(config.hooks)) throw new Error('Invalid Cursor hooks');
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  if (hooks.stop !== undefined && !Array.isArray(hooks.stop)) throw new Error('Invalid Cursor stop hooks');
  const stop = ((hooks.stop ?? []) as unknown[]).filter(hook => !record(hook)
    || typeof hook.command !== 'string' || !hook.command.endsWith(' __cursor-usage-v1'));
  stop.push({ command, timeout: 5, loop_limit: null });
  const content = JSON.stringify({ ...config, version: 1, hooks: { ...hooks, stop } }, null, 2) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
}
