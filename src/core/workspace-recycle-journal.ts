import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { canonicalWorkspacePath, pathInside, type WorkspaceIdentity } from './workspace-recycle-path.js';
import { WORKSPACE_RECYCLE_PROTOCOL, type WorkspaceSessionTarget } from './workspace-recycle-model.js';
import type { RecycleResources } from './workspace-recycle-resources.js';
import type { CloseSessionResult } from './worker-pool.js';

export interface RecyclePeer { larkAppId: string; sessionId: string }
export interface RecycleRequest {
  protocol: typeof WORKSPACE_RECYCLE_PROTOCOL;
  operationId: string;
  workspace: WorkspaceIdentity;
  target: WorkspaceSessionTarget;
  peers: RecyclePeer[];
  initiator?: RecyclePeer;
}

export interface RecycleJournal extends RecycleRequest {
  phase: 'prepared' | 'closing' | 'deferred' | 'closed' | 'blocked' | 'closed_with_residual' | 'aborted';
  inputStamp: string;
  before: RecycleResources;
  after?: RecycleResources;
  closeResult?: CloseSessionResult;
  blockers: string[];
  preparedAt: string;
  updatedAt: string;
  deferredUntil?: number;
}

export function recycleKey(peer: RecyclePeer): string {
  return createHash('sha256').update(JSON.stringify([peer.larkAppId, peer.sessionId])).digest('hex');
}

export function validateRecycleOperationId(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error('invalid_operation_id');
}

export function recycleJournalPath(dataDir: string, operationId: string, peer: RecyclePeer): string {
  validateRecycleOperationId(operationId);
  return join(dataDir, 'workspace-recycle', operationId, `${recycleKey(peer)}.json`);
}

export function assertRecycleStateOutsideWorkspace(dataDir: string, workspace: WorkspaceIdentity): void {
  if (pathInside(workspace.canonicalPath, canonicalWorkspacePath(dataDir))) throw new Error('recycle_state_inside_workspace');
}

export function persistRecycleJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { durable: true, mode: 0o600, followTargetSymlink: false });
}

export function readRecycleJournal(path: string): RecycleJournal | undefined {
  let parsed: RecycleJournal;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  validateRecycleRequest(parsed);
  if (!parsed.before || !Array.isArray(parsed.before.processes) || typeof parsed.inputStamp !== 'string'
      || !Array.isArray(parsed.blockers) || !['prepared', 'closing', 'deferred', 'closed', 'blocked', 'closed_with_residual', 'aborted'].includes(parsed.phase)) {
    throw new Error('invalid_recycle_journal');
  }
  return parsed;
}

export function validateRecycleRequest(value: unknown): asserts value is RecycleRequest {
  const r = value as RecycleRequest;
  if (!r || r.protocol !== WORKSPACE_RECYCLE_PROTOCOL) throw new Error('unsupported_recycle_protocol');
  validateRecycleOperationId(r.operationId);
  if (!r.workspace || typeof r.workspace.device !== 'string' || typeof r.workspace.inode !== 'string') throw new Error('invalid_workspace_identity');
  canonicalWorkspacePath(r.workspace.path);
  canonicalWorkspacePath(r.workspace.canonicalPath);
  const t = r.target;
  if (!t || ['sessionId', 'larkAppId', 'chatId', 'rootMessageId', 'createdAt', 'workingDir', 'canonicalWorkingDir'].some(key => typeof t[key as keyof WorkspaceSessionTarget] !== 'string')
      || !/^[a-f0-9]{64}$/.test(t.fingerprint) || t.evidence !== 'session.workingDir' || !['chat', 'thread'].includes(t.scope)) throw new Error('invalid_recycle_target');
  if (!pathInside(r.workspace.canonicalPath, t.canonicalWorkingDir)) throw new Error('target_outside_workspace');
  if (!Array.isArray(r.peers) || r.peers.length > 10_000 || r.peers.some(p => !p || typeof p.sessionId !== 'string' || typeof p.larkAppId !== 'string')
      || new Set(r.peers.map(recycleKey)).size !== r.peers.length
      || !r.peers.some(p => recycleKey(p) === recycleKey(t))) throw new Error('invalid_recycle_peers');
  if (r.initiator && !r.peers.some(p => recycleKey(p) === recycleKey(r.initiator!))) throw new Error('initiator_not_in_plan');
}

export function sameRecycleRequest(a: RecycleRequest, b: RecycleRequest): boolean {
  return a.operationId === b.operationId && JSON.stringify(a.workspace) === JSON.stringify(b.workspace)
    && a.target.fingerprint === b.target.fingerprint && recycleKey(a.target) === recycleKey(b.target)
    && JSON.stringify(a.peers) === JSON.stringify(b.peers) && JSON.stringify(a.initiator) === JSON.stringify(b.initiator);
}
