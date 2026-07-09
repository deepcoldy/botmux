import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDispatchRepoRequirement,
  inspectLocalRepo,
  listRepoCapabilities,
  normalizeRepoRemote,
  parseDispatchRepoRequirement,
  rememberRepoCapability,
  resolveRepoRequirement,
} from '../src/core/repo-requirement.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `botmux-${label}-`));
  roots.push(root);
  return root;
}

function git(path: string, ...args: string[]): void {
  execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' });
}

function makeRepo(root: string, name: string, remote: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, 'remote', 'add', 'origin', remote);
  return path;
}

describe('dispatch repo requirement wire format', () => {
  it('formats, parses, and strips the machine block from worker input', () => {
    const block = formatDispatchRepoRequirement({
      taskId: 'task-repo-1',
      repo: 'git@github.com:acme/project.git',
    });
    const parsed = parseDispatchRepoRequirement(`完成登录模块并自测\n\n${block}`);
    expect(parsed).toEqual({
      taskId: 'task-repo-1',
      repo: 'git@github.com:acme/project.git',
      content: '完成登录模块并自测',
    });
  });

  it('normalizes HTTPS, SSH URL, and scp-like remotes to the same identity', () => {
    expect(normalizeRepoRemote('https://github.com/Acme/project.git')).toBe('github.com/Acme/project');
    expect(normalizeRepoRemote('ssh://git@github.com/Acme/project.git')).toBe('github.com/Acme/project');
    expect(normalizeRepoRemote('git@github.com:Acme/project.git')).toBe('github.com/Acme/project');
  });
});

describe('receiver-side repository preflight', () => {
  it('accepts a matching repo on the local machine', () => {
    const root = tempRoot('repo-local');
    const dataDir = tempRoot('repo-local-data');
    const path = makeRepo(root, 'project', 'git@github.com:acme/project.git');

    const result = resolveRepoRequirement({
      requirement: 'https://github.com/acme/project.git',
      scanDirs: [root],
      dataDir,
    });

    expect(result).toMatchObject({ ok: true, path, remoteIdentity: 'github.com/acme/project', source: 'scan' });
    expect(listRepoCapabilities(dataDir)).toEqual([expect.objectContaining({
      remoteUrl: 'github.com/acme/project',
      remoteIdentity: 'github.com/acme/project',
    })]);
  });

  it('resolves the same project to a different path on a remote machine', () => {
    const senderRoot = tempRoot('repo-sender');
    const receiverRoot = tempRoot('repo-receiver');
    const dataDir = tempRoot('repo-receiver-data');
    makeRepo(senderRoot, 'sender-checkout', 'https://git.example.com/team/project.git');
    const receiverPath = makeRepo(receiverRoot, 'different-local-name', 'git@git.example.com:team/project.git');

    const result = resolveRepoRequirement({
      requirement: 'https://git.example.com/team/project',
      scanDirs: [receiverRoot],
      dataDir,
    });

    expect(result).toMatchObject({ ok: true, path: receiverPath, matchedBy: 'remote' });
  });

  it('prefers an explicitly configured linked worktree over the main checkout', () => {
    const root = tempRoot('repo-worktree-main');
    const worktreeRoot = tempRoot('repo-worktree-feature');
    const dataDir = tempRoot('repo-worktree-data');
    const mainPath = makeRepo(root, 'project', 'https://github.com/acme/worktree.git');
    git(mainPath, 'config', 'user.email', 'botmux@example.com');
    git(mainPath, 'config', 'user.name', 'Botmux Test');
    writeFileSync(join(mainPath, 'README.md'), 'main\n');
    git(mainPath, 'add', 'README.md');
    git(mainPath, 'commit', '-m', 'initial');
    const worktreePath = join(worktreeRoot, 'project-feature');
    git(mainPath, 'worktree', 'add', '-b', 'feature', worktreePath);

    const result = resolveRepoRequirement({
      requirement: 'git@github.com:acme/worktree.git',
      scanDirs: [worktreePath],
      dataDir,
    });

    expect(result).toMatchObject({ ok: true, path: worktreePath, source: 'scan' });
  });

  it('fails cleanly when the receiver does not have the project', () => {
    const root = tempRoot('repo-missing');
    const dataDir = tempRoot('repo-missing-data');

    expect(resolveRepoRequirement({
      requirement: 'https://github.com/acme/missing.git',
      scanDirs: [root],
      dataDir,
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('re-checks a stored path and rejects it after the directory is deleted', () => {
    const root = tempRoot('repo-stale');
    const dataDir = tempRoot('repo-stale-data');
    const path = makeRepo(root, 'project', 'https://github.com/acme/stale.git');
    expect(rememberRepoCapability(path, ['stale-project'], dataDir)).toBeDefined();
    rmSync(path, { recursive: true, force: true });

    expect(resolveRepoRequirement({
      requirement: 'https://github.com/acme/stale.git',
      scanDirs: [root],
      dataDir,
    })).toMatchObject({ ok: false, reason: 'stale_path', stalePath: path });
  });

  it('rejects a stored path whose origin changed after registration', () => {
    const root = tempRoot('repo-remote-changed');
    const dataDir = tempRoot('repo-remote-changed-data');
    const path = makeRepo(root, 'project', 'https://github.com/acme/original.git');
    expect(rememberRepoCapability(path, [], dataDir)).toBeDefined();
    git(path, 'remote', 'set-url', 'origin', 'https://github.com/acme/other.git');

    expect(resolveRepoRequirement({
      requirement: 'https://github.com/acme/original.git',
      scanDirs: [root],
      dataDir,
    })).toMatchObject({ ok: false, reason: 'remote_mismatch', stalePath: path });
  });

  it('keeps a stored alias bound to the remote it originally identified', () => {
    const root = tempRoot('repo-alias-changed');
    const dataDir = tempRoot('repo-alias-changed-data');
    const path = makeRepo(root, 'project', 'https://github.com/acme/original.git');
    expect(rememberRepoCapability(path, ['project-alias'], dataDir)).toBeDefined();
    git(path, 'remote', 'set-url', 'origin', 'https://github.com/acme/other.git');

    expect(resolveRepoRequirement({
      requirement: 'project-alias',
      scanDirs: [root],
      dataDir,
    })).toMatchObject({ ok: false, reason: 'remote_mismatch', stalePath: path });
  });

  it('only records real git repos with a usable origin', () => {
    const root = tempRoot('repo-invalid');
    const dataDir = tempRoot('repo-invalid-data');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(inspectLocalRepo(plain)).toMatchObject({ ok: false, reason: 'not_git' });
    expect(rememberRepoCapability(plain, [], dataDir)).toBeUndefined();
  });
});
