/**
 * Request-bound group send: one caller `requestId` → at most one visible message
 * from this daemon's bot in one chat, with the exact Lark `message_id` returned
 * and an independent read-back of that message.
 *
 * Why: `/api/trigger` returns no message id and `hall-announce` may skip, so an
 * integrator cannot prove that *this* request produced *that* visible message.
 *
 * Dedupe has two layers:
 *  1. A durable per-bot record `${chatId}\u0000${requestId}` → {contentDigest,
 *     uuid, state, messageId}. It is written (fsync) *before* the provider call,
 *     so a crash cannot lose the fact that a send may have happened.
 *  2. The Lark IM `uuid` (≤50 chars, ~1h server-side dedupe) derived from the
 *     record. A retry of a `pending` record inside the window reuses the uuid,
 *     and Lark returns the original message_id instead of sending again.
 *
 * Outside that window a `pending` record is reported as `outcome_unknown` and
 * is never re-sent. The same requestId with different content is a conflict.
 * Corrupt or unreadable state fails closed (it is a dedupe authority): a record
 * missing `uuid` / `firstAttemptAt`, or carrying a uuid that is not the one
 * derived for this app, is invalid and nothing is sent.
 *
 * The live file is capped at {@link GROUP_SEND_RECORD_LIMIT}. Admitting a new
 * requestId past that cap compacts the oldest `sent` records (by
 * `firstAttemptAt`, at least {@link GROUP_SEND_COMPACT_BATCH} at a time) into
 * a sibling archive capped at {@link GROUP_SEND_ARCHIVE_LIMIT}. The archive is
 * fsynced before those keys are removed from the live file, and it is not
 * rewritten on replay, on the post-provider `sent` save, or on the new
 * requestIds admitted into the room a compaction made. Pending records are
 * never compacted — they are the proof an attempt may already be visible — and
 * a new requestId is refused with `store_full` once they fill the cap. A
 * requestId evicted from the archive (oldest `sentAt` past the archive cap)
 * retries as a new send.
 *
 * `outbound.send` is at-most-once per message id, not exactly-once. The route
 * always passes `suppressHook` into `sendMessage`. This module fires
 * `onCommitted` only after the `sent` record is durable, and a later call that
 * finds `state:'sent'` returns without firing again. A crash between that write
 * and the callback drops the hook; firing it earlier could emit it twice.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  extractLarkBusinessCode,
  LARK_CODE_APP_SCOPE_MISSING,
  LARK_CODE_MESSAGE_CONTENT_TOO_LONG,
  LARK_CODE_MESSAGE_WITHDRAWN,
} from '../im/lark/lark-errors.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const GROUP_SEND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * Feishu group chat ids are `oc_` plus a token. Underscores and long ids are
 * real (the same class as exact-chat-grant); a tighter pattern rejects them.
 */
export const GROUP_CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
export const GROUP_SEND_CONTENT_MAX_BYTES = 8192;
/**
 * JSON envelope around a max-size body. Control characters expand to `\u00XX`
 * (6 bytes) under JSON.stringify, so 8192 content bytes can approach 48KiB.
 * The cap rejects an unbounded buffer before parsing; it still accepts that
 * worst case.
 */
export const GROUP_SEND_BODY_MAX_BYTES = 64 * 1024;
/** Stay well inside Lark's ~1h uuid dedupe window. */
export const GROUP_SEND_UUID_REUSE_MS = 50 * 60 * 1000;
export const GROUP_SEND_RECORD_LIMIT = 2000;
/**
 * Archive cap. 20_000 full records is about 6MB. That file is rewritten only
 * by a compaction (see {@link GROUP_SEND_COMPACT_BATCH}).
 * Past this cap the oldest `sentAt` is dropped, and that requestId retries
 * as a new send.
 */
export const GROUP_SEND_ARCHIVE_LIMIT = 20_000;
/**
 * Minimum `sent` records moved per compaction. Once the live file is full,
 * every new requestId needs a slot; moving one record at a time rewrites and
 * fsyncs the whole archive (up to ~6MB) on every new send. A tenth of the live
 * cap is one archive rewrite per 200 new requestIds (~30KB per send at the
 * archive cap), well under the live-file rewrite each send already does.
 */
