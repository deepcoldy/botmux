import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { LarkMessage } from '../types.js';
import {
  revalidatePrincipalLaneDispatchCapability,
  type PrincipalLaneDispatchAuthority,
  type PrincipalLaneDispatchCapability,
  type PrincipalLaneDispatchContextResult,
  type PrincipalLaneQueueIdentity,
} from '../core/principal-lane-dispatch.js';
import {
  principalLaneTicketRecordLocator,
  resolvePrincipalLaneTicketRecord,
  type PrincipalLaneAdmissionTicketCapability,
} from './principal-lane-ticket-record-resolver.js';

function getQueuesDir(): string {
  return join(config.session.dataDir, 'queues');
}

function getQueueFile(rootMessageId: string): string {
  return join(getQueuesDir(), `${rootMessageId}.jsonl`);
}

function getOffsetFile(rootMessageId: string): string {
  return join(getQueuesDir(), `${rootMessageId}.offset`);
}

export function ensureQueue(rootMessageId: string): void {
  const dir = getQueuesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const queueFile = getQueueFile(rootMessageId);
  if (!existsSync(queueFile)) {
    writeFileSync(queueFile, '', 'utf-8');
  }
}

export function appendMessage(rootMessageId: string, message: LarkMessage): void {
  ensureQueue(rootMessageId);
  const line = JSON.stringify(message) + '\n';
  appendFileSync(getQueueFile(rootMessageId), line, 'utf-8');
  logger.debug(`MessageQueue: appended message to ${rootMessageId}`);
}

