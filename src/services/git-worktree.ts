/**
 * Git worktree creation for repo selection — "pick a repo, open it as a
 * fresh worktree". Creates a linked worktree next to the repo, branched off
 * the remote default branch (origin/master / origin/main), so each session
 * can get an isolated checkout without touching the main one.
 *
 * Async (execFile) on purpose: a `git fetch` can take many seconds and this
 * runs inside the daemon's event loop.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

const execFileP = promisify(execFile);

export interface WorktreeCreation {
  /** Absolute path of the new worktree. */
  path: string;
  /** Local branch checked out in the worktree. */
  branch: string;
  /** Ref the branch was created from (e.g. `origin/master`); equals `branch`
   *  when an existing local branch was checked out instead. */
  baseRef: string;
}

async function git(args: string[], cwd: string, timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: timeoutMs, encoding: 'utf-8' });
    return stdout.trim();
  } catch (e: any) {
    const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
    throw new Error(stderr || e?.message || String(e));
  }
}

async function tryGit(args: string[], cwd: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    return await git(args, cwd, timeoutMs);
  } catch {
    return null;
  }
}

async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  return (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)) !== null;
}

/** The remote default branch (`origin/master` / `origin/main`), or `HEAD`
 *  for repos without a usable remote. `origin/HEAD` is only set on clone, so
 *  fall through to probing the usual names when it's missing. */
async function resolveBaseRef(repo: string): Promise<string> {
  const originHead = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
  if (originHead) return originHead;
  for (const cand of ['origin/master', 'origin/main']) {
    if ((await tryGit(['rev-parse', '--verify', '--quiet', cand], repo)) !== null) return cand;
  }
  return 'HEAD';
}

/** Branch names may contain `/` etc. — flatten to a filesystem-safe suffix. */
function dirSuffixForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A linked worktree resolves to its repo's MAIN checkout (entry 0 of
 *  `git worktree list`), so sibling placement and `<repo>-…` naming follow
 *  the main repo no matter which checkout the caller picked. */
async function resolveMainWorktree(dir: string): Promise<string> {
  const out = await tryGit(['worktree', 'list', '--porcelain'], dir);
  const first = out?.split('\n').find(l => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : dir;
}

/**
 * Create a linked worktree for `repoPath`, as a sibling of the repo's MAIN
 * checkout (a linked-worktree input is resolved back to the main one first).
 *
 * - No `branch` given → auto-pick `wt/N` (first free N), dir `<repo>-wt-N`.
 * - `branch` given and exists locally → check it out into the worktree.
 * - `branch` given and new → create it from the remote default branch.
 *
 * The base ref is fetched first so the worktree starts from the remote's
 * latest state; fetch failure degrades to the local (possibly stale) ref.
 */
export async function createRepoWorktree(
  repoPath: string,
  opts: { branch?: string } = {},
): Promise<WorktreeCreation> {
  const startDir = resolve(repoPath);
  await git(['rev-parse', '--git-dir'], startDir); // not a repo → throw early
  const repo = await resolveMainWorktree(startDir);

  const baseRef = await resolveBaseRef(repo);
  if (baseRef.startsWith('origin/')) {
    const remoteBranch = baseRef.slice('origin/'.length);
    try {
      await git(['fetch', 'origin', remoteBranch], repo, 30_000);
    } catch (e) {
      logger.warn(`[git-worktree] fetch origin ${remoteBranch} failed, using local ref: ${e instanceof Error ? e.message : e}`);
    }
  }

  const parent = dirname(repo);
  const repoBase = basename(repo);

  let branch = opts.branch?.trim() ?? '';
  let wtPath: string;
  if (branch) {
    wtPath = join(parent, `${repoBase}-${dirSuffixForBranch(branch)}`);
    if (existsSync(wtPath)) throw new Error(`worktree target already exists: ${wtPath}`);
  } else {
    let n = 1;
    for (;; n++) {
      if (n > 1000) throw new Error('no free wt/N slot under 1000');
      const candPath = join(parent, `${repoBase}-wt-${n}`);
      if (existsSync(candPath) || (await localBranchExists(repo, `wt/${n}`))) continue;
      branch = `wt/${n}`;
      wtPath = candPath;
      break;
    }
  }

  if (await localBranchExists(repo, branch)) {
    // Existing branch: check it out as-is (git rejects it if the branch is
    // already checked out in another worktree — surface that error verbatim).
    await git(['worktree', 'add', wtPath, branch], repo, 60_000);
    logger.info(`[git-worktree] created ${wtPath} on existing branch ${branch}`);
    return { path: wtPath, branch, baseRef: branch };
  }

  await git(['worktree', 'add', '-b', branch, wtPath, baseRef], repo, 60_000);
  logger.info(`[git-worktree] created ${wtPath} (branch ${branch} from ${baseRef})`);
  return { path: wtPath, branch, baseRef };
}
