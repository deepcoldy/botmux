import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { errorMessage } from '../utils/error-message.js';
import { FileLockTimeoutError, withFileLockSync } from '../utils/file-lock.js';
import {
  StoreFileUnavailableError,
  isJsonObject,
  isStoreFileUnavailableError,
  quarantineStoreFileIfUnchanged,
  readStoreFileStrict,
} from '../utils/json-file.js';
import { logger } from '../utils/logger.js';

export type VcMeetingPreparationQaMode = 'off' | 'auto';

export interface VcMeetingPreparationRecord {
  larkAppId: string;
  meetingNo: string;
  meetingLink?: string;
  topic?: string;
  prepChatId: string;
  agentAppId: string;
  agentSessionId?: string;
  ownerOpenId?: string;
  qaMode: VcMeetingPreparationQaMode;
  createdAt: number;
  updatedAt: number;
}

const FILE_NAME = 'vc-meeting-preparations.json';

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

function preparationKey(larkAppId: string, meetingNo: string): string {
  return `${larkAppId}:${meetingNo}`;
}

export function normalizeVcMeetingNumber(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
}

function normalizeRecord(value: unknown): VcMeetingPreparationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const larkAppId = typeof r.larkAppId === 'string' ? r.larkAppId.trim() : '';
  const meetingNo = normalizeVcMeetingNumber(r.meetingNo);
  const prepChatId = typeof r.prepChatId === 'string' ? r.prepChatId.trim() : '';
  const agentAppId = typeof r.agentAppId === 'string' ? r.agentAppId.trim() : '';
  if (!larkAppId || !meetingNo || !prepChatId || !agentAppId) return undefined;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
    ? r.createdAt
    : Date.now();
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)
    ? r.updatedAt
    : createdAt;
  return {
    larkAppId,
    meetingNo,
    prepChatId,
    agentAppId,
    qaMode: r.qaMode === 'off' ? 'off' : 'auto',
    ...(typeof r.meetingLink === 'string' && r.meetingLink.trim() ? { meetingLink: r.meetingLink.trim() } : {}),
    ...(typeof r.topic === 'string' && r.topic.trim() ? { topic: r.topic.trim() } : {}),
    ...(typeof r.agentSessionId === 'string' && r.agentSessionId.trim()
      ? { agentSessionId: r.agentSessionId.trim() }
      : {}),
    ...(typeof r.ownerOpenId === 'string' && r.ownerOpenId.trim() ? { ownerOpenId: r.ownerOpenId.trim() } : {}),
    createdAt,
    updatedAt,
  };
}

const LABEL = 'vc-meeting-preparations-store';

export interface VcMeetingPreparationReadOptions {
  /** `'throw'` surfaces a file that cannot be read or parsed as
   * StoreFileUnavailableError instead of reading it as "no preparation" — for
   * callers that answer a person (/vc status, /vc prepare). */
  ioErrors?: 'skip' | 'throw';
}

type RawEntries = Array<[string, unknown]>;

/** Parsed top-level entries, or undefined when the content is not a store.
 * A top-level array (hand-edited files; the old reader accepted it) is read
 * as its elements. */
function parseEntries(text: string): RawEntries | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(raw)) return raw.map((value, index) => [String(index), value]);
  return isJsonObject(raw) ? Object.entries(raw) : undefined;
}

function normalizeEntries(entries: RawEntries): {
  store: Record<string, VcMeetingPreparationRecord>;
  passthrough: RawEntries;
} {
  const store: Record<string, VcMeetingPreparationRecord> = {};
  const passthrough: RawEntries = [];
  for (const [key, value] of entries) {
    const record = normalizeRecord(value);
    if (record) store[preparationKey(record.larkAppId, record.meetingNo)] = record;
    else passthrough.push([key, value]);
  }
  return { store, passthrough };
}

/**
 * Read-only lookups. By default degrades to "no preparation" with a warning —
 * meeting join must not fail because of this file. It never quarantines: an
 * unlocked reader renaming the file could race a locked writer and move the
 * writer's fresh file aside; quarantine is left to the locked write path.
 *
 * Semantics after a quarantine: the write path moves bad bytes to a
 * `.corrupt-*` evidence file and may leave no main file behind (a mutation
 * that changed nothing). From then on every read here answers "no
 * preparation" — quarantine is deliberately treated as "no bindings", with
 * recovery happening through the next `/vc prepare`. The evidence file is the
 * only trace; stricter sibling stores reject that state via
 * hasQuarantinedSibling, but this store keeps the join path degrading.
 */
function readStore(
  dataDir: string,
  opts: VcMeetingPreparationReadOptions = {},
): Record<string, VcMeetingPreparationRecord> {
  const fp = filePath(dataDir);
  let text: string | undefined;
  try {
    text = readStoreFileStrict(fp, LABEL)?.text;
  } catch (err) {
    if (opts.ioErrors === 'throw') throw err;
    logger.warn(`[${LABEL}] ${errorMessage(err)}; treating as no preparations`);
    return {};
  }
  if (text === undefined) return {};
  const entries = parseEntries(text);
  if (!entries) {
    const err = new StoreFileUnavailableError(LABEL, fp, 'parse', new Error('content is not a JSON object'));
    if (opts.ioErrors === 'throw') throw err;
    logger.warn(`[${LABEL}] ${err.message}; treating as no preparations until the next write quarantines it`);
    return {};
  }
  return normalizeEntries(entries).store;
}

