/**
 * Durable, bounded ownership index for primary Lark messages emitted by a
 * meeting receiver. Quote routing consults this index to disambiguate multiple
 * meetings in one listener chat without relying on daemon memory.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const DIR_NAME = 'vc-meeting-listener-messages';
const SCHEMA_VERSION = 1;
export const MAX_VC_MEETING_LISTENER_MESSAGES = 512;

export interface VcMeetingListenerMessageOwner {
  listenerAppId: string;
  meetingId: string;
  targetChatId: string;
}

export interface VcMeetingListenerMessageRecord extends VcMeetingListenerMessageOwner {
  messageId: string;
  recordedAt: number;
}

interface VcMeetingListenerMessageState {
  schemaVersion: number;
  listenerAppId: string;
  targetChatId: string;
  messages: VcMeetingListenerMessageRecord[];
  createdAt: number;
  updatedAt: number;
}

export type RecordVcMeetingListenerMessageResult =
  | { ok: true; kind: 'recorded' | 'existing'; record: VcMeetingListenerMessageRecord }
  | { ok: false; reason: 'invalid' | 'owner_conflict' };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeFileToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, char => `%${char.charCodeAt(0).toString(16)}`);
}

function stateFileName(listenerAppId: string, targetChatId: string): string {
  return `${safeFileToken(listenerAppId)}__${safeFileToken(targetChatId)}.json`;
}

function stateFilePath(dataDir: string, listenerAppId: string, targetChatId: string): string {
  return join(dataDir, DIR_NAME, stateFileName(listenerAppId, targetChatId));
}

function validateRecord(
  value: unknown,
  scope: { listenerAppId: string; targetChatId: string },
): asserts value is VcMeetingListenerMessageRecord {
  if (!plainObject(value)
    || Object.keys(value).some(key => ![
      'listenerAppId', 'meetingId', 'targetChatId', 'messageId', 'recordedAt',
    ].includes(key))
    || value.listenerAppId !== scope.listenerAppId
    || value.targetChatId !== scope.targetChatId
    || !nonEmpty(value.meetingId)
    || !nonEmpty(value.messageId)
    || !finiteTimestamp(value.recordedAt)) {
    throw new Error('invalid VC meeting listener-message record');
  }
}

function readState(
  fp: string,
  scope: { listenerAppId: string; targetChatId: string },
): VcMeetingListenerMessageState | undefined {
  if (!existsSync(fp)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fp, 'utf8'));
  } catch (error) {
    throw new Error(
      `VC meeting listener-message index is unreadable at ${fp}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!plainObject(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || parsed.listenerAppId !== scope.listenerAppId
    || parsed.targetChatId !== scope.targetChatId
    || basename(fp) !== stateFileName(scope.listenerAppId, scope.targetChatId)
    || !Array.isArray(parsed.messages)
    || parsed.messages.length > MAX_VC_MEETING_LISTENER_MESSAGES
    || !finiteTimestamp(parsed.createdAt)
    || !finiteTimestamp(parsed.updatedAt)
    || Object.keys(parsed).some(key => ![
      'schemaVersion', 'listenerAppId', 'targetChatId', 'messages', 'createdAt', 'updatedAt',
    ].includes(key))) {
    throw new Error(`VC meeting listener-message index binding/schema mismatch at ${fp}`);
  }
  const seen = new Set<string>();
  for (const record of parsed.messages) {
    validateRecord(record, scope);
    if (seen.has(record.messageId)) {
      throw new Error(`VC meeting listener-message index contains duplicate ${record.messageId}`);
    }
    seen.add(record.messageId);
  }
  return parsed as unknown as VcMeetingListenerMessageState;
}

function writeState(fp: string, state: VcMeetingListenerMessageState): void {
  const dir = join(fp, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(fp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function recordVcMeetingListenerMessage(
  dataDir: string,
  input: VcMeetingListenerMessageOwner & { messageId: string },
  now = Date.now(),
): RecordVcMeetingListenerMessageResult {
  const listenerAppId = input.listenerAppId?.trim();
  const meetingId = input.meetingId?.trim();
  const targetChatId = input.targetChatId?.trim();
  const messageId = input.messageId?.trim();
  if (!listenerAppId || !meetingId || !targetChatId || !messageId || !finiteTimestamp(now)) {
    return { ok: false, reason: 'invalid' };
  }
  const scope = { listenerAppId, targetChatId };
  const fp = stateFilePath(dataDir, listenerAppId, targetChatId);
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLockSync(fp, () => {
    const prior = readState(fp, scope);
    const existing = prior?.messages.find(record => record.messageId === messageId);
    if (existing?.meetingId !== undefined && existing.meetingId !== meetingId) {
      return { ok: false as const, reason: 'owner_conflict' as const };
    }
    const record: VcMeetingListenerMessageRecord = {
      ...scope,
      meetingId,
      messageId,
      recordedAt: existing?.recordedAt ?? now,
    };
    if (existing) return { ok: true as const, kind: 'existing' as const, record };
    const state: VcMeetingListenerMessageState = prior ?? {
      schemaVersion: SCHEMA_VERSION,
      ...scope,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    state.messages.push(record);
    if (state.messages.length > MAX_VC_MEETING_LISTENER_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_VC_MEETING_LISTENER_MESSAGES);
    }
    state.updatedAt = now;
    writeState(fp, state);
    return { ok: true as const, kind: 'recorded' as const, record };
  });
}

export function listVcMeetingListenerMessageIds(
  dataDir: string,
  owner: VcMeetingListenerMessageOwner,
): string[] {
  const listenerAppId = owner.listenerAppId?.trim();
  const meetingId = owner.meetingId?.trim();
  const targetChatId = owner.targetChatId?.trim();
  if (!listenerAppId || !meetingId || !targetChatId) return [];
  const scope = { listenerAppId, targetChatId };
  const state = readState(stateFilePath(dataDir, listenerAppId, targetChatId), scope);
  return state?.messages
    .filter(record => record.meetingId === meetingId)
    .map(record => record.messageId) ?? [];
}
