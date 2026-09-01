import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  clearSessionRowEnrichmentCaches,
  getGitRepoInfo,
} from '../src/core/session-row-enrichment.js';

let dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(branch: string): string {
  const dir = tempDir('botmux-enrich-repo-');
  git(['init', '-q'], dir);
  git(['checkout', '-q', '-b', branch], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], dir);
  return dir;
}

beforeEach(() => clearSessionRowEnrichmentCaches());
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('getGitRepoInfo', () => {
  it('resolves repo name + branch for a git workdir', async () => {
    const repo = initRepo('feat/enrich-x');
    const info = await getGitRepoInfo(repo);
    expect(info?.repoName).toBe(repo.split('/').pop());
    expect(info?.branch).toBe('feat/enrich-x');
  });

  it('resolves from a subdirectory of the repo', async () => {
    const repo = initRepo('main');
    const sub = join(repo, 'a/b');
    mkdirSync(sub, { recursive: true });
    const info = await getGitRepoInfo(sub);
    expect(info?.repoName).toBe(repo.split('/').pop());
    expect(info?.branch).toBe('main');
  });

  it('returns null branch for detached HEAD', async () => {
    const repo = initRepo('main');
    git(['checkout', '-q', '--detach', 'HEAD'], repo);
    const info = await getGitRepoInfo(repo);
    expect(info?.repoName).toBeTruthy();
    expect(info?.branch).toBeNull();
  });

  it('force-refreshes a branch change inside the positive cache TTL', async () => {
    const repo = initRepo('main');
    expect((await getGitRepoInfo(repo))?.branch).toBe('main');
    git(['checkout', '-q', '-b', 'feat/live'], repo);

    expect((await getGitRepoInfo(repo))?.branch).toBe('main');
    expect((await getGitRepoInfo(repo, { force: true }))?.branch).toBe('feat/live');
    expect((await getGitRepoInfo(repo))?.branch).toBe('feat/live');
  });

  it('returns null for non-repo dirs and caches the miss', async () => {
    const plain = tempDir('botmux-enrich-plain-');
    expect(await getGitRepoInfo(plain)).toBeNull();
    // Second call must be served from cache (no throw, still null).
    expect(await getGitRepoInfo(plain)).toBeNull();
  });

  it('returns null for empty/missing cwd without spawning git', async () => {
    expect(await getGitRepoInfo('')).toBeNull();
    expect(await getGitRepoInfo('   ')).toBeNull();
  });
});