function readOffset(rootMessageId: string): number {
  const offsetFile = getOffsetFile(rootMessageId);
  if (!existsSync(offsetFile)) return 0;
  try {
    return parseInt(readFileSync(offsetFile, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(rootMessageId: string, offset: number): void {
  // 原子写：offset 半截（如 "12" 只写出 "1"）会导致重启后消息重读或跳读。
  atomicWriteFileSync(getOffsetFile(rootMessageId), String(offset));
}

/** Reset offset to re-read all messages from a given byte position (0 = beginning). */
export function rewindOffset(rootMessageId: string, to = 0): void {
  writeOffset(rootMessageId, to);
}

/** Return the current read offset (byte position) without advancing it. */
export function getOffset(rootMessageId: string): number {
  return readOffset(rootMessageId);
}

export function readUnread(rootMessageId: string): LarkMessage[] {
  const queueFile = getQueueFile(rootMessageId);
  if (!existsSync(queueFile)) return [];

  const content = readFileSync(queueFile, 'utf-8');
  const offset = readOffset(rootMessageId);

  if (offset >= content.length) return [];

  const unread = content.slice(offset);
  const messages: LarkMessage[] = [];
  for (const line of unread.split('\n')) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        logger.warn(`MessageQueue: failed to parse line: ${line}`);
      }
    }
  }

  if (messages.length > 0) {
    writeOffset(rootMessageId, content.length);
  }

  return messages;
}

const PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION = 1 as const;
const PRINCIPAL_LANE_QUEUE_DOMAIN = 'botmux.principal-lane.queue.namespace';

interface PrincipalLaneQueueManifest extends PrincipalLaneQueueIdentity {
  namespaceVersion: typeof PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION;
}

declare const principalLaneQueueHandleBrand: unique symbol;

/** Opaque capability for one lane queue. Queue file APIs never accept raw
 * namespace/path strings, so display or routing identifiers cannot be used as
 * accidental fallbacks. */
export interface PrincipalLaneQueueHandle {
  readonly namespaceVersion: typeof PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION;
  readonly namespace: string;
  readonly [principalLaneQueueHandleBrand]: true;
}

interface PrincipalLaneQueueHandleRecord {
  identity: PrincipalLaneQueueIdentity;
  capability: PrincipalLaneDispatchCapability;
  namespace: string;
  dir: string;
  manifestFile: string;
}

const PRINCIPAL_LANE_RECORD_VERSION = 1 as const;
const PRINCIPAL_LANE_RECORD_DOMAIN = 'botmux.principal-lane.queue.record';
const PRINCIPAL_LANE_RECORD_ENCODING = 'canonical-json-utf8-base64' as const;
const MAX_PRINCIPAL_LANE_RECORD_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES = 2 * 1024 * 1024;

export interface PrincipalLaneDurableRecordLocator {
  namespaceVersion: typeof PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION;
  namespace: string;
  recordVersion: typeof PRINCIPAL_LANE_RECORD_VERSION;
  recordId: string;
  turnId: string;
  payloadEncoding: typeof PRINCIPAL_LANE_RECORD_ENCODING;
  payloadHash: string;
  exactFileLength: number;
}

interface PrincipalLaneRecordEnvelope {
  version: typeof PRINCIPAL_LANE_RECORD_VERSION;
  recordId: string;
  turnId: string;
  payloadEncoding: typeof PRINCIPAL_LANE_RECORD_ENCODING;
  payloadHash: string;
  payloadBase64: string;
}

declare const principalLaneAppendReceiptBrand: unique symbol;

export interface PrincipalLaneAppendReceipt {
  readonly version: typeof PRINCIPAL_LANE_RECORD_VERSION;
  readonly [principalLaneAppendReceiptBrand]: true;
}

declare const principalLaneClaimedRecordCapabilityBrand: unique symbol;

/** Rehydrated only from a store-verified admission ticket. This checkpoint
 * intentionally exposes no production raw-locator issuer. */
export interface PrincipalLaneClaimedRecordCapability {
  readonly version: typeof PRINCIPAL_LANE_RECORD_VERSION;
  readonly [principalLaneClaimedRecordCapabilityBrand]: true;
}

type PrincipalLaneExactRecordCapability =
  | PrincipalLaneAppendReceipt
  | PrincipalLaneClaimedRecordCapability;

interface PrincipalLaneRecordCapabilityRecord {
  handle: PrincipalLaneQueueHandle;
  locator: Readonly<PrincipalLaneDurableRecordLocator>;
}

const principalLaneAppendReceipts = new WeakMap<object, PrincipalLaneRecordCapabilityRecord>();
const principalLaneClaimedRecordCapabilities = new WeakMap<object, PrincipalLaneRecordCapabilityRecord>();

export type PrincipalLaneQueueFailure =
  | {
      status: 'invalid';
      reason: 'invalid_capability' | 'invalid_handle' | 'invalid_record_input' | 'record_too_large';
    }
  | {
      status: 'retry';
      reason: 'manifest_create_failed' | 'manifest_read_failed' | 'queue_io_failed'
        | 'record_io_failed' | 'record_publish_unsupported';
    }
  | {
      status: 'quarantined';
      reason: 'invalid_identity' | 'manifest_malformed'
        | 'manifest_identity_mismatch' | 'invalid_offset' | 'invalid_queue_record'
        | 'record_conflict' | 'record_malformed' | 'record_identity_mismatch';
    }
  | Exclude<PrincipalLaneDispatchContextResult, { status: 'ready' | 'invalid' }>;

export type PrincipalLaneQueueResult<T> = { status: 'ready'; value: T }
  | PrincipalLaneQueueFailure;

const principalLaneQueueHandles = new WeakMap<object, PrincipalLaneQueueHandleRecord>();

function lengthPrefixed(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function validQueueIdentity(identity: PrincipalLaneQueueIdentity): boolean {
  return [identity.larkAppId, identity.sourceSessionId, identity.laneId, identity.sessionId]
    .every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096);
}

function principalLaneQueueNamespace(identity: PrincipalLaneQueueIdentity): string {
  const hash = createHash('sha256');
  hash.update(lengthPrefixed(PRINCIPAL_LANE_QUEUE_DOMAIN));
  const version = Buffer.allocUnsafe(4);
  version.writeUInt32BE(PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION, 0);
  hash.update(version);
  for (const [name, value] of [
    ['larkAppId', identity.larkAppId],
    ['sourceSessionId', identity.sourceSessionId],
    ['laneId', identity.laneId],
    ['sessionId', identity.sessionId],
  ] as const) {
    hash.update(lengthPrefixed(name));
    hash.update(lengthPrefixed(value));
  }
  return `plq_v${PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION}_${hash.digest('hex')}`;
}

function manifestFor(identity: PrincipalLaneQueueIdentity): PrincipalLaneQueueManifest {
  return {
    namespaceVersion: PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION,
    larkAppId: identity.larkAppId,
    sourceSessionId: identity.sourceSessionId,
    laneId: identity.laneId,
    sessionId: identity.sessionId,
  };
}

function sameManifest(
  manifest: PrincipalLaneQueueManifest,
  identity: PrincipalLaneQueueIdentity,
): boolean {
  return manifest.namespaceVersion === PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION
    && manifest.larkAppId === identity.larkAppId
    && manifest.sourceSessionId === identity.sourceSessionId
    && manifest.laneId === identity.laneId
    && manifest.sessionId === identity.sessionId;
}

function parseManifest(raw: string): PrincipalLaneQueueManifest | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join('\0') !== [
    'laneId', 'larkAppId', 'namespaceVersion', 'sessionId', 'sourceSessionId',
  ].join('\0')) return undefined;
  if (candidate.namespaceVersion !== PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION
      || typeof candidate.larkAppId !== 'string'
      || typeof candidate.sourceSessionId !== 'string'
      || typeof candidate.laneId !== 'string'
      || typeof candidate.sessionId !== 'string') return undefined;
  const manifest = candidate as unknown as PrincipalLaneQueueManifest;
  return validQueueIdentity(manifest) ? manifest : undefined;
}

