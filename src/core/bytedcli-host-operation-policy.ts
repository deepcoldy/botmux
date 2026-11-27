import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ensureBytedcliPrivateDirectory } from './bytedcli-broker-audit.js';
import { parseBytedcliOperationPolicy, type BytedcliOperationPolicy } from './bytedcli-operation-policy-config.js';

export interface BytedcliHostOperationPolicySnapshot {
  readonly policy?: BytedcliOperationPolicy;
  readonly revision: string;
  /** A present invalid/unsafe/unstable file is never the default policy. */
  readonly errorCode?: 'operation_policy_invalid';
}
/** Frozen credential-free projection shared by safe help and trusted hosts. */
export interface BytedcliFrozenOperationPolicy {
  readonly globalRevision: string;
  readonly globalPolicy?: BytedcliOperationPolicy;
  readonly botPolicy?: BytedcliOperationPolicy;
}
const MAX_BYTES = 32 * 1024;
const hash = (value: unknown): string => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const identity = (stat: BigIntStats) => [stat.dev.toString(), stat.ino.toString(), stat.mode.toString(), stat.uid.toString(), stat.gid.toString()];
const metadata = (stat: BigIntStats) => [...identity(stat), stat.nlink.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function owned(stat: BigIntStats): boolean { return !process.getuid || stat.uid === BigInt(process.getuid()); }
function fileStat(file: string): BigIntStats | undefined {
  try { return lstatSync(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Fixed host path only. Construction is inert in legacy modes; the first
 * strict read creates the safe private directory before taking its revision. */
export function createBytedcliHostOperationPolicyReader(privateRoot: string): () => BytedcliHostOperationPolicySnapshot {
  if (!isAbsolute(privateRoot) || resolve(privateRoot) !== privateRoot) {
    return () => Object.freeze({ revision: hash('invalid-root'), errorCode: 'operation_policy_invalid' });
  }
  const directory = join(privateRoot, 'policy'), file = join(directory, 'operation-policy.json');
  const ancestors: string[] = []; let cursor = directory;
  while (cursor !== parse(cursor).root) { ancestors.unshift(cursor); cursor = dirname(cursor); }
  const directories = () => ancestors.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || ([privateRoot, directory].includes(path) && ((stat.mode & 0o777n) !== 0o700n || !owned(stat)))) throw new Error('unsafe_policy_directory');
    return { path, stat };
  });
  const directoryState = (rows: ReturnType<typeof directories>) => rows.map(row => row.path === directory ? metadata(row.stat) : identity(row.stat));
  const invalid = (): BytedcliHostOperationPolicySnapshot => {
    // Error contents and host paths never leave this reader. Best-effort fixed
    // path lstat preserves an opaque state marker even for unsafe paths.
    const state = [privateRoot, directory, file].map(path => {
      try { const stat = fileStat(path); return stat ? metadata(stat) : null; } catch { return 'unreadable'; }
    });
    return Object.freeze({ revision: hash(['invalid', state]), errorCode: 'operation_policy_invalid' });
  };
  return () => {
    let fd: number | undefined;
    try {
      ensureBytedcliPrivateDirectory(privateRoot);
      ensureBytedcliPrivateDirectory(directory);
      const before = directories(), beforeFile = fileStat(file);
      const validFile = (stat: BigIntStats) => {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n
          || !owned(stat) || stat.size > BigInt(MAX_BYTES)) throw new Error('unsafe_policy_file');
      };
      let policy: BytedcliOperationPolicy | undefined;
      if (beforeFile) {
        validFile(beforeFile);
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = fstatSync(fd, { bigint: true }); validFile(opened);
        if (!same(metadata(beforeFile), metadata(opened))) throw new Error('unstable_policy_file');
        const bytes = Buffer.alloc(Number(opened.size) + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, count);
          if (!read) break;
          count += read;
        }
        if (count !== Number(opened.size) || !same(metadata(opened), metadata(fstatSync(fd, { bigint: true })))) throw new Error('unstable_policy_file');
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_policy_object');
        policy = parseBytedcliOperationPolicy(raw);
        if (!policy) throw new Error('invalid_policy_object');
      }
      const after = directories(), afterFile = fileStat(file);
      if (!same(directoryState(before), directoryState(after))
        || !same(beforeFile ? metadata(beforeFile) : null, afterFile ? metadata(afterFile) : null)) throw new Error('unstable_policy_path');
      const revision = hash([policy ?? null, directoryState(before),
        beforeFile ? metadata(beforeFile) : null]);
      return Object.freeze({ revision, ...(policy ? { policy } : {}) });
    } catch { return invalid(); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}
