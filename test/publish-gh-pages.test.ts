import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../scripts/publish-gh-pages.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'pages-test',
  GIT_AUTHOR_EMAIL: 'pages-test@example.com',
  GIT_COMMITTER_NAME: 'pages-test',
  GIT_COMMITTER_EMAIL: 'pages-test@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

describe('publish-gh-pages.sh', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(): { remote: string; site: string } {
    root = mkdtempSync(join(tmpdir(), 'botmux-pages-'));
    const remote = join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', remote);
    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'blog'), { recursive: true });
    mkdirSync(join(seed, 'botmux-midscene', 'pr-1'), { recursive: true });
    writeFileSync(join(seed, 'blog', 'index.html'), 'blog');
    writeFileSync(join(seed, 'botmux-midscene', 'pr-1', 'index.html'), 'old report');
    git(seed, 'init', '-q', '-b', 'gh-pages');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'first');
    writeFileSync(join(seed, 'botmux-midscene', 'pr-1', 'index.html'), 'newer report');
    git(seed, 'commit', '-q', '-am', 'second');
    git(seed, 'push', '-q', remote, 'gh-pages');
    const site = join(root, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), 'pr-2 report');
    return { remote, site };
  }

  const publish = (remote: string, site: string, target: string) =>
    execFileSync('bash', [SCRIPT, site, target, `publish ${target}`], {
      env: { ...ENV, PAGES_REMOTE: remote },
      encoding: 'utf8',
    });

  it('publishes as one parentless commit and keeps every other path', () => {
    const { remote, site } = setup();
    expect(publish(remote, site, 'botmux-midscene/pr-2')).toContain('single commit');
    const check = join(root!, 'check');
    git(root!, 'clone', '-q', '--branch', 'gh-pages', remote, check);
    expect(git(check, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(readFileSync(join(check, 'botmux-midscene', 'pr-2', 'index.html'), 'utf8')).toBe('pr-2 report');
    expect(readFileSync(join(check, 'botmux-midscene', 'pr-1', 'index.html'), 'utf8')).toBe('newer report');
    expect(readFileSync(join(check, 'blog', 'index.html'), 'utf8')).toBe('blog');
  });

  it('does not publish when the content is unchanged', () => {
    const { remote, site } = setup();
    publish(remote, site, 'botmux-midscene/pr-2');
    const before = git(root!, 'ls-remote', remote, 'refs/heads/gh-pages');
    expect(publish(remote, site, 'botmux-midscene/pr-2')).toContain('Nothing changed');
    expect(git(root!, 'ls-remote', remote, 'refs/heads/gh-pages')).toBe(before);
  });

  it('refuses target paths outside the branch', () => {
    const { remote, site } = setup();
    for (const target of ['', '/etc', '../x', '.git']) {
      expect(() => publish(remote, site, target)).toThrow();
    }
  });
});