export const GROUP_SEND_COMPACT_BATCH = GROUP_SEND_RECORD_LIMIT / 10;

/** The live cap, compaction batch and archive cap in force. */
type GroupSendLimits = { record: number; compactBatch: number; archive: number };
const PRODUCTION_LIMITS: Readonly<GroupSendLimits> = Object.freeze({
  record: GROUP_SEND_RECORD_LIMIT, compactBatch: GROUP_SEND_COMPACT_BATCH, archive: GROUP_SEND_ARCHIVE_LIMIT,
});
let limits: Readonly<GroupSendLimits> = PRODUCTION_LIMITS;

/**
 * @internal test-only. Every send rewrites the whole live file, so crossing
 * the real 2000-record cap through real sends is quadratic work (tens of
 * seconds, minutes on a loaded runner). Tests that need to cross the cap that
 * way shrink the limits instead; the cap, compaction and eviction code is the
 * same. `null` restores the production limits.
 */
export function __setGroupSendLimitsForTest(next: GroupSendLimits | null): void {
  if (next && !(Number.isInteger(next.record) && next.record > 1
    && Number.isInteger(next.compactBatch) && next.compactBatch > 0 && next.compactBatch < next.record
    && Number.isInteger(next.archive) && next.archive > 0)) {
    throw new Error('invalid group send limits');
  }
  limits = next ? Object.freeze({ ...next }) : PRODUCTION_LIMITS;
}

/** Sibling of the live store: `group-sends-<appId>.json` → `group-sends-<appId>-archive.json`. */
export function groupSendArchivePath(storePath: string): string {
  return storePath.endsWith('.json')
    ? `${storePath.slice(0, -'.json'.length)}-archive.json`
    : `${storePath}-archive.json`;
}

export type GroupSendRecord = {
  chatId: string; requestId: string; contentDigest: string; uuid: string;
  state: 'pending' | 'sent'; firstAttemptAt: number; messageId?: string; sentAt?: number;
};
type StoreFile = { schemaVersion: 1; records: Record<string, GroupSendRecord> };

/** Plain-text hook body. `content` is the POST string, not the Lark wire JSON. */
export type GroupSendCommitted = {
  larkAppId: string;
  chatId: string;
  messageId: string;
  msgType: 'text';
  uuid: string;
  content: string;
  requestId: string;
};

export type GroupSendDeps = {
  larkAppId: string;
  storePath: string;
  send: (chatId: string, text: string, uuid: string) => Promise<string>;
  now?: () => number;
  /**
   * At most once per message, after `state:'sent'` is durable. The route binds
   * this to `emitHookEventLocal('outbound.send', …)` and always calls
   * `sendMessage` with `suppressHook: true`. Not called on a sent replay.
   */
  onCommitted?: (payload: GroupSendCommitted) => void;
};
export type GroupSendInput = { chatId: string; requestId: string; content: string };
export type GroupSendResult =
  | { ok: true; status: 200; messageId: string; requestId: string; chatId: string; replayed: boolean }
  | { ok: false; status: 400 | 409 | 502 | 503; error: 'invalid_request' | 'request_conflict' | 'outcome_unknown' | 'send_failed' | 'store_full'; retryable?: boolean };

/** Provider rejections that did not create a message. Retrying them until the
 * uuid window expires only ends in `outcome_unknown`. */
const DEFINITE_SEND_FAILURE_CODES = new Set<number>([
  230001,
  230002,
  LARK_CODE_MESSAGE_WITHDRAWN,
  230022,
  LARK_CODE_MESSAGE_CONTENT_TOO_LONG,
  LARK_CODE_APP_SCOPE_MISSING,
]);
/** message.get rejections that mean "not in this chat / not visible", as opposed
 * to a withdrawn message (230011) or a blip worth retrying. */
const READ_NOT_FOUND_CODES = new Set<number>([230001, 230002, 230022]);