function verifyPrincipalLaneQueueManifest(
  record: PrincipalLaneQueueHandleRecord,
): PrincipalLaneQueueFailure | undefined {
  let raw: string;
  try {
    raw = readFileSync(record.manifestFile, 'utf8');
  } catch {
    return { status: 'retry', reason: 'manifest_read_failed' };
  }
  const manifest = parseManifest(raw);
  if (!manifest) return { status: 'quarantined', reason: 'manifest_malformed' };
  if (!sameManifest(manifest, record.identity)) {
    return { status: 'quarantined', reason: 'manifest_identity_mismatch' };
  }
  return undefined;
}

function principalLaneQueueRecord(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<PrincipalLaneQueueHandleRecord> {
  const record = principalLaneQueueHandles.get(handle as object);
  if (!record) return { status: 'invalid', reason: 'invalid_handle' };
  const dispatch = revalidatePrincipalLaneDispatchCapability(record.capability, authority);
  if (dispatch.status !== 'ready') return dispatch;
  if (!sameManifest(manifestFor(dispatch.context.queueIdentity), record.identity)) {
    return { status: 'invalid', reason: 'invalid_capability' };
  }
  const failure = verifyPrincipalLaneQueueManifest(record);
  return failure ?? { status: 'ready', value: record };
}

/** Open (or create) one lane queue capability. The manifest is the collision
 * backstop for the SHA-256 namespace and is revalidated by every operation. */
export function openPrincipalLaneQueue(
  capability: PrincipalLaneDispatchCapability,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<PrincipalLaneQueueHandle> {
  const dispatch = revalidatePrincipalLaneDispatchCapability(capability, authority);
  if (dispatch.status !== 'ready') return dispatch;
  const identity = dispatch.context.queueIdentity;
  if (!validQueueIdentity(identity)) {
    return { status: 'quarantined', reason: 'invalid_identity' };
  }
  const stableIdentity = Object.freeze({ ...identity });
  const namespace = principalLaneQueueNamespace(stableIdentity);
  const dir = join(
    getQueuesDir(),
    'principal-lanes',
    `v${PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION}`,
    namespace,
  );
  const manifestFile = join(dir, 'manifest.json');
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(manifestFile)) {
      try {
        writeFileSync(
          manifestFile,
          `${JSON.stringify(manifestFor(stableIdentity))}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          return { status: 'retry', reason: 'manifest_create_failed' };
        }
      }
    }
  } catch {
    return { status: 'retry', reason: 'manifest_create_failed' };
  }
  const record: PrincipalLaneQueueHandleRecord = {
    identity: stableIdentity,
    capability,
    namespace,
    dir,
    manifestFile,
  };
  const failure = verifyPrincipalLaneQueueManifest(record);
  if (failure) return failure;
  const handle = Object.freeze({
    namespaceVersion: PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION,
    namespace,
  }) as PrincipalLaneQueueHandle;
  principalLaneQueueHandles.set(handle as object, record);
  return { status: 'ready', value: handle };
}

function principalLaneRecordsDir(record: PrincipalLaneQueueHandleRecord): string {
  return join(record.dir, 'records', `v${PRINCIPAL_LANE_RECORD_VERSION}`);
}

function ensureDurablePrincipalLaneRecordsDir(record: PrincipalLaneQueueHandleRecord): string {
  const recordsRoot = join(record.dir, 'records');
  mkdirSync(recordsRoot, { recursive: true, mode: 0o700 });
  fsyncDirectory(record.dir);
  const versionDir = principalLaneRecordsDir(record);
  mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  fsyncDirectory(recordsRoot);
  fsyncDirectory(versionDir);
  return versionDir;
}

function principalLaneRecordFile(
  record: PrincipalLaneQueueHandleRecord,
  recordId: string,
): string {
  return join(principalLaneRecordsDir(record), `${recordId}.json`);
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('principal lane immutable record write made no progress');
    }
    offset += written;
  }
}

function hashPrincipalLanePayload(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function principalLaneRecordId(args: {
  namespace: string;
  turnId: string;
  payloadHash: string;
}): string {
  const hash = createHash('sha256');
  hash.update(lengthPrefixed(PRINCIPAL_LANE_RECORD_DOMAIN));
  const version = Buffer.allocUnsafe(4);
  version.writeUInt32BE(PRINCIPAL_LANE_RECORD_VERSION, 0);
  hash.update(version);
  for (const [name, value] of [
    ['namespace', args.namespace],
    ['turnId', args.turnId],
    ['payloadHash', args.payloadHash],
  ] as const) {
    hash.update(lengthPrefixed(name));
    hash.update(lengthPrefixed(value));
  }
  return `plr_v${PRINCIPAL_LANE_RECORD_VERSION}_${hash.digest('hex')}`;
}

function validTurnId(turnId: string): boolean {
  return typeof turnId === 'string' && turnId.length > 0 && turnId.length <= 4096;
}

function validPayloadHash(payloadHash: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(payloadHash);
}

function validRecordId(recordId: string): boolean {
  return /^plr_v1_[a-f0-9]{64}$/.test(recordId);
}

function validDurableRecordLocator(locator: PrincipalLaneDurableRecordLocator): boolean {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return false;
  const keys = Object.keys(locator).sort();
  if (keys.join('\0') !== [
    'exactFileLength', 'namespace', 'namespaceVersion', 'payloadEncoding', 'payloadHash',
    'recordId', 'recordVersion', 'turnId',
  ].join('\0')) return false;
  return !!locator
    && typeof locator === 'object'
    && locator.namespaceVersion === PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION
    && /^plq_v1_[a-f0-9]{64}$/.test(locator.namespace)
    && locator.recordVersion === PRINCIPAL_LANE_RECORD_VERSION
    && validRecordId(locator.recordId)
    && validTurnId(locator.turnId)
    && locator.payloadEncoding === PRINCIPAL_LANE_RECORD_ENCODING
    && validPayloadHash(locator.payloadHash)
    && Number.isSafeInteger(locator.exactFileLength)
    && locator.exactFileLength > 0
    && locator.exactFileLength <= MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES;
}

function canonicalRecordEnvelopeBytes(envelope: PrincipalLaneRecordEnvelope): Buffer {
  return Buffer.from(canonicalJson(envelope), 'utf8');
}

function cleanupStagingBestEffort(stagingFile: string, recordsDir: string): void {
  try {
    unlinkSync(stagingFile);
    fsyncDirectory(recordsDir);
  } catch {
    // Staging files are never executable records. A later inventory/GC pass may
    // remove them after correlating durable admission tickets.
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function immutableRecordCapability(
  map: WeakMap<object, PrincipalLaneRecordCapabilityRecord>,
  handle: PrincipalLaneQueueHandle,
  locator: PrincipalLaneDurableRecordLocator,
): PrincipalLaneAppendReceipt | PrincipalLaneClaimedRecordCapability {
  const capability = Object.freeze({ version: PRINCIPAL_LANE_RECORD_VERSION });
  map.set(capability, { handle, locator: Object.freeze({ ...locator }) });
  return capability as PrincipalLaneAppendReceipt | PrincipalLaneClaimedRecordCapability;
}

/** Append one exact admission record. The deterministic final path is never
 * visible until a complete, fsynced staging inode is hard-linked into place. */
export function appendPrincipalLaneQueueRecord(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
  turnId: string,
  payload: LarkMessage,
): PrincipalLaneQueueResult<PrincipalLaneAppendReceipt> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  if (!validTurnId(turnId)) {
    return { status: 'invalid', reason: 'invalid_record_input' };
  }

  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
  } catch {
    return { status: 'invalid', reason: 'invalid_record_input' };
  }
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_PRINCIPAL_LANE_RECORD_PAYLOAD_BYTES) {
    return { status: 'invalid', reason: 'record_too_large' };
  }
  const payloadHash = hashPrincipalLanePayload(payloadBytes);
  const recordId = principalLaneRecordId({
    namespace: resolved.value.namespace,
    turnId,
    payloadHash,
  });
  const envelope: PrincipalLaneRecordEnvelope = {
    version: PRINCIPAL_LANE_RECORD_VERSION,
    recordId,
    turnId,
    payloadEncoding: PRINCIPAL_LANE_RECORD_ENCODING,
    payloadHash,
    payloadBase64: payloadBytes.toString('base64'),
  };
  const recordBytes = canonicalRecordEnvelopeBytes(envelope);
  if (recordBytes.length > MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES) {
    return { status: 'invalid', reason: 'record_too_large' };
  }
  const locator: PrincipalLaneDurableRecordLocator = {
    namespaceVersion: PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION,
    namespace: resolved.value.namespace,
    recordVersion: PRINCIPAL_LANE_RECORD_VERSION,
    recordId,
    turnId,
    payloadEncoding: PRINCIPAL_LANE_RECORD_ENCODING,
    payloadHash,
    exactFileLength: recordBytes.length,
  };
  let recordsDir: string;
  try {
    recordsDir = ensureDurablePrincipalLaneRecordsDir(resolved.value);
  } catch {
    return { status: 'retry', reason: 'record_io_failed' };
  }
  const finalFile = principalLaneRecordFile(resolved.value, recordId);
  let stagingFile: string | undefined;
  try {
    stagingFile = join(recordsDir, `.stage-${randomUUID()}.tmp`);
    const fd = openSync(stagingFile, 'wx', 0o600);
    try {
      writeAll(fd, recordBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(stagingFile, finalFile);
      fsyncDirectory(recordsDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP'
            || code === 'EOPNOTSUPP') {
          return { status: 'retry', reason: 'record_publish_unsupported' };
        }
        return { status: 'retry', reason: 'record_io_failed' };
      }
      const existingSize = statSync(finalFile).size;
      if (!Number.isSafeInteger(existingSize)
          || existingSize <= 0
          || existingSize > MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES
          || existingSize !== recordBytes.length) {
        return { status: 'quarantined', reason: 'record_conflict' };
      }
      const existing = readFileSync(finalFile);
      const existingBytes = Buffer.isBuffer(existing)
        ? existing
        : Buffer.from(String(existing), 'utf8');
      if (!existingBytes.equals(recordBytes)) {
        return { status: 'quarantined', reason: 'record_conflict' };
      }
      fsyncFile(finalFile);
      fsyncDirectory(recordsDir);
    }
    cleanupStagingBestEffort(stagingFile, recordsDir);
    stagingFile = undefined;
  } catch {
    return { status: 'retry', reason: 'record_io_failed' };
  } finally {
    if (stagingFile) cleanupStagingBestEffort(stagingFile, recordsDir);
  }
  return {
    status: 'ready',
    value: immutableRecordCapability(
      principalLaneAppendReceipts,
      handle,
      locator,
    ) as PrincipalLaneAppendReceipt,
  };
}

function exactRecordCapabilityRecord(
  capability: PrincipalLaneExactRecordCapability,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<PrincipalLaneRecordCapabilityRecord> {
  const record = principalLaneAppendReceipts.get(capability as object)
    ?? principalLaneClaimedRecordCapabilities.get(capability as object);
  if (!record) return { status: 'invalid', reason: 'invalid_capability' };
  const queue = principalLaneQueueRecord(record.handle, authority);
  if (queue.status !== 'ready') return queue;
  if (!validDurableRecordLocator(record.locator)
      || record.locator.namespace !== queue.value.namespace) {
    return { status: 'invalid', reason: 'invalid_capability' };
  }
  return { status: 'ready', value: record };
}

export function principalLaneAppendReceiptLocator(
  receipt: PrincipalLaneAppendReceipt,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<Readonly<PrincipalLaneDurableRecordLocator>> {
  const record = principalLaneAppendReceipts.get(receipt as object);
  if (!record) return { status: 'invalid', reason: 'invalid_capability' };
  const validated = exactRecordCapabilityRecord(receipt, authority);
  if (validated.status !== 'ready') return validated;
  return { status: 'ready', value: Object.freeze({ ...record.locator }) };
}

function parseExactRecord(
  bytes: Buffer,
  locator: Readonly<PrincipalLaneDurableRecordLocator>,
): PrincipalLaneQueueResult<LarkMessage> {
  if (bytes.length !== locator.exactFileLength
      || bytes.length === 0
      || bytes.length > MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES) {
    return { status: 'quarantined', reason: 'record_identity_mismatch' };
  }
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  const candidate = raw as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join('\0') !== [
    'payloadBase64', 'payloadEncoding', 'payloadHash', 'recordId', 'turnId', 'version',
  ].join('\0')) {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  if (candidate.version !== PRINCIPAL_LANE_RECORD_VERSION
      || candidate.recordId !== locator.recordId
      || candidate.turnId !== locator.turnId
      || candidate.payloadEncoding !== locator.payloadEncoding
      || candidate.payloadHash !== locator.payloadHash
      || typeof candidate.payloadBase64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        candidate.payloadBase64,
      )) {
    return { status: 'quarantined', reason: 'record_identity_mismatch' };
  }
  let canonicalEnvelope: string;
  try { canonicalEnvelope = canonicalJson(candidate); } catch {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  if (!Buffer.from(canonicalEnvelope, 'utf8').equals(bytes)) {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  const payloadBytes = Buffer.from(candidate.payloadBase64, 'base64');
  if (payloadBytes.length === 0
      || payloadBytes.length > MAX_PRINCIPAL_LANE_RECORD_PAYLOAD_BYTES
      || payloadBytes.toString('base64') !== candidate.payloadBase64
      || hashPrincipalLanePayload(payloadBytes) !== locator.payloadHash
      || principalLaneRecordId({
        namespace: locator.namespace,
        turnId: locator.turnId,
        payloadHash: locator.payloadHash,
      }) !== locator.recordId) {
    return { status: 'quarantined', reason: 'record_identity_mismatch' };
  }
  let payload: unknown;
  try {
    const text = payloadBytes.toString('utf8');
    payload = JSON.parse(text);
    if (canonicalJson(payload) !== text) {
      return { status: 'quarantined', reason: 'record_malformed' };
    }
  } catch {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'quarantined', reason: 'record_malformed' };
  }
  return { status: 'ready', value: payload as LarkMessage };
}

export function readExactPrincipalLaneQueueRecord(
  capability: PrincipalLaneExactRecordCapability,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<LarkMessage> {
  const resolved = exactRecordCapabilityRecord(capability, authority);
  if (resolved.status !== 'ready') return resolved;
  const queue = principalLaneQueueHandles.get(resolved.value.handle as object)!;
  let bytes: Buffer;
  try {
    const recordFile = principalLaneRecordFile(queue, resolved.value.locator.recordId);
    const size = statSync(recordFile).size;
    if (!Number.isSafeInteger(size)
        || size <= 0
        || size > MAX_PRINCIPAL_LANE_RECORD_FILE_BYTES
        || size !== resolved.value.locator.exactFileLength) {
      return { status: 'quarantined', reason: 'record_identity_mismatch' };
    }
    const raw = readFileSync(recordFile);
    bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  } catch {
    return { status: 'retry', reason: 'record_io_failed' };
  }
  return parseExactRecord(bytes, resolved.value.locator);
}

export interface PrincipalLaneRecordInventory {
  namespaceVersion: typeof PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION;
  namespace: string;
  records: Array<{ recordId: string; exactFileLength: number }>;
  staging: Array<{ name: string; exactFileLength: number }>;
}

/** Read-only inventory only. Orphan classification requires admission tickets
 * and deliberately remains outside this checkpoint. */
export function inventoryPrincipalLaneQueueRecords(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<PrincipalLaneRecordInventory> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  const recordsDir = principalLaneRecordsDir(resolved.value);
  if (!existsSync(recordsDir)) {
    return {
      status: 'ready',
      value: Object.freeze({
        namespaceVersion: PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION,
        namespace: resolved.value.namespace,
        records: Object.freeze([]) as unknown as PrincipalLaneRecordInventory['records'],
        staging: Object.freeze([]) as unknown as PrincipalLaneRecordInventory['staging'],
      }),
    };
  }
  try {
    const records: PrincipalLaneRecordInventory['records'] = [];
    const staging: PrincipalLaneRecordInventory['staging'] = [];
    for (const name of readdirSync(recordsDir)) {
      const size = statSync(join(recordsDir, name)).size;
      const final = /^(plr_v1_[a-f0-9]{64})\.json$/.exec(name);
      if (final) records.push({ recordId: final[1]!, exactFileLength: size });
      else if (/^\.stage-[a-f0-9-]+\.tmp$/.test(name)) {
        staging.push({ name, exactFileLength: size });
      }
    }
    records.sort((a, b) => a.recordId.localeCompare(b.recordId));
    staging.sort((a, b) => a.name.localeCompare(b.name));
    return {
      status: 'ready',
      value: Object.freeze({
        namespaceVersion: PRINCIPAL_LANE_QUEUE_NAMESPACE_VERSION,
        namespace: resolved.value.namespace,
        records: Object.freeze(records),
        staging: Object.freeze(staging),
      }) as PrincipalLaneRecordInventory,
    };
  } catch {
    return { status: 'retry', reason: 'record_io_failed' };
  }
}

/** Rehydrate through the admission resolver only. Checkpoint A intentionally
 * has no production ticket issuer; B-E will implement the durable verifier. */
export function rehydratePrincipalLaneClaimedRecordFromTicket(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
  ticket: PrincipalLaneAdmissionTicketCapability,
): PrincipalLaneQueueResult<PrincipalLaneClaimedRecordCapability> {
  const resolvedTicket = resolvePrincipalLaneTicketRecord(ticket, authority);
  if (resolvedTicket.status !== 'ready') {
    return { status: 'invalid', reason: 'invalid_capability' };
  }
  const locator = principalLaneTicketRecordLocator(resolvedTicket.value);
  if (!locator) return { status: 'invalid', reason: 'invalid_capability' };
  const queue = principalLaneQueueRecord(handle, authority);
  if (queue.status !== 'ready') return queue;
  if (!validDurableRecordLocator(locator) || locator.namespace !== queue.value.namespace) {
    return { status: 'invalid', reason: 'invalid_capability' };
  }
  const capability = immutableRecordCapability(
    principalLaneClaimedRecordCapabilities,
    handle,
    locator,
  ) as PrincipalLaneClaimedRecordCapability;
  const verified = readExactPrincipalLaneQueueRecord(capability, authority);
  if (verified.status !== 'ready') {
    principalLaneClaimedRecordCapabilities.delete(capability as object);
    return verified;
  }
  return { status: 'ready', value: capability };
}

function principalLaneQueueFile(record: PrincipalLaneQueueHandleRecord): string {
  return join(record.dir, 'messages.jsonl');
}

function principalLaneOffsetFile(record: PrincipalLaneQueueHandleRecord): string {
  return join(record.dir, 'offset');
}

function ensurePrincipalLaneQueueFile(
  record: PrincipalLaneQueueHandleRecord,
): PrincipalLaneQueueFailure | undefined {
  try {
    const queueFile = principalLaneQueueFile(record);
    if (!existsSync(queueFile)) {
      try {
        writeFileSync(queueFile, '', { encoding: 'utf8', flag: 'ax', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return undefined;
  } catch {
    return { status: 'retry', reason: 'queue_io_failed' };
  }
}

export function ensurePrincipalLaneQueue(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<undefined> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  const failure = ensurePrincipalLaneQueueFile(resolved.value);
  return failure ?? { status: 'ready', value: undefined };
}

export function appendPrincipalLaneMessage(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
  message: LarkMessage,
): PrincipalLaneQueueResult<undefined> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  const failure = ensurePrincipalLaneQueueFile(resolved.value);
  if (failure) return failure;
  try {
    appendFileSync(
      principalLaneQueueFile(resolved.value),
      `${JSON.stringify(message)}\n`,
      'utf8',
    );
    return { status: 'ready', value: undefined };
  } catch {
    return { status: 'retry', reason: 'queue_io_failed' };
  }
}

function readPrincipalLaneOffset(
  record: PrincipalLaneQueueHandleRecord,
): PrincipalLaneQueueResult<number> {
  const offsetFile = principalLaneOffsetFile(record);
  if (!existsSync(offsetFile)) return { status: 'ready', value: 0 };
  try {
    const raw = readFileSync(offsetFile, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return { status: 'quarantined', reason: 'invalid_offset' };
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return { status: 'quarantined', reason: 'invalid_offset' };
    }
    return { status: 'ready', value: offset };
  } catch {
    return { status: 'retry', reason: 'queue_io_failed' };
  }
}

export function getPrincipalLaneQueueOffset(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<number> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  return readPrincipalLaneOffset(resolved.value);
}

export function rewindPrincipalLaneQueue(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
  to = 0,
): PrincipalLaneQueueResult<undefined> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  if (!Number.isSafeInteger(to) || to < 0) {
    return { status: 'quarantined', reason: 'invalid_offset' };
  }
  try {
    atomicWriteFileSync(principalLaneOffsetFile(resolved.value), String(to));
    return { status: 'ready', value: undefined };
  } catch {
    return { status: 'retry', reason: 'queue_io_failed' };
  }
}

export function readPrincipalLaneUnread(
  handle: PrincipalLaneQueueHandle,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneQueueResult<LarkMessage[]> {
  const resolved = principalLaneQueueRecord(handle, authority);
  if (resolved.status !== 'ready') return resolved;
  const queueFile = principalLaneQueueFile(resolved.value);
  if (!existsSync(queueFile)) return { status: 'ready', value: [] };
  const offsetResult = readPrincipalLaneOffset(resolved.value);
  if (offsetResult.status !== 'ready') return offsetResult;
  let content: Buffer;
  try {
    const raw = readFileSync(queueFile);
    content = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  } catch {
    return { status: 'retry', reason: 'queue_io_failed' };
  }
  if (offsetResult.value > content.length) {
    return { status: 'quarantined', reason: 'invalid_offset' };
  }
  if (offsetResult.value === content.length) return { status: 'ready', value: [] };
  const messages: LarkMessage[] = [];
  for (const line of content.subarray(offsetResult.value).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'quarantined', reason: 'invalid_queue_record' };
      }
      messages.push(parsed as LarkMessage);
    } catch {
      return { status: 'quarantined', reason: 'invalid_queue_record' };
    }
  }
  if (messages.length > 0) {
    try {
      atomicWriteFileSync(principalLaneOffsetFile(resolved.value), String(content.length));
    } catch {
      return { status: 'retry', reason: 'queue_io_failed' };
    }
  }
  return { status: 'ready', value: messages };
}
