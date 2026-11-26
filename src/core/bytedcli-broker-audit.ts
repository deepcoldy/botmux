import { constants, lstatSync, mkdirSync, openSync, fstatSync, fsyncSync, closeSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { BytedcliExecErrorCode, BytedcliExecOutcome } from '../cli/bytedcli-exec-protocol.js';

export interface BytedcliAuditRecord {
  readonly phase: 'intent' | 'result'; readonly daemonBootId: string; readonly botAppId: string;
  readonly sessionId: string; readonly turnId: string; readonly identityTurnId: string;
  readonly workerGeneration: number; readonly dispatchAttempt: number; readonly policyFingerprint: string;
  readonly requestId: string; readonly operationId: string; readonly catalogVersion: string;
  readonly effect: 'read' | 'write'; readonly accountFingerprint: string;
  readonly source: 'machine' | 'local' | 'platform'; readonly resources: Readonly<Record<string, string>>;
  readonly inputDigest: string; readonly timestamp: string;
  readonly outcome?: BytedcliExecOutcome; readonly errorCode?: BytedcliExecErrorCode;
  readonly durationMs?: number; readonly exitCode?: number; readonly upstreamRequestId?: string;
}
export interface BytedcliAuditSink { append(record: BytedcliAuditRecord): Promise<void> }

/** Reject symlinks in every path component. Preexisting authority roots must
 * already be private; this never repairs a caller-supplied unsafe directory. */
export function ensureBytedcliPrivateDirectory(path: string, sync: (fd: number) => void = fsyncSync): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_private_root');
  const ancestors: string[] = []; let cursor = path;
  while (cursor !== parse(cursor).root) { ancestors.unshift(cursor); cursor = dirname(cursor); }
  for (const dir of ancestors) {
    try { lstatSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { mkdirSync(dir, { mode: 0o700 }); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
    }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_private_root');
    // Existence is not proof that a previous mkdir's parent fsync succeeded.
    // Repeat the complete barrier on retry and after daemon reconstruction.
    for (const path of [dir, dirname(dir)]) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { sync(fd); } finally { closeSync(fd); }
    }
  }
  const stat = lstatSync(path);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_private_root');
}

const keys = ['phase', 'daemonBootId', 'botAppId', 'sessionId', 'turnId', 'identityTurnId', 'workerGeneration',
  'dispatchAttempt', 'policyFingerprint', 'requestId', 'operationId', 'catalogVersion', 'effect', 'accountFingerprint',
  'source', 'resources', 'inputDigest', 'timestamp', 'outcome', 'errorCode', 'durationMs', 'exitCode', 'upstreamRequestId'];
const resourceKeys = new Set(['repo', 'repoId', 'mr', 'mrId', 'spaceId', 'psm', 'head', 'base']);
function safeRecord(record: BytedcliAuditRecord): string {
  if (!record || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('unsafe_audit_record');
  if (!['intent', 'result'].includes(record.phase) || !['read', 'write'].includes(record.effect)
    || !['machine', 'local', 'platform'].includes(record.source)
    || !/^sha256:[A-Za-z0-9_-]+$/.test(record.accountFingerprint) || !/^sha256:[A-Za-z0-9_-]+$/.test(record.inputDigest)
    || !Number.isSafeInteger(record.workerGeneration) || !Number.isSafeInteger(record.dispatchAttempt)) throw new Error('unsafe_audit_record');
  for (const [key, value] of Object.entries(record)) {
    if (key === 'resources' || value === undefined) continue;
    if (typeof value === 'string' && (Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/.test(value)
      || /(?:https?:\/\/|Bearer\s|eyJ[A-Za-z0-9_-]+\.)/i.test(value))) throw new Error('unsafe_audit_record');
  }
  for (const [key, value] of Object.entries(record.resources)) {
    if (!resourceKeys.has(key) || typeof value !== 'string' || value.length > 256
      || !/^[A-Za-z0-9_./-]+$/.test(value)) throw new Error('unsafe_audit_resource');
  }
  const encoded = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(encoded) > 8192) throw new Error('unsafe_audit_record');
  return encoded;
}

/** Append+fsync serializes each line inside this daemon, without promising
 * cross-daemon transactions or cross-restart exactly-once execution. */
export class BytedcliBrokerAudit implements BytedcliAuditSink {
  constructor(private readonly root: string, private readonly sync: (fd: number) => void = fsyncSync) {}
  async append(record: BytedcliAuditRecord): Promise<void> {
    const bytes = Buffer.from(safeRecord(record)); ensureBytedcliPrivateDirectory(this.root, this.sync);
    const fd = openSync(join(this.root, 'audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_audit_file');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      this.sync(fd);
      const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { this.sync(directory); } finally { closeSync(directory); }
    } finally { closeSync(fd); }
  }
}
