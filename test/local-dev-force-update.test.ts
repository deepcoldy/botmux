import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDevForceUpdates } from '../src/utils/local-dev-force-update.js';

let root: string, upstream: string, local: string;
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-force-update-'));
  upstream = join(root, 'upstream'); local = join(root, 'local');
  mkdirSync(upstream);
  git(upstream, 'init');
  writeFileSync(join(upstream, 'package.json'), '{"name":"botmux"}');
  writeFileSync(join(upstream, 'feature.txt'), 'official');
  writeFileSync(join(upstream, '.gitignore'), 'ignored/\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'official');
  git(root, 'clone', upstream, local);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('confirmed local overwrite', () => {
  it.skipIf(process.platform === 'win32').each(['tracked', 'ignored'] as const)('preserves a %s edit made during backup creation instead of discarding it from a clean plan', async kind => {
    if (kind === 'ignored') {
      mkdirSync(join(upstream, 'ignored'));
      writeFileSync(join(upstream, 'ignored/config'), 'upstream config');
      git(upstream, 'add', '-f', 'ignored/config'); git(upstream, 'commit', '-m', 'track config');
    }
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    const before = git(local, 'rev-parse', 'HEAD');
    const bin = join(root, 'bin'); mkdirSync(bin);
    const originalPath = process.env.PATH;
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {mkdirSync,writeFileSync}=require('node:fs');
const {dirname}=require('node:path');
const args=process.argv.slice(2);
const child=spawnSync('git',args,{env:{...process.env,PATH:${JSON.stringify(originalPath)}},stdio:'inherit'});
if(child.status===0 && args[0]==='update-ref' && args[1].endsWith('/head')) {
  const file=${JSON.stringify(kind === 'ignored' ? 'ignored/config' : 'feature.txt')};
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,'human edit during backup');
}
process.exit(child.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o755);
    try {
      process.env.PATH = bin + delimiter + originalPath;
      await expect(controller.apply(local, preview.token)).rejects.toMatchObject({ code: kind === 'ignored' ? 'local_update_ignored_collision' : 'local_update_preview_stale' });
    } finally { process.env.PATH = originalPath; }
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(local, kind === 'ignored' ? 'ignored/config' : 'feature.txt'), 'utf8')).toBe('human edit during backup');
  });
  it.skipIf(process.platform === 'win32')('restores files and retains exact stash recovery when writing the backup reference fails', async () => {
    writeFileSync(join(local, 'feature.txt'), 'staged'); git(local, 'add', '.');
    writeFileSync(join(local, 'feature.txt'), 'unstaged');
    writeFileSync(join(local, 'new.txt'), 'untracked');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    const before = git(local, 'rev-parse', 'HEAD');
    const bin = join(root, 'bin'); mkdirSync(bin);
    const originalPath = process.env.PATH;
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {mkdirSync,writeFileSync}=require('node:fs');
const {dirname,join}=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='update-ref' && args[1].endsWith('/worktree')) {
  const lock=join(process.cwd(),'.git',args[1]+'.lock');
  mkdirSync(dirname(lock),{recursive:true}); writeFileSync(lock,'held');
}
const child=spawnSync('git',args,{env:{...process.env,PATH:${JSON.stringify(originalPath)}},stdio:'inherit'});
process.exit(child.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o755);
    let error!: Error & { backupRef: string; backupStash: string };
    try {
      process.env.PATH = bin + delimiter + originalPath;
      await controller.apply(local, preview.token).catch(e => { error = e; });
    } finally { process.env.PATH = originalPath; }
    expect(error).toBeDefined();
    expect(error.backupStash).toMatch(/^[0-9a-f]{40}$/);
    expect(git(local, 'rev-parse', 'refs/stash')).toBe(error.backupStash);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe('unstaged');
    expect(git(local, 'show', ':feature.txt')).toBe('staged');
    expect(readFileSync(join(local, 'new.txt'), 'utf8')).toBe('untracked');
    expect(git(local, 'rev-parse', `${error.backupRef}/head`)).toBe(before);
  });
  it('does not erase a cherry-pick started after preview even when the working tree remains clean', async () => {
    git(local, 'checkout', '-b', 'empty-commit');
    git(local, 'commit', '--allow-empty', '-m', 'empty');
    const empty = git(local, 'rev-parse', 'HEAD');
    git(local, 'checkout', 'master');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    expect(() => git(local, 'cherry-pick', empty)).toThrow();
    expect(git(local, 'status', '--porcelain')).toBe('');
    await expect(controller.apply(local, preview.token)).rejects.toMatchObject({ code: 'local_update_operation_in_progress' });
    expect(git(local, 'rev-parse', 'CHERRY_PICK_HEAD')).toBe(empty);
    expect(git(local, 'for-each-ref', 'refs/botmux/update-backups')).toBe('');
  });
  it('previews without changing files, backs up staged/unstaged/untracked changes and commits, and preserves ignored files', async () => {
    writeFileSync(join(local, 'feature.txt'), 'custom commit');
    git(local, 'add', '.'); git(local, 'commit', '-m', 'custom feature');
    const customHead = git(local, 'rev-parse', 'HEAD');
    writeFileSync(join(local, 'feature.txt'), 'staged'); git(local, 'add', '.');
    writeFileSync(join(local, 'feature.txt'), 'unstaged');
    writeFileSync(join(local, 'new.txt'), 'untracked');
    mkdirSync(join(local, 'ignored')); writeFileSync(join(local, 'ignored/config'), 'keep');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    expect(preview.status).toContain('new.txt');
    expect(preview.localCommits).toContain('custom feature');
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe('unstaged');
    const { backupRef } = await controller.apply(local, preview.token);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', 'HEAD'));
    expect(git(local, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(local, 'ignored/config'), 'utf8')).toBe('keep');
    expect(git(local, 'rev-parse', `${backupRef}/head`)).toBe(customHead);
    expect(git(local, 'show', `${backupRef}/worktree:feature.txt`)).toBe('unstaged');
    expect(git(local, 'show', `${backupRef}/worktree^2:feature.txt`)).toBe('staged');
    expect(git(local, 'show', `${backupRef}/worktree^3:new.txt`)).toBe('untracked');
    await expect(controller.apply(local, preview.token)).rejects.toMatchObject({ code: 'local_update_preview_stale' });
    git(local, 'checkout', '-b', 'recover-update', `${backupRef}/head`);
    git(local, 'stash', 'apply', '--index', `${backupRef}/worktree`);
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe('unstaged');
    expect(git(local, 'show', ':feature.txt')).toBe('staged');
    expect(readFileSync(join(local, 'new.txt'), 'utf8')).toBe('untracked');
  });

  it.each(['tracked', 'untracked', 'upstream', 'expired', 'checkout'] as const)('rejects %s drift before backup or reset', async kind => {
    writeFileSync(join(local, 'feature.txt'), 'draft');
    writeFileSync(join(local, 'new.txt'), 'draft');
    const before = git(local, 'rev-parse', 'HEAD');
    let now = 1000;
    const controller = new LocalDevForceUpdates(() => now);
    const preview = await controller.preview(local);
    if (kind === 'tracked') writeFileSync(join(local, 'feature.txt'), 'new draft');
    if (kind === 'untracked') writeFileSync(join(local, 'new.txt'), 'new draft');
    if (kind === 'upstream') {
      writeFileSync(join(upstream, 'feature.txt'), 'new official'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'advance');
    }
    if (kind === 'expired') now += 6 * 60_000;
    await expect(controller.apply(kind === 'checkout' ? upstream : local, preview.token)).rejects.toMatchObject({ code: 'local_update_preview_stale' });
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(local, 'for-each-ref', 'refs/botmux/update-backups')).toBe('');
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe(kind === 'tracked' ? 'new draft' : 'draft');
  });

  it('keeps local data intact if fetching upstream fails after confirmation', async () => {
    writeFileSync(join(local, 'feature.txt'), 'draft');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    renameSync(upstream, upstream + '-offline');
    await expect(controller.apply(local, preview.token)).rejects.toThrow();
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe('draft');
    expect(git(local, 'for-each-ref', 'refs/botmux/update-backups')).toBe('');
  });

  it('handles detached HEAD and configures a tracking branch for future normal updates', async () => {
    git(local, 'checkout', '--detach');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    await controller.apply(local, preview.token);
    expect(git(local, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe('HEAD');
    expect(git(local, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/master');
  });

  it('refuses to overwrite ignored configuration introduced after preview', async () => {
    mkdirSync(join(upstream, 'ignored'));
    writeFileSync(join(upstream, 'ignored/config'), 'upstream');
    git(upstream, 'add', '-f', 'ignored/config'); git(upstream, 'commit', '-m', 'track config');
    const controller = new LocalDevForceUpdates();
    const preview = await controller.preview(local);
    mkdirSync(join(local, 'ignored'));
    writeFileSync(join(local, 'ignored/config'), 'local secret');
    await expect(controller.apply(local, preview.token)).rejects.toMatchObject({ code: 'local_update_ignored_collision' });
    expect(readFileSync(join(local, 'ignored/config'), 'utf8')).toBe('local secret');
    expect(readFileSync(join(local, 'feature.txt'), 'utf8')).toBe('official');
  });
});
