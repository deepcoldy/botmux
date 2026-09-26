import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  HumanLaneIdentityEvidence,
  PrincipalLaneSourceState,
  PrincipalLaneWorktreeProof,
} from '../types.js';
import {
  createRepoWorktreeAndCommit,
  mainWorktreeFor,
  worktreeRootFor,
} from '../services/git-worktree.js';
import { lanePrincipalKey } from './principal-lane-routing.js';

export interface PrincipalLaneWorktreeMaterialization {
  version: 1;
  materializationId: string;
  sourceSessionId: string;
  principalKey: string;
  workspaceEpoch: number;
  sourceCanonicalCwd: string;
  sourceRepoRoot: string;
  sourceGitCommonDir: string;
  sourceRelativeCwd: string;
  worktreeRoot: string;
  worktreeGitCommonDir: string;
  workingDir: string;
  branch: string;
  baseRef: string;
  createdAt: string;
}

export type PrincipalLaneWorktreeMaterializeResult<T> =
  | {
      status: 'ready';
      materialization: PrincipalLaneWorktreeMaterialization;
      value: T;
    }
  | {
      status: 'retry';
      reason: 'source_not_git' | 'source_subdir_missing' | 'worktree_create_failed';
      detail: string;
    }
  | {
      status: 'unknown';
      reason: 'publication_unknown';
      orphan: {
        worktreePath: string;
        branch: string;
        materializationId: string;
      };
      detail: string;
    };

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function containedRelativePath(value: string): boolean {
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function canonicalHumanPrincipalKey(identity: HumanLaneIdentityEvidence): string | undefined {
  const unionId = identity.unionId?.trim();
  if (unionId) return lanePrincipalKey({ senderType: 'user', kind: 'union', unionId });
  const openId = identity.openId?.trim();
  const larkAppId = identity.larkAppId?.trim();
  if (!openId || !larkAppId) return undefined;
  return lanePrincipalKey({ senderType: 'user', kind: 'app_open', larkAppId, openId });
}

function hashParts(domain: string, parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of [domain, '1', ...parts]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export interface PrincipalLaneGitIdentity {
  repoRoot: string;
  gitCommonDir: string;
  branch: string;
}

const execFileP = promisify(execFile);
let testOnlyBeforePrincipalLaneGitIdentity:
  | ((dir: string) => Promise<void> | void)
  | undefined;

export function __testOnly_setBeforePrincipalLaneGitIdentity(
  hook: ((dir: string) => Promise<void> | void) | undefined,
): void {
  testOnlyBeforePrincipalLaneGitIdentity = hook;
}

/** Re-read Git's own identity instead of trusting a persisted path or `.git`
 * marker. Child processes stay asynchronous so a slow checkout cannot block
 * unrelated lanes on the daemon event loop. */
export async function readPrincipalLaneGitIdentity(dir: string): Promise<PrincipalLaneGitIdentity> {
  const cwd = realpathSync(resolve(dir));
  await testOnlyBeforePrincipalLaneGitIdentity?.(cwd);
  const run = async (...args: string[]) => {
    const { stdout } = await execFileP('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
    });
    return stdout.trim();
  };
  const [rootText, commonDirText, branch] = await Promise.all([
    run('rev-parse', '--show-toplevel'),
    run('rev-parse', '--git-common-dir'),
    run('branch', '--show-current'),
  ]);
  const repoRoot = realpathSync(resolve(cwd, rootText));
  const gitCommonDir = realpathSync(resolve(cwd, commonDirText));
  return { repoRoot, gitCommonDir, branch };
}

export function principalLaneWorktreeMaterializationId(args: {
  sourceSessionId: string;
  principalKey: string;
  workspaceEpoch: number;
  sourceCanonicalCwd: string;
}): string {
  return `principal-lane-worktree:v1:${hashParts('botmux.principal-lane.worktree', [
    args.sourceSessionId,
    args.principalKey,
    String(args.workspaceEpoch),
    resolve(args.sourceCanonicalCwd),
  ])}`;
}

export function parsePrincipalLaneWorktreeProof(
  value: unknown,
  expected?: {
    sourceSessionId?: string;
    laneId?: string;
    sessionId?: string;
    principalKey?: string;
    workspaceEpoch?: number;
  },
): { ok: true; value: PrincipalLaneWorktreeProof } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'not_object' };
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.phase !== 'ready' || row.revision !== 1) {
    return { ok: false, error: 'unsupported_version_or_phase' };
  }
  for (const key of [
    'materializationId', 'sourceSessionId', 'laneId', 'sessionId', 'principalKey',
    'sourceCanonicalCwd', 'sourceRepoRoot', 'sourceGitCommonDir', 'worktreeRoot',
    'worktreeGitCommonDir', 'workingDir', 'branch',
    'baseRef', 'createdAt', 'updatedAt',
  ]) {
    if (!nonempty(row[key])) return { ok: false, error: `invalid_${key}` };
  }
  if (!Number.isSafeInteger(row.workspaceEpoch) || Number(row.workspaceEpoch) < 1) {
    return { ok: false, error: 'invalid_workspace_epoch' };
  }
  if (typeof row.sourceRelativeCwd !== 'string' || !containedRelativePath(row.sourceRelativeCwd)) {
    return { ok: false, error: 'invalid_source_relative_cwd' };
  }
  if (!canonicalIso(row.createdAt) || !canonicalIso(row.updatedAt)
      || Date.parse(row.updatedAt) < Date.parse(row.createdAt)) {
    return { ok: false, error: 'invalid_timestamp' };
  }
  for (const key of [
    'sourceCanonicalCwd', 'sourceRepoRoot', 'sourceGitCommonDir', 'worktreeRoot',
    'worktreeGitCommonDir', 'workingDir',
  ] as const) {
    if (!isAbsolute(row[key] as string) || resolve(row[key] as string) !== row[key]) {
      return { ok: false, error: `noncanonical_${key}` };
    }
  }
  if (resolve(row.worktreeRoot as string, row.sourceRelativeCwd as string) !== row.workingDir) {
    return { ok: false, error: 'working_dir_mismatch' };
  }
  if (resolve(row.sourceRepoRoot as string, row.sourceRelativeCwd as string)
      !== row.sourceCanonicalCwd) {
    return { ok: false, error: 'source_dir_mismatch' };
  }
  const proof = row as unknown as PrincipalLaneWorktreeProof;
  if ((expected?.sourceSessionId && proof.sourceSessionId !== expected.sourceSessionId)
      || (expected?.laneId && proof.laneId !== expected.laneId)
      || (expected?.sessionId && proof.sessionId !== expected.sessionId)
      || (expected?.principalKey && proof.principalKey !== expected.principalKey)
      || (expected?.workspaceEpoch && proof.workspaceEpoch !== expected.workspaceEpoch)) {
    return { ok: false, error: 'authority_mismatch' };
  }
  if (proof.materializationId !== principalLaneWorktreeMaterializationId(proof)) {
    return { ok: false, error: 'materialization_id_mismatch' };
  }
  if (proof.worktreeRoot === proof.sourceRepoRoot
      || proof.sourceGitCommonDir !== proof.worktreeGitCommonDir
      || proof.workingDir === proof.sourceCanonicalCwd) {
    return { ok: false, error: 'worktree_not_isolated' };
  }
  return { ok: true, value: structuredClone(proof) };
}