export function groupSendUuid(larkAppId: string, chatId: string, requestId: string): string {
  return 'bmxgs-' + createHash('sha256').update(`${larkAppId}\u0000${chatId}\u0000${requestId}`).digest('hex').slice(0, 40);
}
const key = (chatId: string, requestId: string) => `${chatId}\u0000${requestId}`;
const digest = (content: string) => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isGroupSendRecord(value: unknown, storeKey: string, larkAppId: string): value is GroupSendRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as GroupSendRecord;
  if (typeof r.chatId !== 'string' || !GROUP_CHAT_ID.test(r.chatId)) return false;
  if (typeof r.requestId !== 'string' || !GROUP_SEND_REQUEST_ID.test(r.requestId)) return false;
  if (storeKey !== key(r.chatId, r.requestId)) return false;
  if (typeof r.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(r.contentDigest)) return false;
  if (typeof r.uuid !== 'string' || r.uuid !== groupSendUuid(larkAppId, r.chatId, r.requestId)) return false;
  if (r.state !== 'pending' && r.state !== 'sent') return false;
  if (!isFiniteNumber(r.firstAttemptAt)) return false;
  if (r.messageId !== undefined && (typeof r.messageId !== 'string' || !r.messageId)) return false;
  if (r.state === 'sent' && !r.messageId) return false;
  if (r.sentAt !== undefined && !isFiniteNumber(r.sentAt)) return false;
  return true;
}

function load(path: string, larkAppId: string): StoreFile {
  if (!existsSync(path)) return { schemaVersion: 1, records: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile; // throws → fail closed
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.records !== 'object' || parsed.records === null || Array.isArray(parsed.records)) {
    throw new Error('group send store is invalid');
  }
  for (const [storeKey, record] of Object.entries(parsed.records)) {
    if (!isGroupSendRecord(record, storeKey, larkAppId)) throw new Error('group send store is invalid');
  }
  return parsed;
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Live slot order. Only `sent` records can leave the live file. */
function oldestSent(file: StoreFile): [string, GroupSendRecord][] {
  return Object.entries(file.records)
    .filter(([, record]) => record.state === 'sent')
    .sort((a, b) => a[1].firstAttemptAt - b[1].firstAttemptAt || byKey(a[0], b[0]));
}

/**
 * Archive retention order is `sentAt`, not `firstAttemptAt`. A missing
 * `sentAt` sorts oldest so an undated row cannot pin the cap forever.
 */
function evictArchiveOverflow(file: StoreFile): void {
  const entries = Object.entries(file.records);
  let overflow = entries.length - limits.archive;
  if (overflow <= 0) return;
  entries.sort((a, b) => (a[1].sentAt ?? Number.NEGATIVE_INFINITY) - (b[1].sentAt ?? Number.NEGATIVE_INFINITY) || byKey(a[0], b[0]));
  for (const [storeKey] of entries) {
    if (overflow <= 0) break;
    delete file.records[storeKey];
    overflow--;
  }
}

/**
 * Forward lookup is one value. Live wins when the same key is in both files,
 * including when the message ids differ. Do not replace this with a merged
 * map whose last write wins: equal message ids hide a reversed merge.
 */
function forwardRecord(active: StoreFile, archive: StoreFile, storeKey: string): GroupSendRecord | undefined {
  const live = active.records[storeKey];
  if (live) return live;
  return archive.records[storeKey];
}

function save(path: string, file: StoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(file), { mode: 0o600, durable: true });
}

const queues = new Map<string, Promise<unknown>>();
function serial<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  queues.set(name, tail);
  void tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
  return next;
}

export function parseGroupSendBody(body: unknown): { requestId: string; content: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('content')) return undefined;
  const { requestId, content } = body as Record<string, unknown>;
  if (typeof requestId !== 'string' || !GROUP_SEND_REQUEST_ID.test(requestId)) return undefined;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > GROUP_SEND_CONTENT_MAX_BYTES) return undefined;
  return { requestId, content };
}

