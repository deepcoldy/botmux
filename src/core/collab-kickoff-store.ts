/**
 * collab.kickoff target-owned durable operation store（PR-3a，§7.1）。
 *
 * 照 dispatch-launch-admission-store 模式：per-kickoffId 文件、tmp+rename+0600+fsync、
 * 单 writer（target daemon）。operation 状态机 preparing/prepared/starting/started/failed/
 * cancelled。幂等：重复 kickoffId + 同 payloadHash 返回原 operation；同 key 不同 payloadHash
 * → OPERATION_CONFLICT。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const COLLAB_KICKOFF_OPERATION_SCHEMA_VERSION = 1;
const KICKOFF_ID_RE = /^[0-9a-f]{64}$/;

export type CollabKickoffState = 'preparing' | 'prepared' | 'starting' | 'started' | 'failed' | 'cancelled';

export interface CollabKickoffOperationV1 {
  schemaVersion: 1;
  kickoffId: string;
  initId: string;
  sourceLarkAppId: string;
  targetLarkAppId: string;
  appId: string;
  chatId: string;
  configVersion: string;
  payloadHash: string;
  state: CollabKickoffState;
  sessionId?: string;
  turnId?: string;
  acceptedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function kickoffDir(dataDir: string, targetLarkAppId: string): string {
  return join(dataDir, 'collab-kickoff', 'operations', targetLarkAppId);
}

function opPath(dataDir: string, targetLarkAppId: string, kickoffId: string): string {
  if (!KICKOFF_ID_RE.test(kickoffId)) throw new Error('invalid collab kickoff id');
  return join(kickoffDir(dataDir, targetLarkAppId), `${kickoffId}.json`);
}

export type CollabKickoffReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupted'; message: string }
  | { kind: 'ok'; operation: CollabKickoffOperationV1 };

function parseOperation(raw: string, kickoffId: string): { ok: true; operation: CollabKickoffOperationV1 } | { ok: false; message: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) { return { ok: false, message: `JSON 损坏: ${err instanceof Error ? err.message : String(err)}` }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, message: 'operation 非对象' };
  const op = parsed as CollabKickoffOperationV1;
  if (op.schemaVersion !== 1) return { ok: false, message: 'schemaVersion 不符' };
  if (op.kickoffId !== kickoffId) return { ok: false, message: 'operation kickoffId 不匹配' };
  if (typeof op.initId !== 'string' || !/^[0-9a-f]{64}$/.test(op.initId)) return { ok: false, message: 'initId 非法' };
  if (!op.payloadHash || !op.configVersion) return { ok: false, message: 'operation 缺 payloadHash/configVersion' };
  return { ok: true, operation: op };
}

/**
 * F4：只有 ENOENT 判 missing；读错 / JSON 错 / schema 或身份不符返回 corrupted，
 * 调用方不得覆盖旧文件重新 prepare。
 */
export function readCollabKickoffOperation(dataDir: string, targetLarkAppId: string, kickoffId: string): CollabKickoffOperationV1 | undefined;
export function readCollabKickoffOperation(dataDir: string, targetLarkAppId: string, kickoffId: string, strict: true): CollabKickoffReadResult;
export function readCollabKickoffOperation(dataDir: string, targetLarkAppId: string, kickoffId: string, strict?: true): CollabKickoffOperationV1 | undefined | CollabKickoffReadResult {
  const fp = opPath(dataDir, targetLarkAppId, kickoffId);
  let exists: boolean;
  try { exists = existsSync(fp); } catch { exists = false; }
  if (!exists) return strict ? { kind: 'missing' } : undefined;
  let raw: string;
  try {
    raw = readFileSync(fp, 'utf-8');
  } catch (err) {
    if (strict) return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) };
    return undefined;
  }
  const parsed = parseOperation(raw, kickoffId);
  if (!parsed.ok) {
    if (strict) return { kind: 'corrupted', message: parsed.message };
    return undefined;
  }
  return strict ? { kind: 'ok', operation: parsed.operation } : parsed.operation;
}

