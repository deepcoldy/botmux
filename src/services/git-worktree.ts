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
import { existsSync, mkdirSync } from 'node:fs';
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

export interface CreateRepoWorktreeOptions {
  /** Explicit branch to check out/create. Takes precedence over `slug`. */
  branch?: string;
  /** Semantic auto-name seed; creates `wt/<slug>` and dir `<repo>-wt-<slug>`. */
  slug?: string;
  /** Explicit target directory. Used by multi-repo worktree groups. */
  worktreePath?: string;
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

async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  return (await tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repo)) !== null;
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
export function dirSuffixForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

/**
 * Build a git/filesystem-safe semantic slug from a session title or the first
 * prompt. Keep it ASCII so branch and directory names are portable. When the
 * source text has no latin/digit tokens (for example, all-CJK text), return
 * `undefined` so the caller falls back to the sequential `wt/N` naming rather
 * than an opaque hash.
 */
export function slugFromWorktreeText(text: string | undefined | null): string | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || undefined;
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
 * - No `branch` given, `slug` yields a latin slug → auto-pick `wt/<slug>`
 *   (or `-2` etc.), dir `<repo>-wt-<slug>`.
 * - No `branch`/`slug` (or a `slug` with no latin/digit tokens, e.g. all-CJK)
 *   → auto-pick `wt/N` (first free N), dir `<repo>-wt-N`.
 * - `branch` given and exists locally → check it out into the worktree.
 * - `branch` given and exists remotely → create a local tracking branch from it.
 * - `branch` given and new → create it from the remote default branch.
 *
 * The base ref is fetched first so the worktree starts from the remote's
 * latest state; fetch failure degrades to the local (possibly stale) ref.
 */
export async function createRepoWorktree(
  repoPath: string,
  opts: CreateRepoWorktreeOptions = {},
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
  const explicitPath = opts.worktreePath ? resolve(opts.worktreePath) : undefined;
  // Sanitize the auto-name seed up front: a slug with no latin/digit tokens
  // (e.g. all-CJK) collapses to nothing → fall through to the `wt/N` path
  // rather than throwing or emitting an opaque hash.
  const slug = branch ? undefined : slugFromWorktreeText(opts.slug);
  if (branch) {
    wtPath = explicitPath ?? join(parent, `${repoBase}-${dirSuffixForBranch(branch)}`);
    if (existsSync(wtPath)) throw new Error(`worktree target already exists: ${wtPath}`);
  } else if (slug) {
    if (explicitPath) {
      for (let n = 1;; n++) {
        if (n > 1000) throw new Error(`no free wt/${slug} slot under 1000`);
        const candidateSlug = n === 1 ? slug : `${slug}-${n}`;
        const candidateBranch = `wt/${candidateSlug}`;
        if ((await localBranchExists(repo, candidateBranch)) ||
          (await remoteBranchExists(repo, candidateBranch))) continue;
        branch = candidateBranch;
        wtPath = explicitPath;
        break;
      }
      if (existsSync(wtPath)) throw new Error(`worktree target already exists: ${wtPath}`);
    } else {
      for (let n = 1;; n++) {
        if (n > 1000) throw new Error(`no free wt/${slug} slot under 1000`);
        const candidateSlug = n === 1 ? slug : `${slug}-${n}`;
        const candidateBranch = `wt/${candidateSlug}`;
        const candPath = join(parent, `${repoBase}-${dirSuffixForBranch(candidateBranch)}`);
        if (existsSync(candPath) ||
          (await localBranchExists(repo, candidateBranch)) ||
          (await remoteBranchExists(repo, candidateBranch))) continue;
        branch = candidateBranch;
        wtPath = candPath;
        break;
      }
    }
  } else {
    if (explicitPath) {
      let n = 1;
      for (;; n++) {
        if (n > 1000) throw new Error('no free wt/N slot under 1000');
        if (await localBranchExists(repo, `wt/${n}`)) continue;
        branch = `wt/${n}`;
        wtPath = explicitPath;
        break;
      }
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
  }

  mkdirSync(dirname(wtPath), { recursive: true });

  if (await localBranchExists(repo, branch)) {
    // Existing branch: check it out as-is (git rejects it if the branch is
    // already checked out in another worktree — surface that error verbatim).
    await git(['worktree', 'add', wtPath, branch], repo, 60_000);
    logger.info(`[git-worktree] created ${wtPath} on existing branch ${branch}`);
    return { path: wtPath, branch, baseRef: branch };
  }

  if (opts.branch?.trim()) {
    try {
      await git(['fetch', 'origin', branch], repo, 30_000);
    } catch (e) {
      logger.warn(`[git-worktree] fetch origin ${branch} failed, checking local remote ref: ${e instanceof Error ? e.message : e}`);
    }

    const remoteRef = `origin/${branch}`;
    if (await remoteBranchExists(repo, branch)) {
      await git(['worktree', 'add', '-b', branch, '--track', wtPath, remoteRef], repo, 60_000);
      logger.info(`[git-worktree] created ${wtPath} tracking ${remoteRef}`);
      return { path: wtPath, branch, baseRef: remoteRef };
    }
  }

  await git(['worktree', 'add', '-b', branch, wtPath, baseRef], repo, 60_000);
  logger.info(`[git-worktree] created ${wtPath} (branch ${branch} from ${baseRef})`);
  return { path: wtPath, branch, baseRef };
}

/** Remove a worktree created by {@link createRepoWorktree}. Used to roll back the
 *  worktrees already built when a later repo in a multi-repo batch fails — leaves
 *  the branch in place (it may be a pre-existing branch we only checked out, and a
 *  dangling auto-named branch is harmless) and only detaches/deletes the worktree
 *  dir so a retry doesn't trip over "worktree target already exists". */
export async function removeRepoWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], repo, 30_000);
  logger.info(`[git-worktree] removed worktree ${worktreePath}`);
}
