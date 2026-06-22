/**
 * Unit tests for git-worktree: createRepoWorktree.
 *
 * Uses REAL git against temp repos (no network — the "remote" is a local
 * clone source), since worktree semantics are exactly what's under test.
 *
 * Run:  pnpm vitest run test/git-worktree.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRepoWorktree, removeRepoWorktree, slugFromWorktreeText } from '../src/services/git-worktree.js';
import { localWorktreeSlugFromContext } from '../src/services/worktree-slug-ai.js';

let tempRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A repo with one commit on `master`, usable as a clone source ("remote"). */
function makeUpstream(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir);
  git(dir, 'init', '-b', 'master');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

function makeClone(upstream: string, name: string): string {
  const dir = join(tempRoot, name);
  git(tempRoot, 'clone', upstream, dir);
  return dir;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'git-worktree-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('createRepoWorktree', () => {
  it('creates a sibling worktree wt/1 off origin/master for a clone', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo);

    expect(res.path).toBe(join(tempRoot, 'proj-wt-1'));
    expect(res.branch).toBe('wt/1');
    expect(res.baseRef).toBe('origin/master');
    expect(existsSync(join(res.path, '.git'))).toBe(true);
    expect(git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/1');
    // same commit as origin/master
    expect(git(res.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/master'));
  });

  it('picks up new upstream commits via fetch before branching', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    // advance the remote AFTER the clone — worktree must start from this
    git(upstream, 'commit', '--allow-empty', '-m', 'newer');
    const newer = git(upstream, 'rev-parse', 'HEAD');

    const res = await createRepoWorktree(repo);

    expect(git(res.path, 'rev-parse', 'HEAD')).toBe(newer);
  });

  it('auto-increments to wt/2 when wt/1 is taken', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    const first = await createRepoWorktree(repo);
    const second = await createRepoWorktree(repo);

    expect(first.branch).toBe('wt/1');
    expect(second.branch).toBe('wt/2');
    expect(second.path).toBe(join(tempRoot, 'proj-wt-2'));
  });

  it('uses a semantic slug for auto-named worktrees and increments on collisions', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    const first = await createRepoWorktree(repo, { slug: 'Fix Repo WT naming!' });
    const second = await createRepoWorktree(repo, { slug: 'Fix Repo WT naming!' });

    expect(first.branch).toBe('wt/fix-repo-wt-naming');
    expect(first.path).toBe(join(tempRoot, 'proj-wt-fix-repo-wt-naming'));
    expect(second.branch).toBe('wt/fix-repo-wt-naming-2');
    expect(second.path).toBe(join(tempRoot, 'proj-wt-fix-repo-wt-naming-2'));
  });

  it('skips a remote semantic branch instead of tracking it for auto-names', async () => {
    const upstream = makeUpstream('upstream');
    git(upstream, 'switch', '-c', 'wt/fix-repo-wt-naming');
    git(upstream, 'commit', '--allow-empty', '-m', 'remote semantic branch');
    git(upstream, 'switch', 'master');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo, { slug: 'Fix Repo WT naming!' });

    expect(res.branch).toBe('wt/fix-repo-wt-naming-2');
    expect(res.path).toBe(join(tempRoot, 'proj-wt-fix-repo-wt-naming-2'));
  });

  it('falls back to wt/N when the slug has no latin/digit tokens (all-CJK)', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo, { slug: '修复卡片重复点击' });

    expect(res.branch).toBe('wt/1');
    expect(res.path).toBe(join(tempRoot, 'proj-wt-1'));
  });

  it('uses an explicit new branch name (sanitized into the dir name)', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo, { branch: 'feat/foo' });

    expect(res.branch).toBe('feat/foo');
    expect(res.baseRef).toBe('origin/master');
    expect(res.path).toBe(join(tempRoot, 'proj-feat-foo'));
    expect(git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/foo');
  });

  it('uses an explicit worktree path when provided', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const target = join(tempRoot, 'feat-parent', 'proj');

    const res = await createRepoWorktree(repo, { branch: 'feat/group', worktreePath: target });

    expect(res.path).toBe(target);
    expect(res.branch).toBe('feat/group');
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/group');
  });

  it('removeRepoWorktree detaches the worktree dir so the slot is reusable (rollback)', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const target = join(tempRoot, 'rollback-parent', 'proj');
    const res = await createRepoWorktree(repo, { branch: 'feat/rollback', worktreePath: target });
    expect(existsSync(join(target, '.git'))).toBe(true);

    await removeRepoWorktree(repo, res.path);

    expect(existsSync(target)).toBe(false);
    // git no longer tracks the worktree, so the path is free for a retry
    expect(git(repo, 'worktree', 'list')).not.toContain(target);
  });

  it('checks out an existing local branch instead of recreating it', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    git(repo, 'branch', 'feat/existing');

    const res = await createRepoWorktree(repo, { branch: 'feat/existing' });

    expect(res.branch).toBe('feat/existing');
    expect(res.baseRef).toBe('feat/existing'); // not re-branched off origin
    expect(git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/existing');
  });

  it('creates a local tracking branch when the explicit branch exists only on origin', async () => {
    const upstream = makeUpstream('upstream');
    git(upstream, 'switch', '-c', 'feat/remote-only');
    git(upstream, 'commit', '--allow-empty', '-m', 'remote branch');
    const remoteHead = git(upstream, 'rev-parse', 'HEAD');
    git(upstream, 'switch', 'master');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo, { branch: 'feat/remote-only' });

    expect(res.branch).toBe('feat/remote-only');
    expect(res.baseRef).toBe('origin/feat/remote-only');
    expect(res.path).toBe(join(tempRoot, 'proj-feat-remote-only'));
    expect(git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/remote-only');
    expect(git(res.path, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(git(res.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/feat/remote-only');
  });

  it('names the worktree after the MAIN repo when given a linked worktree path', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const first = await createRepoWorktree(repo); // proj-wt-1

    // create FROM the linked worktree — placement/naming must follow `proj`,
    // not `proj-wt-1` (no proj-wt-1-wt-N)
    const second = await createRepoWorktree(first.path);

    expect(second.path).toBe(join(tempRoot, 'proj-wt-2'));
    expect(second.branch).toBe('wt/2');
  });

  it('falls back to HEAD for a repo without a remote', async () => {
    const repo = makeUpstream('standalone');

    const res = await createRepoWorktree(repo);

    expect(res.baseRef).toBe('HEAD');
    expect(res.branch).toBe('wt/1');
    expect(git(res.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('rejects when the target dir already exists', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    mkdirSync(join(tempRoot, 'proj-feat-x'));

    await expect(createRepoWorktree(repo, { branch: 'feat/x' }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects when the branch is already checked out in another worktree', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');

    await createRepoWorktree(repo, { branch: 'feat/busy' });
    // second worktree for the same branch → git refuses; target dir differs
    // (suffix collision is on the branch, not the path) so we hit git's error
    rmSync(join(tempRoot, 'proj-feat-busy'), { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    git(repo, 'worktree', 'add', join(tempRoot, 'elsewhere'), 'feat/busy');

    await expect(createRepoWorktree(repo, { branch: 'feat/busy' }))
      .rejects.toThrow(/feat\/busy|already/i);
  });

  it('rejects a non-repo directory', async () => {
    const plain = join(tempRoot, 'not-a-repo');
    mkdirSync(plain);

    await expect(createRepoWorktree(plain)).rejects.toThrow();
  });
});

describe('worktree semantic slug helpers', () => {
  it('prefers the title and falls back to the first prompt', () => {
    expect(localWorktreeSlugFromContext('Fix Repo WT naming!', 'first prompt')).toBe('fix-repo-wt-naming');
    expect(localWorktreeSlugFromContext('   ', 'Implement the picker')).toBe('implement-the-picker');
  });

  it('keeps latin tokens from mixed text and returns undefined for all-CJK', () => {
    expect(slugFromWorktreeText('新建 worktree 和分支')).toBe('worktree');
    expect(slugFromWorktreeText('看下新开工作树的命名逻辑')).toBeUndefined();
    expect(localWorktreeSlugFromContext('修复卡片重复点击')).toBeUndefined();
  });
});
