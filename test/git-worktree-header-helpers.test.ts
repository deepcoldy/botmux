/**
 * 话题指令头 `/repo wt` 依赖的两个 git-worktree 助手：
 *   - isValidBranchName：仓库里唯一的分支名合法性校验（git check-ref-format --branch）；
 *   - resolveWorktreePathForBranch：createRepoWorktree 显式分支时**将会**使用的目录，
 *     两者必须逐字一致，否则头部的「目标目录已存在」前置校验会查错地方。
 *
 * Run: bun run vitest run test/git-worktree-header-helpers.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRepoWorktree,
  isValidBranchName,
  resolveWorktreePathForBranch,
} from '../src/services/git-worktree.js';

let tempRoot: string;
let repo: string;

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

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'git-worktree-header-')));
  repo = join(tempRoot, 'proj');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('isValidBranchName', () => {
  it('accepts ordinary and slashed names', async () => {
    expect(await isValidBranchName('ci/temp_split')).toBe(true);
    expect(await isValidBranchName('feat-x.1')).toBe(true);
  });

  it('rejects what git check-ref-format rejects, plus option-looking names', async () => {
    for (const bad of ['a.lock', 'feat/', 'a..b', 'HEAD', 'x y', '-x', '', 'a//b', 'feat/.hidden']) {
      expect(await isValidBranchName(bad), bad).toBe(false);
    }
  });
});

describe('resolveWorktreePathForBranch', () => {
  it('matches the directory createRepoWorktree actually uses for an explicit branch', async () => {
    const predicted = await resolveWorktreePathForBranch(repo, 'ci/temp_split');
    expect(predicted).toBe(join(tempRoot, 'proj-ci-temp_split'));
    const created = await createRepoWorktree(repo, { branch: 'ci/temp_split' });
    expect(created.path).toBe(predicted);
  });

  it('normalises a linked worktree back to the main checkout', async () => {
    const linked = (await createRepoWorktree(repo, { branch: 'feat/from-linked' })).path;
    expect(await resolveWorktreePathForBranch(linked, 'feat/other')).toBe(join(tempRoot, 'proj-feat-other'));
  });

  it('throws for a non-git directory', async () => {
    const plain = join(tempRoot, 'plain');
    mkdirSync(plain);
    await expect(resolveWorktreePathForBranch(plain, 'x')).rejects.toThrow();
  });
});