export async function materializePrincipalLaneWorktree<T>(args: {
  sourceSessionId: string;
  source: PrincipalLaneSourceState;
  identity: HumanLaneIdentityEvidence;
  now?: string;
  commit: (materialization: PrincipalLaneWorktreeMaterialization) => Promise<T> | T;
}): Promise<PrincipalLaneWorktreeMaterializeResult<T>> {
  const principalKey = canonicalHumanPrincipalKey(args.identity);
  if (!principalKey || args.identity.larkAppId !== args.source.displayTarget.larkAppId) {
    return { status: 'retry', reason: 'worktree_create_failed', detail: 'invalid human lane identity' };
  }
  const sourceCanonicalCwd = resolve(args.source.canonicalCwd);
  let containingRoot: string | null;
  try { containingRoot = await worktreeRootFor(sourceCanonicalCwd); }
  catch (error) {
    return {
      status: 'retry', reason: 'source_not_git',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!containingRoot) {
    return { status: 'retry', reason: 'source_not_git', detail: sourceCanonicalCwd };
  }
  const sourceRelativeCwd = relative(containingRoot, sourceCanonicalCwd);
  if (!containedRelativePath(sourceRelativeCwd)) {
    return { status: 'retry', reason: 'source_subdir_missing', detail: sourceCanonicalCwd };
  }
  let sourceRepoRoot: string;
  let sourceGitCommonDir: string;
  try {
    sourceRepoRoot = realpathSync(await mainWorktreeFor(containingRoot));
    const sourceGit = await readPrincipalLaneGitIdentity(sourceRepoRoot);
    if (sourceGit.repoRoot !== sourceRepoRoot) throw new Error('source repo root mismatch');
    sourceGitCommonDir = sourceGit.gitCommonDir;
  }
  catch (error) {
    return {
      status: 'retry', reason: 'source_not_git',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const materializationId = principalLaneWorktreeMaterializationId({
    sourceSessionId: args.sourceSessionId,
    principalKey,
    workspaceEpoch: args.source.workspaceEpoch,
    sourceCanonicalCwd,
  });
  const suffix = materializationId.slice(-16);
  const branch = `wt/principal-lane-${suffix}`;
  const worktreePath = join(
    dirname(sourceRepoRoot),
    `${basename(sourceRepoRoot)}-wt-principal-lane-${suffix}`,
  );
  try {
    const committed = await createRepoWorktreeAndCommit(
      sourceRepoRoot,
      { branch, worktreePath, reuseExisting: true, ignoreRemoteBranch: true },
      async creation => {
        const worktreeRoot = realpathSync(creation.path);
        const observedMain = realpathSync(await mainWorktreeFor(worktreeRoot));
        const worktreeGit = await readPrincipalLaneGitIdentity(worktreeRoot);
        if (observedMain !== sourceRepoRoot || worktreeRoot === sourceRepoRoot
            || worktreeGit.repoRoot !== worktreeRoot
            || worktreeGit.gitCommonDir !== sourceGitCommonDir
            || worktreeGit.branch !== branch
            || creation.branch !== branch) {
          throw new Error('materialized worktree identity mismatch');
        }
        const workingDirCandidate = resolve(worktreeRoot, sourceRelativeCwd);
        if (!existsSync(workingDirCandidate)) {
          throw new Error(`source subdirectory missing from worktree: ${sourceRelativeCwd}`);
        }
        const workingDir = realpathSync(workingDirCandidate);
        if (relative(worktreeRoot, workingDir).startsWith('..')) {
          throw new Error('materialized working directory escapes worktree');
        }
        const createdAt = args.now ?? new Date().toISOString();
        if (!canonicalIso(createdAt)) throw new Error('invalid materialization timestamp');
        const materialization: PrincipalLaneWorktreeMaterialization = {
          version: 1,
          materializationId,
          sourceSessionId: args.sourceSessionId,
          principalKey,
          workspaceEpoch: args.source.workspaceEpoch,
          sourceCanonicalCwd,
          sourceRepoRoot,
          sourceGitCommonDir,
          sourceRelativeCwd,
          worktreeRoot,
          worktreeGitCommonDir: worktreeGit.gitCommonDir,
          workingDir,
          branch,
          baseRef: creation.baseRef,
          createdAt,
        };
        return { materialization, value: await args.commit(materialization) };
      },
    );
    return { status: 'ready', ...committed.result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (existsSync(worktreePath)) {
      return {
        status: 'unknown',
        reason: 'publication_unknown',
        orphan: { worktreePath, branch, materializationId },
        detail,
      };
    }
    return {
      status: 'retry',
      reason: detail.includes('source subdirectory missing')
        ? 'source_subdir_missing'
        : 'worktree_create_failed',
      detail,
    };
  }
}
