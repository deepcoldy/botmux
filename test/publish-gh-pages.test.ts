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

  const publish = (remote: string, site: string, target: string, extraEnv: Record<string, string> = {}) =>
    execFileSync('bash', [SCRIPT, site, target, `publish ${target}`], {
      env: { ...ENV, PAGES_REMOTE: remote, ...extraEnv },
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

  it('keeps only the newest per-run directories with the prefix and leaves the rest alone', () => {
    const { remote, site } = setup();
    const keep = { PAGES_KEEP_PREFIX: 'master-run-', PAGES_KEEP: '2' };
    // 9 < 10 < 100 numerically, but not as plain strings.
    for (const id of ['100', '9', '10']) publish(remote, site, `botmux-midscene/master-run-${id}`, keep);
    const check = join(root!, 'check');
    git(root!, 'clone', '-q', '--branch', 'gh-pages', remote, check);
    const listed = git(check, 'ls-tree', '--name-only', 'HEAD', 'botmux-midscene/').split('\n').sort();
    expect(listed).toEqual(['botmux-midscene/master-run-10', 'botmux-midscene/master-run-100', 'botmux-midscene/pr-1']);
  });

  it('removes reports of PRs that are not open, but keeps open ones, the target and other directories', () => {
    const { remote, site } = setup();
    for (const key of ['pr-3', 'pr-4', 'pr-x', 'manual', 'master-run-7']) publish(remote, site, `botmux-midscene/${key}`);
    // pr-1 and pr-4 are closed; pr-5 is the target and is published even though it is not listed.
    publish(remote, site, 'botmux-midscene/pr-5', { PAGES_OPEN_PRS: '3 12' });
    const check = join(root!, 'check');
    git(root!, 'clone', '-q', '--branch', 'gh-pages', remote, check);
    const listed = git(check, 'ls-tree', '--name-only', 'HEAD', 'botmux-midscene/').split('\n').sort();
    expect(listed).toEqual([
      'botmux-midscene/manual',
      'botmux-midscene/master-run-7',
      'botmux-midscene/pr-3',
      'botmux-midscene/pr-5',
      'botmux-midscene/pr-x',
    ]);
    expect(readFileSync(join(check, 'blog', 'index.html'), 'utf8')).toBe('blog');
  });

  it('treats an empty open-PR list as "no PR is open"', () => {
    const { remote, site } = setup();
    publish(remote, site, 'botmux-midscene/manual', { PAGES_OPEN_PRS: '' });
    const check = join(root!, 'check');
    git(root!, 'clone', '-q', '--branch', 'gh-pages', remote, check);
    expect(git(check, 'ls-tree', '--name-only', 'HEAD', 'botmux-midscene/')).toBe('botmux-midscene/manual');
  });

  it('refuses target paths outside the branch', () => {
    const { remote, site } = setup();
    for (const target of ['', '/etc', '../x', '.git']) {
      expect(() => publish(remote, site, target)).toThrow();
    }
  });
});
