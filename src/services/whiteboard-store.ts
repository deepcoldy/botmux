import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { readGlobalConfig } from '../global-config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type WhiteboardScope = 'chat' | 'project' | 'custom';

export interface WhiteboardMeta {
  id: string;
  title: string;
  scope: WhiteboardScope;
  larkAppId?: string;
  chatId?: string;
  workingDir?: string;
  createdFromSessionId?: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

interface WhiteboardIndex {
  version: 1;
  boards: Record<string, WhiteboardMeta>;
  bindings: Record<string, string>;
}

export interface WhiteboardBindingInput {
  larkAppId?: string;
  chatId?: string;
  workingDir?: string;
}

export interface EnsureWhiteboardInput extends WhiteboardBindingInput {
  sessionId?: string;
  title?: string;
}

export interface WhiteboardSummary extends WhiteboardMeta {
  path: string;
  preview: string;
  logCount: number;
}

const INDEX_VERSION = 1 as const;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 3;

function positiveEnvInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function whiteboardLogMaxBytes(): number {
  return positiveEnvInt('BOTMUX_WHITEBOARD_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES);
}

export function whiteboardEnabled(): boolean {
  return readGlobalConfig().whiteboard?.enabled === true;
}

export function whiteboardsRoot(): string {
  return join(config.session.dataDir, 'whiteboards');
}

function indexPath(): string {
  return join(whiteboardsRoot(), 'index.json');
}

function boardDir(id: string): string {
  return join(whiteboardsRoot(), id);
}

export function whiteboardBoardPath(id: string): string {
  return join(boardDir(id), 'board.md');
}

function metaPath(id: string): string {
  return join(boardDir(id), 'meta.json');
}

export function whiteboardLogPath(id: string): string {
  return join(boardDir(id), 'log.jsonl');
}

function ensureRoot(): void {
  mkdirSync(whiteboardsRoot(), { recursive: true });
}

function emptyIndex(): WhiteboardIndex {
  return { version: INDEX_VERSION, boards: {}, bindings: {} };
}

function readIndex(): WhiteboardIndex {
  const fp = indexPath();
  if (!existsSync(fp)) return emptyIndex();
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<WhiteboardIndex>;
    return {
      version: INDEX_VERSION,
      boards: parsed.boards && typeof parsed.boards === 'object' ? parsed.boards as Record<string, WhiteboardMeta> : {},
      bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings as Record<string, string> : {},
    };
  } catch {
    return emptyIndex();
  }
}

function writeIndex(index: WhiteboardIndex): void {
  ensureRoot();
  atomicWriteFileSync(indexPath(), JSON.stringify(index, null, 2) + '\n');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Locks reuse the cross-process file-lock primitive (utils/file-lock.ts): it
// writes the holder PID + acquire time and stale-breaks a lock whose holder
// PID is dead (atomic rename — exactly one waiter wins). This is the recovery
// the previous mkdir-based `withDirLock` lacked: a daemon killed by OOM/SIGKILL
// mid-section used to leave a `.index.lock` dir behind that blocked every
// subsequent caller for the full timeout. Each lock targets a real file path
// so the `.lock` sibling sits beside it (index.json.lock / board.md.lock /
// log.jsonl.lock) and is cleaned up in the holder's `finally`.
const INDEX_LOCK_TIMEOUT_MS = 5_000;
const BOARD_LOCK_TIMEOUT_MS = 10_000;
const LOG_LOCK_TIMEOUT_MS = 5_000;

function withIndexLock<T>(fn: () => T): T {
  ensureRoot();
  return withFileLockSync(indexPath(), fn, { maxWaitMs: INDEX_LOCK_TIMEOUT_MS });
}

function withLogLock<T>(id: string, fn: () => T): T {
  mkdirSync(boardDir(id), { recursive: true });
  return withFileLockSync(whiteboardLogPath(id), fn, { maxWaitMs: LOG_LOCK_TIMEOUT_MS });
}

// Per-board content lock serializes the read-modify-write of board.md so two
// agents updating the same shared board can't blind-overwrite each other (the
// board is a single current-state snapshot shared across the whole chat). The
// log already had a lock; the board content did not — last writer won silently
// and the loser's update vanished with no error and no history.
function withBoardLock<T>(id: string, fn: () => T): T {
  mkdirSync(boardDir(id), { recursive: true });
  return withFileLockSync(whiteboardBoardPath(id), fn, { maxWaitMs: BOARD_LOCK_TIMEOUT_MS });
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(id)) throw new Error('invalid_whiteboard_id');
  return id;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function normalizeWhiteboardWorkingDir(workingDir?: string): string | undefined {
  const raw = workingDir?.trim();
  if (!raw) return undefined;
  try { return resolve(expandHome(raw)); } catch { return raw; }
}

export function whiteboardBindingKey(input: WhiteboardBindingInput): string {
  const chat = input.chatId?.trim();
  if (chat) return `chat:${chat}:default`;
  const wd = normalizeWhiteboardWorkingDir(input.workingDir) ?? '-';
  return `local:${wd}`;
}

/** 初始 board.md 模板：固定中文结构，引导 agent 把白板当作「当前项目的全局上下文
 *  快照」来维护（项目目标 / 组织方式 / 核心方案 / 关键进展 / 下一步），而不是过程
 *  日志或零散备忘录。与 botmux-whiteboard skill 的结构示例保持一致。 */
const DEFAULT_WHITEBOARD_TEMPLATE = `# 当前状态

## 项目目标

- ...

## 组织方式

- ...

## 核心方案

- ...

## 关键进展

- ...

## 下一步

- ...
`;

function defaultTitle(input: EnsureWhiteboardInput): string {
  const wd = normalizeWhiteboardWorkingDir(input.workingDir);
  if (wd) return `白板：${wd.split('/').filter(Boolean).pop() ?? wd}`;
  if (input.chatId) return `白板：${input.chatId.substring(0, 12)}`;
  return '白板';
}

function writeMeta(meta: WhiteboardMeta): void {
  mkdirSync(dirname(metaPath(meta.id)), { recursive: true });
  atomicWriteFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2) + '\n');
}