/**
 * Read for a read-modify-write, inside the file lock. Unlike {@link readStore}
 * an unreadable file throws StoreFileUnavailableError: treating it as empty
 * here would make the following write replace every other bot's / chat's
 * preparation with just the one being changed. Corrupt content is moved aside
 * (inode-checked) before the write replaces it. Entries that do not normalize
 * are carried through untouched instead of being silently dropped.
 */
function readStoreForMutation(fp: string): ReturnType<typeof normalizeEntries> {
  const read = readStoreFileStrict(fp, LABEL);
  if (read === undefined) return { store: {}, passthrough: [] };
  const entries = parseEntries(read.text);
  if (entries) return normalizeEntries(entries);
  const aside = `${fp}.corrupt-${Date.now()}`;
  if (!quarantineStoreFileIfUnchanged(fp, read.ident, aside)) {
    throw new StoreFileUnavailableError(LABEL, fp, 'quarantine', new Error('file was replaced after it was read'));
  }
  logger.warn(`[${LABEL}] ${fp} is not a JSON object; moved to ${aside}, continuing with an empty store`);
  return { store: {}, passthrough: [] };
}

function hasErrnoCode(err: unknown): boolean {
  return !!err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string';
}

/**
 * Serialized read-modify-write; `fn` returns whether the store changed.
 * Every failure to take the lock, read, quarantine or write surfaces as
 * StoreFileUnavailableError so /vc can tell the owner (other errors, i.e. bugs,
 * propagate unchanged). The file is never left half-written: writes are atomic.
 */
function mutateStore<T>(
  dataDir: string,
  fn: (store: Record<string, VcMeetingPreparationRecord>) => { result: T; changed: boolean },
): T {
  const fp = filePath(dataDir);
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    return withFileLockSync(fp, () => {
      const { store, passthrough } = readStoreForMutation(fp);
      const { result, changed } = fn(store);
      if (changed) {
        // fromEntries keeps keys such as "__proto__" as own data properties.
        const merged = Object.fromEntries([...passthrough, ...Object.entries(store)]);
        atomicWriteFileSync(fp, JSON.stringify(merged, null, 2) + '\n');
      }
      return result;
    });
  } catch (err) {
    if (isStoreFileUnavailableError(err)) throw err;
    if (err instanceof FileLockTimeoutError) throw new StoreFileUnavailableError(LABEL, fp, 'lock', err);
    if (hasErrnoCode(err)) throw new StoreFileUnavailableError(LABEL, fp, 'update', err);
    throw err;
  }
}

export function putVcMeetingPreparation(
  dataDir: string,
  input: Omit<VcMeetingPreparationRecord, 'createdAt' | 'updatedAt'>,
): VcMeetingPreparationRecord {
  const meetingNo = normalizeVcMeetingNumber(input.meetingNo);
  if (!meetingNo) throw new Error('invalid meeting number');
  return mutateStore(dataDir, store => {
    const key = preparationKey(input.larkAppId, meetingNo);
    const prior = store[key];
    const now = Date.now();
    const next: VcMeetingPreparationRecord = {
      ...input,
      meetingNo,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    store[key] = next;
    return { result: next, changed: true };
  });
}

export function getVcMeetingPreparation(
  dataDir: string,
  larkAppId: string,
  meetingNo: string,
  opts: VcMeetingPreparationReadOptions = {},
): VcMeetingPreparationRecord | undefined {
  const normalized = normalizeVcMeetingNumber(meetingNo);
  if (!normalized) return undefined;
  return readStore(dataDir, opts)[preparationKey(larkAppId, normalized)];
}

export function listVcMeetingPreparations(
  dataDir: string,
  larkAppId: string,
  opts: VcMeetingPreparationReadOptions = {},
): VcMeetingPreparationRecord[] {
  return Object.values(readStore(dataDir, opts))
    .filter(record => record.larkAppId === larkAppId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findVcMeetingPreparationByChat(
  dataDir: string,
  larkAppId: string,
  prepChatId: string,
  opts: VcMeetingPreparationReadOptions = {},
): VcMeetingPreparationRecord | undefined {
  return listVcMeetingPreparations(dataDir, larkAppId, opts)
    .find(record => record.prepChatId === prepChatId);
}

export function removeVcMeetingPreparation(
  dataDir: string,
  larkAppId: string,
  meetingNo: string,
): VcMeetingPreparationRecord | undefined {
  const normalized = normalizeVcMeetingNumber(meetingNo);
  if (!normalized) return undefined;
  return mutateStore(dataDir, store => {
    const key = preparationKey(larkAppId, normalized);
    const removed = store[key];
    if (!removed) return { result: undefined, changed: false };
    delete store[key];
    return { result: removed, changed: true };
  });
}

/** Removes every *recognized* preparation of one bot in a single locked
 * update (`/vc off all`), so a failure leaves either all or none of them
 * removed. Entries that do not normalize are opaque passthrough data and stay
 * (same as the old per-record deletion); the returned count covers recognized
 * records only. */
export function removeVcMeetingPreparationsForApp(dataDir: string, larkAppId: string): number {
  return mutateStore(dataDir, store => {
    let removed = 0;
    for (const [key, record] of Object.entries(store)) {
      if (record.larkAppId !== larkAppId) continue;
      delete store[key];
      removed += 1;
    }
    return { result: removed, changed: removed > 0 };
  });
}

export function removeVcMeetingPreparationsByChat(
  dataDir: string,
  larkAppId: string,
  prepChatId: string,
): number {
  return mutateStore(dataDir, store => {
    let removed = 0;
    for (const [key, record] of Object.entries(store)) {
      if (record.larkAppId !== larkAppId || record.prepChatId !== prepChatId) continue;
      delete store[key];
      removed += 1;
    }
    return { result: removed, changed: removed > 0 };
  });
}
