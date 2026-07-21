import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionRowEnrichmentCaches,
  enrichSessionRowsForPresentation,
  getBotAvatarByAppId,
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

describe('getBotAvatarByAppId', () => {
  it('maps larkAppId → avatar URL from bots-info.json', () => {
    const dataDir = tempDir('botmux-enrich-data-');
    writeFileSync(
      join(dataDir, 'bots-info.json'),
      JSON.stringify([
        { larkAppId: 'cli_a', botAvatarUrl: 'https://img.example/a.png' },
        { larkAppId: 'cli_b', botAvatarUrl: null },
        { larkAppId: 'cli_c' },
      ]),
    );
    const map = getBotAvatarByAppId(dataDir);
    expect(map.get('cli_a')).toBe('https://img.example/a.png');
    expect(map.has('cli_b')).toBe(false);
    expect(map.has('cli_c')).toBe(false);
  });

  it('returns an empty map when bots-info.json is missing or corrupt', () => {
    const dataDir = tempDir('botmux-enrich-data-');
    expect(getBotAvatarByAppId(dataDir).size).toBe(0);
    writeFileSync(join(dataDir, 'bots-info.json'), '{nope');
    expect(getBotAvatarByAppId(dataDir).size).toBe(0);
  });
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

describe('enrichSessionRowsForPresentation', () => {
  it('stamps avatar + repo/branch; passes untouched rows through by identity', async () => {
    const dataDir = tempDir('botmux-enrich-data-');
    writeFileSync(
      join(dataDir, 'bots-info.json'),
      JSON.stringify([{ larkAppId: 'cli_a', botAvatarUrl: 'https://img.example/a.png' }]),
    );
    const repo = initRepo('main');
    const plain = tempDir('botmux-enrich-plain-');

    const rich = { sessionId: 's1', larkAppId: 'cli_a', workingDir: repo };
    const plainRow = { sessionId: 's2', larkAppId: 'cli_zzz', workingDir: plain };
    const bare = { sessionId: 's3' };
    const [r1, r2, r3] = await enrichSessionRowsForPresentation([rich, plainRow, bare], dataDir);

    expect(r1.botAvatarUrl).toBe('https://img.example/a.png');
    expect(r1.repoName).toBe(repo.split('/').pop());
    expect(r1.gitBranch).toBe('main');
    expect(r2.botAvatarUrl).toBeUndefined();
    expect(r2.repoName).toBeUndefined();
    expect(r2).toBe(plainRow);
    expect(r3).toBe(bare);
  });
});