function syncMetaFromDisk(id: string, fallback?: WhiteboardMeta): WhiteboardMeta | undefined {
  const fp = metaPath(id);
  if (!existsSync(fp)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as WhiteboardMeta;
    return parsed?.id ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function getWhiteboard(id: string): WhiteboardMeta | undefined {
  const clean = safeId(id);
  const index = readIndex();
  return syncMetaFromDisk(clean, index.boards[clean]);
}

export function ensureDefaultWhiteboard(input: EnsureWhiteboardInput): WhiteboardMeta {
  if (!whiteboardEnabled()) throw new Error('whiteboard_disabled');
  return withIndexLock(() => {
    const index = readIndex();
    const key = whiteboardBindingKey(input);
    const existingId = index.bindings[key];
    if (existingId) {
      const existing = syncMetaFromDisk(existingId, index.boards[existingId]);
      if (existing && !existing.archived) return existing;
    }

    const now = new Date().toISOString();
    const id = `wb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const normalizedWorkingDir = normalizeWhiteboardWorkingDir(input.workingDir);
    const meta: WhiteboardMeta = {
      id,
      title: input.title?.trim() || defaultTitle(input),
      scope: normalizedWorkingDir ? 'project' : 'chat',
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      workingDir: normalizedWorkingDir,
      createdFromSessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(boardDir(id), { recursive: true });
    atomicWriteFileSync(whiteboardBoardPath(id), DEFAULT_WHITEBOARD_TEMPLATE);
    writeFileSync(whiteboardLogPath(id), '', { flag: 'a' });
    writeMeta(meta);
    index.boards[id] = meta;
    index.bindings[key] = id;
    writeIndex(index);
    return meta;
  });
}

export function createWhiteboard(input: EnsureWhiteboardInput & { id?: string; scope?: WhiteboardScope }): WhiteboardMeta {
  if (!whiteboardEnabled()) throw new Error('whiteboard_disabled');
  return withIndexLock(() => {
    const index = readIndex();
    const id = input.id ? safeId(input.id) : `wb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (index.boards[id] || existsSync(boardDir(id))) throw new Error('whiteboard_exists');
    const now = new Date().toISOString();
    const normalizedWorkingDir = normalizeWhiteboardWorkingDir(input.workingDir);
    const meta: WhiteboardMeta = {
      id,
      title: input.title?.trim() || defaultTitle(input),
      scope: input.scope ?? (normalizedWorkingDir ? 'project' : input.chatId ? 'chat' : 'custom'),
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      workingDir: normalizedWorkingDir,
      createdFromSessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(boardDir(id), { recursive: true });
    atomicWriteFileSync(whiteboardBoardPath(id), DEFAULT_WHITEBOARD_TEMPLATE);
    writeFileSync(whiteboardLogPath(id), '', { flag: 'a' });
    writeMeta(meta);
    index.boards[id] = meta;
    writeIndex(index);
    return meta;
  });
}

function touchWhiteboard(id: string): WhiteboardMeta {
  return withIndexLock(() => {
    const index = readIndex();
    const meta = syncMetaFromDisk(id, index.boards[id]);
    if (!meta) throw new Error('whiteboard_not_found');
    meta.updatedAt = new Date().toISOString();
    index.boards[id] = meta;
    writeMeta(meta);
    writeIndex(index);
    return meta;
  });
}

export function listWhiteboards(): WhiteboardSummary[] {
  const index = readIndex();
  const ids = new Set([...Object.keys(index.boards)]);
  const root = whiteboardsRoot();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.index.lock') ids.add(entry.name);
    }
  } catch { /* ignore */ }
  const out: WhiteboardSummary[] = [];
  for (const id of ids) {
    const meta = syncMetaFromDisk(id, index.boards[id]);
    if (!meta) continue;
    const board = readWhiteboard(id, { allowDisabled: true, missingAsEmpty: true });
    const logCount = readLogLines(id).length;
    out.push({ ...meta, path: whiteboardBoardPath(id), preview: board.trim().slice(0, 500), logCount });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readWhiteboard(id: string, opts?: { allowDisabled?: boolean; missingAsEmpty?: boolean }): string {
  if (!opts?.allowDisabled && !whiteboardEnabled()) throw new Error('whiteboard_disabled');
  const clean = safeId(id);
  const fp = whiteboardBoardPath(clean);
  if (!existsSync(fp)) {
    if (opts?.missingAsEmpty) return '';
    throw new Error('whiteboard_not_found');
  }
  return readFileSync(fp, 'utf-8');
}

function readLogLines(id: string): string[] {
  const dir = boardDir(id);
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === 'log.jsonl' || /^log\.[1-3]\.jsonl$/.test(entry)) {
        files.push(entry);
      }
    }
  } catch {
    return [];
  }
  // Read oldest → newest: log.3 (oldest archive) … log.1 (newest archive) …
  // log.jsonl (current). The previous order fn mapped log.1→1, log.2→2, log.3→3
  // which read the *newest* archive first and the *oldest* last — the rotated
  // history came out in reverse chronological order. Invert the archive index.
  const order = (name: string) => {
    if (name === 'log.jsonl') return LOG_ARCHIVE_COUNT + 1;
    const n = Number(name.match(/^log\.(\d)\.jsonl$/)?.[1] ?? 0);
    return LOG_ARCHIVE_COUNT - n + 1;
  };
  return files
    .sort((a, b) => order(a) - order(b))
    .flatMap(file => {
      try { return readFileSync(join(dir, file), 'utf-8').split('\n').filter(Boolean); }
      catch { return []; }
    });
}