function writeOperation(dataDir: string, targetLarkAppId: string, op: CollabKickoffOperationV1): void {
  const fp = opPath(dataDir, targetLarkAppId, op.kickoffId);
  mkdirSync(dirname(fp), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(fp, `${JSON.stringify(op, null, 2)}\n`, { mode: 0o600, durable: true });
}

export type CollabKickoffPrepareResult =
  | { ok: true; operation: CollabKickoffOperationV1 }
  | { ok: false; errorCode: 'OPERATION_CONFLICT' | 'OPERATION_CORRUPTED'; message: string };

/**
 * prepare：幂等。重复 kickoffId + 同 payloadHash → 返回已有 operation；同 key 不同
 * payloadHash → OPERATION_CONFLICT；已有 operation 损坏 → OPERATION_CORRUPTED（不覆盖）。
 * 首次 → 建 operation(state=prepared)。
 */
export function prepareCollabKickoff(opts: {
  dataDir: string;
  sourceLarkAppId: string;
  targetLarkAppId: string;
  kickoffId: string;
  initId: string;
  appId: string;
  chatId: string;
  configVersion: string;
  payloadHash: string;
  now: string;
}): CollabKickoffPrepareResult {
  const read = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId, true);
  if (read.kind === 'corrupted') {
    // F4：损坏的旧记录不得被覆盖，保留原文件 fail-closed。
    return { ok: false, errorCode: 'OPERATION_CORRUPTED', message: read.message };
  }
  if (read.kind === 'ok') {
    if (read.operation.payloadHash !== opts.payloadHash) {
      return { ok: false, errorCode: 'OPERATION_CONFLICT', message: 'payloadHash mismatch for same kickoffId' };
    }
    return { ok: true, operation: read.operation };
  }
  const op: CollabKickoffOperationV1 = {
    schemaVersion: 1,
    kickoffId: opts.kickoffId,
    initId: opts.initId,
    sourceLarkAppId: opts.sourceLarkAppId,
    targetLarkAppId: opts.targetLarkAppId,
    appId: opts.appId,
    chatId: opts.chatId,
    configVersion: opts.configVersion,
    payloadHash: opts.payloadHash,
    state: 'prepared',
    createdAt: opts.now,
    updatedAt: opts.now,
  };
  writeOperation(opts.dataDir, opts.targetLarkAppId, op);
  return { ok: true, operation: op };
}

/** start：仅在持久化**有效非空** {sessionId,turnId,acceptedAt} 后置 state='started' 并返回。 */
export function startCollabKickoff(opts: {
  dataDir: string;
  targetLarkAppId: string;
  kickoffId: string;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  now: string;
}): { ok: true; operation: CollabKickoffOperationV1 } | { ok: false; errorCode: string; message: string } {
  // F1：三元组任一空 → 拒绝置 started（fail-closed），保持 prepared。
  if (!opts.sessionId || !opts.turnId || !opts.acceptedAt) {
    return { ok: false, errorCode: 'NOT_READY', message: 'sessionId/turnId/acceptedAt must be non-empty before started' };
  }
  const read = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId, true);
  if (read.kind === 'corrupted') return { ok: false, errorCode: 'OPERATION_CORRUPTED', message: read.message };
  if (read.kind === 'missing') return { ok: false, errorCode: 'OPERATION_NOT_FOUND', message: 'no prepared operation' };
  const existing = read.operation;
  if (existing.state === 'started') return { ok: true, operation: existing };
  if (existing.state !== 'prepared' && existing.state !== 'starting') {
    return { ok: false, errorCode: 'INVALID_STATE', message: `cannot start from ${existing.state}` };
  }
  const op: CollabKickoffOperationV1 = {
    ...existing,
    state: 'started',
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    acceptedAt: opts.acceptedAt,
    updatedAt: opts.now,
  };
  writeOperation(opts.dataDir, opts.targetLarkAppId, op);
  return { ok: true, operation: op };
}

/** cancel：置 cancelled。 */
export function cancelCollabKickoff(opts: {
  dataDir: string;
  targetLarkAppId: string;
  kickoffId: string;
  now: string;
}): { ok: true; operation: CollabKickoffOperationV1 } | { ok: false; errorCode: string; message: string } {
  const read = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId, true);
  if (read.kind === 'corrupted') return { ok: false, errorCode: 'OPERATION_CORRUPTED', message: read.message };
  if (read.kind === 'missing') return { ok: false, errorCode: 'OPERATION_NOT_FOUND', message: 'no operation' };
  const existing = read.operation;
  if (existing.state === 'started') return { ok: false, errorCode: 'INVALID_STATE', message: 'already started, cannot cancel' };
  const op: CollabKickoffOperationV1 = { ...existing, state: 'cancelled', updatedAt: opts.now };
  writeOperation(opts.dataDir, opts.targetLarkAppId, op);
  return { ok: true, operation: op };
}
