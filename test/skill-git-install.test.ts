import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  discoverGitSkillCandidates,
  installGitSkill,
  installGitSkillAsync,
  installGitSkillsFromSourceAsync,
  readSkillRegistry,
  removeInstalledSkill,
  updateInstalledSkill,
  updateInstalledSkillAsync,
} from '../src/services/skill-registry-store.js';

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8' }).trim();
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function installedGitSourceDir(home: string): string {
  const sourcesDir = join(home, '.botmux', 'skills', 'sources');
  const entry = readdirSync(sourcesDir, { withFileTypes: true })
    .find(candidate => candidate.isDirectory() && !candidate.name.startsWith('.'));
  if (!entry) throw new Error('test git source cache missing');
  return join(sourcesDir, entry.name);
}

function installGithubGitShim(
  home: string,
  repo: string,
  mode: 'ssh-only' | 'stale-token-public' | 'cached-fetch',
): { url: string; logFile: string } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const binDir = join(home, 'bin');
  const fakeGit = join(binDir, 'git');
  const logFile = join(home, 'git-attempts.log');
  const repoName = mode === 'stale-token-public' ? 'public' : 'private';
  const url = `https://github.com/acme/${repoName}.git`;
  const sshUrl = `git@github.com:acme/${repoName}.git`;
  write(fakeGit, `#!/bin/sh
real="$BOTMUX_TEST_REAL_GIT"
repo="$BOTMUX_TEST_PRIVATE_REPO"
url="$BOTMUX_TEST_GITHUB_URL"
log="$BOTMUX_TEST_GIT_LOG"
mode="$BOTMUX_TEST_GIT_MODE"

fetch_local() {
  if [ "$2" = "--tags" ]; then
    exec "$real" fetch --tags --prune "$repo"
  fi
  exec "$real" fetch "$repo" "$3"
}

if [ "$1" = "clone" ] && [ "$3" = "$url" ]; then
  if [ "$mode" = "stale-token-public" ] && [ "\${GIT_CONFIG_COUNT:-0}" = "0" ]; then
    printf '%s\n' 'https-anonymous-clone' >> "$log"
    "$real" clone -- "$repo" "$4" || exit $?
    exec "$real" -C "$4" remote set-url origin "$url"
  fi
  if [ "$mode" = "cached-fetch" ] && [ "$BOTMUX_TEST_FORCE_HTTPS_FETCH_FAIL" != "1" ]; then
    printf '%s\n' 'https-authenticated-clone' >> "$log"
    "$real" clone -- "$repo" "$4" || exit $?
    exec "$real" -C "$4" remote set-url origin "$url"
  fi
  printf '%s\n' 'https-clone-auth-failed' >> "$log"
  echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
  exit 128
fi

if [ "$1" = "clone" ] && [ "$3" = "$BOTMUX_TEST_GITHUB_SSH_URL" ]; then
  printf '%s\n' 'ssh-clone' >> "$log"
  exec "$real" clone -- "$repo" "$4"
fi

if [ "$1" = "fetch" ]; then
  origin=$("$real" remote get-url origin)
  if [ "$origin" = "$url" ]; then
    if [ "$mode" = "stale-token-public" ] && [ "\${GIT_CONFIG_COUNT:-0}" = "0" ]; then
      printf '%s\n' 'https-anonymous-fetch' >> "$log"
      fetch_local "$@"
    fi
    if [ "$mode" = "cached-fetch" ] && [ "$BOTMUX_TEST_FORCE_HTTPS_FETCH_FAIL" != "1" ]; then
      printf '%s\n' 'https-authenticated-fetch' >> "$log"
      fetch_local "$@"
    fi
    printf '%s\n' 'https-fetch-auth-failed' >> "$log"
    echo "fatal: Authentication failed for '$url'" >&2
    exit 128
  fi
  if [ "$origin" = "$BOTMUX_TEST_GITHUB_SSH_URL" ]; then
    printf '%s\n' 'ssh-fetch' >> "$log"
    fetch_local "$@"
  fi
fi

exec "$real" "$@"
`);
  chmodSync(fakeGit, 0o755);
  vi.stubEnv('BOTMUX_TEST_REAL_GIT', realGit);
  vi.stubEnv('BOTMUX_TEST_PRIVATE_REPO', repo);
  vi.stubEnv('BOTMUX_TEST_GITHUB_URL', url);
  vi.stubEnv('BOTMUX_TEST_GITHUB_SSH_URL', sshUrl);
  vi.stubEnv('BOTMUX_TEST_GIT_LOG', logFile);
  vi.stubEnv('BOTMUX_TEST_GIT_MODE', mode);
  vi.stubEnv('GITHUB_TOKEN', 'ghp_test_only');
  // Make botmux's appended header observable without inheriting unrelated Git
  // config entries from the test runner.
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH}`);
  return { url, logFile };
}

describe('git skill install', () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-home-'));
    repo = mkdtempSync(join(tmpdir(), 'botmux-skill-repo-'));
    vi.stubEnv('HOME', home);
    run('git', ['init'], repo);
    run('git', ['config', 'user.email', 'botmux@example.com'], repo);
    run('git', ['config', 'user.name', 'botmux'], repo);
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n# Deploy');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'add deploy skill'], repo);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('installs a skill from git path and records the checked out commit', () => {
    const commit = run('git', ['rev-parse', 'HEAD'], repo);

    const pkg = installGitSkill({ url: repo, path: 'skills/deploy', ref: 'HEAD' });

    expect(pkg.name).toBe('deploy');
    expect(readSkillRegistry().skills.deploy.source).toMatchObject({
      type: 'git',
      url: repo,
      path: 'skills/deploy',
      ref: 'HEAD',
      commit,
    });
  });

  it('clones successfully when the daemon launch directory was deleted', () => {
    const originalCwd = process.cwd();
    const staleCwd = mkdtempSync(join(tmpdir(), 'botmux-stale-cwd-'));
    process.chdir(staleCwd);
    rmSync(staleCwd, { recursive: true, force: true });

    try {
      const pkg = installGitSkill({ url: repo, path: 'skills/deploy', ref: 'HEAD' });
      expect(pkg.name).toBe('deploy');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('falls back to SSH when a GitHub HTTPS clone needs authentication', () => {
    const { url, logFile } = installGithubGitShim(home, repo, 'ssh-only');

    const pkg = installGitSkill({
      url,
      path: 'skills/deploy',
      ref: 'HEAD',
    });

    expect(pkg.name).toBe('deploy');
    expect(pkg.source).toMatchObject({
      type: 'git',
      url,
    });
    expect(readFileSync(logFile, 'utf8')).toContain('ssh-clone');
  });

  it('retries public GitHub HTTPS without a stale token before SSH', () => {
    const { url, logFile } = installGithubGitShim(home, repo, 'stale-token-public');

    const pkg = installGitSkill({ url, path: 'skills/deploy', ref: 'HEAD' });

    expect(pkg.name).toBe('deploy');
    expect(readFileSync(logFile, 'utf8')).toContain('https-anonymous-clone');
    expect(readFileSync(logFile, 'utf8')).not.toContain('ssh-clone');
  });

  it('falls back cached synchronous HTTPS fetches to SSH', () => {
    const { url, logFile } = installGithubGitShim(home, repo, 'cached-fetch');
    installGitSkill({ url, path: 'skills/deploy', ref: 'HEAD' });
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: SSH Updated\n---\n# Deploy');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'update over ssh fallback'], repo);
    vi.stubEnv('BOTMUX_TEST_FORCE_HTTPS_FETCH_FAIL', '1');

    const result = updateInstalledSkill('deploy');

    expect(result.ok).toBe(true);
    expect(readSkillRegistry().skills.deploy.description).toBe('SSH Updated');
    expect(readFileSync(logFile, 'utf8')).toContain('ssh-fetch');
    expect(run('git', ['remote', 'get-url', 'origin'], installedGitSourceDir(home))).toBe(url);
  });

  it('falls back cached asynchronous HTTPS fetches to SSH', async () => {
    const { url, logFile } = installGithubGitShim(home, repo, 'cached-fetch');
    await installGitSkillAsync({ url, path: 'skills/deploy', ref: 'HEAD' });
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Async SSH Updated\n---\n# Deploy');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'async update over ssh fallback'], repo);
    vi.stubEnv('BOTMUX_TEST_FORCE_HTTPS_FETCH_FAIL', '1');

    const result = await updateInstalledSkillAsync('deploy');

    expect(result.ok).toBe(true);
    expect(readSkillRegistry().skills.deploy.description).toBe('Async SSH Updated');
    expect(readFileSync(logFile, 'utf8')).toContain('ssh-fetch');
    expect(run('git', ['remote', 'get-url', 'origin'], installedGitSourceDir(home))).toBe(url);
  });

  it('discovers skills from a git repository root', () => {
    write(join(repo, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\n# Review');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'add review skill'], repo);

    const discovered = discoverGitSkillCandidates({ url: repo, ref: 'HEAD' });

    expect(discovered.commit).toBe(run('git', ['rev-parse', 'HEAD'], repo));
    expect(discovered.skills.map(skill => [skill.name, skill.path])).toEqual([
      ['deploy', 'skills/deploy'],
      ['review', 'skills/review'],
    ]);
    expect(discovered.skills.find(skill => skill.name === 'review')?.description).toBe('Review code');
    expect(readdirSync(join(home, '.botmux', 'skills', 'sources'))).toEqual([]);
  });

  it('removes the throwaway checkout after async dashboard discovery', async () => {
    const { discoverGitSkillCandidatesAsync } = await import('../src/services/skill-registry-store.js');

    const discovered = await discoverGitSkillCandidatesAsync({ url: repo, ref: 'HEAD' });

    expect(discovered.skills.map(skill => skill.name)).toEqual(['deploy']);
    expect(readdirSync(join(home, '.botmux', 'skills', 'sources'))).toEqual([]);
  });

  it('installs the only discovered skill from a repository root', async () => {
    const [pkg] = await installGitSkillsFromSourceAsync({ url: repo, ref: 'HEAD' });

    expect(pkg.name).toBe('deploy');
    expect(readSkillRegistry().skills.deploy.source).toMatchObject({
      type: 'git',
      url: repo,
      path: 'skills/deploy',
    });
  });

  it('requires a selection when a repository root contains multiple skills', async () => {
    write(join(repo, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n# Review');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'add review skill'], repo);

    await expect(installGitSkillsFromSourceAsync({ url: repo, ref: 'HEAD' })).rejects.toThrow(/multiple_skills_found/);

    const packages = await installGitSkillsFromSourceAsync({ url: repo, ref: 'HEAD', skillNames: ['review'] });
    expect(packages.map(pkg => pkg.name)).toEqual(['review']);
    expect(readSkillRegistry().skills.review.source).toMatchObject({
      type: 'git',
      url: repo,
      path: 'skills/review',
    });
  });

  it('updates an installed git skill from its recorded source', () => {
    installGitSkill({ url: repo, path: 'skills/deploy', ref: 'HEAD' });
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Updated\n---\n# Deploy');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'update deploy skill'], repo);
    const commit = run('git', ['rev-parse', 'HEAD'], repo);

    const result = updateInstalledSkill('deploy');

    expect(result.ok).toBe(true);
    expect(readSkillRegistry().skills.deploy.description).toBe('Updated');
    expect(readSkillRegistry().skills.deploy.source).toMatchObject({ commit });
  });

  it('removes the store copy for git installs', () => {
    const pkg = installGitSkill({ url: repo, path: 'skills/deploy', ref: 'HEAD' });
    expect(existsSync(pkg.rootDir)).toBe(true);

    const result = removeInstalledSkill('deploy');

    expect(result).toEqual({ ok: true });
    expect(readSkillRegistry().skills.deploy).toBeUndefined();
    expect(existsSync(pkg.rootDir)).toBe(false);
  });

  it('rejects git skill paths outside the cached checkout', () => {
    expect(() => installGitSkill({ url: repo, path: '../deploy', ref: 'HEAD' })).toThrow(/invalid_git_skill_path/);
  });

  it('reports git_not_found when git is unavailable', () => {
    vi.stubEnv('PATH', join(home, 'missing-bin'));

    expect(() => installGitSkill({ url: repo, path: 'skills/deploy', ref: 'HEAD' })).toThrow(/^git_not_found$/);
  });

  it('rejects git skill paths that resolve outside through symlinks', () => {
    const outside = mkdtempSync(join(tmpdir(), 'botmux-skill-outside-'));
    write(join(outside, 'SKILL.md'), '---\nname: outside\n---\n# Outside');
    symlinkSync(outside, join(repo, 'skills', 'outside-link'));
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'add outside symlink'], repo);

    try {
      expect(() => installGitSkill({ url: repo, path: 'skills/outside-link', ref: 'HEAD' })).toThrow(/git_skill_path_outside_repo/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('supports async install and update for dashboard jobs', async () => {
    await installGitSkillAsync({ url: repo, path: 'skills/deploy', ref: 'HEAD' });
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Async Updated\n---\n# Deploy');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'async update deploy skill'], repo);

    const result = await updateInstalledSkillAsync('deploy');

    expect(result.ok).toBe(true);
    expect(readSkillRegistry().skills.deploy.description).toBe('Async Updated');
  });

  it('serializes concurrent async installs from the same git source', async () => {
    const firstCommit = run('git', ['rev-parse', 'HEAD'], repo);
    write(join(repo, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Updated\n---\n# Deploy');
    write(join(repo, 'skills', 'analyze', 'SKILL.md'), '---\nname: analyze\ndescription: Analyze\n---\n# Analyze');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'add analyze skill'], repo);
    const secondCommit = run('git', ['rev-parse', 'HEAD'], repo);

    const [deploy, analyze] = await Promise.all([
      installGitSkillAsync({ url: repo, path: 'skills/deploy', ref: firstCommit }),
      installGitSkillAsync({ url: repo, path: 'skills/analyze', ref: secondCommit }),
    ]);

    expect(deploy.name).toBe('deploy');
    expect(deploy.description).toBeUndefined();
    expect(deploy.source).toMatchObject({ type: 'git', commit: firstCommit });
    expect(analyze.name).toBe('analyze');
    expect(analyze.description).toBe('Analyze');
    expect(analyze.source).toMatchObject({ type: 'git', commit: secondCommit });
  });
});