function rotateWhiteboardLogIfNeeded(id: string, incomingBytes = 0): void {
  const fp = whiteboardLogPath(id);
  if (!existsSync(fp)) return;
  const maxBytes = whiteboardLogMaxBytes();
  let size = 0;
  try { size = statSync(fp).size; } catch { return; }
  if (size + incomingBytes <= maxBytes) return;

  const dir = boardDir(id);
  try { unlinkSync(join(dir, `log.${LOG_ARCHIVE_COUNT}.jsonl`)); } catch { /* ignore */ }
  for (let i = LOG_ARCHIVE_COUNT - 1; i >= 1; i--) {
    const from = join(dir, `log.${i}.jsonl`);
    if (!existsSync(from)) continue;
    renameSync(from, join(dir, `log.${i + 1}.jsonl`));
  }
  renameSync(fp, join(dir, 'log.1.jsonl'));
}

export function writeWhiteboard(id: string, content: string, opts?: { actor?: string; kind?: string; expectedUpdatedAt?: string }): WhiteboardMeta {
  if (!whiteboardEnabled()) throw new Error('whiteboard_disabled');
  const clean = safeId(id);
  // Reject empty/whitespace-only content at the store boundary so no caller
  // (CLI flag misuse, future dashboard writes) can silently blank a shared
  // board. The board is the chat-wide current-state snapshot — wiping it to
  // "" loses everyone's context with no history trail.
  if (!content.trim()) throw new Error('whiteboard_empty_content');
  mkdirSync(boardDir(clean), { recursive: true });
  return withBoardLock(clean, () => {
    const existing = getWhiteboard(clean);
    if (!existing) throw new Error('whiteboard_not_found');
    // Optional compare-and-set: if the caller read the board at updatedAt X
    // and it has since changed, refuse the blind overwrite so the caller can
    // re-read and merge. Wired as a store primitive; CLI opts in later.
    if (opts?.expectedUpdatedAt && existing.updatedAt !== opts.expectedUpdatedAt) {
      throw new Error('whiteboard_cas_mismatch');
    }
    const tmp = `${whiteboardBoardPath(clean)}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, content.endsWith('\n') ? content : content + '\n', 'utf-8');
    renameSync(tmp, whiteboardBoardPath(clean));
    appendLog(clean, { kind: opts?.kind ?? 'write', actor: opts?.actor, content: `[overwrite ${content.length} chars]` });
    return touchWhiteboard(clean);
  });
}

export function appendLog(id: string, entry: { kind: string; actor?: string; to?: string; content?: string }): void {
  const clean = safeId(id);
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
  withLogLock(clean, () => {
    rotateWhiteboardLogIfNeeded(clean, Buffer.byteLength(line, 'utf-8'));
    appendFileSync(whiteboardLogPath(clean), line, 'utf-8');
  });
}

function clearSessionWhiteboardRefs(id: string): number {
  let cleared = 0;
  let files: string[] = [];
  try { files = readdirSync(config.session.dataDir); } catch { return 0; }
  for (const file of files) {
    if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
    const fp = join(config.session.dataDir, file);
    let data: Record<string, any>;
    try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { continue; }
    let dirty = false;
    for (const session of Object.values(data)) {
      if (session && typeof session === 'object' && session.whiteboardId === id) {
        delete session.whiteboardId;
        dirty = true;
        cleared++;
      }
    }
    if (dirty) atomicWriteFileSync(fp, JSON.stringify(data, null, 2) + '\n');
  }
  return cleared;
}

export function deleteWhiteboard(id: string): { ok: true; id: string; clearedSessions: number } {
  const clean = safeId(id);
  return withIndexLock(() => {
    const index = readIndex();
    delete index.boards[clean];
    for (const [key, boardId] of Object.entries(index.bindings)) {
      if (boardId === clean) delete index.bindings[key];
    }
    // Persist the index removal BEFORE touching files on disk. The old order
    // (rmSync → clearSessionWhiteboardRefs → writeIndex) left a window where a
    // crash between rmSync and writeIndex kept the on-disk index referencing a
    // board whose dir was already gone — a "ghost" board that
    // ensureDefaultWhiteboard would resurrect from the stale binding, pointing
    // sessions at a missing board.md. Index-first means a crash can at worst
    // leave an orphaned dir with no index entry (harmless), never a ghost.
    writeIndex(index);
    const clearedSessions = clearSessionWhiteboardRefs(clean);
    rmSync(boardDir(clean), { recursive: true, force: true });
    return { ok: true, id: clean, clearedSessions };
  });
}

export function whiteboardPath(id: string): { dir: string; board: string; log: string; meta: string } {
  const clean = safeId(id);
  return { dir: boardDir(clean), board: whiteboardBoardPath(clean), log: whiteboardLogPath(clean), meta: metaPath(clean) };
}
