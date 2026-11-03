import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceResolver } from '../src/core/workspace-metadata.js';

const dirs: string[] = [];
function dir() { const d = mkdtempSync(join(tmpdir(), 'workspace-test-')); dirs.push(d); return d; }
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('host workspace resolver', () => {
  it('resolves an unborn checkout, subdirectory and symlink to the same root', async () => {
    const root = dir(); git(root, 'init'); git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const sub = join(root, 'src'); mkdirSync(sub);
    const alias = join(dir(), 'alias'); symlinkSync(root, alias);
    const resolve = createWorkspaceResolver(() => 'host-a');
    const [a, b, c] = await Promise.all([resolve(root, 'pty'), resolve(sub, 'tmux'), resolve(alias, 'zellij')]);
    expect(a).toMatchObject({ kind: 'git', branch: 'main', state: 'resolved' });
    expect(b.rootPath).toBe(a.rootPath); expect(c.rootPath).toBe(a.rootPath);
  });
  it('keeps linked worktrees separate and handles detached HEAD', async () => {
    const root = dir(); git(root, 'init'); git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    const linked = join(dir(), 'linked'); git(root, 'worktree', 'add', '--detach', linked);
    const resolve = createWorkspaceResolver(() => 'host');
    const a = await resolve(root, 'pty'); const b = await resolve(linked, 'tmux');
    expect(b.kind).toBe('git'); expect(b.rootPath).not.toBe(a.rootPath); expect(b.branch).toBeUndefined();
  });
  it('returns explicit directory and missing fallbacks and caches concurrent calls', async () => {
    const root = dir(); const resolve = createWorkspaceResolver(() => 'host');
    const [a, b] = await Promise.all([resolve(root, 'pty'), resolve(root, 'pty', true)]);
    expect(a).toBe(b); expect(a).toMatchObject({ kind: 'directory', state: 'resolved' });
    expect(await resolve(join(root, 'missing'), 'pty')).toMatchObject({ state: 'missing', kind: 'directory' });
  });
  it('does not probe remote or unknown backend paths even when they exist locally', async () => {
    const root = dir(); git(root, 'init'); const resolve = createWorkspaceResolver(() => 'host');
    for (const backend of ['riff', 'mojo', undefined]) expect(await resolve(root, backend)).toEqual({
      sourceId: 'host', kind: 'unknown', state: 'unsupported',
    });
  });
});
