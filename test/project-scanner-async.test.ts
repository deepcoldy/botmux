import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanMultipleProjectsAsync } from '../src/services/project-scanner-async.js';
import { scanMultipleProjects } from '../src/services/project-scanner.js';

let tempRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'project-scanner-async-test-'));
  const repoPath = join(tempRoot, 'main-repo');
  const worktreePath = join(tempRoot, 'linked-worktree');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# scanner fixture\n');
  git(repoPath, 'add', 'README.md');
  git(
    repoPath,
    '-c', 'user.name=botmux-test',
    '-c', 'user.email=botmux-test@example.com',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', 'test fixture',
  );
  git(repoPath, 'worktree', 'add', '-b', 'feature/linked', worktreePath);
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('scanMultipleProjectsAsync', () => {
  it('matches the synchronous scanner for a real repo and linked worktree', async () => {
    const expected = scanMultipleProjects([tempRoot]);

    const actual = await scanMultipleProjectsAsync([tempRoot]);

    expect(expected.some(project => project.type === 'worktree')).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('preserves sync filtering and deduplication when worktrees are excluded', async () => {
    const options = { includeWorktrees: false };
    const expected = scanMultipleProjects([tempRoot, tempRoot], 3, options);

    const actual = await scanMultipleProjectsAsync([tempRoot, tempRoot], 3, options);

    expect(actual.every(project => project.type === 'repo')).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('keeps the event loop responsive while awaiting the scan', async () => {
    const expected = scanMultipleProjects([tempRoot]);
    let timerRan = false;
    const pending = scanMultipleProjectsAsync([tempRoot]);
    setTimeout(() => {
      timerRan = true;
    }, 0);

    const actual = await pending;

    expect(timerRan).toBe(true);
    expect(actual).toEqual(expected);
  });
});
