import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
