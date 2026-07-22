/**
 * Durable topic anchor for one automatic meeting-consumer output stream.
 *
 * The first visible output in `topic` placement is sent as a top-level message
 * and becomes the topic root. Later outputs reply to that message. The member
 * epoch is part of the key so removing/re-adding a profile starts a fresh topic
 * without reusing an old role's presentation state.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const DIR_NAME = 'vc-meeting-listener-topics';
const SCHEMA_VERSION = 1 as const;

export interface VcMeetingListenerTopicKey {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  targetChatId: string;
}

interface VcMeetingListenerTopicRecord extends VcMeetingListenerTopicKey {
  schemaVersion: typeof SCHEMA_VERSION;
  rootMessageId: string;
  createdAt: number;
  updatedAt: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, char => `%${char.charCodeAt(0).toString(16)}`);
}

function validKey(key: VcMeetingListenerTopicKey): boolean {
  return nonEmpty(key.listenerAppId)
    && nonEmpty(key.meetingId)
    && nonEmpty(key.memberId)
    && Number.isSafeInteger(key.memberEpoch)
    && key.memberEpoch > 0
    && nonEmpty(key.targetChatId);
}

function filePath(dataDir: string, key: VcMeetingListenerTopicKey): string {
  return join(
    dataDir,
    DIR_NAME,
    `${safeToken(key.listenerAppId)}__${safeToken(key.meetingId)}__${safeToken(key.memberId)}__${key.memberEpoch}__${safeToken(key.targetChatId)}.json`,
  );
}

function readRecord(fp: string, key: VcMeetingListenerTopicKey): VcMeetingListenerTopicRecord | undefined {
  if (!existsSync(fp)) return undefined;
  const parsed = JSON.parse(readFileSync(fp, 'utf8')) as Partial<VcMeetingListenerTopicRecord>;
  if (parsed.schemaVersion !== SCHEMA_VERSION
    || parsed.listenerAppId !== key.listenerAppId
    || parsed.meetingId !== key.meetingId
    || parsed.memberId !== key.memberId
    || parsed.memberEpoch !== key.memberEpoch
    || parsed.targetChatId !== key.targetChatId
    || !nonEmpty(parsed.rootMessageId)
    || typeof parsed.createdAt !== 'number'
    || !Number.isFinite(parsed.createdAt)
    || typeof parsed.updatedAt !== 'number'
    || !Number.isFinite(parsed.updatedAt)) {
    throw new Error(`invalid VC meeting listener-topic record at ${fp}`);
  }
  return parsed as VcMeetingListenerTopicRecord;
}

export function getVcMeetingListenerTopicRoot(
  dataDir: string,
  key: VcMeetingListenerTopicKey,
): string | undefined {
  if (!validKey(key)) return undefined;
  return readRecord(filePath(dataDir, key), key)?.rootMessageId;
}

/** First successful provider message wins. A conflicting later root is a hard
 * failure so retries cannot silently split one meeting stream across topics. */
export function recordVcMeetingListenerTopicRoot(
  dataDir: string,
  key: VcMeetingListenerTopicKey,
  rootMessageId: string,
  now = Date.now(),
): { ok: true; rootMessageId: string; existing: boolean } | { ok: false; reason: 'invalid' | 'conflict' } {
  if (!validKey(key) || !nonEmpty(rootMessageId) || !Number.isFinite(now)) {
    return { ok: false, reason: 'invalid' };
  }
  const fp = filePath(dataDir, key);
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLockSync(fp, () => {
    const prior = readRecord(fp, key);
    if (prior) {
      return prior.rootMessageId === rootMessageId
        ? { ok: true as const, rootMessageId, existing: true }
        : { ok: false as const, reason: 'conflict' as const };
    }
    const record: VcMeetingListenerTopicRecord = {
      schemaVersion: SCHEMA_VERSION,
      ...key,
      rootMessageId: rootMessageId.trim(),
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteFileSync(fp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: true as const, rootMessageId: record.rootMessageId, existing: false };
  });
}
