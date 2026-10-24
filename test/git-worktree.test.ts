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
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRepoWorktree, removeRepoWorktree, resolveDeletedWorktreeOrigin, restoreDeletedWorktree, slugFromWorktreeText, worktreeRootFor, worktreeSafetyStatus } from '../src/services/git-worktree.js';
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
  // git worktree canonicalizes macOS /var temp paths to /private/var.
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'git-worktree-test-')));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

  it('reuses an existing explicit worktree only when its repo and branch match', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const target = join(tempRoot, 'shared-topic', 'proj');
    const first = await createRepoWorktree(repo, { branch: 'feat/shared', worktreePath: target });

    const reused = await createRepoWorktree(repo, {
      branch: 'feat/shared',
      worktreePath: target,
      reuseExisting: true,
    });

    expect(reused).toEqual({ path: target, branch: 'feat/shared', baseRef: 'feat/shared' });
    expect(git(repo, 'worktree', 'list').split('\n').filter(line => line.includes(target))).toHaveLength(1);
    expect(first.path).toBe(reused.path);
  });

  it('refuses to reuse an explicit path checked out on a different branch', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const target = join(tempRoot, 'shared-topic', 'proj');
    await createRepoWorktree(repo, { branch: 'feat/other', worktreePath: target });

    await expect(createRepoWorktree(repo, {
      branch: 'feat/shared',
      worktreePath: target,
      reuseExisting: true,
    })).rejects.toThrow('not feat/shared in the expected repository');
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

  it('can reserve a deterministic explicit branch without adopting a same-named remote', async () => {
    const upstream = makeUpstream('upstream');
    const masterHead = git(upstream, 'rev-parse', 'HEAD');
    git(upstream, 'switch', '-c', 'wt/host-owned');
    git(upstream, 'commit', '--allow-empty', '-m', 'unrelated remote branch');
    const remoteHead = git(upstream, 'rev-parse', 'HEAD');
    git(upstream, 'switch', 'master');
    const repo = makeClone(upstream, 'proj');

    const res = await createRepoWorktree(repo, {
      branch: 'wt/host-owned',
      worktreePath: join(tempRoot, 'host-owned-target'),
      ignoreRemoteBranch: true,
    });

    expect(res.baseRef).toBe('origin/master');
    expect(git(res.path, 'rev-parse', 'HEAD')).toBe(masterHead);
    expect(git(res.path, 'rev-parse', 'HEAD')).not.toBe(remoteHead);
    expect(() => git(
      res.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
    )).toThrow();
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

describe('worktreeRootFor', () => {
  it('resolves a nested directory to its containing linked worktree root', async () => {
    const upstream = makeUpstream('root-upstream');
    const repo = makeClone(upstream, 'root-proj');
    const wt = await createRepoWorktree(repo);
    const nested = join(wt.path, 'nested', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(await worktreeRootFor(nested)).toBe(wt.path);
    expect(await worktreeRootFor(wt.path)).toBe(wt.path);
    expect(await worktreeRootFor(repo)).toBe(repo);
  });
});

describe('worktreeSafetyStatus', () => {
  it('detects ignored files without recursively enumerating ignored directories', async () => {
    const repo = makeUpstream('ignored-safety');
    writeFileSync(join(repo, '.gitignore'), 'secret.env\ncache/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore local data');
    writeFileSync(join(repo, 'secret.env'), 'secret\n');
    mkdirSync(join(repo, 'cache'));
    writeFileSync(join(repo, 'cache', 'a.txt'), 'a\n');
    writeFileSync(join(repo, 'cache', 'b.txt'), 'b\n');

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles).toContain('secret.env');
    expect(status.dirtyFiles).toContain('cache/');
    expect(status.dirtyFiles).not.toContain('cache/a.txt');
    expect(status.uncommittedCount).toBe(0);
    expect(status.uncommittedFiles).toEqual([]);
    expect(status.ignoredCount).toBe(2);
    expect(status.ignoredFiles).toEqual(expect.arrayContaining(['secret.env', 'cache/']));
  });

  it('fingerprints ignored directories whose expanded status exceeds the child-process buffer', async () => {
    const repo = makeUpstream('large-ignored-status');
    writeFileSync(join(repo, '.gitignore'), 'cache/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore generated cache');
    const component = 'd'.repeat(120);
    const cache = join(repo, 'cache', component, component, component);
    mkdirSync(cache, { recursive: true });
    for (let i = 0; i < 2_500; i++) {
      const name = `entry-${String(i).padStart(4, '0')}-${'x'.repeat(100)}`;
      writeFileSync(join(cache, name), '');
    }

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.uncommittedCount).toBe(0);
    expect(status.ignoredCount).toBe(1);
    expect(status.ignoredFiles).toEqual(['cache/']);
    expect(status.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fingerprints an ignored directory symlink without following its target', async () => {
    const repo = makeUpstream('ignored-symlink-safety');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore dependencies');
    const firstTarget = join(tempRoot, 'dependencies-v1');
    const secondTarget = join(tempRoot, 'dependencies-v2');
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    const firstTargetFile = join(firstTarget, 'package.json');
    writeFileSync(firstTargetFile, '{"version":1}\n');
    writeFileSync(join(secondTarget, 'package.json'), '{"version":2}\n');
    const link = join(repo, 'node_modules');
    symlinkSync(firstTarget, link, 'dir');

    const first = await worktreeSafetyStatus(repo);
    writeFileSync(firstTargetFile, '{"version":3}\n');
    const targetContentChanged = await worktreeSafetyStatus(repo);
    unlinkSync(link);
    symlinkSync(secondTarget, link, 'dir');
    const retargeted = await worktreeSafetyStatus(repo);

    expect(first.dirtyFiles).toContain('node_modules');
    expect(first.uncommittedFiles).toEqual([]);
    expect(first.ignoredFiles).toContain('node_modules');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(targetContentChanged.fingerprint).toBe(first.fingerprint);
    expect(retargeted.fingerprint).not.toBe(first.fingerprint);
  });

  it('detects untracked files even when git config hides them', async () => {
    const repo = makeUpstream('untracked-safety');
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirtyFiles).toContain('new.txt');
    expect(status.uncommittedFiles).toContain('new.txt');
    expect(status.ignoredFiles).toEqual([]);
  });

  it('reports the full dirty count while bounding file examples', async () => {
    const repo = makeUpstream('many-dirty-files');
    for (let i = 0; i < 25; i++) writeFileSync(join(repo, `dirty-${i}.txt`), `${i}\n`);

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirtyCount).toBe(25);
    expect(status.dirtyFiles).toHaveLength(20);
  });

  it('preserves the full path for an unstaged modification', async () => {
    const repo = makeUpstream('safety-status');
    const file = join(repo, 'first-character.ts');
    writeFileSync(file, 'initial\n');
    git(repo, 'add', 'first-character.ts');
    git(repo, 'commit', '-m', 'add file');
    writeFileSync(file, 'changed\n');

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirtyFiles).toEqual(['first-character.ts']);
  });

  it('fingerprints a tracked deletion without treating the missing path as a scan error', async () => {
    const repo = makeUpstream('deleted-fingerprint');
    const file = join(repo, 'deleted.txt');
    writeFileSync(file, 'base\n');
    git(repo, 'add', 'deleted.txt');
    git(repo, 'commit', '-m', 'add tracked file');
    rmSync(file);

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirtyFiles).toEqual(['deleted.txt']);
    expect(status.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the fingerprint when staged content changes but the worktree bytes stay the same', async () => {
    const repo = makeUpstream('index-fingerprint');
    const file = join(repo, 'staged.txt');
    writeFileSync(file, 'base\n');
    git(repo, 'add', 'staged.txt');
    git(repo, 'commit', '-m', 'add tracked file');
    writeFileSync(file, 'first staged value\n');
    git(repo, 'add', 'staged.txt');
    writeFileSync(file, 'same worktree value\n');
    const first = await worktreeSafetyStatus(repo);

    writeFileSync(file, 'second staged value\n');
    git(repo, 'add', 'staged.txt');
    writeFileSync(file, 'same worktree value\n');
    const second = await worktreeSafetyStatus(repo);

    expect(second.dirtyFiles).toEqual(first.dirtyFiles);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('handles porcelain-quoted non-ASCII paths and fingerprints their content', async () => {
    const repo = makeUpstream('quoted-path-fingerprint');
    const file = join(repo, '中文.txt');
    writeFileSync(file, 'first\n');
    const first = await worktreeSafetyStatus(repo);

    writeFileSync(file, 'second\n');
    const second = await worktreeSafetyStatus(repo);

    expect(first.dirtyFiles).toContain('中文.txt');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('fingerprints a conflicted index without requiring write-tree', async () => {
    const repo = makeUpstream('conflicted-index');
    const file = join(repo, 'conflict.txt');
    writeFileSync(file, 'base\n');
    git(repo, 'add', 'conflict.txt');
    git(repo, 'commit', '-m', 'add conflict file');
    git(repo, 'checkout', '-b', 'other');
    writeFileSync(file, 'other\n');
    git(repo, 'commit', '-am', 'other change');
    git(repo, 'checkout', 'master');
    writeFileSync(file, 'master\n');
    git(repo, 'commit', '-am', 'master change');
    try { git(repo, 'merge', 'other'); } catch { /* expected conflict */ }

    const status = await worktreeSafetyStatus(repo);

    expect(status.dirtyFiles).toContain('conflict.txt');
    expect(status.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the fingerprint when an already-dirty file content changes', async () => {
    const repo = makeUpstream('content-fingerprint');
    const file = join(repo, 'dirty.txt');
    writeFileSync(file, 'base\n');
    git(repo, 'add', 'dirty.txt');
    git(repo, 'commit', '-m', 'add tracked file');
    writeFileSync(file, 'first value\n');
    const first = await worktreeSafetyStatus(repo);

    writeFileSync(file, 'second value\n');
    const second = await worktreeSafetyStatus(repo);

    expect(second.dirtyFiles).toEqual(first.dirtyFiles);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('changes the fingerprint when a submodule index changes but its worktree bytes stay the same', async () => {
    const subOrigin = makeUpstream('submodule-index-origin');
    const tracked = join(subOrigin, 'tracked.txt');
    writeFileSync(tracked, 'base\n');
    git(subOrigin, 'add', 'tracked.txt');
    git(subOrigin, 'commit', '-m', 'add tracked file');

    const repo = makeUpstream('submodule-index-parent');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/sub');
    git(repo, 'commit', '-m', 'add submodule');
    const nestedFile = join(repo, 'vendor/sub/tracked.txt');
    writeFileSync(nestedFile, 'first staged value\n');
    git(join(repo, 'vendor/sub'), 'add', 'tracked.txt');
    writeFileSync(nestedFile, 'same worktree value\n');
    const first = await worktreeSafetyStatus(repo);

    writeFileSync(nestedFile, 'second staged value\n');
    git(join(repo, 'vendor/sub'), 'add', 'tracked.txt');
    writeFileSync(nestedFile, 'same worktree value\n');
    const second = await worktreeSafetyStatus(repo);

    expect(second.dirtyFiles).toEqual(first.dirtyFiles);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('changes the fingerprint when an ignored directory file changes inside an initialized submodule', async () => {
    const subOrigin = makeUpstream('submodule-ignored-dir-origin');
    writeFileSync(join(subOrigin, '.gitignore'), 'cache/\n');
    git(subOrigin, 'add', '.gitignore');
    git(subOrigin, 'commit', '-m', 'ignore local cache');

    const repo = makeUpstream('submodule-ignored-dir-parent');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/sub');
    git(repo, 'commit', '-m', 'add submodule');
    const cache = join(repo, 'vendor/sub/cache');
    mkdirSync(cache);
    const cached = join(cache, 'state.json');
    writeFileSync(cached, '{"value":1}\n');
    const first = await worktreeSafetyStatus(repo);

    writeFileSync(cached, '{"value":2}\n');
    const second = await worktreeSafetyStatus(repo);

    expect(first.dirtyFiles).toContain('vendor/sub/cache/');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('detects ignored files inside an initialized submodule', async () => {
    const subOrigin = makeUpstream('submodule-origin');
    writeFileSync(join(subOrigin, '.gitignore'), 'secret.env\n');
    git(subOrigin, 'add', '.gitignore');
    git(subOrigin, 'commit', '-m', 'ignore local secret');

    const repo = makeUpstream('submodule-parent');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/sub');
    git(repo, 'commit', '-m', 'add submodule');
    const secret = join(repo, 'vendor/sub/secret.env');
    writeFileSync(secret, 'local\n');
    const status = await worktreeSafetyStatus(repo);

    writeFileSync(secret, 'changed\n');
    const changed = await worktreeSafetyStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles).toContain('vendor/sub/secret.env');
    expect(changed.fingerprint).not.toBe(status.fingerprint);
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

describe('deleted worktree recovery', () => {
  it('reads the branch off a registration that rm -rf left behind, then rebuilds it in place', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const created = await createRepoWorktree(repo, { branch: 'wt/review-pr-1809-cd' });
    writeFileSync(join(created.path, 'note.txt'), 'kept');
    git(created.path, 'add', 'note.txt');
    git(created.path, 'commit', '-m', 'work');
    rmSync(created.path, { recursive: true, force: true });

    const origin = await resolveDeletedWorktreeOrigin(created.path);
    expect(origin).toEqual({ repo, branch: 'wt/review-pr-1809-cd' });

    const rebuilt = await restoreDeletedWorktree(origin!, created.path);
    expect(rebuilt.path).toBe(created.path);
    expect(rebuilt.branch).toBe('wt/review-pr-1809-cd');
    expect(existsSync(join(created.path, 'note.txt'))).toBe(true);
    expect(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/review-pr-1809-cd');
  });

  it('only clears the rebuilt path, leaving other stale registrations alone', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const a = await createRepoWorktree(repo, { branch: 'feat/a' });
    const b = await createRepoWorktree(repo, { branch: 'feat/b' });
    rmSync(a.path, { recursive: true, force: true });
    rmSync(b.path, { recursive: true, force: true });

    await restoreDeletedWorktree({ repo, branch: 'feat/a' }, a.path);
    const listing = git(repo, 'worktree', 'list', '--porcelain');
    expect(listing).toContain(`worktree ${b.path}`);
  });

  it('matches the branch by directory suffix once the registration was pruned', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    const created = await createRepoWorktree(repo, { branch: 'wt/botmux-claude-review-pr-1809-cd' });
    rmSync(created.path, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');

    expect(await resolveDeletedWorktreeOrigin(created.path)).toEqual({
      repo,
      branch: 'wt/botmux-claude-review-pr-1809-cd',
    });
  });

  it('does not let a sibling linked worktree with a shorter name claim the path', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    // `proj-wt` is itself a linked worktree; `proj-wt-x` belongs to `proj`.
    await createRepoWorktree(repo, { branch: 'side', worktreePath: join(tempRoot, 'proj-wt') });
    const target = await createRepoWorktree(repo, { branch: 'wt/x' });
    expect(target.path).toBe(join(tempRoot, 'proj-wt-x'));
    rmSync(target.path, { recursive: true, force: true });

    expect(await resolveDeletedWorktreeOrigin(target.path)).toEqual({ repo, branch: 'wt/x' });
  });

  it('returns null when no sibling main checkout owns the name', async () => {
    expect(await resolveDeletedWorktreeOrigin(join(tempRoot, 'nothing-wt-here'))).toBeNull();
  });

  it('returns null when two branches flatten to the same directory suffix', async () => {
    const upstream = makeUpstream('upstream');
    const repo = makeClone(upstream, 'proj');
    git(repo, 'branch', 'wt/a-b');
    git(repo, 'branch', 'wt-a/b');
    expect(await resolveDeletedWorktreeOrigin(join(tempRoot, 'proj-wt-a-b'))).toBeNull();
  });
});
