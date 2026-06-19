import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { readGlobalConfig } from '../global-config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

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

function withDirLock<T>(lockDir: string, timeoutMs: number, errorMessage: string, fn: () => T): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(errorMessage);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function withIndexLock<T>(fn: () => T): T {
  ensureRoot();
  return withDirLock(join(whiteboardsRoot(), '.index.lock'), 5_000, 'whiteboard index lock timeout', fn);
}

function withLogLock<T>(id: string, fn: () => T): T {
  mkdirSync(boardDir(id), { recursive: true });
  return withDirLock(join(boardDir(id), '.log.lock'), 5_000, 'whiteboard log lock timeout', fn);
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

function defaultTitle(input: EnsureWhiteboardInput): string {
  const wd = normalizeWhiteboardWorkingDir(input.workingDir);
  if (wd) return `Whiteboard: ${wd.split('/').filter(Boolean).pop() ?? wd}`;
  if (input.chatId) return `Whiteboard: ${input.chatId.substring(0, 12)}`;
  return 'Whiteboard';
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
    atomicWriteFileSync(whiteboardBoardPath(id), `# ${meta.title}\n\n`);
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
    atomicWriteFileSync(whiteboardBoardPath(id), `# ${meta.title}\n\n`);
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
  const order = (name: string) => name === 'log.jsonl' ? 4 : Number(name.match(/^log\.(\d)\.jsonl$/)?.[1] ?? 0);
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

export function writeWhiteboard(id: string, content: string, opts?: { actor?: string; kind?: string }): WhiteboardMeta {
  if (!whiteboardEnabled()) throw new Error('whiteboard_disabled');
  const clean = safeId(id);
  if (!getWhiteboard(clean)) throw new Error('whiteboard_not_found');
  mkdirSync(boardDir(clean), { recursive: true });
  const tmp = `${whiteboardBoardPath(clean)}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content.endsWith('\n') ? content : content + '\n', 'utf-8');
  renameSync(tmp, whiteboardBoardPath(clean));
  appendLog(clean, { kind: opts?.kind ?? 'write', actor: opts?.actor, content: `[overwrite ${content.length} chars]` });
  return touchWhiteboard(clean);
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
    rmSync(boardDir(clean), { recursive: true, force: true });
    const clearedSessions = clearSessionWhiteboardRefs(clean);
    writeIndex(index);
    return { ok: true, id: clean, clearedSessions };
  });
}

export function whiteboardPath(id: string): { dir: string; board: string; log: string; meta: string } {
  const clean = safeId(id);
  return { dir: boardDir(clean), board: whiteboardBoardPath(clean), log: whiteboardLogPath(clean), meta: metaPath(clean) };
}