function sendFailure(err: unknown): GroupSendResult {
  const named = err as { name?: string; code?: unknown } | null;
  // sendMessage rewrites 230011 into these before the numeric code is visible.
  const namedDefinite = named?.name === 'MessageWithdrawnError'
    || (named?.name === 'TopicSendError' && named.code === 'TOPIC_SEND_BLOCKED');
  const code = extractLarkBusinessCode(err);
  const retryable = !namedDefinite && (code === undefined || !DEFINITE_SEND_FAILURE_CODES.has(code));
  return { ok: false, status: 502, error: 'send_failed', retryable };
}

export async function sendRequestBoundGroupMessage(deps: GroupSendDeps, input: GroupSendInput): Promise<GroupSendResult> {
  if (!GROUP_CHAT_ID.test(input.chatId) || !GROUP_SEND_REQUEST_ID.test(input.requestId)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  const now = deps.now ?? Date.now;
  return serial(deps.storePath, async () => {
    const active = load(deps.storePath, deps.larkAppId);
    const archivePath = groupSendArchivePath(deps.storePath);
    // Missing archive is an empty store. A corrupt archive throws here (fail
    // closed) before any provider call or write.
    const archive = load(archivePath, deps.larkAppId);
    const k = key(input.chatId, input.requestId), contentDigest = digest(input.content);
    let record = forwardRecord(active, archive, k);
    if (record && record.contentDigest !== contentDigest) return { ok: false, status: 409, error: 'request_conflict' };
    if (record?.state === 'sent' && record.messageId) {
      return { ok: true, status: 200, messageId: record.messageId, requestId: input.requestId, chatId: input.chatId, replayed: true };
    }
    if (record && now() - record.firstAttemptAt > GROUP_SEND_UUID_REUSE_MS) {
      return { ok: false, status: 409, error: 'outcome_unknown', retryable: false };
    }
    const replayed = !!record;
    if (!record) {
      record = { chatId: input.chatId, requestId: input.requestId, contentDigest,
        uuid: groupSendUuid(deps.larkAppId, input.chatId, input.requestId), state: 'pending', firstAttemptAt: now() };
      const overflow = Object.keys(active.records).length + 1 - limits.record;
      if (overflow > 0) {
        const movable = oldestSent(active);
        // Decide the whole move before touching either file. Compacting only
        // part of the overflow would still be over the cap and would have
        // written the archive on a store_full response.
        if (movable.length < overflow) return { ok: false, status: 503, error: 'store_full', retryable: false };
        const moving = movable.slice(0, Math.max(overflow, limits.compactBatch));
        for (const [storeKey, compacted] of moving) archive.records[storeKey] = compacted;
        evictArchiveOverflow(archive);
        save(archivePath, archive);
        for (const [storeKey] of moving) delete active.records[storeKey];
      }
      active.records[k] = record;
      save(deps.storePath, active);
    }
    let messageId: string;
    try { messageId = await deps.send(input.chatId, input.content, record.uuid); }
    catch (err) { return sendFailure(err); }
    if (typeof messageId !== 'string' || !messageId) return { ok: false, status: 502, error: 'send_failed', retryable: true };
    // Post-provider save rewrites only the live file. The archive was already
    // fsynced above when this send had to compact, and must not be rewritten here.
    const latest = load(deps.storePath, deps.larkAppId);
    latest.records[k] = { ...record, state: 'sent', messageId, sentAt: now() };
    save(deps.storePath, latest);
    const payload: GroupSendCommitted = {
      larkAppId: deps.larkAppId, chatId: input.chatId, messageId, msgType: 'text',
      uuid: record.uuid, content: input.content, requestId: input.requestId,
    };
    try { deps.onCommitted?.(payload); }
    catch { /* message is durable; a hook error must not look like a failed send */ }
    return { ok: true, status: 200, messageId, requestId: input.requestId, chatId: input.chatId, replayed };
  });
}

export type GroupMessageReadback = {
  ok: true; messageId: string; chatId: string; deleted: boolean; msgType: string | null;
  sender: { id: string | null; idType: string | null; senderType: string | null; isSelf: boolean };
  createTime: string | null; text: string | null; requestId: string | null;
};
export type GroupReadDeps = {
  larkAppId: string; storePath: string;
  detail: (messageId: string) => Promise<any>;
};
export type GroupReadResult = GroupMessageReadback | {
  ok: false; status: 400 | 404 | 409 | 502; error: 'invalid_request' | 'not_found' | 'chat_mismatch' | 'read_failed';
};

/**
 * Reverse lookup scans every entry of both files. It must not use
 * {@link forwardRecord}: that view keeps one message id per key, so a stale
 * archived message id would lose its binding once the live row diverges.
 */
function requestIdForMessage(active: StoreFile, archive: StoreFile, chatId: string, messageId: string): string | null {
  for (const source of [active.records, archive.records]) {
    for (const record of Object.values(source)) {
      if (record.chatId === chatId && record.messageId === messageId) return record.requestId;
    }
  }
  return null;
}

function boundRequestId(deps: GroupReadDeps, chatId: string, messageId: string): string | null {
  try {
    const active = load(deps.storePath, deps.larkAppId);
    const archive = load(groupSendArchivePath(deps.storePath), deps.larkAppId);
    return requestIdForMessage(active, archive, chatId, messageId);
  } catch { /* unreadable store: no binding claim */ }
  return null;
}

/** Lark stamps a bot `app` or (seen on cross-bot cards) `bot`. The identity is the app id. */
function senderIsSelf(sender: { sender_type?: unknown; id?: unknown }, larkAppId: string): boolean {
  return (sender.sender_type === 'app' || sender.sender_type === 'bot') && sender.id === larkAppId;
}

function withdrawnReadback(deps: GroupReadDeps, chatId: string, messageId: string): GroupMessageReadback {
  return {
    ok: true, messageId, chatId, deleted: true, msgType: null,
    sender: { id: null, idType: null, senderType: null, isSelf: false },
    createTime: null, text: null, requestId: boundRequestId(deps, chatId, messageId),
  };
}

/** Independent read-back. `requestId` is only reported when the durable record binds it to this message. */
export async function readRequestBoundGroupMessage(deps: GroupReadDeps, chatId: string, messageId: string): Promise<GroupReadResult> {
  if (!GROUP_CHAT_ID.test(chatId) || !messageId) return { ok: false, status: 400, error: 'invalid_request' };
  let data: any;
  try { data = await deps.detail(messageId); }
  catch (err) {
    const code = extractLarkBusinessCode(err);
    if (code === LARK_CODE_MESSAGE_WITHDRAWN) return withdrawnReadback(deps, chatId, messageId);
    if (code !== undefined && READ_NOT_FOUND_CODES.has(code)) return { ok: false, status: 404, error: 'not_found' };
    return { ok: false, status: 502, error: 'read_failed' };
  }
  const item = Array.isArray(data?.items) ? data.items.find((m: any) => m?.message_id === messageId) : undefined;
  if (!item) return { ok: false, status: 404, error: 'not_found' };
  if (item.chat_id !== chatId) return { ok: false, status: 409, error: 'chat_mismatch' };
  let text: string | null = null;
  if (item.msg_type === 'text' && typeof item.body?.content === 'string') {
    try { const parsed = JSON.parse(item.body.content); if (typeof parsed?.text === 'string') text = parsed.text; } catch { /* leave null */ }
  }
  const sender = item.sender ?? {};
  return { ok: true, messageId, chatId, deleted: item.deleted === true, msgType: typeof item.msg_type === 'string' ? item.msg_type : null,
    sender: { id: typeof sender.id === 'string' ? sender.id : null, idType: typeof sender.id_type === 'string' ? sender.id_type : null,
      senderType: typeof sender.sender_type === 'string' ? sender.sender_type : null,
      isSelf: senderIsSelf(sender, deps.larkAppId) },
    createTime: typeof item.create_time === 'string' ? item.create_time : null, text,
    requestId: boundRequestId(deps, chatId, messageId) };
}
