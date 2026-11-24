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

export function readCollabKickoffOperation(dataDir: string, targetLarkAppId: string, kickoffId: string): CollabKickoffOperationV1 | undefined {
  const fp = opPath(dataDir, targetLarkAppId, kickoffId);
  if (!existsSync(fp)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as CollabKickoffOperationV1;
  } catch {
    return undefined;
  }
}

function writeOperation(dataDir: string, targetLarkAppId: string, op: CollabKickoffOperationV1): void {
  const fp = opPath(dataDir, targetLarkAppId, op.kickoffId);
  mkdirSync(dirname(fp), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(fp, `${JSON.stringify(op, null, 2)}\n`, { mode: 0o600, durable: true });
}

export type CollabKickoffPrepareResult =
  | { ok: true; operation: CollabKickoffOperationV1 }
  | { ok: false; errorCode: 'OPERATION_CONFLICT'; message: string };

/**
 * prepare：幂等。重复 kickoffId + 同 payloadHash → 返回已有 operation；同 key 不同
 * payloadHash → OPERATION_CONFLICT。首次 → 建 operation(state=prepared)。
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
  const existing = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId);
  if (existing) {
    if (existing.payloadHash !== opts.payloadHash) {
      return { ok: false, errorCode: 'OPERATION_CONFLICT', message: 'payloadHash mismatch for same kickoffId' };
    }
    return { ok: true, operation: existing };
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

/** start：仅在持久化 {sessionId,turnId,acceptedAt} 后置 state='started' 并返回。 */
export function startCollabKickoff(opts: {
  dataDir: string;
  targetLarkAppId: string;
  kickoffId: string;
  sessionId: string;
  turnId: string;
  acceptedAt: string;
  now: string;
}): { ok: true; operation: CollabKickoffOperationV1 } | { ok: false; errorCode: string; message: string } {
  const existing = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId);
  if (!existing) return { ok: false, errorCode: 'OPERATION_NOT_FOUND', message: 'no prepared operation' };
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
  const existing = readCollabKickoffOperation(opts.dataDir, opts.targetLarkAppId, opts.kickoffId);
  if (!existing) return { ok: false, errorCode: 'OPERATION_NOT_FOUND', message: 'no operation' };
  if (existing.state === 'started') return { ok: false, errorCode: 'INVALID_STATE', message: 'already started, cannot cancel' };
  const op: CollabKickoffOperationV1 = { ...existing, state: 'cancelled', updatedAt: opts.now };
  writeOperation(opts.dataDir, opts.targetLarkAppId, op);
  return { ok: true, operation: op };
}
